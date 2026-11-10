/**
 * Mod host supervisor (DESIGN-v2 §1.1–§1.7; AMENDMENTS-c1 §T05, §T06). One unprivileged `deno run` per mod folder,
 * started under the platform's sandbox provider (`sandbox.ts`; on macOS Seatbelt, `seatbelt.ts`) as
 *
 *   sandbox-exec -f <run>/seatbelt/<folder>.sb <deno> run --no-prompt --no-remote --no-npm --no-lock \
 *     --config=<modhost>/deno.json --allow-read=<folder>,<modhost> --allow-net=127.0.0.1:<ctlPort> \
 *     --v8-flags=--max-old-space-size=256 <modhost>/src/main.js <ctlPort> <folder>
 *
 * with the mod folder (real path) as working directory, a cleared environment (`DENO_DIR=<run>/deno-dir/<folder>`, fresh
 * per spawn; `NO_COLOR=1`; `TZ`), the spawn's token as the only stdin line, and stdout/stderr forwarded to the log.
 *
 * Copies drive the lifecycle: the first `create` of a folder's copy starts its host; a folder left without copies is
 * stopped after 30 s. Start: realpath, symlink audit (a refused folder does not start), profile, spawn, `hello`
 * (≤ 5 s), `boot`, `loaded` (≤ 10 s), then `create` of every copy with its persisted `localStorage`. Running: `ping`
 * every 2 s; no `pong` for 3 ping intervals → SIGKILL; heap over 200 MiB → restart when idle. Any exit nobody asked
 * for (crash, OOM exit 133, self-kill, watchdog) restarts after 0 s, 1 s, 5 s, 30 s; more than 5 within 10 min →
 * `failed`, retried every 5 min. A change in the mod folder (500 ms debounce) restarts the host gracefully and clears
 * that history. `state` pushes are debounced (16 ms).
 *
 * Trust: every message is attributed to the folder of the connection it arrived on; a `copy` of another folder is
 * logged `forged-<t>-ignored` and dropped. `storage.set` is answered here; every other RPC goes to `handlers.rpc`.
 */

import { join, toFileUrl } from "@std/path";
import {
  type Boot,
  BootSchema,
  type BridgeToHost,
  CONTROL_PING_INTERVAL_MS,
  copyBelongsTo,
  type Create,
  type Created,
  type Emit,
  type EventResult,
  type HostError,
  type HostState,
  type HostStatus,
  type HostToBridge,
  type JsonObject,
  type JsonValue,
  type Origin,
  parseCopyId,
  type Placement,
  type Pong,
  type Rpc,
  type RpcResult,
  StorageMapSchema,
  type Tree,
  validate,
  type ValidationError,
} from "@herdr-relay/protocol";
import { messageOf } from "../core/errors.ts";
import { hostPlatform } from "../platform.ts";
import { logDecision, type PolicyLog } from "../policy/decision.ts";
import { resolveAllowedCommand } from "../policy/spawn.ts";
import { symlinkAudit, symlinkAuditMessage } from "../policy/symlink.ts";
import { type ControlConnection, type ControlPeer, ControlServer, mintToken } from "./control.ts";
import type { Sandbox, SandboxRun } from "./sandbox.ts";
import { FolderStorage, StorageRefusal } from "./storage.ts";

/** Timeouts, intervals and thresholds of the lifecycle (DESIGN-v2 §1.6). */
export interface SupervisorLimits {
  /** A spawned host must authenticate within this long. */
  helloMs: number;
  /** After `boot`, the mod's main.js must load within this long. */
  loadedMs: number;
  /** `ping` interval once loaded. */
  pingMs: number;
  /** No `pong` for this many ping intervals → SIGKILL. */
  missedPongs: number;
  /** `pong.heap` above this many bytes → restart at the next idle ping. */
  heapBytes: number;
  /** Delay before the 1st, 2nd, 3rd and every later restart within the crash window. */
  backoffMs: readonly number[];
  crashWindowMs: number;
  /** More unrequested exits than this within the window → `failed`. */
  maxExits: number;
  /** A `failed` folder is tried again after this long. */
  failedRetryMs: number;
  /** Quiet time after a change in the mod folder before the host restarts. */
  folderDebounceMs: number;
  stateDebounceMs: number;
  /** `exit` → SIGKILL after this long. */
  exitGraceMs: number;
  /** A folder without copies is stopped after this long. */
  idleStopMs: number;
  /** Failed control connections attributed to one host within a minute before it is killed and restarted. */
  rejectsPerMinute: number;
}

export const SUPERVISOR_LIMITS: Readonly<SupervisorLimits> = Object.freeze({
  helloMs: 5000,
  loadedMs: 10_000,
  pingMs: CONTROL_PING_INTERVAL_MS,
  missedPongs: 3,
  heapBytes: 200 * 1024 * 1024,
  backoffMs: [0, 1000, 5000, 30_000],
  crashWindowMs: 10 * 60_000,
  maxExits: 5,
  failedRetryMs: 5 * 60_000,
  folderDebounceMs: 500,
  stateDebounceMs: 16,
  exitGraceMs: 2000,
  idleStopMs: 30_000,
  rejectsPerMinute: 20,
});

/** The V8 heap cap of a host, MiB (an isolate over it aborts the process with exit 133). */
export const HOST_HEAP_MIB = 256;
/** Longest host stdout/stderr line kept in the log. */
const LOG_LINE_MAX = 2000;
/** Longest device-visible reason taken from a host's load error. */
const REASON_MAX = 300;

/** One host process of a folder; `generation` grows with every spawn (handler ids and trees of older ones are void). */
export interface HostRef {
  folder: string;
  generation: number;
}

export interface HostExit {
  code: number;
  signal: Deno.Signal | null;
  /** Why it ended, safe to show on a device. */
  reason: string;
}

/** Where host messages go. Every callback is optional; a throwing callback is logged and does not affect the host. */
export interface HostHandlers {
  /** A folder's lifecycle state changed (`starting` → `running`, `restarting`, `failed` with a reason, `stopped`). */
  status?(status: HostStatus): void;
  /** A host loaded the mod and its copies are being created again: earlier trees and handler ids are void. */
  started?(host: HostRef): void;
  exited?(host: HostRef, exit: HostExit): void;
  created?(host: HostRef, msg: Created): void;
  /** A validated render of one copy of this folder. */
  tree?(host: HostRef, msg: Tree): void;
  emit?(host: HostRef, msg: Emit): void;
  /** Answers an RPC (all but `storage.set`): its value (`undefined` = none) or a rejection, sent as `rpc-result`. */
  rpc?(host: HostRef, msg: Rpc): Promise<JsonValue | undefined> | JsonValue | undefined;
  eventResult?(host: HostRef, msg: EventResult): void;
  /** A host or mod failure; also a `tree` that failed validation (`where: "tree"`). Not path-stripped. */
  error?(host: HostRef, msg: HostError): void;
}

export interface SupervisorOptions {
  /** `<appHome>`; mod folders are `<appHome>/mods/<folder>`. */
  appHome: string;
  /** `<repo>/packages/modhost`. */
  modhost: string;
  /**
   * `<run>` (0700, created and removed by the bridge): sandbox files in `<run>/<subdir>` (Seatbelt: profiles in
   * `<run>/seatbelt`), DENO_DIRs in `<run>/deno-dir`. Kept as given for the bridge's own file operations (Deno's
   * permission lists are lexical: `$TMPDIR/herdr-relay` does not cover `/private/var/folders/…`); its real path is used
   * only where the kernel checks it (profile, host DENO_DIR).
   */
  run: string;
  /** `<state>`: `localStorage` is persisted in `<state>/storage/<folder>.json`. */
  stateDir: string;
  /** The full `HostState` of one folder, for `boot` and every `state` push. */
  stateFor(folder: string): HostState;
  handlers?: HostHandlers;
  /**
   * The hosts' kernel sandbox; the host platform's provider when absent (an error where the platform has none).
   * `null` runs hosts unconfined: only for `HERDR_RELAY_DEV=insecure-no-sandbox`, which the caller checks (it also
   * disables pairing).
   */
  sandbox?: Sandbox | null;
  /** Receives the symlink-audit and `storage.set` decisions. */
  policyLog?: PolicyLog;
  /** The id of the policy profile governing a folder (OSS-PLAN §1): `HostStatus.profile` and its policy records. */
  profileOf?(folder: string): string;
  log?: (message: string) => void;
  /** `TZ` of the hosts; the bridge's own zone when absent. */
  timeZone?: string;
  limits?: Partial<SupervisorLimits>;
}

/** A snapshot of one folder's host, for diagnostics and tests. */
export interface HostInfo {
  status: HostStatus;
  /** Process id of the current host (`sandbox-exec` execs deno, so it is deno's), or null. */
  pid: number | null;
  generation: number;
  copies: string[];
}

interface Context {
  readonly appHome: string;
  readonly modhost: string;
  /** `<run>` as given: every file operation of the bridge itself. */
  readonly run: string;
  /** Real path of `<run>`: what the sandbox checks and what the host is given. */
  readonly runReal: string;
  readonly stateDir: string;
  /** The provider prepared for this run; `null` = unconfined (`insecure-no-sandbox`). */
  readonly sandbox: SandboxRun | null;
  readonly timeZone: string;
  readonly limits: SupervisorLimits;
  readonly handlers: HostHandlers;
  readonly policyLog: PolicyLog | null;
  profileOf(folder: string): string | undefined;
  readonly control: ControlServer;
  /** Absolute roots → device-safe labels (longest first). */
  readonly redactions: readonly (readonly [string, string])[];
  stateFor(folder: string): HostState;
  log(message: string): void;
  stateVersion: number;
  stopped: boolean;
}

type Timer = ReturnType<typeof setTimeout>;

interface CopySpec {
  props: JsonObject;
  placement: Placement | null;
}

/** Why the supervisor ended a host; `kill` and an unrequested exit count towards `failed`. */
type Ending =
  | { kind: "stop" }
  | { kind: "restart"; reason: string }
  | { kind: "kill"; reason: string }
  | { kind: "load-failed"; reason: string };

interface Instance {
  readonly generation: number;
  readonly child: Deno.ChildProcess;
  readonly pid: number;
  readonly mainUrl: string;
  readonly exited: Promise<void>;
  conn: ControlConnection | null;
  phase: "hello" | "boot" | "running";
  ending: Ending | null;
  done: boolean;
  /** `hello`/`loaded` deadline, then the watchdog. */
  deadline: Timer | undefined;
  pinger: ReturnType<typeof setInterval> | undefined;
  grace: Timer | undefined;
  linger: Timer | undefined;
  pingN: number;
  /** Ping number → when it was sent. */
  pingSent: Map<number, number>;
  /** When the host was last known to run its event loop: the send time of the newest answered ping. */
  aliveAt: number;
  /** RPCs and events not answered yet. */
  inflight: number;
  heapHigh: boolean;
  stateVersion: number;
}

/** A folder the supervisor will not start; the message is the device-visible reason. */
class LaunchRefusal extends Error {}

/** The host platform's provider, for a supervisor created without `sandbox`; never silently unconfined. */
function platformSandbox(): Sandbox {
  const platform = hostPlatform();
  if (platform.sandbox === null) {
    throw new Error(`${platform.label} has no mod-host sandbox; pass sandbox: null to run hosts unconfined`);
  }
  return platform.sandbox;
}

const encoder = new TextEncoder();
const NO_PEER: ControlPeer = { message() {}, invalid() {}, closed() {} };

function describeExit(s: Deno.CommandStatus): string {
  if (s.signal === "SIGTRAP" || s.code === 133) {
    return `exited with code ${s.code} (V8 fatal error, e.g. out of memory)`;
  }
  if (s.signal !== null) return `killed by ${s.signal}`;
  return `exited with code ${s.code}`;
}

const errorsText = (errors: readonly ValidationError[]) =>
  errors.slice(0, 3).map((e) => `${e.path || "/"}: ${e.message}`).join("; ");

/** Forwards a host's stdout/stderr to the log line by line; never parsed as protocol (mods can write them). */
async function pipeLines(stream: ReadableStream<Uint8Array>, emit: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  const clip = (line: string) => (line.length > LOG_LINE_MAX ? `${line.slice(0, LOG_LINE_MAX)}…` : line);
  let pending = "";
  try {
    for await (const chunk of stream) {
      const parts = (pending + decoder.decode(chunk, { stream: true })).split("\n");
      pending = parts.pop() ?? "";
      for (const line of parts) emit(clip(line));
      if (pending.length > LOG_LINE_MAX) {
        emit(clip(pending));
        pending = "";
      }
    }
  } catch {
    // the process is gone
  }
  if (pending !== "") emit(clip(pending));
}

/** Supervises the mod hosts of one bridge run. */
export class HostSupervisor {
  readonly #ctx: Context;
  readonly #hosts = new Map<string, FolderHost>();
  #stateTimer: Timer | undefined;

  private constructor(
    options: SupervisorOptions,
    paths: { appHome: string; modhost: string; run: string; runReal: string },
    sandbox: SandboxRun | null,
  ) {
    const log = options.log ?? ((message: string) => console.error(`herdr-relay hosts: ${message}`));
    const control = ControlServer.listen({
      log: (message) => log(`control: ${message}`),
      rejected: (folder) => {
        if (folder !== null) this.#hosts.get(folder)?.noteRejected();
      },
      folderOfPid: (pid) => {
        for (const host of this.#hosts.values()) if (host.pid === pid) return host.folder;
        return null;
      },
    });
    const redactions: [string, string][] = [
      [toFileUrl(paths.appHome).href + "/", ""],
      [paths.appHome + "/", ""],
      [toFileUrl(paths.modhost).href + "/", "modhost/"],
      [paths.modhost + "/", "modhost/"],
      [paths.run + "/", "run/"],
      [paths.runReal + "/", "run/"],
    ];
    redactions.sort((a, b) => b[0].length - a[0].length);
    this.#ctx = {
      ...paths,
      stateDir: options.stateDir,
      sandbox,
      timeZone: options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      limits: { ...SUPERVISOR_LIMITS, ...options.limits },
      handlers: options.handlers ?? {},
      policyLog: options.policyLog ?? null,
      profileOf: (folder) => options.profileOf?.(folder),
      control,
      redactions,
      stateFor: options.stateFor,
      log,
      stateVersion: 0,
      stopped: false,
    };
  }

  /**
   * Resolves the mod-host paths (real; `<run>` is kept as given besides), prepares the sandbox provider (Seatbelt:
   * measures the deno runtime and loads the profile template), then listens.
   */
  static async create(options: SupervisorOptions): Promise<HostSupervisor> {
    const [appHome, modhost, runReal] = await Promise.all(
      [options.appHome, options.modhost, options.run].map((p) => Deno.realPath(p)),
    );
    const sandbox = options.sandbox === undefined ? platformSandbox() : options.sandbox;
    const prepared = sandbox === null ? null : await sandbox.prepare(options.run);
    return new HostSupervisor(options, { appHome, modhost, run: options.run, runReal }, prepared);
  }

  /** The control port on 127.0.0.1. */
  get port(): number {
    return this.#ctx.control.port;
  }

  /** Every folder seen so far with its lifecycle state. */
  statuses(): HostStatus[] {
    return [...this.#hosts.values()].map((h) => ({ ...h.status }));
  }

  info(folder: string): HostInfo | null {
    const host = this.#hosts.get(folder);
    return host
      ? { status: { ...host.status }, pid: host.pid, generation: host.generation, copies: [...host.copies.keys()] }
      : null;
  }

  /**
   * Registers a copy (`<folder>:<blockId>`, `<folder>:overlay:<id>`, `<folder>:pane:<id>`) and creates it in its
   * folder's host — now when the host runs, else as soon as it has loaded (also after every restart). Starts the
   * host when needed. Registering an existing copy creates it again with the new props.
   */
  create(copy: string, props: JsonObject = {}, placement: Placement | null = null): void {
    if (this.#ctx.stopped) throw new Error("the host supervisor is stopped");
    const ref = parseCopyId(copy);
    if (ref === null) throw new TypeError(`not a copy id: ${JSON.stringify(copy)}`);
    let host = this.#hosts.get(ref.folder);
    if (!host) {
      host = new FolderHost(ref.folder, this.#ctx);
      this.#hosts.set(ref.folder, host);
    }
    host.addCopy(copy, { props, placement });
  }

  /** Forgets a copy and closes it in its host. False when it was not registered. */
  close(copy: string): boolean {
    return this.#hostOf(copy)?.removeCopy(copy) ?? false;
  }

  /** Asks for a render now. False when the copy's host is not running. */
  render(copy: string): boolean {
    return this.#hostOf(copy)?.send({ t: "render", copy }) ?? false;
  }

  /**
   * Delivers a device event to a copy's handler of render `n` (`tree.n`; the host refuses it unrun when that is not
   * the copy's latest render). False when its host is not running (`ack host-down`).
   */
  event(copy: string, handler: number, args: JsonValue[], origin: Origin, n?: number): boolean {
    const render = n === undefined ? {} : { n };
    return this.#hostOf(copy)?.send({ t: "event", copy, handler, args, origin, ...render }) ?? false;
  }

  /** Delivers a command to a copy's `nextCommand()`. False when its host is not running. */
  command(copy: string, command: string, origin: Origin): boolean {
    return this.#hostOf(copy)?.send({ t: "command", copy, command, origin }) ?? false;
  }

  /** Sends one shared key to every host now (each folder's next `stateFor` must include it too). */
  shared(key: string, value: JsonValue): void {
    for (const host of this.#hosts.values()) host.send({ t: "shared", key, value }, false);
  }

  /** Something `stateFor` returns changed: every host gets a full `state`, debounced. */
  stateChanged(): void {
    this.#ctx.stateVersion++;
    if (this.#stateTimer !== undefined || this.#ctx.stopped) return;
    this.#stateTimer = setTimeout(() => {
      this.#stateTimer = undefined;
      for (const host of this.#hosts.values()) host.pushState();
    }, this.#ctx.limits.stateDebounceMs);
  }

  /** Restarts a folder's host now (also out of `failed`), clearing its exit history. */
  restart(folder: string): void {
    this.#hosts.get(folder)?.restart("restart requested");
  }

  /** Bridge exit: `exit` to every host, SIGKILL after the grace time, storage flushed, profiles and DENO_DIRs removed. */
  async stop(): Promise<void> {
    if (this.#ctx.stopped) return;
    this.#ctx.stopped = true;
    clearTimeout(this.#stateTimer);
    this.#stateTimer = undefined;
    const hosts = [...this.#hosts.values()];
    await Promise.all(hosts.map((h) => h.stop()));
    this.#ctx.control.close();
    await Promise.all(hosts.map((h) => h.flushStorage()));
    for (const sub of [...(this.#ctx.sandbox ? [this.#ctx.sandbox.subdir] : []), "deno-dir"]) {
      await Deno.remove(join(this.#ctx.run, sub), { recursive: true }).catch((e) => {
        if (!(e instanceof Deno.errors.NotFound)) this.#ctx.log(`cannot remove ${sub}: ${messageOf(e)}`);
      });
    }
  }

  #hostOf(copy: string): FolderHost | null {
    const host = this.#hosts.get(parseCopyId(copy)?.folder ?? "");
    return host && host.copies.has(copy) ? host : null;
  }
}

/** The host of one mod folder across restarts. */
class FolderHost {
  readonly folder: string;
  readonly copies = new Map<string, CopySpec>();
  status: HostStatus;
  readonly #ctx: Context;
  #instance: Instance | null = null;
  #generation = 0;
  #exits: number[] = [];
  #rejects: number[] = [];
  #wanted = false;
  #launching: Promise<void> | null = null;
  #retry: Timer | undefined;
  #idle: Timer | undefined;
  #watcher: Deno.FsWatcher | null = null;
  #watchTimer: Timer | undefined;
  #storage: FolderStorage | null = null;

  constructor(folder: string, ctx: Context) {
    this.folder = folder;
    this.#ctx = ctx;
    const profile = ctx.profileOf(folder);
    this.status = profile === undefined ? { folder, state: "stopped" } : { folder, state: "stopped", profile };
  }

  get pid(): number | null {
    return this.#instance?.pid ?? null;
  }

  get generation(): number {
    return this.#generation;
  }

  addCopy(copy: string, spec: CopySpec): void {
    const again = this.copies.has(copy);
    this.copies.set(copy, spec);
    this.#cancelIdle();
    const inst = this.#instance;
    if (inst && this.#connOf(inst, true)) {
      if (again) inst.conn?.send({ t: "close", copy });
      this.#sendCreate(inst, copy, spec);
    }
    if (!this.#wanted) {
      this.#wanted = true;
      void this.#launch();
    }
  }

  removeCopy(copy: string): boolean {
    if (!this.copies.delete(copy)) return false;
    this.send({ t: "close", copy });
    if (this.copies.size === 0) this.#scheduleIdle();
    return true;
  }

  /** Sends to the current host: once it has loaded, or (`running` false) once it has been booted. */
  send(msg: BridgeToHost, running = true): boolean {
    const inst = this.#instance;
    const conn = inst ? this.#connOf(inst, running) : null;
    if (conn === null || !conn.send(msg)) return false;
    if (msg.t === "event") inst!.inflight++;
    return true;
  }

  pushState(): void {
    const inst = this.#instance;
    const conn = inst ? this.#connOf(inst, false) : null;
    if (inst === null || conn === null) return;
    let state: HostState;
    try {
      state = this.#ctx.stateFor(this.folder);
    } catch (e) {
      this.#ctx.log(`${this.folder}: stateFor failed: ${messageOf(e)}`);
      return;
    }
    const version = this.#ctx.stateVersion;
    if (conn.send({ t: "state", state })) inst.stateVersion = version;
  }

  restart(reason: string): void {
    if (!this.#wanted || this.#ctx.stopped) return;
    this.#ctx.log(`${this.folder}: ${reason}; restarting`);
    this.#exits = [];
    const inst = this.#instance;
    if (inst) {
      this.#setStatus("restarting", reason);
      this.#end(inst, { kind: "restart", reason }, true);
    } else if (this.#launching === null) {
      this.#clearRetry();
      void this.#launch();
    }
  }

  /** A failed control connection was attributed to this folder (S18). */
  noteRejected(): void {
    const now = Date.now();
    this.#rejects = this.#rejects.filter((t) => now - t < 60_000);
    this.#rejects.push(now);
    const limit = this.#ctx.limits.rejectsPerMinute;
    if (this.#rejects.length >= limit && this.#instance) {
      this.#rejects = [];
      this.#end(this.#instance, { kind: "kill", reason: `${limit} failed control connections within a minute` }, false);
    }
  }

  async stop(): Promise<void> {
    this.#wanted = false;
    this.#cancelIdle();
    this.#clearRetry();
    this.#unwatch();
    await this.#launching;
    const inst = this.#instance;
    if (inst) {
      this.#end(inst, { kind: "stop" }, true);
      await inst.exited;
    } else {
      this.#setStatus("stopped");
    }
  }

  async flushStorage(): Promise<void> {
    await this.#storage?.flush();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Start.

  #launch(): Promise<void> {
    if (this.#launching || this.#instance || !this.#wanted || this.#ctx.stopped) {
      return this.#launching ?? Promise.resolve();
    }
    this.#clearRetry();
    if (this.#generation === 0) this.#setStatus("starting");
    else if (this.status.state !== "restarting") this.#setStatus("restarting", this.status.reason);
    this.#launching = this.#spawn().then(
      (inst) => {
        if (!this.#wanted || this.#ctx.stopped) this.#end(inst, { kind: "stop" }, false);
      },
      (e) => {
        const reason = e instanceof LaunchRefusal ? e.message : `cannot start: ${messageOf(e)}`;
        this.#ctx.log(`${this.folder}: ${reason}`);
        if (this.#wanted && !this.#ctx.stopped) this.#fail(reason);
        else this.#setStatus("stopped");
      },
    ).finally(() => {
      this.#launching = null;
    });
    return this.#launching;
  }

  async #spawn(): Promise<Instance> {
    const ctx = this.#ctx;
    const folder = this.folder;
    let real: string;
    try {
      real = await Deno.realPath(join(ctx.appHome, "mods", folder));
      if (!(await Deno.stat(real)).isDirectory) throw new LaunchRefusal(`mods/${folder} is not a folder`);
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) throw new LaunchRefusal(`mods/${folder} does not exist`);
      throw e;
    }
    this.#watch(real);
    const links = await symlinkAudit(real);
    if (links.length > 0) {
      const reason = symlinkAuditMessage(links);
      if (ctx.policyLog) {
        logDecision(ctx.policyLog, {
          folder,
          method: "load",
          argv: links.map((l) => l.path),
          decision: "refuse",
          rule: "symlink",
          reason,
          profile: ctx.profileOf(folder),
        });
      }
      throw new LaunchRefusal(reason);
    }
    // Deno splits permission lists on commas.
    if (real.includes(",") || ctx.modhost.includes(",")) throw new LaunchRefusal(`mods/${folder}: a path contains ","`);
    this.#storage ??= await FolderStorage.open(ctx.stateDir, folder, ctx.log);
    // The bridge creates it through `<run>` as given; the host (and its sandbox) get its real path.
    const denoDir = join(ctx.run, "deno-dir", folder);
    const denoDirReal = join(ctx.runReal, "deno-dir", folder);
    await Deno.remove(denoDir, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
    await Deno.mkdir(denoDir, { recursive: true, mode: 0o700 });
    const port = ctx.control.port;
    const flags = [
      "run",
      "--no-prompt",
      "--no-remote",
      "--no-npm",
      "--no-lock",
      `--config=${join(ctx.modhost, "deno.json")}`,
      `--allow-read=${real},${ctx.modhost}`,
      `--allow-net=127.0.0.1:${port}`,
      `--v8-flags=--max-old-space-size=${HOST_HEAP_MIB}`,
      join(ctx.modhost, "src", "main.js"),
      String(port),
      folder,
    ];
    const { command, args } = ctx.sandbox
      ? await ctx.sandbox.command({
        name: folder,
        folder: real,
        modhost: ctx.modhost,
        denoDir: denoDirReal,
        ctlPort: port,
        denoArgs: flags,
      })
      : { command: resolveAllowedCommand("deno"), args: flags };
    const child = new Deno.Command(command, {
      args,
      cwd: real,
      clearEnv: true,
      env: { DENO_DIR: denoDirReal, NO_COLOR: "1", TZ: ctx.timeZone },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
    const inst: Instance = {
      generation: ++this.#generation,
      child,
      pid: child.pid,
      mainUrl: toFileUrl(join(real, "main.js")).href,
      exited,
      conn: null,
      phase: "hello",
      ending: null,
      done: false,
      deadline: undefined,
      pinger: undefined,
      grace: undefined,
      linger: undefined,
      pingN: 0,
      pingSent: new Map(),
      aliveAt: 0,
      inflight: 0,
      heapHigh: false,
      stateVersion: -1,
    };
    this.#instance = inst;
    const token = mintToken();
    const revoke = ctx.control.expect(token, {
      folder,
      pid: child.pid,
      accepted: (conn) => this.#accepted(inst, conn),
    });
    inst.deadline = setTimeout(() => {
      inst.deadline = undefined;
      this.#end(inst, { kind: "kill", reason: `no hello within ${ctx.limits.helloMs} ms` }, false);
    }, ctx.limits.helloMs);
    const label = `${folder}[${child.pid}]`;
    pipeLines(child.stdout, (line) => ctx.log(`${label} stdout: ${line}`));
    pipeLines(child.stderr, (line) => ctx.log(`${label} stderr: ${line}`));
    child.status.then((status) => {
      revoke();
      this.#exited(inst, status);
      markExited();
    });
    // The token goes last: the host reads it before it connects.
    try {
      const w = child.stdin.getWriter();
      await w.write(encoder.encode(`${token}\n`));
      await w.close();
    } catch {
      // the process already exited; its status handler takes over
    }
    ctx.log(`${folder}: spawned pid ${child.pid} (generation ${inst.generation})`);
    return inst;
  }

  #accepted(inst: Instance, conn: ControlConnection): ControlPeer {
    if (this.#instance !== inst || inst.ending !== null) {
      conn.close("the host is ending");
      return NO_PEER;
    }
    this.#clearDeadline(inst);
    let boot: Boot;
    try {
      boot = { t: "boot", state: this.#ctx.stateFor(this.folder), harden: true, mainUrl: inst.mainUrl };
    } catch (e) {
      this.#end(inst, { kind: "load-failed", reason: `no state for the host: ${messageOf(e)}` }, false);
      conn.close("no state");
      return NO_PEER;
    }
    const v = validate(BootSchema, boot);
    if (!v.ok) {
      this.#end(inst, { kind: "load-failed", reason: `boot is invalid: ${errorsText(v.errors)}` }, false);
      conn.close("invalid boot");
      return NO_PEER;
    }
    inst.conn = conn;
    inst.phase = "boot";
    inst.stateVersion = this.#ctx.stateVersion;
    conn.send(boot);
    const loadedMs = this.#ctx.limits.loadedMs;
    inst.deadline = setTimeout(() => {
      inst.deadline = undefined;
      this.#end(inst, { kind: "kill", reason: `main.js did not load within ${loadedMs} ms` }, false);
    }, loadedMs);
    return {
      message: (m) => this.#message(inst, m),
      invalid: (t, copy, errors) => this.#invalid(inst, t, copy, errors),
      closed: (reason) => this.#connClosed(inst, reason),
    };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Messages.

  #message(inst: Instance, m: HostToBridge): void {
    if (this.#instance !== inst) return;
    const ref: HostRef = { folder: this.folder, generation: inst.generation };
    const h = this.#ctx.handlers;
    switch (m.t) {
      case "loaded":
        if (m.error !== undefined) this.#loadFailed(inst, m.error);
        else this.#loaded(inst, ref);
        return;
      case "pong":
        return this.#pong(inst, m);
      case "rpc":
        if (this.#owns(m.copy, m.t)) this.#rpc(inst, ref, m);
        return;
      case "event-result":
        if (!this.#owns(m.copy, m.t)) return;
        inst.inflight = Math.max(0, inst.inflight - 1);
        return this.#call("eventResult", () => h.eventResult?.(ref, m));
      case "created":
        if (this.#owns(m.copy, m.t)) this.#call("created", () => h.created?.(ref, m));
        return;
      case "tree":
        if (this.#owns(m.copy, m.t)) this.#call("tree", () => h.tree?.(ref, m));
        return;
      case "emit":
        if (this.#owns(m.copy, m.t)) this.#call("emit", () => h.emit?.(ref, m));
        return;
      case "error":
        if (m.copy === null || this.#owns(m.copy, m.t)) this.#call("error", () => h.error?.(ref, m));
        return;
      case "hello":
        return;
    }
  }

  /** The trust rule: a message may only name copies of its connection's folder. */
  #owns(copy: string, t: string): boolean {
    if (copyBelongsTo(copy, this.folder)) return true;
    this.#ctx.log(`forged-${t}-ignored folder=${this.folder} copy=${JSON.stringify(copy)}`);
    return false;
  }

  #invalid(inst: Instance, t: string | null, copy: string | null, errors: readonly ValidationError[]): void {
    if (this.#instance !== inst) return;
    const summary = errorsText(errors);
    this.#ctx.log(`invalid-${t ?? "line"}-ignored folder=${this.folder}${copy ? ` copy=${copy}` : ""}: ${summary}`);
    if (t === "tree" && copy !== null && this.#owns(copy, t)) {
      const ref: HostRef = { folder: this.folder, generation: inst.generation };
      const msg: HostError = { t: "error", copy, where: "tree", error: `invalid tree: ${summary}` };
      this.#call("error", () => this.#ctx.handlers.error?.(ref, msg));
    }
  }

  #loadFailed(inst: Instance, error: string): void {
    if (inst.phase !== "boot") return;
    this.#clearDeadline(inst);
    let line = error.split("\n")[0];
    for (const [root, label] of this.#ctx.redactions) line = line.replaceAll(root, label);
    if (line.length > REASON_MAX) line = `${line.slice(0, REASON_MAX)}…`;
    this.#end(inst, { kind: "load-failed", reason: `main.js failed to load: ${line}` }, true);
  }

  #loaded(inst: Instance, ref: HostRef): void {
    if (inst.phase !== "boot" || inst.ending !== null) return;
    this.#clearDeadline(inst);
    inst.phase = "running";
    inst.aliveAt = Date.now();
    this.#setStatus("running");
    this.#call("started", () => this.#ctx.handlers.started?.(ref));
    for (const [copy, spec] of this.copies) this.#sendCreate(inst, copy, spec);
    if (inst.stateVersion !== this.#ctx.stateVersion) this.pushState();
    inst.pinger = setInterval(() => this.#tick(inst), this.#ctx.limits.pingMs);
    this.#armWatchdog(inst);
  }

  #sendCreate(inst: Instance, copy: string, spec: CopySpec): void {
    const msg: Create = { t: "create", copy, props: spec.props, placement: spec.placement };
    const storage = this.#storage?.get(copy);
    if (storage !== undefined) msg.storage = storage;
    inst.conn?.send(msg);
  }

  #tick(inst: Instance): void {
    const conn = this.#connOf(inst, true);
    if (conn === null) return;
    if (inst.heapHigh && inst.inflight === 0) {
      const mib = Math.round(this.#ctx.limits.heapBytes / 1024 / 1024);
      this.#end(inst, { kind: "kill", reason: `heap over ${mib} MiB` }, true);
      return;
    }
    const n = ++inst.pingN;
    inst.pingSent.set(n, Date.now());
    if (inst.pingSent.size > 8) inst.pingSent.delete(inst.pingSent.keys().next().value!);
    conn.send({ t: "ping", n });
  }

  /** Kills the host when it has not answered a ping for `missedPongs` intervals since it was last alive. */
  #armWatchdog(inst: Instance): void {
    this.#clearDeadline(inst);
    const limitMs = this.#ctx.limits.pingMs * this.#ctx.limits.missedPongs;
    inst.deadline = setTimeout(() => {
      inst.deadline = undefined;
      this.#end(inst, { kind: "kill", reason: `no pong for ${limitMs / 1000} s` }, false);
    }, Math.max(0, inst.aliveAt + limitMs - Date.now()));
  }

  #pong(inst: Instance, m: Pong): void {
    const sent = inst.pingSent.get(m.n);
    if (sent === undefined || inst.phase !== "running" || inst.ending !== null) return;
    for (const n of [...inst.pingSent.keys()]) if (n <= m.n) inst.pingSent.delete(n);
    if (sent > inst.aliveAt) {
      inst.aliveAt = sent;
      this.#armWatchdog(inst);
    }
    if (m.heap > this.#ctx.limits.heapBytes && !inst.heapHigh) {
      inst.heapHigh = true;
      this.#ctx.log(`${this.folder}: heap ${Math.round(m.heap / 1024 / 1024)} MiB; restarting when idle`);
    }
  }

  #rpc(inst: Instance, ref: HostRef, m: Rpc): void {
    inst.inflight++;
    const finish = (result: Omit<RpcResult, "t" | "id">) => {
      inst.inflight = Math.max(0, inst.inflight - 1);
      if (this.#instance === inst) inst.conn?.send({ t: "rpc-result", id: m.id, ...result });
    };
    if (m.method === "storage.set") return finish(this.#storageSet(m));
    const handler = this.#ctx.handlers.rpc;
    if (!handler) return finish({ ok: false, error: `${m.method} is not available` });
    Promise.try(() => handler(ref, m)).then(
      (value) => finish(value === undefined ? { ok: true } : { ok: true, value }),
      (e) => finish({ ok: false, error: messageOf(e) }),
    );
  }

  #storageSet(m: Rpc): Omit<RpcResult, "t" | "id"> {
    const decide = (decision: "allow" | "refuse", reason?: string) => {
      if (this.#ctx.policyLog) {
        logDecision(this.#ctx.policyLog, {
          folder: this.folder,
          method: m.method,
          argv: [m.copy],
          decision,
          rule: "storage",
          reason,
          session: m.origin?.session,
          profile: this.#ctx.profileOf(this.folder),
        });
      }
    };
    const v = m.args.length === 1 ? validate(StorageMapSchema, m.args[0]) : null;
    if (v === null || !v.ok) {
      const error = "storage.set expects one map of strings";
      decide("refuse", error);
      return { ok: false, error };
    }
    try {
      this.#storage!.set(m.copy, v.value);
    } catch (e) {
      if (!(e instanceof StorageRefusal)) throw e;
      decide("refuse", e.message);
      return { ok: false, error: e.message };
    }
    decide("allow");
    return { ok: true };
  }

  // -------------------------------------------------------------------------------------------------------------------
  // End.

  #connClosed(inst: Instance, reason: string | null): void {
    inst.conn = null;
    if (this.#instance !== inst || inst.ending !== null || inst.done) return;
    if (reason !== null) {
      this.#end(inst, { kind: "kill", reason: `control channel dropped: ${reason}` }, false);
      return;
    }
    // A dying process closes its socket first: give its exit status a moment to arrive.
    inst.linger = setTimeout(() => {
      inst.linger = undefined;
      this.#end(inst, { kind: "kill", reason: "closed its control channel" }, false);
    }, 250);
  }

  /** Ends a host: politely (`exit`, SIGKILL after the grace time) or at once. The first reason given stays. */
  #end(inst: Instance, ending: Ending, graceful: boolean): void {
    if (inst.done) return;
    inst.ending ??= ending;
    if (graceful && inst.grace === undefined && inst.conn?.send({ t: "exit" })) {
      inst.grace = setTimeout(() => {
        inst.grace = undefined;
        this.#kill(inst);
      }, this.#ctx.limits.exitGraceMs);
      return;
    }
    if (!graceful || inst.grace === undefined) this.#kill(inst);
  }

  #kill(inst: Instance): void {
    if (inst.done) return;
    try {
      inst.child.kill("SIGKILL");
    } catch {
      // already gone
    }
  }

  #exited(inst: Instance, status: Deno.CommandStatus): void {
    inst.done = true;
    for (const t of [inst.deadline, inst.grace, inst.linger]) clearTimeout(t);
    clearInterval(inst.pinger);
    if (this.#instance === inst) this.#instance = null;
    inst.conn?.close("the host exited");
    inst.conn = null;
    const ending = inst.ending;
    const exit = describeExit(status);
    const reason = ending !== null && ending.kind !== "stop" ? ending.reason : exit;
    this.#ctx.log(
      `${this.folder}: pid ${inst.pid} (generation ${inst.generation}) ${exit}` +
        (ending !== null ? ` [${ending.kind}${ending.kind === "stop" ? "" : `: ${ending.reason}`}]` : ""),
    );
    const ref: HostRef = { folder: this.folder, generation: inst.generation };
    this.#call("exited", () => this.#ctx.handlers.exited?.(ref, { code: status.code, signal: status.signal, reason }));
    if (!this.#wanted || this.#ctx.stopped) {
      this.#setStatus("stopped");
      return;
    }
    switch (ending?.kind) {
      case "stop":
      case "restart":
        void this.#launch();
        return;
      case "load-failed":
        this.#fail(ending.reason);
        return;
      default:
        this.#crashed(reason);
    }
  }

  #crashed(reason: string): void {
    const { backoffMs, crashWindowMs, maxExits } = this.#ctx.limits;
    const now = Date.now();
    this.#exits = this.#exits.filter((t) => now - t < crashWindowMs);
    this.#exits.push(now);
    const count = this.#exits.length;
    if (count > maxExits) {
      this.#fail(`${reason} (${count} exits within ${Math.round(crashWindowMs / 60_000)} min)`);
      return;
    }
    this.#setStatus("restarting", reason);
    this.#clearRetry();
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#launch();
    }, backoffMs[Math.min(count, backoffMs.length) - 1]);
  }

  #fail(reason: string): void {
    this.#setStatus("failed", reason);
    this.#clearRetry();
    this.#retry = setTimeout(() => {
      this.#retry = undefined;
      void this.#launch();
    }, this.#ctx.limits.failedRetryMs);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Folder watch, idle stop, helpers.

  /**
   * Restarts the host after changes in its folder (debounced). Deno.watchFs on macOS reports nothing for a newly created
   * symlink (measured with Deno 2.9.8); such a link is denied by Seatbelt at runtime and refused by the audit at the next
   * restart.
   */
  #watch(real: string): void {
    if (this.#watcher !== null || !this.#wanted || this.#ctx.stopped) return;
    let watcher: Deno.FsWatcher;
    try {
      watcher = Deno.watchFs(real, { recursive: true });
    } catch (e) {
      this.#ctx.log(`${this.folder}: cannot watch the mod folder: ${messageOf(e)}`);
      return;
    }
    this.#watcher = watcher;
    (async () => {
      try {
        for await (const event of watcher) {
          if (event.kind === "access") continue;
          clearTimeout(this.#watchTimer);
          this.#watchTimer = setTimeout(() => {
            this.#watchTimer = undefined;
            this.restart("mod folder changed");
          }, this.#ctx.limits.folderDebounceMs);
        }
      } catch (e) {
        if (this.#watcher === watcher) this.#ctx.log(`${this.folder}: folder watch ended: ${messageOf(e)}`);
      }
      if (this.#watcher === watcher) this.#watcher = null;
    })();
  }

  #unwatch(): void {
    const watcher = this.#watcher;
    this.#watcher = null;
    try {
      watcher?.close();
    } catch {
      // already closed
    }
    clearTimeout(this.#watchTimer);
    this.#watchTimer = undefined;
  }

  #scheduleIdle(): void {
    this.#cancelIdle();
    this.#idle = setTimeout(() => {
      this.#idle = undefined;
      if (this.copies.size === 0) void this.stop();
    }, this.#ctx.limits.idleStopMs);
  }

  #cancelIdle(): void {
    clearTimeout(this.#idle);
    this.#idle = undefined;
  }

  #clearRetry(): void {
    clearTimeout(this.#retry);
    this.#retry = undefined;
  }

  #clearDeadline(inst: Instance): void {
    clearTimeout(inst.deadline);
    inst.deadline = undefined;
  }

  /** The instance's open connection: after `loaded` (`running`) or after `boot`; null while it ends. */
  #connOf(inst: Instance, running: boolean): ControlConnection | null {
    if (inst.ending !== null || inst.conn === null || inst.conn.closed) return null;
    if (running ? inst.phase !== "running" : inst.phase === "hello") return null;
    return inst.conn;
  }

  #setStatus(state: HostStatus["state"], reason?: string): void {
    if (state === this.status.state && reason === this.status.reason) return;
    const status: HostStatus = { folder: this.folder, state };
    if (reason !== undefined) status.reason = reason;
    const profile = this.#ctx.profileOf(this.folder);
    if (profile !== undefined) status.profile = profile;
    this.status = status;
    this.#call("status", () => this.#ctx.handlers.status?.({ ...status }));
  }

  #call(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.#ctx.log(`${this.folder}: handlers.${what} failed: ${messageOf(e)}`);
    }
  }
}
