import type { HostState, LayoutNode } from "@herdr-relay/protocol";
import { effectiveSettings, resolveTheme } from "../../src/herdr/look.ts";

/** Synthetic mod-host state; never reads a real Herdr installation or user data. */
export function fixtureState(appHome: string, home: string, layoutName: string, dataHome = appHome): HostState {
  const layout = JSON.parse(Deno.readTextFileSync(`${appHome}/layouts/${layoutName}.json`)) as LayoutNode;
  const rawSettings = JSON.parse(Deno.readTextFileSync(`${dataHome}/settings.json`));
  const settings = effectiveSettings(rawSettings, layout, resolveTheme(layout, rawSettings, new Map()).name);
  const rawKeys = JSON.parse(Deno.readTextFileSync(`${dataHome}/keys.json`)) as Record<string, Record<string, string>>;
  const keys = Object.entries(rawKeys).flatMap(([section, bindings]) =>
    Object.entries(bindings).map(([keys, action]) => ({ section, keys, action }))
  );
  const source = JSON.parse(Deno.readTextFileSync(`${dataHome}/themes/atom-one-dark.json`)) as {
    background: string;
    foreground: string;
    selection: string;
    ansi: string[];
  };
  const theme: Record<string, string> = {
    background: source.background,
    foreground: source.foreground,
    selection: source.selection,
    surface: "#282c34",
    canvas: "#1b1e23",
    chrome: "#1e2227",
    popover: "#2c313a",
    raised: "#2c313a",
    hover: "#2f343e",
    selected: source.selection,
    border: "#3a3f4b",
    input: "#3a3f4b",
    muted: "#7f848e",
    dim: "#5c6370",
    accent: source.ansi[4],
    accent_foreground: source.background,
    solid: source.foreground,
    solid_foreground: source.background,
    working: source.ansi[3],
    blocked: source.ansi[1],
    done: source.ansi[2],
    idle: "#7f848e",
    unknown: "#5c6370",
  };
  source.ansi.forEach((color, index) => theme[`ansi${index}`] = color);
  const folder = `${home}/project`;
  const program = {
    key: "shell",
    name: "Shell",
    icon: null,
    tint: true,
    tile: null,
    color: null,
    shell: true,
    agent: false,
  };
  const tab = {
    id: "s1/t1",
    index: 1,
    name: "Terminal",
    named: true,
    active: true,
    status: null,
    panes: 1,
    zoomed: false,
    settled: false,
    settled_at: null,
    changed_at: 0,
    working_since: null,
  };
  return {
    folder: "fixture",
    home,
    appHome,
    layout,
    layouts: [layoutName],
    commands: [],
    spaces: [{
      id: "s1",
      index: 1,
      name: "Project",
      named: true,
      folder,
      machine: null,
      branch: "main",
      active: true,
      status: null,
      tabs: [tab],
    }],
    agents: [],
    panes: [{
      pane: "p1",
      terminal: "t1",
      tab: "s1/t1",
      title: "Shell",
      cwd: folder,
      branch: "main",
      status: null,
      app: null,
      program,
      focused: true,
      zoomed: false,
      movable: true,
    }],
    terminals: [{ address: "t1", argv: ["sh"], state: "live", cwd: folder, title: "Shell", program }],
    focused: { space: "s1", tab: "s1/t1", pane: "p1", terminal: "t1", shown: null, agent: null, cwd: folder },
    window: { platform: "macos", titlebar: "none", buttons: false, maximized: false, fullscreen: false, active: true },
    theme,
    themes: [],
    fonts: ["monospace", "sans-serif"],
    updates: {
      app: { version: "0.1.14", ready: null, updates: true },
      notes: [],
      core: { version: "0.1.19", managed: null, ready: null, updating: false, error: null },
      checked: 0,
      checks: true,
      checking: false,
    },
    settings,
    keys,
    machines: [{ name: null, layout: "ready" }],
    shared: {},
  };
}
