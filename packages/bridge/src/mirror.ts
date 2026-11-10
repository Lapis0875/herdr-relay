/**
 * The mirror endpoint (DESIGN-v2 T12, decision D5): what the `herdr-relay-mirror` mod (repo-root
 * `mods/herdr-relay-mirror/`) reports from inside the Herdr window — the only exact source of Herdr's built-in theme
 * palettes, the Mac's focus and zoom, and the live `shared` map.
 *
 * - `POST <mount>/mirror` (loopback token only: a tailnet request is refused even from a paired device): a JSON object
 *   of at most {@link MIRROR_BODY_MAX_BYTES} with `relayMod` (the mod's version) and any of `theme`, `settings`,
 *   `fonts`, `layout`, `focused`, `panes`, `updates`, `window`, `commands`, `keys`, `shared` — the values of the
 *   same-named `herdr` functions, `shared` holding every key. Validated against the protocol schemas
 *   ({@link MIRROR_POST_SCHEMA}); one invalid field rejects the whole body (400 with JSON Pointers). Unknown keys are
 *   ignored (a newer mod). A body equal to the last one only refreshes freshness.
 * - `GET <mount>/mirror` (loopback token only): {@link MirrorStatus}, the staleness marker.
 * - Freshness: a POST makes the mirror `fresh`; without one for {@link MIRROR_STALE_MS} it is `stale` (the window is
 *   closed, the layout shown has no mirror, or the mod is gone). Stale keeps only the look facts
 *   ({@link RETAINED_WHEN_STALE}) — DESIGN.md §1.3 gap 1's "last cached snapshot" fallback for a closed window; the
 *   window's own state (focus, panes, `shared`, `window()`) falls back to the core document and `shared.json`.
 * - Cache: each accepted change is written atomically to `<appHome>/data/herdr-relay/mirror.json`
 *   ({@link MirrorCacheFile}, 0600). The next start reads it as `stale`: freshness needs a POST to this run (the mod
 *   re-sends at least every 15 s). A cache that cannot be written (`HERDR_APP_HOME` outside the bridge's
 *   `--allow-write`, OSS-PLAN G18) is logged once and skipped.
 * - Discovery: `<state>/mirror-endpoint.json` = {@link MirrorEndpointFile} (0600) while the bridge runs, removed on
 *   stop, so the mod finds the bridge on any `HERDR_RELAY_PORT`; the mod reads the loopback token from `<state>/token`.
 * - Handshake (OSS-PLAN §5 upgrade path, T44): an accepted `relayMod` older than the copy this bridge ships
 *   ({@link BUNDLED_RELAY_MOD}, the repo's `mods/herdr-relay-mirror/mod.json`) is logged on the Mac and handed to
 *   `onOutdated` (the session layer toasts the connected devices), once per distinct reported version; the remedy is
 *   `herdr-relay install-mod`. The status and the POST answer carry `bundledMod` and `outdated`.
 *
 * `layout` is validated and cached (T46 compatibility evidence) but not fed to {@link MirrorSink}: the bridge's
 * layout comes from `layouts/` and `.state/` files, where the device recomposition reads its clicks.
 */

import {
  type CommandInfo,
  CommandInfoSchema,
  definition,
  type Focused,
  FocusedSchema,
  type JsonObject,
  type KeyBindingInfo,
  KeyBindingInfoSchema,
  type LayoutNode,
  LayoutNodeSchema,
  type PaneInfo,
  PaneInfoSchema,
  SharedSchema,
  type UpdatesInfo,
  UpdatesInfoSchema,
  validateJson,
  type ValidationError,
  type WindowInfo,
  WindowInfoSchema,
} from "@herdr-relay/protocol";
import { join } from "@std/path";
import mirrorMod from "../../../mods/herdr-relay-mirror/mod.json" with { type: "json" };
import { compareVersions } from "./compat/pins.ts";
import { messageOf } from "./core/errors.ts";
import type { MirrorSnapshot } from "./herdr/mod.ts";
import { BodyError, json, readJsonObject, type Route, text } from "./server/mod.ts";

/** Mount-relative path of the endpoint. */
export const MIRROR_PATH = "/mirror";
/** Without a POST for this long the mirror is stale. The mod re-sends an unchanged snapshot every 5–15 s. */
export const MIRROR_STALE_MS = 30_000;
/** Largest POST body (a real snapshot is ~100 KB: commands, keys, fonts, layout, shared, release notes). */
export const MIRROR_BODY_MAX_BYTES = 1024 * 1024;
/** `<appHome>`-relative folder of the snapshot cache. */
export const MIRROR_CACHE_DIR = "data/herdr-relay";
/** The snapshot cache, in {@link MIRROR_CACHE_DIR}. */
export const MIRROR_CACHE_FILE = "mirror.json";
/** `<state>`-relative discovery file the mod reads. */
export const MIRROR_ENDPOINT_FILE = "mirror-endpoint.json";
/** What the mod's `relayMod` must look like (its `mod.json` version). */
export const RELAY_MOD_PATTERN = "^[0-9]+\\.[0-9]+\\.[0-9]+(-[0-9A-Za-z.-]+)?$";
/**
 * The mirror mod version this bridge ships (`mods/herdr-relay-mirror/mod.json`, a static import: the bridge's
 * `--allow-read` does not cover `mods/`). `herdr-relay install-mod` installs that copy.
 */
export const BUNDLED_RELAY_MOD: string = mirrorMod.version;
/** Snapshot fields kept while the mirror is stale: Herdr's look and lists, not the window's own state. */
export const RETAINED_WHEN_STALE = ["theme", "settings", "fonts", "commands", "keys", "updates"] as const;
/** Validation errors one 400 response lists. */
const MAX_REPORTED_ERRORS = 20;

/** The POST body (and the cached snapshot). */
export interface MirrorPost {
  relayMod: string;
  theme?: Record<string, string>;
  settings?: JsonObject;
  fonts?: string[];
  layout?: LayoutNode;
  focused?: Focused | null;
  panes?: PaneInfo[];
  updates?: UpdatesInfo;
  window?: WindowInfo;
  commands?: CommandInfo[];
  keys?: KeyBindingInfo[];
  shared?: JsonObject;
}

const list = (items: JsonObject, maxItems: number): JsonObject => ({ type: "array", items, maxItems });

/** {@link MirrorPost} as a JSON Schema over the protocol's registered definitions (`validateJson` + `definition`). */
export const MIRROR_POST_SCHEMA: JsonObject = {
  type: "object",
  required: ["relayMod"],
  properties: {
    relayMod: { type: "string", maxLength: 64, pattern: RELAY_MOD_PATTERN },
    theme: { type: "object", additionalProperties: { type: "string", maxLength: 256 } },
    // Any JSON object (`Shared` is `record(JsonValue)`).
    settings: SharedSchema.json,
    fonts: list({ type: "string", maxLength: 1024 }, 65_536),
    layout: LayoutNodeSchema.json,
    focused: { anyOf: [FocusedSchema.json, { type: "null" }] },
    panes: list(PaneInfoSchema.json, 65_536),
    updates: UpdatesInfoSchema.json,
    window: WindowInfoSchema.json,
    commands: list(CommandInfoSchema.json, 65_536),
    keys: list(KeyBindingInfoSchema.json, 65_536),
    shared: SharedSchema.json,
  },
};

/** The staleness marker (`GET <mount>/mirror`). */
export interface MirrorStatus {
  /** `none`: never reported (no cache); `fresh`: a POST within {@link MIRROR_STALE_MS}; `stale`: older or cached. */
  state: "none" | "fresh" | "stale";
  /** When the snapshot in use arrived (ISO 8601), or null. */
  receivedAt: string | null;
  /** The reporting mod's version, or null. */
  relayMod: string | null;
  /** {@link BUNDLED_RELAY_MOD}. */
  bundledMod: string;
  /** Whether `relayMod` is older than `bundledMod` (`herdr-relay install-mod` updates it); false without one. */
  outdated: boolean;
  staleAfterMs: number;
}

/** `<appHome>/data/herdr-relay/mirror.json`. */
export interface MirrorCacheFile {
  v: 1;
  receivedAt: string;
  snapshot: MirrorPost;
}

/** `<state>/mirror-endpoint.json`: where the running bridge listens (the mod builds `http://127.0.0.1:<port>`). */
export interface MirrorEndpointFile {
  v: 1;
  port: number;
  pid: number;
}

/** Where accepted snapshots go ({@link HerdrSource} satisfies it). */
export interface MirrorSink {
  mirror(snapshot: MirrorSnapshot | null): void;
}

export interface MirrorEndpointOptions {
  /** `<appHome>` as configured (lexical): the cache lives under it. */
  appHome: string;
  /** `<state>` (exists, 0700): the discovery file goes there. */
  stateDir: string;
  /** The bridge's loopback port. */
  port: number;
  sink: MirrorSink;
  /** Default {@link MIRROR_STALE_MS}; tests shorten it. */
  staleMs?: number;
  /** Diagnostics. Default: `console.error` with a `herdr-relay: mirror:` prefix. */
  log?: (line: string) => void;
  /** Called once per distinct `relayMod` older than {@link BUNDLED_RELAY_MOD} with the notice also logged. */
  onOutdated?: (text: string) => void;
  /** Default {@link BUNDLED_RELAY_MOD}; tests vary it. */
  bundledMod?: string;
}

export type MirrorReceipt = { ok: true; changed: boolean } | { ok: false; errors: ValidationError[] };

/** Validates a POST body against {@link MIRROR_POST_SCHEMA}. */
export function validateMirrorPost(value: unknown): ValidationError[] {
  return validateJson(MIRROR_POST_SCHEMA, value, definition);
}

export class MirrorEndpoint {
  readonly #o: MirrorEndpointOptions;
  readonly #log: (line: string) => void;
  readonly #staleMs: number;
  readonly #cachePath: string;
  readonly #endpointPath: string;
  readonly #bundled: string;
  #state: MirrorStatus["state"] = "none";
  #snapshot: MirrorPost | null = null;
  #key = "";
  #receivedAt: number | null = null;
  #staleTimer: ReturnType<typeof setTimeout> | undefined;
  #pendingCache: MirrorCacheFile | null = null;
  #cacheBusy: Promise<void> = Promise.resolve();
  #cacheFailed = false;
  #lastRejection = "";
  /** The outdated `relayMod` versions already noticed. */
  readonly #noticed = new Set<string>();
  #closed = false;

  private constructor(o: MirrorEndpointOptions) {
    this.#o = o;
    this.#log = o.log ?? ((line) => console.error(`herdr-relay: mirror: ${line}`));
    this.#staleMs = o.staleMs ?? MIRROR_STALE_MS;
    this.#cachePath = join(o.appHome, MIRROR_CACHE_DIR, MIRROR_CACHE_FILE);
    this.#endpointPath = join(o.stateDir, MIRROR_ENDPOINT_FILE);
    this.#bundled = o.bundledMod ?? BUNDLED_RELAY_MOD;
  }

  /** Reads the cache (applied as `stale`) and writes the discovery file. */
  static async start(o: MirrorEndpointOptions): Promise<MirrorEndpoint> {
    const m = new MirrorEndpoint(o);
    await m.#loadCache();
    const file: MirrorEndpointFile = { v: 1, port: o.port, pid: Deno.pid };
    await writeAtomic(m.#endpointPath, `${JSON.stringify(file)}\n`);
    return m;
  }

  status(): MirrorStatus {
    const relayMod = this.#snapshot?.relayMod ?? null;
    return {
      state: this.#state,
      receivedAt: this.#receivedAt === null ? null : new Date(this.#receivedAt).toISOString(),
      relayMod,
      bundledMod: this.#bundled,
      outdated: relayMod !== null && compareVersions(relayMod, this.#bundled) < 0,
      staleAfterMs: this.#staleMs,
    };
  }

  /** The handshake: logs and hands on an outdated `relayMod`, once per version. */
  #checkVersion(relayMod: string): void {
    if (compareVersions(relayMod, this.#bundled) >= 0 || this.#noticed.has(relayMod)) return;
    this.#noticed.add(relayMod);
    const text =
      `herdr-relay-mirror ${relayMod} is older than ${this.#bundled}: run herdr-relay install-mod on the Mac`;
    this.#log(text);
    this.#o.onOutdated?.(text);
  }

  /** Takes one POST body: validates it, refreshes freshness, and on a change feeds the sink and the cache. */
  receive(body: unknown): MirrorReceipt {
    const errors = validateMirrorPost(body);
    if (errors.length > 0) return { ok: false, errors };
    const post = body as MirrorPost;
    const key = JSON.stringify(post);
    const changed = key !== this.#key || this.#state !== "fresh";
    this.#receivedAt = Date.now();
    this.#armStale();
    if (!changed) return { ok: true, changed: false };
    this.#checkVersion(post.relayMod);
    if (this.#state !== "fresh") this.#log(`fresh (herdr-relay-mirror ${post.relayMod})`);
    this.#state = "fresh";
    this.#snapshot = post;
    this.#key = key;
    this.#o.sink.mirror(sinkSnapshot(post, false));
    this.#saveCache({ v: 1, receivedAt: new Date(this.#receivedAt).toISOString(), snapshot: post });
    return { ok: true, changed: true };
  }

  /** The `device`-level route: loopback token only; `POST` a snapshot, `GET`/`HEAD` the status. */
  route(): Route {
    return { prefix: MIRROR_PATH, level: "device", handle: (req, ctx) => this.#handle(req, ctx.path, ctx.via) };
  }

  /** Stops the stale timer, finishes the cache write and removes the discovery file if it is still this run's. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#staleTimer);
    await this.#cacheBusy;
    try {
      const file = JSON.parse(await Deno.readTextFile(this.#endpointPath)) as Partial<MirrorEndpointFile>;
      if (file.pid === Deno.pid) await Deno.remove(this.#endpointPath);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) this.#log(`removing ${MIRROR_ENDPOINT_FILE}: ${messageOf(e)}`);
    }
  }

  async #handle(req: Request, path: string, via: string): Promise<Response> {
    if (path !== MIRROR_PATH) return text("not found", 404);
    if (via !== "local") return text("the mirror endpoint is loopback-only", 403);
    if (req.method === "GET" || req.method === "HEAD") return json(this.status());
    if (req.method !== "POST") return text("POST or GET only", 405);
    let body: Record<string, unknown>;
    try {
      body = await readJsonObject(req, MIRROR_BODY_MAX_BYTES);
    } catch (e) {
      return this.#rejected([{ path: "", message: e instanceof BodyError ? e.message : "bad body" }]);
    }
    const r = this.receive(body);
    if (!r.ok) return this.#rejected(r.errors);
    const { bundledMod, outdated, staleAfterMs } = this.status();
    return json({ ok: true, changed: r.changed, staleAfterMs, bundledMod, outdated });
  }

  /** 400 with the first errors; logged when they differ from the last rejection (a broken mod retries often). */
  #rejected(errors: ValidationError[]): Response {
    const shown = errors.slice(0, MAX_REPORTED_ERRORS);
    const line = shown.map((e) => `${e.path || "/"}: ${e.message}`).join("; ");
    if (line !== this.#lastRejection) {
      this.#lastRejection = line;
      this.#log(`snapshot rejected (${errors.length} error${errors.length === 1 ? "" : "s"}): ${line}`);
    }
    return json({ error: "invalid mirror snapshot", errors: shown }, 400);
  }

  #armStale(): void {
    clearTimeout(this.#staleTimer);
    if (this.#closed) return;
    const timer = setTimeout(() => this.#goStale(), this.#staleMs);
    Deno.unrefTimer(timer);
    this.#staleTimer = timer;
  }

  #goStale(): void {
    this.#staleTimer = undefined;
    if (this.#closed || this.#state !== "fresh" || this.#snapshot === null) return;
    this.#state = "stale";
    this.#log(`stale: nothing for ${this.#staleMs / 1000} s; keeping only ${RETAINED_WHEN_STALE.join(", ")}`);
    this.#o.sink.mirror(sinkSnapshot(this.#snapshot, true));
  }

  async #loadCache(): Promise<void> {
    let raw: string;
    try {
      raw = await Deno.readTextFile(this.#cachePath);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) this.#log(`reading ${this.#cachePath}: ${messageOf(e)}`);
      return;
    }
    let file: Partial<MirrorCacheFile>;
    try {
      file = JSON.parse(raw);
    } catch {
      return this.#log(`${this.#cachePath} is not JSON; ignored`);
    }
    const at = typeof file.receivedAt === "string" ? Date.parse(file.receivedAt) : NaN;
    if (file.v !== 1 || Number.isNaN(at) || validateMirrorPost(file.snapshot).length > 0) {
      return this.#log(`${this.#cachePath} is not a valid mirror cache; ignored`);
    }
    this.#state = "stale";
    this.#snapshot = file.snapshot!;
    this.#key = JSON.stringify(file.snapshot);
    this.#receivedAt = at;
    this.#o.sink.mirror(sinkSnapshot(this.#snapshot, true));
  }

  /** Queues the latest cache content; one write runs at a time and only the newest pending content is written. */
  #saveCache(file: MirrorCacheFile): void {
    if (this.#cacheFailed) return;
    this.#pendingCache = file;
    this.#cacheBusy = this.#cacheBusy.then(async () => {
      const next = this.#pendingCache;
      this.#pendingCache = null;
      if (next === null || this.#cacheFailed) return;
      try {
        await Deno.mkdir(join(this.#o.appHome, MIRROR_CACHE_DIR), { recursive: true, mode: 0o700 });
        await writeAtomic(this.#cachePath, `${JSON.stringify(next)}\n`);
      } catch (e) {
        this.#cacheFailed = true;
        this.#log(`cannot write ${this.#cachePath} (${messageOf(e)}); the snapshot is not cached this run`);
      }
    });
  }
}

/** What the sink gets: every consumed field when fresh, only {@link RETAINED_WHEN_STALE} when stale. */
function sinkSnapshot(post: MirrorPost, stale: boolean): MirrorSnapshot {
  const out: MirrorSnapshot = {};
  if (post.theme !== undefined) out.theme = post.theme;
  if (post.settings !== undefined) out.settings = post.settings;
  if (post.fonts !== undefined) out.fonts = post.fonts;
  if (post.commands !== undefined) out.commands = post.commands;
  if (post.keys !== undefined) out.keys = post.keys;
  if (post.updates !== undefined) out.updates = post.updates;
  if (stale) return out;
  if (post.focused !== undefined) out.focused = post.focused;
  if (post.panes !== undefined) out.panes = post.panes;
  if (post.shared !== undefined) out.shared = post.shared;
  if (post.window !== undefined) out.window = post.window;
  return out;
}

/** Writes `text` (0600) beside `path` and renames it over `path`. */
async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${Deno.pid}.tmp`;
  try {
    await Deno.writeTextFile(tmp, text, { mode: 0o600 });
    await Deno.chmod(tmp, 0o600);
    await Deno.rename(tmp, path);
  } catch (e) {
    await Deno.remove(tmp).catch(() => {});
    throw e;
  }
}
