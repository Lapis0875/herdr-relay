/**
 * Herdr's data shapes as the `herdr` module returns them to mods (`fixtures/herdr-home/herdr.d.ts`, Herdr for
 * gpui-shell 0.7.1). The bridge builds them (DESIGN.md §5.4), pushes them to mod hosts in `HostState` and to devices
 * in `snapshot`.
 */

import {
  array,
  boolean,
  define,
  enumOf,
  integer,
  type JsonObject,
  jsonObjectRef,
  jsonValueRef,
  nullable,
  number,
  object,
  openObject,
  record,
  type Same,
  type Schema,
  type Static,
  string,
} from "./schema.ts";

const nullableString = () => nullable(string());
const nullableNumber = () => nullable(number());

/** An agent's status. */
export const StatusSchema = define("Status", () => enumOf(["working", "blocked", "done", "idle"]));
export type Status = Static<typeof StatusSchema>;

export const TabInfoSchema = define("TabInfo", () =>
  object({
    id: string(),
    index: integer({ minimum: 1 }),
    name: string(),
    named: boolean(),
    active: boolean(),
    status: nullable(StatusSchema),
    panes: integer({ minimum: 0 }),
    zoomed: boolean(),
    settled: boolean(),
    settled_at: nullableNumber(),
    changed_at: nullableNumber(),
    working_since: nullableNumber(),
  }));
export type TabInfo = Static<typeof TabInfoSchema>;

export const SpaceInfoSchema = define("SpaceInfo", () =>
  object({
    id: string(),
    index: integer({ minimum: 1 }),
    name: string(),
    named: boolean(),
    folder: string(),
    machine: nullableString(),
    branch: nullableString(),
    active: boolean(),
    status: nullable(StatusSchema),
    tabs: array(TabInfoSchema),
  }));
export type SpaceInfo = Static<typeof SpaceInfoSchema>;

/** How a terminal shows, from programs.json. */
export const ProgramSchema = define("Program", () =>
  object({
    key: string(),
    name: string(),
    icon: nullableString(),
    tint: boolean(),
    tile: nullableString(),
    color: nullableString(),
    shell: boolean(),
    agent: boolean(),
  }));
export type Program = Static<typeof ProgramSchema>;

export const AgentInfoSchema = define("AgentInfo", () =>
  object({
    address: string(),
    pane: string(),
    space: string(),
    space_name: string(),
    tab: string(),
    tab_index: integer({ minimum: 1 }),
    tab_name: string(),
    status: StatusSchema,
    app: nullableString(),
    program: ProgramSchema,
    title: string(),
    seq: number(),
    pinned: boolean(),
    focused: boolean(),
  }));
export type AgentInfo = Static<typeof AgentInfoSchema>;

/**
 * One pane. For a mod pane (`terminal: null`, `mod` set) Herdr sets only pane, mod, tab, title, focused and zoomed,
 * so the terminal-only fields are optional here.
 */
export const PaneInfoSchema = define("PaneInfo", () =>
  object({
    pane: string(),
    terminal: nullableString(),
    tab: string(),
    title: string(),
    focused: boolean(),
    zoomed: boolean(),
  }, {
    mod: string(),
    cwd: nullableString(),
    branch: nullableString(),
    status: nullable(StatusSchema),
    app: nullableString(),
    program: ProgramSchema,
    movable: boolean(),
  }));
export type PaneInfo = Static<typeof PaneInfoSchema>;

/** A core terminal as `hc ls --json` describes it (open: herdr-core adds fields), plus `status`/`report`/`program`. */
export const TerminalInfoSchema = define("TerminalInfo", () => openObject({ address: string() }));
export type TerminalInfo = Static<typeof TerminalInfoSchema>;

/** `focused()`. */
export const FocusedSchema = define("Focused", () =>
  object({
    space: string(),
    tab: string(),
    pane: nullableString(),
    terminal: nullableString(),
    shown: nullableString(),
    agent: nullableString(),
    cwd: nullableString(),
  }));
export type Focused = Static<typeof FocusedSchema>;

/** One entry of `commands()`. */
export const CommandInfoSchema = define("CommandInfo", () =>
  object({
    name: string(),
    args: array(object({ name: string(), required: boolean() })),
    about: string(),
  }));
export type CommandInfo = Static<typeof CommandInfoSchema>;

/** One entry of `keys()`. */
export const KeyBindingInfoSchema = define(
  "KeyBindingInfo",
  () => object({ section: string(), keys: string(), action: string() }),
);
export type KeyBindingInfo = Static<typeof KeyBindingInfoSchema>;

/** `window()`. */
export const WindowInfoSchema = define("WindowInfo", () =>
  object({
    platform: enumOf(["linux", "macos", "windows"]),
    titlebar: enumOf(["system", "none"]),
    buttons: boolean(),
    maximized: boolean(),
    fullscreen: boolean(),
    active: boolean(),
  }));
export type WindowInfo = Static<typeof WindowInfoSchema>;

/** One entry of `themes()`. */
export const ThemeInfoSchema = define(
  "ThemeInfo",
  () => object({ name: string(), light: boolean(), colors: record(string()) }),
);
export type ThemeInfo = Static<typeof ThemeInfoSchema>;

/** One entry of `machines()`; `name: null` is this computer. */
export const MachineInfoSchema = define(
  "MachineInfo",
  () => object({ name: nullableString(), layout: enumOf(["loading", "ready", "unavailable"]) }),
);
export type MachineInfo = Static<typeof MachineInfoSchema>;

/** `updates()`. */
export const UpdatesInfoSchema = define("UpdatesInfo", () =>
  object({
    app: object({ version: string(), ready: nullableString(), updates: boolean() }),
    notes: array(object({
      version: string(),
      date: string(),
      items: array(object({
        headline: string(),
        detail: string(),
        fixed: boolean(),
        media: array(object({ path: string(), width: number(), height: number() })),
      })),
      spotlight: boolean(),
    })),
    core: object({
      version: nullableString(),
      managed: nullableString(),
      ready: nullableString(),
      updating: boolean(),
      error: nullableString(),
    }),
    checked: nullableNumber(),
    checks: boolean(),
    checking: boolean(),
  }));
export type UpdatesInfo = Static<typeof UpdatesInfoSchema>;

/**
 * A node of `layouts/<name>.json` (`layout()`): `row`/`column`/`stack`/`block` with `children`, the root's `floating`
 * entries, sizes, and a block's `content` (`{mod, props}`, `{agent:"focused"}`, `{tab:"active", pane}`,
 * `{terminal}`). Herdr's layout format is open (look keys such as `radius`, `border`, `background`), so unknown keys
 * are kept; the keys `recompose()` reads are typed.
 */
export interface LayoutNode {
  id?: string;
  type?: string;
  children?: LayoutNode[];
  floating?: LayoutNode[];
  hidden?: boolean;
  active?: string;
  size?: { px?: number; weight?: number; [key: string]: unknown };
  min?: number;
  max?: number;
  content?: JsonObject;
  [key: string]: unknown;
}

export const LayoutNodeSchema: Schema<LayoutNode> = define("LayoutNode", () => layoutNodeBody);

const layoutNodeBody = openObject({}, {
  id: string(),
  type: string({ description: "row | column | stack | block (floating entries have none)" }),
  children: array(LayoutNodeSchema),
  floating: array(LayoutNodeSchema),
  hidden: boolean(),
  active: string(),
  size: openObject({}, { px: number(), weight: number() }),
  min: number(),
  max: number(),
  content: jsonObjectRef,
});

const _layoutNodeMatches: Same<Static<typeof layoutNodeBody>, LayoutNode> = true;

/** `shared()` values: any JSON. */
export const SharedSchema = define("Shared", () => record(jsonValueRef));
export type Shared = Static<typeof SharedSchema>;
