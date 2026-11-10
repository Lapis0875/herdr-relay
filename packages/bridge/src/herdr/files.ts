/**
 * The appHome files the `herdr` data comes from (DESIGN.md §5.4, AGENTS.md "Files"): `settings.json`, `keys.json`,
 * `programs.json`, `themes/*.json`, `layouts/*.json` with their clicks in `layouts/.state/`, `shared.json` and
 * `cockpit.json`. Read only — the bridge never writes appHome (D8: `shared.json` included). One recursive
 * `Deno.watchFs` on appHome, filtered to these paths and debounced, reloads them.
 */

import { join } from "@std/path";
import {
  type ClickState,
  ClickStateSchema,
  is,
  type JsonObject,
  type LayoutNode,
  LayoutNodeSchema,
  type NamedLayout,
} from "@herdr-relay/protocol";
import type { CockpitInstall } from "../policy/mod.ts";
import { parseThemeFile, type ThemeFile } from "./look.ts";

/** Largest config file read (shared.json holds mods' state and may grow). */
export const CONFIG_MAX_BYTES = 4 * 1024 * 1024;
/** File changes are reloaded this long after the last event. */
export const FILES_DEBOUNCE_MS = 100;

export interface AppFiles {
  /** `settings.json` (`{}` when absent or invalid). */
  settings: JsonObject;
  /** `keys.json`. */
  keys: JsonObject;
  /** `programs.json`. */
  programs: JsonObject;
  /** `themes/<name>.json` by name (valid ones). */
  themes: Map<string, ThemeFile>;
  /** `layouts/*.json` names, `main` first. */
  layouts: string[];
  /** The shown layout: `shared("layout")` when it names one, else `main`, else the first. */
  layout: NamedLayout;
  /** Its clicks (`layouts/.state/<name>.json`), or null. */
  clicks: ClickState | null;
  /** `shared.json`. */
  shared: JsonObject;
  /** `cockpit.json` (cockpit's install record), or null. */
  cockpit: CockpitInstall | null;
}

/** The layout shown when appHome has none at all. */
const EMPTY_LAYOUT: LayoutNode = { id: "root", type: "row", children: [] };

/**
 * Reads a JSON file of at most `max` bytes: `undefined` when it does not exist; a file that is too big or not JSON is
 * reported through `log` and also reads as `undefined` (Herdr keeps going with defaults too).
 */
export async function readJson(path: string, log: (line: string) => void, max = CONFIG_MAX_BYTES): Promise<unknown> {
  try {
    const st = await Deno.stat(path);
    if (!st.isFile) return undefined;
    if (st.size > max) {
      log(`${path}: over ${max} bytes; ignored`);
      return undefined;
    }
    return JSON.parse(await Deno.readTextFile(path));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    log(`${path}: ${e instanceof Error ? e.message : String(e)}`);
    return undefined;
  }
}

async function names(dir: string, ext: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(ext) && !e.name.startsWith(".")) out.push(e.name.slice(0, -ext.length));
    }
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
  return out.sort((a, b) => a.localeCompare(b));
}

const objectOr = (
  v: unknown,
): JsonObject => (typeof v === "object" && v !== null && !Array.isArray(v) ? v as JsonObject : {});

/**
 * Reads every file `herdr` data uses from `appHome`. `shown` names the layout the Mac shows when something fresher
 * than `shared.json` knows it (the mirror mod's `shared("layout")`).
 */
export async function loadAppFiles(appHome: string, log: (line: string) => void, shown?: string): Promise<AppFiles> {
  const read = (rel: string) => readJson(join(appHome, rel), log);
  const [settings, keys, programs, shared, cockpit] = await Promise.all(
    ["settings.json", "keys.json", "programs.json", "shared.json", "cockpit.json"].map(read),
  );
  const themes = new Map<string, ThemeFile>();
  for (const name of await names(join(appHome, "themes"), ".json")) {
    const t = parseThemeFile(await read(`themes/${name}.json`));
    if (t) themes.set(name, t);
    else log(`themes/${name}.json is not a theme file; ignored`);
  }
  const all = await names(join(appHome, "layouts"), ".json");
  const layouts = all.includes("main") ? ["main", ...all.filter((n) => n !== "main")] : all;
  const sharedObj = objectOr(shared);
  const want = shown ?? sharedObj.layout;
  const name = (typeof want === "string" && layouts.includes(want) ? want : null) ?? layouts[0] ?? "main";
  const tree = layouts.includes(name) ? await read(`layouts/${name}.json`) : undefined;
  const layoutOk = is(LayoutNodeSchema, tree);
  if (tree !== undefined && !layoutOk) log(`layouts/${name}.json is not a layout; showing an empty one`);
  const clicks = await read(`layouts/.state/${name}.json`);
  const clicksOk = is(ClickStateSchema, clicks);
  if (clicks !== undefined && !clicksOk) log(`layouts/.state/${name}.json is not valid; ignored`);
  return {
    settings: objectOr(settings),
    keys: objectOr(keys),
    programs: objectOr(programs),
    themes,
    layouts,
    layout: { name, tree: layoutOk ? tree : structuredClone(EMPTY_LAYOUT) },
    clicks: clicksOk ? clicks : null,
    shared: sharedObj,
    cockpit: cockpit === undefined ? null : cockpitInstall(objectOr(cockpit)),
  };
}

/** The fields of `cockpit.json` the policy reads, type-checked. */
function cockpitInstall(raw: JsonObject): CockpitInstall {
  const out: CockpitInstall = {};
  for (const key of ["bin", "cache", "home", "version"] as const) {
    const v = raw[key];
    if (typeof v === "string") out[key] = v;
  }
  const env = raw.env;
  if (typeof env === "object" && env !== null && !Array.isArray(env)) {
    out.env = {};
    for (const [k, v] of Object.entries(env)) if (typeof v === "string") out.env[k] = v;
  }
  return out;
}

/** Whether a changed path (relative to the real appHome, `/`-separated) can change {@link AppFiles}. */
export function relevantPath(rel: string): boolean {
  if (rel === "" || rel === "layouts" || rel === "themes") return true;
  const top = rel.split("/")[0];
  if (top === "layouts" || top === "themes") return true;
  return ["settings.json", "keys.json", "programs.json", "shared.json", "cockpit.json"].includes(rel);
}

/**
 * Watches the real appHome recursively and calls `changed` once per burst of relevant events (debounced
 * {@link FILES_DEBOUNCE_MS}). Returns the stop function.
 */
export function watchAppFiles(appHomeReal: string, changed: () => void, log: (line: string) => void): () => void {
  let watcher: Deno.FsWatcher;
  try {
    watcher = Deno.watchFs(appHomeReal, { recursive: true });
  } catch (e) {
    log(`cannot watch ${appHomeReal}: ${e instanceof Error ? e.message : String(e)}; appHome changes are not followed`);
    return () => {};
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prefix = `${appHomeReal}/`;
  (async () => {
    try {
      for await (const ev of watcher) {
        const hit = ev.paths.some((p) =>
          p === appHomeReal || (p.startsWith(prefix) && relevantPath(p.slice(prefix.length)))
        );
        if (!hit) continue;
        clearTimeout(timer);
        timer = setTimeout(changed, FILES_DEBOUNCE_MS);
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.BadResource)) log(`appHome watch ended: ${e instanceof Error ? e.message : e}`);
    }
  })();
  return () => {
    clearTimeout(timer);
    try {
      watcher.close();
    } catch {
      // already closed
    }
  };
}
