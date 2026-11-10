/**
 * Herdr's model from herdr-core (DESIGN.md §5.4): `spaces()`/`panes()` from the core's `herdr-app` document (spaces →
 * tabs → a split tree of blocks; a block's id is its pane id), `terminals()`/`agents()` from the mirrored terminal list,
 * and `program` from Herdr's program table (its built-in one, `programs.json` here, with the person's `programs.json`
 * on top). Pure; the caller supplies the repo lookup and the Mac's own selection.
 *
 * [I] What only the Herdr window knows is approximated until the mirror mod (D5) reports it: the Mac's focus and shown
 * space/tab (first space, its first tab and pane), zoom (none), settled tabs (none) and pins (a `herdr.pin*` label).
 */

import type {
  AgentInfo,
  Focused,
  JsonObject,
  LayoutNode,
  PaneInfo,
  Program,
  SpaceInfo,
  Status,
  TabInfo,
  TerminalInfo,
} from "@herdr-relay/protocol";
import type { CoreTerminal } from "../core/mod.ts";
import builtIn from "./programs.json" with { type: "json" };
import { folderName, type RepoInfo } from "./repos.ts";

/** One program table entry (AGENTS.md "Programs"): every field optional, as in `programs.json`. */
export interface ProgramEntry {
  name?: string;
  /** A path in the home folder ("icons/deno.svg"). */
  icon?: string;
  tint?: boolean;
  tile?: string;
  color?: string;
  match?: string[];
  run?: string[];
}

/**
 * Herdr's program table (herdr-app v0.1.14 `src/programs.rs`): the built-in `defaults/programs.json` (bundled as
 * `./programs.json`) with the person's `programs.json` on top, entry by entry.
 */
export interface ProgramTable {
  /** By key, in key order: Herdr keeps them in a `BTreeMap`, and a lookup takes the first match in that order. */
  entries: Map<string, ProgramEntry>;
  shells: Set<string>;
  interpreters: Set<string>;
}

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** A terminal's OSC 7501 report (`status`: `{state, app, …}`), or null. */
function reportOf(t: CoreTerminal | undefined): JsonObject | null {
  const s = t?.status;
  return isObject(s) ? s : null;
}

/** What runs in a terminal now (`foreground`: `{argv, cwd, name, pid}`), or null. */
function foregroundOf(t: CoreTerminal | undefined): JsonObject | null {
  const f = t?.foreground;
  return isObject(f) ? f : null;
}

/** `v` when it is a list of strings (absent: empty); `undefined` when it is anything else. */
function stringList(v: unknown): string[] | undefined {
  if (v === undefined) return [];
  return Array.isArray(v) && v.every((x) => typeof x === "string") ? v : undefined;
}

/**
 * A program table file as Herdr reads it (serde): `shells`/`interpreters` lists of strings, `programs` an object of
 * entries whose `name`/`icon`/`tile`/`color` are strings or null, `tint` a boolean or null, `match`/`run` lists of
 * strings; other keys are ignored. `null` when any of these has another type: Herdr then keeps only its built-in
 * table (and reports "programs.json: …" in the window).
 */
function tableOf(file: unknown): ProgramTable | null {
  if (!isObject(file)) return null;
  const shells = stringList(file.shells);
  const interpreters = stringList(file.interpreters);
  const programs = file.programs === undefined ? {} : file.programs;
  if (!shells || !interpreters || !isObject(programs)) return null;
  const entries = new Map<string, ProgramEntry>();
  for (const [key, raw] of Object.entries(programs)) {
    if (!isObject(raw)) return null;
    const e: ProgramEntry = {};
    for (const field of ["name", "icon", "tile", "color"] as const) {
      const v = raw[field];
      if (typeof v === "string") e[field] = v;
      else if (v !== undefined && v !== null) return null;
    }
    if (typeof raw.tint === "boolean") e.tint = raw.tint;
    else if (raw.tint !== undefined && raw.tint !== null) return null;
    const match = stringList(raw.match);
    const run = stringList(raw.run);
    if (!match || !run) return null;
    if (match.length) e.match = match;
    if (run.length) e.run = run;
    entries.set(key, e);
  }
  return { entries, shells: new Set(shells), interpreters: new Set(interpreters) };
}

/** Herdr's built-in table with the person's `programs.json` (`file`) on top (`programs::load`). */
export function programTable(file: JsonObject): ProgramTable {
  const table = tableOf(builtIn)!;
  const mine = tableOf(file);
  if (mine) {
    for (const s of mine.shells) table.shells.add(s);
    for (const s of mine.interpreters) table.interpreters.add(s);
    // `Entry::over`: a field the person sets wins; a non-empty `match`/`run` replaces the built-in one.
    for (const [key, e] of mine.entries) {
      const out: ProgramEntry = { ...table.entries.get(key) };
      for (const field of ["name", "icon", "tile", "color"] as const) if (e[field] !== undefined) out[field] = e[field];
      if (e.tint !== undefined) out.tint = e.tint;
      if (e.match) out.match = e.match;
      if (e.run) out.run = e.run;
      table.entries.set(key, out);
    }
  }
  table.entries = new Map([...table.entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return table;
}

/** An entry as mods see it (`shown`): `name` (a process name) wins over the entry's; `tint` defaults to true. */
function shown(key: string, e: ProgramEntry, name: string | null, shell: boolean, agent: boolean): Program {
  return {
    key,
    name: name ?? e.name ?? key,
    icon: e.icon ?? null,
    tint: e.tint ?? true,
    tile: e.tile ?? null,
    color: e.color ?? null,
    shell,
    agent,
  };
}

/** The entry for `name`: a key equal to it (case-insensitively), else one whose `match` lists it, in key order. */
function find(t: ProgramTable, name: string): [string, ProgramEntry] | null {
  const lower = name.toLowerCase();
  for (const entry of t.entries) if (entry[0] === name || entry[0].toLowerCase() === lower) return entry;
  for (const entry of t.entries) {
    if (entry[1].match?.some((a) => a === name || a.toLowerCase() === lower)) return entry;
  }
  return null;
}

/** A command's own name: the last path segment, without leading `-` (login shells) or a Windows `.exe`. */
function base(s: string): string {
  return s.slice(Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\")) + 1).replace(/^-+/, "").replace(/\.exe$/i, "");
}

/** PowerShell's single quotes, the curly ones included. */
const PS_QUOTES = "'\u2018\u2019\u201A\u201B";

/** The words of Herdr's `& 'prog' 'arg 1'` PowerShell line (a doubled quote is one), or null for any other line. */
function powershellWords(line: string): string[] | null {
  if (!line.startsWith("& ")) return null;
  const chars = Array.from(line.slice(2));
  const words: string[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === " ") continue;
    if (!PS_QUOTES.includes(chars[i])) return null;
    let w = "";
    for (i++; i < chars.length; i++) {
      if (PS_QUOTES.includes(chars[i])) {
        if (i + 1 < chars.length && PS_QUOTES.includes(chars[i + 1])) {
          w += chars[++i];
          continue;
        }
        break;
      }
      w += chars[i];
    }
    words.push(w);
  }
  return words;
}

/** Tiles for programs nobody listed: one per name, the same every time (FNV-1a of its UTF-8 bytes). */
const PALETTE = ["#6d5bd0", "#2f80ed", "#0f9d8a", "#d9822b", "#c2417d", "#3a7d44", "#8a5a44", "#4e5d94"];
const utf8 = new TextEncoder();

/** Script extensions an interpreter's argument loses before the lookup (`vite.js` is Vite). */
const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".ts", ".py", ".rb"];

/** Herdr's `programs::resolve`: an agent's report (`app`), else the program `argv` runs. */
function resolve(t: ProgramTable, app: string | null, argv: string[]): Program {
  if (app) {
    const found = find(t, app);
    return found
      ? shown(found[0], found[1], null, false, true)
      : shown("agent", t.entries.get("agent") ?? {}, app, false, true);
  }
  // The app starts commands in the person's shell: `zsh -ic '"$@"; exec "$0" -i' zsh <cmd>...`.
  if (
    argv.length > 4 && t.shells.has(base(argv[0])) && argv[1].startsWith("-") && argv[1].endsWith("c") &&
    (argv[2].includes('"$@"') || argv[2] === "command $argv[2..]; exec $argv[1] -i")
  ) return resolve(t, null, argv.slice(4));
  // On Windows: `pwsh -NoExit -Command "& 'codex' ..."`.
  if (argv.length === 4 && t.shells.has(base(argv[0])) && argv[1] === "-NoExit" && argv[2] === "-Command") {
    const words = powershellWords(argv[3]);
    if (words) return resolve(t, null, words);
  }
  if (argv.length === 0) return shown("shell", t.entries.get("shell") ?? {}, null, true, false);
  const first = base(argv[0]);
  // `node .../vite.js dev`, `npx vite`, `uv run pytest`: the program they run, when it's known.
  if (t.interpreters.has(first)) {
    for (const arg of argv.slice(1)) {
      if (arg.startsWith("-")) continue;
      // A script's name without its extension (`vite.js`), never a module path (`http.server`).
      const name = base(arg);
      const ext = SCRIPT_EXTENSIONS.find((x) => name.endsWith(x));
      const found = find(t, ext ? name.slice(0, -ext.length) : name);
      if (found && !t.interpreters.has(found[0])) return shown(found[0], found[1], null, false, false);
    }
  }
  const found = find(t, first);
  if (found) return shown(found[0], found[1], null, false, false);
  if (t.shells.has(first)) return shown("shell", t.entries.get("shell") ?? {}, first, true, false);
  let hash = 2166136261;
  for (const b of utf8.encode(first)) hash = Math.imul(hash ^ b, 16777619) >>> 0;
  const unlisted = { ...t.entries.get("program"), tile: PALETTE[hash % PALETTE.length], color: "#ffffff" };
  return shown("program", unlisted, first, false, false);
}

/**
 * `program` of a terminal as Herdr shows it (`window.rs` `program_of`): the agent's own report (`status.app`), else
 * what runs in it now (`foreground.argv`), else what it started with (`argv`).
 */
export function programOf(table: ProgramTable, t: CoreTerminal | undefined): Program {
  const running = foregroundOf(t)?.argv;
  const argv = Array.isArray(running) && running.length > 0 ? strings(running) : strings(t?.argv);
  return resolve(table, str(reportOf(t)?.app), argv);
}

/** The agents people pick most, first in menus; the rest follow by key. */
const AGENTS_FIRST = ["claude", "codex", "pi", "opencode", "cursor", "copilot", "amp", "gemini", "grok"];

/** Every entry with `run` (an agent the table can start), most picked first (`programs::startable`). */
export function startable(table: ProgramTable): (Program & { run: string[] })[] {
  const rank = (key: string) => {
    const i = AGENTS_FIRST.indexOf(key);
    return i < 0 ? AGENTS_FIRST.length : i;
  };
  return [...table.entries]
    .filter(([, e]) => e.run)
    .sort(([a], [b]) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, e]) => ({ ...shown(key, e, null, false, true), run: e.run! }));
}

/** A core status word as Herdr's `Status`; [I] `error` (core only) counts as needing the person. */
function status(t: CoreTerminal | undefined): Status | null {
  const s = reportOf(t)?.state;
  switch (s) {
    case "working":
    case "blocked":
    case "done":
    case "idle":
      return s;
    case "error":
      return "blocked";
    default:
      return null;
  }
}

const URGENCY: Record<Status, number> = { blocked: 4, done: 3, working: 2, idle: 1 };

function mostUrgent(list: (Status | null)[]): Status | null {
  let best: Status | null = null;
  for (const s of list) if (s && (!best || URGENCY[s] > URGENCY[best])) best = s;
  return best;
}

/** The Mac's selection, from the mirror mod's `focused()` and `panes()` when it reports them. */
export interface MacView {
  focused: Focused | null;
  /** Mirrored panes by id: their `focused`, `zoomed`, `branch`, `program`, `title`, `movable` win. */
  panes: ReadonlyMap<string, PaneInfo>;
}

export interface ModelInput {
  /** The `herdr-app` document's value. */
  doc: unknown;
  terminals: ReadonlyMap<string, CoreTerminal>;
  programs: ProgramTable;
  home: string;
  repo(cwd: string): RepoInfo | null;
  mac: MacView;
}

export interface Model {
  spaces: SpaceInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  terminals: TerminalInfo[];
  focused: Focused | null;
}

interface Block {
  id: string;
  content: JsonObject;
}

/** The blocks of a tab's split tree, in order. */
function blocks(node: unknown, out: Block[] = []): Block[] {
  if (!isObject(node)) return out;
  const n = node as LayoutNode;
  if (n.type === "block" && typeof n.id === "string" && isObject(n.content)) out.push({ id: n.id, content: n.content });
  if (Array.isArray(n.children)) { for (const c of n.children) blocks(c, out); }
  return out;
}

interface DocTab {
  id: string;
  name: string;
  blocks: Block[];
}
interface DocSpace {
  id: string;
  name: string;
  folder: string;
  tabs: DocTab[];
}

function docSpaces(doc: unknown): DocSpace[] {
  const spaces = isObject(doc) && Array.isArray(doc.spaces) ? doc.spaces : [];
  const out: DocSpace[] = [];
  for (const s of spaces) {
    if (!isObject(s) || !str(s.id)) continue;
    const tabs: DocTab[] = [];
    for (const t of Array.isArray(s.tabs) ? s.tabs : []) {
      if (isObject(t) && str(t.id)) tabs.push({ id: t.id as string, name: str(t.name) ?? "", blocks: blocks(t.root) });
    }
    out.push({ id: s.id as string, name: str(s.name) ?? "", folder: str(s.folder) ?? "", tabs });
  }
  return out;
}

/** The space folders the read policy adds as roots (DESIGN-v2 §2.1). */
export function spaceFolders(doc: unknown): string[] {
  return docSpaces(doc).map((s) => s.folder).filter((f) => f.startsWith("/"));
}

/** Builds `spaces()`, `panes()`, `agents()`, `terminals()` and the Mac's `focused()`. */
export function buildModel(input: ModelInput): Model {
  const { terminals, programs, mac } = input;
  const spaces = docSpaces(input.doc);
  const cwdOf = (t: CoreTerminal | undefined): string | null => str(foregroundOf(t)?.cwd) ?? str(t?.cwd);

  // The Mac's selection: the mirror's, else [I] the first space, its first tab and that tab's first pane.
  const tabSpace = new Map<string, DocSpace>();
  for (const s of spaces) for (const t of s.tabs) tabSpace.set(t.id, s);
  const mirrored = mac.focused && spaces.some((s) => s.id === mac.focused!.space) ? mac.focused : null;
  const shownSpace = mirrored?.space ?? spaces[0]?.id ?? null;
  const shownTab = (s: DocSpace) =>
    mirrored && tabSpace.get(mirrored.tab)?.id === s.id ? mirrored.tab : s.tabs[0]?.id ?? null;

  const panes: PaneInfo[] = [];
  const agents: AgentInfo[] = [];
  const paneOfTerminal = new Map<string, PaneInfo>();
  const spaceInfos: SpaceInfo[] = spaces.map((s, si) => {
    const active = s.id === shownSpace;
    const showing = shownTab(s);
    let firstCwd: string | null = null;
    const tabs: TabInfo[] = s.tabs.map((tab, ti) => {
      const tabPanes: PaneInfo[] = [];
      for (const b of tab.blocks) {
        const own = mac.panes.get(b.id);
        const mod = str(b.content.mod);
        const address = str(b.content.terminal);
        if (mod && !address) {
          tabPanes.push({
            pane: b.id,
            terminal: null,
            mod,
            tab: tab.id,
            title: own?.title ?? mod,
            focused: own?.focused ?? false,
            zoomed: own?.zoomed ?? false,
          });
          continue;
        }
        if (!address) continue;
        const t = terminals.get(address);
        const cwd = cwdOf(t);
        firstCwd ??= cwd;
        const prog = own?.program ?? programOf(programs, t);
        tabPanes.push({
          pane: b.id,
          terminal: address,
          tab: tab.id,
          title: own?.title ?? (str(t?.title) ?? prog.name),
          cwd,
          branch: own?.branch ?? (cwd ? input.repo(cwd)?.branch ?? null : null),
          status: status(t),
          app: str(reportOf(t)?.app),
          program: prog,
          focused: own?.focused ?? false,
          zoomed: own?.zoomed ?? false,
          movable: own?.movable ?? false,
        });
      }
      // [I] Without the mirror the Mac's focused pane is the shown tab's first one.
      if (!mac.panes.size && active && tab.id === showing && tabPanes[0]) tabPanes[0].focused = true;
      for (const p of tabPanes) {
        if (p.movable !== undefined && !mac.panes.has(p.pane)) p.movable = tabPanes.length > 1;
        if (p.terminal) paneOfTerminal.set(p.terminal, p);
      }
      panes.push(...tabPanes);
      const stamps = tabPanes.map((p) => (p.terminal ? terminals.get(p.terminal)?.status_ms : null))
        .filter((n): n is number => typeof n === "number");
      const working = tabPanes.filter((p) => p.status === "working")
        .map((p) => terminals.get(p.terminal!)?.status_ms).filter((n): n is number => typeof n === "number");
      return {
        id: tab.id,
        index: ti + 1,
        name: tab.name || String(ti + 1),
        named: tab.name !== "",
        active: tab.id === showing,
        status: mostUrgent(tabPanes.map((p) => p.status ?? null)),
        panes: tabPanes.length,
        zoomed: tabPanes.some((p) => p.zoomed),
        settled: false,
        settled_at: null,
        changed_at: stamps.length ? Math.max(...stamps) : null,
        working_since: working.length ? Math.min(...working) : null,
      };
    });
    const repo = firstCwd ? input.repo(firstCwd) : null;
    return {
      id: s.id,
      index: si + 1,
      name: s.name ||
        (firstCwd ? folderName(firstCwd, repo, input.home) : folderName(s.folder || input.home, null, input.home)),
      named: s.name !== "",
      folder: s.folder,
      machine: null,
      branch: repo?.branch ?? null,
      active,
      status: mostUrgent(tabs.map((t) => t.status)),
      tabs,
    };
  });

  // Agents: terminals that report a status, in space, tab, pane order; [I] a sub-agent (no pane) follows its parent.
  const tabInfo = new Map<string, { space: SpaceInfo; tab: TabInfo }>();
  for (const space of spaceInfos) for (const tab of space.tabs) tabInfo.set(tab.id, { space, tab });
  const agentOf = (t: CoreTerminal, pane: PaneInfo | undefined, tabId: string): AgentInfo | null => {
    const st = status(t);
    const where = tabInfo.get(tabId);
    if (!st || !where) return null;
    const labels = isObject(t.labels) ? t.labels : {};
    return {
      address: t.address,
      pane: pane?.pane ?? "",
      space: where.space.id,
      space_name: where.space.name,
      tab: where.tab.id,
      tab_index: where.tab.index,
      tab_name: where.tab.name,
      status: st,
      app: str(reportOf(t)?.app),
      program: pane?.program ?? programOf(programs, t),
      title: str(t.title) ?? "",
      seq: typeof t.status_ms === "number" ? t.status_ms : t.created_ms ?? 0,
      pinned: Object.keys(labels).some((k) => k.startsWith("herdr.pin")),
      focused: pane?.focused ?? false,
    };
  };
  for (const p of panes) {
    const t = p.terminal ? terminals.get(p.terminal) : undefined;
    const a = t && agentOf(t, p, p.tab);
    if (a) agents.push(a);
    for (const sub of t ? terminals.values() : []) {
      if (sub.parent === p.terminal && !paneOfTerminal.has(sub.address)) {
        const s = agentOf(sub, undefined, p.tab);
        if (s) agents.push(s);
      }
    }
  }

  const terminalInfos: TerminalInfo[] = [...terminals.values()].map((t) => {
    const out: TerminalInfo = { ...(t as unknown as JsonObject), address: t.address };
    const report = reportOf(t);
    out.status = str(report?.state);
    out.report = report;
    out.program = programOf(programs, t) as unknown as JsonObject;
    return out;
  });

  let focused: Focused | null = mirrored;
  if (!focused && shownSpace) {
    const s = spaceInfos.find((x) => x.id === shownSpace)!;
    const tab = s.tabs.find((t) => t.active) ?? s.tabs[0];
    const pane = panes.find((p) => p.tab === tab?.id && p.focused) ?? panes.find((p) => p.tab === tab?.id);
    const agent = agents.find((a) => a.pane === pane?.pane) ?? agents[0];
    focused = {
      space: s.id,
      tab: tab?.id ?? "",
      pane: pane?.pane ?? null,
      terminal: pane?.terminal ?? null,
      shown: null,
      agent: agent?.address ?? null,
      cwd: pane?.cwd ?? null,
    };
  }
  return { spaces: spaceInfos, panes, agents, terminals: terminalInfos, focused };
}
