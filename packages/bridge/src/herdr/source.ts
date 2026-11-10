/**
 * The `herdr` implementation (DESIGN-v2 §4 T09, DESIGN.md §5.4): {@link HerdrSource} fulfils the view manager's
 * {@link HerdrData} from this Mac's real sources.
 *
 * Sources: herdr-core (`doc.get herdr-app` → spaces, tabs, panes; the mirrored terminal list from
 * `events.subscribe` → terminals, agents); appHome files (`./files.ts`: layouts and clicks, settings, keys, programs,
 * themes, `shared.json`, `cockpit.json`, watched); the bundled `herdr-app commands` list (`./commands.json`);
 * `herdr-app --version` and `herdr-app commands` once at start with the compat check (`./version.ts`: the running
 * Herdr's version for the exec policy until the mirror reports it, and `hello.compat`);
 * and the mirror mod's snapshot (D5, {@link HerdrSource.mirror}), whose exact values win once it reports them.
 *
 * The 44 `herdr` functions and where each is served:
 * - host state (`hostState`, read synchronously by the mod host's shim): `home`, `appHome`, `spaces`, `agents`,
 *   `panes`, `terminals`, `focused`, `layout`, `layouts`, `commands`, `window`, `theme`, `updates`, `settings`, `keys`,
 *   `shared`; `props`/`placement`/`nextCommand` are copy-scoped in the host;
 * - RPCs (`rpc`): `exec`, `hc` (exec policy E1–E16, E11 `open <url>` → a toast with `action.open` on the originating
 *   device), `readTextFile` (the folder's read roots), `writeTextFile` (refused: editing from a device is out of
 *   scope), `knownAgents`, `watchFolder` (`./watch.ts`), and `net.*` for the cockpit hub (`./net.ts`; each write is
 *   decided for the call's origin under the folder's `net.writes`); each folder is decided under its policy profile
 *   (OSS-PLAN §1, `../policy/profiles.ts`);
 * - emits (`emit`): `setShared` (D8: a per-session overlay; `shared.json` is never written), `setAgentOrder`;
 *   the view manager handles `run`, `openOverlay`, `closeOverlay`, `notify`, `focus`, `write_to_clipboard`, and
 *   `playSound`, whose file and rate are checked here (`sound`: a mod's own sound file the asset route serves, at most
 *   {@link SOUND_RATE_PER_S} per second per session) and which plays only on the device of the call's origin;
 * - `run()` of the `passthrough` class: `herdr-app do` through the E9 policy (`passthrough`);
 * - not supported remotely (12): `machines`, `pickFolder`, `themes`, `fonts`, `presentUpdateNotes`, `telemetry`,
 *   `feedbackPreview`, `feedbackPasteImage`, `feedbackPickImages`, `feedbackAttachImages`, `feedbackClearImages`,
 *   `sendFeedback`. The ones that reach the bridge are refused with `not supported remotely: <name>`; their host state
 *   fields (`machines`, `themes`, `fonts`) are empty — except `fonts`, the Mac's font families, once the mirror
 *   reports them.
 *
 * Changes: core terminal events are coalesced to one `state` change per {@link STATE_THROTTLE_MS} (measured: a working
 * agent's spinner title changes about ten times a second, and each `state` is a full push to every host); every read
 * returns the latest values at once.
 */

import {
  applyClicks,
  type CommandInfo,
  CommandInfoSchema,
  type Emit,
  type Focused,
  FocusedSchema,
  type HelloCompat,
  type HostState,
  is,
  type JsonObject,
  type JsonValue,
  type KeyBindingInfo,
  KeyBindingInfoSchema,
  type PaneInfo,
  PaneInfoSchema,
  type PolicyProfile,
  type Rpc,
  type Schema,
  SharedSchema,
  type Toast,
  type UpdatesInfo,
  UpdatesInfoSchema,
  type WindowInfo,
  WindowInfoSchema,
} from "@herdr-relay/protocol";
import { join } from "@std/path";
import {
  type CoreClientEvent,
  type CoreClientListener,
  type CoreClientState,
  type CoreDoc,
  type CoreSession,
  type CoreTerminal,
  HERDR_APP_DOC,
} from "../core/mod.ts";
import type { HostRef } from "../hosts/mod.ts";
import type { Platform } from "../platform.ts";
import {
  type ExecOptions,
  type ExecOutcome,
  FolderPolicies,
  lexical,
  logDecision,
  type PolicyContext,
  policyContext,
  policyExec,
  policyHerdrAppDo,
  type PolicyLog,
  policyReadTextFile,
  PolicyRefusal,
  ProfileSet,
  ReadRoots,
  type ReadRootsInput,
  refuse,
  refusedResult,
  relativeInside,
  resolveAsset,
  resolveDirUnderRoots,
  type RunnerPaths,
  USER_DECISIONS,
  type UserDecisions,
} from "../policy/mod.ts";
import { openLinkToast } from "../policy/hub.ts";
import { classifyCommand, type SessionWorld } from "../session/mod.ts";
import type { ClientLook, HerdrChange, HerdrData, MacLayout, ResolvedOrigin, SnapshotState } from "../views/mod.ts";
import bundled from "./commands.json" with { type: "json" };
import { type AppFiles, loadAppFiles, watchAppFiles } from "./files.ts";
import { clientFonts, effectiveSettings, resolveTheme } from "./look.ts";
import { buildModel, type Model, type ProgramTable, programTable, spaceFolders, startable } from "./model.ts";
import { HubProxy } from "./net.ts";
import { RepoCache } from "./repos.ts";
import { FolderWatches } from "./watch.ts";
import { HerdrVersion } from "./version.ts";

/** Core changes are announced at most this often. */
export const STATE_THROTTLE_MS = 250;
/** Deadline of one `doc.get herdr-app`. */
export const DOC_TIMEOUT_MS = 5_000;
/** `knownAgents()` asks again after this long (Herdr: at most once a minute per machine). */
export const KNOWN_AGENTS_TTL_MS = 60_000;
/** Largest value one `setShared` may store in an overlay (serialized). */
export const SHARED_VALUE_MAX_BYTES = 256 * 1024;
/** Keys one overlay may hold. */
export const SHARED_OVERLAY_MAX_KEYS = 1024;
/** `playSound` sounds one device session gets per second at most; the rest are dropped. */
export const SOUND_RATE_PER_S = 4;

/** What {@link HerdrSource} needs of the core client ({@link CoreClient} satisfies it). */
export interface HerdrCore {
  readonly state: CoreClientState;
  readonly session: CoreSession | null;
  readonly terminals: ReadonlyMap<string, CoreTerminal>;
  on(listener: CoreClientListener): () => void;
  docGet<T = unknown>(name: string, timeoutMs?: number): Promise<CoreDoc<T>>;
}

/**
 * What the mirror mod (D5, T12, `../mirror.ts`) reports from inside Herdr: exact values of the same-named `herdr`
 * functions. Every field is optional; a field that does not validate is dropped. `shared` replaces `shared.json` (it
 * is the live map).
 */
export interface MirrorSnapshot {
  theme?: Record<string, string>;
  settings?: JsonObject;
  fonts?: string[];
  focused?: Focused | null;
  panes?: PaneInfo[];
  shared?: JsonObject;
  commands?: CommandInfo[];
  keys?: KeyBindingInfo[];
  updates?: UpdatesInfo;
  window?: WindowInfo;
}

export interface HerdrSourceOptions {
  /** `<appHome>` as configured (`HERDR_APP_HOME` or `~/.config/herdr-app`); `appHome()` returns it. */
  appHome: string;
  /** `$HOME`; `home()` returns it. */
  home: string;
  core: HerdrCore;
  /** Real paths for the exec policy's scoped runners. */
  paths: RunnerPaths;
  /** The bridge's `PATH` (and `TMPDIR`) for the programs the policy runs with a cleared environment. */
  env: { PATH: string; TMPDIR?: string };
  policyLog: PolicyLog;
  /** The policy profiles every folder is decided under (default: the built-ins only, `ProfileSet.load()`). */
  profiles?: ProfileSet;
  /** U1–U3 (default: the confirmed `USER_DECISIONS`). */
  decisions?: UserDecisions;
  /** The computer's platform (E11/E12 openers, refusal labels); default `hostPlatform()`. */
  platform?: Platform;
  /** Mod folders with a running host; default: the folders whose hosts have called. */
  loadedFolders?: () => ReadonlySet<string>;
  /** Shows a toast on one device session (E11 `open <url>`); returns false when that session is gone. */
  toast?: (session: string, toast: Toast) => boolean;
  log?: (line: string) => void;
}

/** The error a `herdr` function that is not available remotely rejects with. */
export function notSupportedRemotely(name: string): Error {
  return new Error(`not supported remotely: ${name}`);
}

const BUNDLED_COMMANDS: readonly CommandInfo[] = bundled.commands;
const PLATFORM: WindowInfo["platform"] = Deno.build.os === "darwin"
  ? "macos"
  : Deno.build.os === "windows"
  ? "windows"
  : "linux";

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

interface Cached {
  model: Model;
  base: Omit<HostState, "folder" | "shared">;
  look: ClientLook;
}

export class HerdrSource implements HerdrData {
  readonly #o: HerdrSourceOptions;
  readonly #log: (line: string) => void;
  readonly #core: HerdrCore;
  readonly #listeners = new Set<(change: HerdrChange) => void>();
  readonly #repos: RepoCache;
  readonly #watches: FolderWatches;
  readonly #net: HubProxy;
  /** Folders whose hosts have called (the default `loadedFolders`). */
  readonly #called = new Set<string>();
  /** D8 overlays: session → key → value. */
  readonly #overlays = new Map<string, Map<string, JsonValue>>();
  /** `setShared` without a device session (a mod's own task): every session sees it; never written to disk. */
  readonly #global = new Map<string, JsonValue>();
  /** Per device session: when its recent sounds were allowed, and whether a drop was logged since the last one. */
  readonly #sounds = new Map<string, { times: number[]; dropped: boolean }>();
  #files: AppFiles;
  #programs: ProgramTable;
  /** appHome only: nothing is readable through them (the static asset route and the policy's appHome). */
  readonly #roots: ReadRoots;
  /** Each folder's profile and read roots. */
  readonly #policies: FolderPolicies;
  #rootsKey = "";
  #doc: unknown = null;
  #mirror: MirrorSnapshot | null = null;
  /** The running Herdr's version (`herdr-app --version`, then the mirror's) and the compat check at start. */
  readonly #version: HerdrVersion;
  #agentOrder: string[] | undefined;
  #cache: Cached | null = null;
  #known: { at: number; value: JsonValue } | null = null;
  #stateTimer: ReturnType<typeof setTimeout> | undefined;
  #docTimer: ReturnType<typeof setTimeout> | undefined;
  #docBusy = false;
  #docAgain = false;
  #filesBusy: Promise<void> = Promise.resolve();
  #unsubscribe: (() => void) | null = null;
  #stopFiles: (() => void) | null = null;
  #closed = false;

  private constructor(o: HerdrSourceOptions, files: AppFiles, roots: ReadRoots, profiles: ProfileSet) {
    this.#o = o;
    this.#log = o.log ?? ((line) => console.error(`herdr-relay herdr: ${line}`));
    this.#core = o.core;
    this.#files = files;
    this.#programs = programTable(files.programs);
    this.#roots = roots;
    this.#policies = new FolderPolicies(profiles, this.#rootsInput([]));
    this.#version = new HerdrVersion({
      home: o.paths.home,
      appHome: o.appHome,
      PATH: o.env.PATH,
      mirrorVersion: () => this.#mirror?.updates?.app.version,
      log: this.#log,
    });
    this.#repos = new RepoCache(() => this.#stateSoon());
    this.#watches = new FolderWatches(this.#log);
    this.#net = new HubProxy({
      cockpit: () => this.#files.cockpit,
      profileFor: (folder) => this.#policies.profileFor(folder),
      policyLog: o.policyLog,
      log: this.#log,
      toast: (session, toast) => this.#o.toast?.(session, toast) ?? false,
      decisions: o.decisions ?? USER_DECISIONS,
    });
  }

  /**
   * Reads appHome, loads the policy profiles when none are given, follows the core (its first `doc.get` is awaited up
   * to {@link DOC_TIMEOUT_MS}; an unreachable core leaves the model empty until it connects) and watches appHome.
   */
  static async start(o: HerdrSourceOptions): Promise<HerdrSource> {
    const log = o.log ?? ((line: string) => console.error(`herdr-relay herdr: ${line}`));
    const files = await loadAppFiles(o.appHome, log);
    const roots = await ReadRoots.resolve(o.appHome, []);
    const profiles = o.profiles ?? await ProfileSet.load({ log });
    const s = new HerdrSource(o, files, roots, profiles);
    s.#rootsKey = JSON.stringify([[], files.cockpit?.home, files.cockpit?.cache]);
    s.#unsubscribe = o.core.on((e) => s.#coreEvent(e));
    s.#stopFiles = watchAppFiles(roots.appHomeReal, () => s.#reloadFiles(), log);
    await Promise.all([s.#fetchDoc(), s.#version.start()]);
    return s;
  }

  /** appHome (no folder's read roots), for the static asset route. */
  get roots(): ReadRoots {
    return this.#roots;
  }

  /** Stops following the core and appHome; closes watches and hub connections. */
  close(): void {
    this.#closed = true;
    this.#unsubscribe?.();
    this.#stopFiles?.();
    clearTimeout(this.#stateTimer);
    clearTimeout(this.#docTimer);
    this.#watches.close();
    this.#net.closeAll();
    this.#listeners.clear();
  }

  /**
   * The mirror mod's latest snapshot (null: none); its valid fields win over the derived values. A stale mirror
   * passes only its look fields, so the window's own state falls back to the derived values.
   */
  mirror(snapshot: MirrorSnapshot | null): void {
    const prevShown = this.#shown();
    this.#mirror = snapshot === null ? null : this.#validMirror(snapshot);
    this.#invalidate();
    // A profile's `requires.herdr` is checked once the running Herdr's version is known.
    const version = this.#mirror?.updates?.app.version;
    if (version) this.#policies.profiles.checkHerdr(version);
    this.#version.note();
    if (this.#shown() !== prevShown) void this.#reloadFiles();
    this.#emit({ kind: "state" });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // HerdrData.

  layout(): MacLayout {
    return { layout: this.#files.layout, clicks: this.#files.clicks };
  }

  world(): SessionWorld {
    const { spaces, panes, agents, focused } = this.#current().model;
    return this.#agentOrder
      ? { spaces, panes, agents, focused, agentOrder: this.#agentOrder }
      : { spaces, panes, agents, focused };
  }

  commands(): readonly CommandInfo[] {
    return this.#mirror?.commands ?? BUNDLED_COMMANDS;
  }

  hostState(folder: string, lead: string | null): HostState {
    return { ...this.#current().base, folder, shared: this.#sharedFor(lead) };
  }

  look(): ClientLook {
    return this.#current().look;
  }

  snapshot(session: string): SnapshotState {
    const { spaces, agents, terminals, panes, focused } = this.#current().model;
    return { spaces, agents, terminals, panes, focused, shared: this.#sharedFor(session) };
  }

  subscribe(listener: (change: HerdrChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(host: HostRef, msg: Emit, origin: ResolvedOrigin | null): void {
    this.#called.add(host.folder);
    switch (msg.method) {
      case "setShared":
        return this.#setShared(host, msg.args, origin);
      case "setAgentOrder": {
        const list = msg.args[0];
        if (!Array.isArray(list)) return this.#log(`${msg.copy}: setAgentOrder without a list`);
        this.#agentOrder = list.filter((a): a is string => typeof a === "string").slice(0, 4096);
        return;
      }
      case "net.close":
        return this.#net.close(host.folder, msg.args[0]);
      default:
        return this.#log(`${msg.copy}: emit ${msg.method} is not handled here; dropped`);
    }
  }

  async rpc(host: HostRef, msg: Rpc, origin: ResolvedOrigin | null): Promise<JsonValue | undefined> {
    this.#called.add(host.folder);
    const a = msg.args;
    const session = origin?.session;
    switch (msg.method) {
      case "exec":
        return await this.#exec(host, "exec", a[0], a[1], a[2], origin);
      case "hc":
        return await this.#exec(host, "hc", "hc", a[0], null, origin);
      case "readTextFile":
        return await this.#guard(host, "readTextFile", a, session, async () => {
          if (isObject(a[1]) && typeof a[1].on === "string" && a[1].on !== "") {
            refuse("read", "remote machines are out of scope");
          }
          if (typeof a[0] !== "string") refuse("read", "readTextFile takes a path");
          return policyReadTextFile((await this.#policies.policyFor(host.folder)).roots, a[0]);
        });
      case "writeTextFile":
        return await this.#guard(host, "writeTextFile", a.slice(0, 1), session, () => {
          refuse("write", "editing files from a device is out of scope");
        });
      case "knownAgents":
        if (isObject(a[0]) && typeof a[0].on === "string" && a[0].on !== "") {
          throw new Error("remote machines are out of scope");
        }
        return await this.#knownAgents();
      case "watchFolder":
        return await this.#guard(host, "watchFolder", a, session, async () => {
          if (typeof a[0] !== "string") refuse("read", "watchFolder takes a folder");
          const { roots } = await this.#policies.policyFor(host.folder);
          const dir = await resolveDirUnderRoots(roots, a[0], "folder");
          return await this.#watches.wait(host.folder, host.generation, dir);
        });
      case "net.connect":
        return await this.#net.connect(host.folder, host.generation, a[0], a[1], session);
      case "net.write":
        await this.#net.write(host.folder, host.generation, a[0], a[1], origin);
        return undefined;
      case "net.read":
        return await this.#net.read(host.folder, host.generation, a[0], a[1]);
      default:
        logDecision(this.#o.policyLog, {
          folder: host.folder,
          method: msg.method,
          argv: [],
          decision: "refuse",
          rule: "rpc.unknown",
          session,
          profile: this.#policies.profileFor(host.folder).id,
        });
        throw notSupportedRemotely(msg.method);
    }
  }

  async passthrough(name: string, args: JsonObject, origin: ResolvedOrigin): Promise<void> {
    let out: ExecOutcome;
    try {
      out = await policyHerdrAppDo(this.#policy(), {
        folder: null,
        name,
        args,
        commandClass: classifyCommand(name).class,
        scope: origin.connected ? origin.scope : "read",
        session: origin.session,
      });
    } catch (e) {
      this.#log(`herdr-app do ${name}: ${e instanceof Error ? e.message : String(e)}`);
      throw new Error("herdr-app is not available on the Mac");
    }
    if (out.result.code === 0) return;
    const why = out.result.stderr.split("\n").map((l) => l.trim()).find((l) => l !== "");
    throw new Error(why?.replace(/^herdr-relay:\s*/, "") ?? `herdr-app do ${name} failed (exit ${out.result.code})`);
  }

  sessionClosed(session: string): void {
    this.#overlays.delete(session);
    this.#sounds.delete(session);
  }

  /**
   * `playSound(path)` from a connected device session (herdr.d.ts: "an MP3 file (absolute, or relative to
   * ~/.config/herdr-app)"): the asset URL to send that device, relative to the mount as image URLs are, when the file is
   * one the asset route serves as audio (`mods/**\/*.mp3|wav|ogg`, same realpath rules) and the session is under
   * {@link SOUND_RATE_PER_S}; otherwise null — a refused file is logged (rule `read`), a dropped one once per burst.
   * Herdr's named sounds (`"done"`, `"blocked"`) are app sounds, not files: refused.
   */
  async sound(host: HostRef, path: JsonValue | undefined, origin: ResolvedOrigin): Promise<string | null> {
    this.#called.add(host.folder);
    const now = Date.now();
    let rate = this.#sounds.get(origin.session);
    if (!rate) this.#sounds.set(origin.session, rate = { times: [], dropped: false });
    rate.times = rate.times.filter((t) => now - t < 1000);
    if (rate.times.length >= SOUND_RATE_PER_S) {
      if (!rate.dropped) this.#log(`${host.folder}: playSound over ${SOUND_RATE_PER_S}/s for one device; dropped`);
      rate.dropped = true;
      return null;
    }
    rate.times.push(now);
    rate.dropped = false;
    const refused = (reason: string): null => {
      const argv = [typeof path === "string" ? path : JSON.stringify(path) ?? ""];
      const session = origin.session;
      logDecision(this.#o.policyLog, {
        folder: host.folder,
        method: "playSound",
        argv,
        decision: "refuse",
        rule: "read",
        reason,
        session,
      });
      return null;
    };
    if (typeof path !== "string" || path === "" || path.includes("\0")) return refused("playSound takes a sound file");
    const abs = lexical(path, this.#roots.appHome);
    const rel = relativeInside(abs, this.#roots.appHome) ?? relativeInside(abs, this.#roots.appHomeReal);
    const asset = rel ? await resolveAsset(this.#roots, rel) : null;
    if (!rel || !asset?.contentType.startsWith("audio/")) {
      return refused(`${path} is not a mod's sound file (mods/<name>/…, mp3, wav or ogg)`);
    }
    return `assets/${rel.split("/").map(encodeURIComponent).join("/")}`;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // RPCs.

  /** Runs `fn`; a policy refusal is logged under its rule and rethrown, so the mod's promise rejects with its reason. */
  async #guard<T>(
    host: HostRef,
    method: string,
    args: readonly JsonValue[],
    session: string | undefined,
    fn: () => T | Promise<T>,
  ): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PolicyRefusal) {
        const argv = args.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? ""));
        logDecision(this.#o.policyLog, {
          folder: host.folder,
          method,
          argv,
          decision: "refuse",
          rule: e.rule,
          reason: e.message,
          session,
          profile: this.#policies.profileFor(host.folder).id,
        });
      }
      throw e;
    }
  }

  async #exec(
    host: HostRef,
    method: "exec" | "hc",
    command: JsonValue | undefined,
    argv: JsonValue | undefined,
    opts: JsonValue | undefined,
    origin: ResolvedOrigin | null,
  ): Promise<JsonValue> {
    if (typeof command !== "string" || !Array.isArray(argv) || !argv.every((x): x is string => typeof x === "string")) {
      throw new Error(method === "hc" ? "hc takes a list of arguments" : "exec takes a program and its arguments");
    }
    const options: ExecOptions = {};
    if (isObject(opts)) {
      if (typeof opts.cwd === "string") options.cwd = opts.cwd;
      if (typeof opts.on === "string") options.on = opts.on;
      if (typeof opts.timeout === "number") options.timeout = opts.timeout;
    }
    const out = await policyExec(this.#policy(), {
      folder: host.folder,
      method,
      command,
      argv,
      options,
      session: origin?.session ?? null,
      scope: origin?.connected ? origin.scope : "read",
    });
    // A named refusal (a change only the Herdr window makes): the device that asked sees why, besides the mod.
    if (out.toast !== undefined && origin?.connected) {
      this.#o.toast?.(origin.session, { t: "toast", title: out.toast, level: "warning" });
    }
    if (out.openUrl === undefined) return { ...out.result };
    // E11 (U3): the link opens on the device that asked, never on the Mac.
    const toast = openLinkToast(out.openUrl);
    const sent = origin?.connected === true && (this.#o.toast?.(origin.session, toast) ?? false);
    return sent ? { ...out.result } : { ...refusedResult("no device to open the link on") };
  }

  /** `knownAgents()`: the program table's startable agents, each `installed` when its program is on `PATH`. */
  async #knownAgents(): Promise<JsonValue> {
    if (this.#known && Date.now() - this.#known.at < KNOWN_AGENTS_TTL_MS) return this.#known.value;
    const out: JsonObject[] = [];
    for (const p of startable(this.#programs)) {
      out.push({ ...p, installed: await onPath(p.run[0], this.#o.env.PATH) });
    }
    this.#known = { at: Date.now(), value: out };
    return out;
  }

  /** The exec policy's context: always through `policyContext`, so every folder is decided under its profile. */
  #policy(): PolicyContext {
    return policyContext({
      roots: this.#roots,
      paths: this.#o.paths,
      loadedFolders: this.#o.loadedFolders?.() ?? this.#called,
      cockpit: this.#files.cockpit,
      env: this.#o.env,
      log: this.#o.policyLog,
      decisions: this.#o.decisions,
      platform: this.#o.platform,
      // The running Herdr's version (E14 pins): the mirror's `updates().app.version`, else `herdr-app --version`.
      herdrVersion: this.#version.current(),
    }, this.#policies);
  }

  /** Where `mod`'s overlays may open: its policy profile's `overlay` (`host-only`: devices get a toast instead). */
  overlayFor(mod: string): NonNullable<PolicyProfile["overlay"]> {
    return this.#policies.profileFor(mod).overlay ?? "device";
  }

  /** `hello.compat`: the running Herdr against the contract pins (undefined until the start-time check ran). */
  compat(): HelloCompat | undefined {
    return this.#version.compat();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // `shared()` and D8 overlays.

  #sharedFor(session: string | null): JsonObject {
    const out: JsonObject = { ...(this.#mirror?.shared ?? this.#files.shared) };
    for (const [k, v] of this.#global) out[k] = v;
    const own = session === null ? undefined : this.#overlays.get(session);
    if (own) { for (const [k, v] of own) out[k] = v; }
    return out;
  }

  #setShared(host: HostRef, args: readonly JsonValue[], origin: ResolvedOrigin | null): void {
    const [key, raw] = args;
    if (typeof key !== "string" || key === "") return this.#log(`${host.folder}: setShared without a key`);
    const value: JsonValue = raw === undefined ? null : raw;
    if ((JSON.stringify(value)?.length ?? 0) > SHARED_VALUE_MAX_BYTES) {
      return this.#log(`${host.folder}: setShared ${key} over ${SHARED_VALUE_MAX_BYTES} bytes; dropped`);
    }
    if (origin === null) {
      if (!this.#global.has(key) && this.#global.size >= SHARED_OVERLAY_MAX_KEYS) {
        return this.#log(`${host.folder}: setShared ${key}: too many keys; dropped`);
      }
      this.#global.set(key, value);
      // A session that set the key itself keeps its own value: hosts get a full state, not the fast path.
      if ([...this.#overlays.values()].some((o) => o.has(key))) return this.#emit({ kind: "state" });
      return this.#emit({ kind: "shared", key, value, session: null });
    }
    if (!origin.connected) {
      return this.#log(`${host.folder}: setShared ${key} for session ${origin.session}, which is not open; dropped`);
    }
    let overlay = this.#overlays.get(origin.session);
    if (!overlay) this.#overlays.set(origin.session, overlay = new Map());
    if (!overlay.has(key) && overlay.size >= SHARED_OVERLAY_MAX_KEYS) {
      return this.#log(`${host.folder}: setShared ${key}: too many keys for session ${origin.session}; dropped`);
    }
    overlay.set(key, value);
    this.#emit({ kind: "shared", key, value, session: origin.session });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The model and its changes.

  #current(): Cached {
    if (this.#cache) return this.#cache;
    const files = this.#files;
    const mirror = this.#mirror;
    const model = buildModel({
      doc: this.#doc,
      terminals: this.#core.terminals,
      programs: this.#programs,
      home: this.#o.home,
      repo: (cwd) => this.#repos.get(cwd),
      mac: { focused: mirror?.focused ?? null, panes: new Map((mirror?.panes ?? []).map((p) => [p.pane, p])) },
    });
    const root = applyClicks(files.layout.tree, files.clicks);
    const theme = resolveTheme(root, files.settings, files.themes);
    const settings = mirror?.settings ?? effectiveSettings(files.settings, root, theme.name);
    const colors = mirror?.theme ?? theme.colors;
    const hello = this.#core.session?.hello;
    const base: Cached["base"] = {
      home: this.#o.home,
      appHome: this.#o.appHome,
      spaces: model.spaces,
      agents: model.agents,
      panes: model.panes,
      terminals: model.terminals,
      focused: model.focused,
      layout: root,
      layouts: files.layouts,
      commands: [...this.commands()],
      window: mirror?.window ?? {
        platform: PLATFORM,
        titlebar: root.titlebar === "none" ? "none" : "system",
        buttons: false,
        maximized: false,
        fullscreen: false,
        active: true,
      },
      theme: colors,
      themes: [],
      fonts: mirror?.fonts ?? [],
      updates: mirror?.updates ?? {
        app: { version: "", ready: null, updates: false },
        notes: [],
        core: { version: hello?.version ?? null, managed: null, ready: null, updating: false, error: null },
        checked: null,
        checks: false,
        checking: false,
      },
      settings,
      keys: mirror?.keys ?? keyBindings(files.keys),
      machines: [],
    };
    this.#cache = { model, base, look: { theme: colors, settings, fonts: clientFonts(settings) } };
    return this.#cache;
  }

  #invalidate(): void {
    this.#cache = null;
  }

  #emit(change: HerdrChange): void {
    if (this.#closed) return;
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (e) {
        this.#log(`a ${change.kind} listener failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** The model changed now; listeners hear one `state` per {@link STATE_THROTTLE_MS}. */
  #stateSoon(): void {
    this.#invalidate();
    if (this.#stateTimer !== undefined || this.#closed) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined;
      this.#emit({ kind: "state" });
    }, STATE_THROTTLE_MS);
  }

  #coreEvent(e: CoreClientEvent): void {
    if (e.type === "event" && e.kind === "doc") {
      const name = e.data.name;
      if (name === undefined || name === HERDR_APP_DOC) this.#docSoon();
      return;
    }
    if (e.type === "reset") this.#docSoon();
    this.#stateSoon();
  }

  #docSoon(): void {
    if (this.#docTimer !== undefined || this.#closed) return;
    this.#docTimer = setTimeout(() => {
      this.#docTimer = undefined;
      void this.#fetchDoc();
    }, 50);
  }

  async #fetchDoc(): Promise<void> {
    if (this.#docBusy) {
      this.#docAgain = true;
      return;
    }
    this.#docBusy = true;
    try {
      do {
        this.#docAgain = false;
        const doc = await this.#core.docGet(HERDR_APP_DOC, DOC_TIMEOUT_MS);
        if (this.#closed || sameJson(doc.value, this.#doc)) continue;
        this.#doc = doc.value;
        this.#stateSoon();
        this.#refreshRoots();
      } while (this.#docAgain && !this.#closed);
    } catch (e) {
      this.#log(`doc.get ${HERDR_APP_DOC}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      this.#docBusy = false;
    }
  }

  /** What every folder's read roots are built from. */
  #rootsInput(spaces: readonly string[]): ReadRootsInput {
    return { home: this.#o.home, appHome: this.#o.appHome, spaceFolders: spaces, cockpit: this.#files.cockpit };
  }

  /** The space folders or cockpit's install changed: every folder's read roots are resolved again on next use. */
  #refreshRoots(): void {
    const folders = spaceFolders(this.#doc);
    const cockpit = this.#files.cockpit;
    const key = JSON.stringify([folders, cockpit?.home, cockpit?.cache]);
    if (key === this.#rootsKey) return;
    this.#rootsKey = key;
    this.#policies.update(this.#rootsInput(folders));
  }

  /** The layout the Mac shows according to the mirror (fresher than `shared.json`), if it says. */
  #shown(): string | undefined {
    const name = this.#mirror?.shared?.layout;
    return typeof name === "string" ? name : undefined;
  }

  #reloadFiles(): Promise<void> {
    this.#filesBusy = this.#filesBusy.then(async () => {
      if (this.#closed) return;
      const prev = this.#files;
      const next = await loadAppFiles(this.#o.appHome, this.#log, this.#shown());
      this.#files = next;
      this.#programs = programTable(next.programs);
      this.#known = null;
      this.#invalidate();
      if (!sameJson(prev.cockpit, next.cockpit)) this.#refreshRoots();
      const layout = prev.layout.name !== next.layout.name || !sameJson(prev.layout.tree, next.layout.tree) ||
        !sameJson(prev.clicks, next.clicks);
      const rest = (f: AppFiles) => [f.settings, f.keys, f.programs, f.layouts, f.shared, [...f.themes]];
      if (layout) this.#emit({ kind: "layout" });
      if (layout || !sameJson(rest(prev), rest(next))) this.#emit({ kind: "state" });
    }).catch((e) => this.#log(`reading appHome: ${e instanceof Error ? e.message : String(e)}`));
    return this.#filesBusy;
  }

  #validMirror(s: MirrorSnapshot): MirrorSnapshot {
    const out: MirrorSnapshot = {};
    const keep = <K extends keyof MirrorSnapshot>(key: K, ok: (v: unknown) => boolean) => {
      if (s[key] === undefined) return;
      if (ok(s[key])) out[key] = s[key];
      else this.#log(`mirror: ${key} is not valid; ignored`);
    };
    const list = (schema: Schema<unknown>) => (v: unknown) => Array.isArray(v) && v.every((x) => is(schema, x));
    keep("theme", (v) => isObject(v) && Object.values(v).every((c) => typeof c === "string"));
    keep("settings", isObject);
    keep("fonts", (v) => Array.isArray(v) && v.every((f) => typeof f === "string"));
    keep("focused", (v) => v === null || is(FocusedSchema, v));
    keep("panes", list(PaneInfoSchema));
    keep("shared", (v) => is(SharedSchema, v));
    keep("commands", list(CommandInfoSchema));
    keep("keys", list(KeyBindingInfoSchema));
    keep("updates", (v) => is(UpdatesInfoSchema, v));
    keep("window", (v) => is(WindowInfoSchema, v));
    return out;
  }
}

/** `keys()` from keys.json: `{section, keys, action}` per binding (an object action by its `command`). */
function keyBindings(file: JsonObject): KeyBindingInfo[] {
  const out: KeyBindingInfo[] = [];
  for (const [section, map] of Object.entries(file)) {
    if (!isObject(map)) continue;
    for (const [keys, action] of Object.entries(map)) {
      const name = typeof action === "string" ? action : isObject(action) ? action.command : null;
      if (typeof name === "string" && name !== "") out.push({ section, keys, action: name });
    }
  }
  return out;
}

/** Whether `program` exists as a file: by path, or in a `PATH` folder the bridge may read. */
async function onPath(program: string, path: string): Promise<boolean> {
  const candidates = program.includes("/")
    ? [program]
    : path.split(":").filter((d) => d.startsWith("/")).map((d) => join(d, program));
  for (const c of candidates) {
    const st = await Deno.stat(c).catch(() => null);
    if (st?.isFile) return true;
  }
  return false;
}
