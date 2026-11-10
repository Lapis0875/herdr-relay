/**
 * A session's own focus (Herdr: "Selection, focus, zoom and settled state belong to this screen only"): the space,
 * tab, pane, zoom and agent this device shows, layered over the Mac's live state (`SessionWorld`). Anything the device
 * has not chosen follows the Mac.
 */

import type { AgentInfo, Focused, JsonObject, PaneInfo, SpaceInfo } from "@herdr-relay/protocol";

/** The Mac's live state the bridge holds (core document, mirror, mods' `setAgentOrder`). */
export interface SessionWorld {
  spaces: SpaceInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  focused: Focused | null;
  /** The last `setAgentOrder()` list from the mods; without it `agent.next/prev` use model order. */
  agentOrder?: string[];
}

/**
 * The Mac's `spaces()`, `panes()`, `agents()` and `focused()` as one device sees them: the same lists with that
 * device's own selection, focus and zoom (`SessionFocus.view`).
 */
export interface SessionView {
  spaces: SpaceInfo[];
  panes: PaneInfo[];
  agents: AgentInfo[];
  focused: Focused | null;
}

/** Focus commands `SessionFocus.apply` handles. */
export const FOCUS_COMMANDS = [
  "space.select",
  "space.next",
  "space.prev",
  "tab.select",
  "tab.next",
  "tab.prev",
  "pane.focus",
  "pane.go",
  "pane.zoom",
  "agent.focus",
  "agent.next",
  "agent.prev",
] as const;
export type FocusCommand = (typeof FOCUS_COMMANDS)[number];

export function isFocusCommand(name: string): name is FocusCommand {
  return (FOCUS_COMMANDS as readonly string[]).includes(name);
}

export class SessionFocus {
  #space: string | null = null;
  /** space id → the tab this device shows there. */
  readonly #tabs = new Map<string, string>();
  /** tab id → the pane this device focuses there. */
  readonly #panes = new Map<string, string>();
  /** tab id → the pane this device zoomed there (`null`: unzoomed here even if the Mac zoomed). */
  readonly #zoom = new Map<string, string | null>();
  #agent: string | null = null;
  /** A terminal focused through a layout terminal block rather than a pane (`pane.focus {terminal}` without a pane). */
  #block: string | null = null;

  /** This device's `focused()`: Herdr's shape, resolved against the Mac's state. */
  current(w: SessionWorld): Focused | null {
    const space = this.#spaceOf(w);
    if (!space) return null;
    const tab = this.#tabOf(w, space);
    const pane = this.#block === null && tab ? this.#paneOf(w, tab) : undefined;
    const terminal = this.#block ?? pane?.terminal ?? null;
    const agent = (this.#agent && w.agents.some((a) => a.address === this.#agent) ? this.#agent : null) ??
      (terminal && w.agents.some((a) => a.address === terminal) ? terminal : null) ??
      w.focused?.agent ?? w.agents[0]?.address ?? null;
    return {
      space: space.id,
      tab: tab ?? "",
      pane: pane?.pane ?? null,
      terminal,
      shown: pane && w.focused?.pane === pane.pane ? w.focused.shown : null,
      agent,
      cwd: pane?.cwd ?? null,
    };
  }

  /** The zoomed pane of the tab this device shows, or `null`. */
  zoomed(w: SessionWorld): string | null {
    const space = this.#spaceOf(w);
    const tab = space && this.#tabOf(w, space);
    return tab ? this.#zoomedIn(w, tab) : null;
  }

  /**
   * This device's {@link SessionView} (Herdr: "Selection, focus, zoom and settled state belong to this screen only"):
   * the space it shows is the `active` one, each space's `active` tab is the one shown there, only its focused pane is
   * `focused` (none while a terminal block is) with that pane's agent, and each tab and pane is `zoomed` as zoomed
   * here. `zoom: false` (a phone, which never zooms) reports nothing zoomed.
   */
  view(w: SessionWorld, zoom = true): SessionView {
    const focused = this.current(w);
    const pane = focused?.pane ?? null;
    const zoomed = new Map<string, string | null>();
    const zoomedIn = (tab: string): string | null => {
      if (!zoom) return null;
      if (!zoomed.has(tab)) zoomed.set(tab, this.#zoomedIn(w, tab));
      return zoomed.get(tab) ?? null;
    };
    return {
      spaces: w.spaces.map((s) => {
        const shown = this.#tabOf(w, s);
        return {
          ...s,
          active: s.id === focused?.space,
          tabs: s.tabs.map((t) => ({ ...t, active: t.id === shown, zoomed: zoomedIn(t.id) !== null })),
        };
      }),
      panes: w.panes.map((p) => ({ ...p, focused: p.pane === pane, zoomed: zoomedIn(p.tab) === p.pane })),
      agents: w.agents.map((a) => ({ ...a, focused: pane !== null && a.pane === pane })),
      focused,
    };
  }

  /** Applies a focus command; returns `null` on success or why it was refused. */
  apply(name: FocusCommand, args: JsonObject, w: SessionWorld): string | null {
    const spaces = [...w.spaces].sort((a, b) => a.index - b.index);
    const current = this.#spaceOf(w);
    switch (name) {
      case "space.select": {
        const index = indexArg(args.index);
        const s = typeof args.id === "string"
          ? spaces.find((x) => x.id === args.id)
          : spaces.find((x) => x.index === index);
        if (!s) return "no such space";
        this.#showSpace(s.id);
        return null;
      }
      case "space.next":
      case "space.prev": {
        if (!current) return "no spaces";
        this.#showSpace(step(spaces, spaces.indexOf(current), name === "space.next").id);
        return null;
      }
      case "tab.select": {
        if (typeof args.id === "string") {
          const s = spaces.find((x) => x.tabs.some((t) => t.id === args.id));
          if (!s) return "no such tab";
          this.#showTab(s.id, args.id);
          return null;
        }
        const index = indexArg(args.index);
        const t = current?.tabs.find((x) => x.index === index);
        if (!current || !t) return "no such tab";
        this.#showTab(current.id, t.id);
        return null;
      }
      case "tab.next":
      case "tab.prev": {
        if (!current || current.tabs.length === 0) return "no tabs";
        const tabs = [...current.tabs].sort((a, b) => a.index - b.index);
        const at = tabs.findIndex((t) => t.id === this.#tabOf(w, current));
        this.#showTab(current.id, step(tabs, Math.max(at, 0), name === "tab.next").id);
        return null;
      }
      case "pane.focus": {
        const pane = typeof args.pane === "string"
          ? w.panes.find((p) => p.pane === args.pane)
          : typeof args.terminal === "string"
          ? w.panes.find((p) => p.terminal === args.terminal)
          : undefined;
        if (pane) return this.#focusPane(w, pane) ? null : "the pane's tab is not in any space";
        if (typeof args.terminal !== "string" || args.terminal === "") return "no such pane";
        // [I] Herdr prefers a visible layout terminal block; a terminal no pane shows is focused as a block here.
        this.#block = args.terminal;
        return null;
      }
      case "pane.go": {
        const dir = args.direction;
        if (dir !== "left" && dir !== "right" && dir !== "up" && dir !== "down") {
          return "direction must be left/right/up/down";
        }
        const f = this.current(w);
        const panes = w.panes.filter((p) => p.tab === f?.tab);
        const at = panes.findIndex((p) => p.pane === f?.pane);
        // [I] Without the tab's split geometry: left/up = the previous pane, right/down = the next, in tab order.
        const next = panes[at + (dir === "left" || dir === "up" ? -1 : 1)];
        if (at >= 0 && next) this.#focusPane(w, next);
        return null;
      }
      case "pane.zoom": {
        const f = this.current(w);
        const pane = typeof args.pane === "string" ? w.panes.find((p) => p.pane === args.pane) : undefined;
        const target = pane ?? w.panes.find((p) => p.pane === f?.pane);
        if (!target) return "no pane to zoom";
        const zoomed = this.#zoomedIn(w, target.tab);
        this.#zoom.set(target.tab, zoomed === target.pane ? null : target.pane);
        return null;
      }
      case "agent.focus": {
        if (typeof args.terminal !== "string" || args.terminal === "") return "terminal is required";
        this.#showAgent(w, args.terminal);
        return null;
      }
      case "agent.next":
      case "agent.prev": {
        const order = agentOrder(w);
        if (order.length === 0) return "no agents";
        const at = order.indexOf(this.current(w)?.agent ?? "");
        this.#showAgent(w, at < 0 ? order[0] : step(order, at, name === "agent.next"));
        return null;
      }
    }
  }

  #spaceOf(w: SessionWorld): SpaceInfo | undefined {
    return w.spaces.find((s) => s.id === this.#space) ?? w.spaces.find((s) => s.id === w.focused?.space) ??
      w.spaces.find((s) => s.active) ?? [...w.spaces].sort((a, b) => a.index - b.index)[0];
  }

  /** A tab's zoomed pane here: this device's zoom, else the Mac's. */
  #zoomedIn(w: SessionWorld, tab: string): string | null {
    if (this.#zoom.has(tab)) return this.#zoom.get(tab) ?? null;
    return w.panes.find((p) => p.tab === tab && p.zoomed)?.pane ?? null;
  }

  #tabOf(w: SessionWorld, space: SpaceInfo): string | undefined {
    const mine = this.#tabs.get(space.id);
    if (mine && space.tabs.some((t) => t.id === mine)) return mine;
    if (w.focused?.space === space.id && space.tabs.some((t) => t.id === w.focused?.tab)) return w.focused.tab;
    return (space.tabs.find((t) => t.active) ?? [...space.tabs].sort((a, b) => a.index - b.index)[0])?.id;
  }

  #paneOf(w: SessionWorld, tab: string): PaneInfo | undefined {
    const panes = w.panes.filter((p) => p.tab === tab);
    const mine = this.#panes.get(tab);
    return panes.find((p) => p.pane === mine) ??
      (w.focused?.tab === tab ? panes.find((p) => p.pane === w.focused?.pane) : undefined) ??
      panes.find((p) => p.focused) ?? panes[0];
  }

  #showSpace(space: string): void {
    this.#space = space;
    this.#block = null;
  }

  #showTab(space: string, tab: string): void {
    this.#showSpace(space);
    this.#tabs.set(space, tab);
  }

  /** Shows a pane's tab and focuses the pane; `false` when no space holds its tab. */
  #focusPane(w: SessionWorld, pane: PaneInfo): boolean {
    const space = w.spaces.find((s) => s.tabs.some((t) => t.id === pane.tab));
    if (!space) return false;
    this.#showTab(space.id, pane.tab);
    this.#panes.set(pane.tab, pane.pane);
    return true;
  }

  /** `agent.focus`: the agent blocks show it, and its pane (when it has one) is shown and focused. */
  #showAgent(w: SessionWorld, terminal: string): void {
    this.#agent = terminal;
    const a: AgentInfo | undefined = w.agents.find((x) => x.address === terminal);
    const pane = w.panes.find((p) => p.pane === a?.pane) ?? w.panes.find((p) => p.terminal === terminal);
    if (pane) this.#focusPane(w, pane);
  }
}

/** The next/previous item, wrapping around. [I] Herdr's wrap behaviour at the ends is not published. */
function step<T>(items: readonly T[], at: number, forward: boolean): T {
  return items[(at + (forward ? 1 : -1) + items.length) % items.length];
}

/** A 1-based position from a number or a keys.json shorthand string (`tab.select:2`). */
function indexArg(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  return typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined;
}

/** `agent.next/prev` order: the mods' `setAgentOrder` list (live agents only), then the rest in model order. */
function agentOrder(w: SessionWorld): string[] {
  const live = w.agents.map((a) => a.address);
  const ordered = (w.agentOrder ?? []).filter((a) => live.includes(a));
  return [...ordered, ...live.filter((a) => !ordered.includes(a))];
}
