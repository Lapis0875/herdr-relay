/**
 * One device session (DESIGN.md §3 "Command interception", DESIGN-v2 §2.4 `session` class): its navigator stack, its
 * own layout clicks (never written to the Mac), its focus and its peek. The ScreenGraph it serves is `recompose()` of
 * the Mac's layout + the Mac's clicks + its device's layout profile (D12) + this session's clicks, carrying this
 * session's stack. On phone and tablet-portrait a push/sheet route is on the stack exactly when its panel is shown in
 * this session's `layout()`, so mods reading `layout().hidden` see what the device shows and their `layout.toggle` does
 * what the person expects.
 *
 * Device layout profile (`./profiles.ts`): the section for the shown layout and this class is read at construction,
 * on a layout switch and a class change, and when another session of the device changed it
 * ({@link Session.reloadProfile}). A client `layout set` changes the entries of `overridable()` nodes all or none (a
 * node not resizable here, a size of the other kind, … refuses the whole message); `layout.resize` (a mod's `run`, a
 * command) on such a node with a size of its kind sets its entry too, and on any other node stays a size click of this
 * session only, as before profiles. Size clicks apply before the profile, hidden/active clicks after it, so the nodes
 * this session accepts entries for are exactly those its graph marks `resize`. Rate limits are the caller's.
 */

import {
  type AckError,
  applyClicks,
  applyProfile,
  type ClickState,
  type CommandInfo,
  type DeviceClass,
  type Focused,
  HOME_ROUTE,
  type JsonObject,
  type LayoutMessage,
  type LayoutNode,
  type LayoutProfileSection,
  type NamedLayout,
  type Nav,
  type NodeClicks,
  type NodeProfile,
  overridable,
  type OverridableNode,
  profiledNodes,
  recomposeTree,
  routeContaining,
  routeOfNode,
  routeWithKind,
  type Scope,
  type ScreenGraph,
  type ScreenRoute,
} from "@herdr-relay/protocol";
import { classifyCommand, parseAction } from "./commands.ts";
import { isFocusCommand, SessionFocus, type SessionView, type SessionWorld } from "./focus.ts";
import { type DeviceProfile, LayoutProfileStore, ProfileRefusal } from "./profiles.ts";

/** A navigator operation a command or `nav` performed (`push` of `/` = back to the home route). */
export interface NavOp {
  action: "push" | "pop" | "replace";
  route: string;
}

/** Work for the view manager: overlays opened or closed on this device only. */
export type SessionEffect = { kind: "overlay.open"; mod: string } | { kind: "overlay.close"; id?: string };

export interface SessionOutcome {
  ok: boolean;
  error?: AckError;
  message?: string;
  nav: NavOp[];
  /**
   * `screens`: send `patch.screens`; `layout`: this session's `layout()` changed; `focus`: its {@link Session.view}
   * (`focused()`, or a selection, focus or zoom flag of `spaces()`/`panes()`/`agents()`); `profile`: this session
   * changed its device's layout profile (the device's other sessions reload it).
   */
  changed: { screens: boolean; layout: boolean; focus: boolean; profile: boolean };
  effects: SessionEffect[];
}

/** What the bridge does with a `run()` / `command`: apply here, route to a mod, `herdr-app do` (E9), or refuse. */
export type RunOutcome =
  | ({ class: "session" } & SessionOutcome)
  | { class: "mod"; folder: string; command: string }
  | { class: "passthrough"; name: string; args: JsonObject }
  | { class: "refused"; error: AckError; message: string };

export interface RunContext {
  /** Mod folders with a running host (for `<folder>.<command>`). */
  modFolders: Iterable<string>;
  /** Herdr's `commands()` (resolves keys.json `name:value` shorthand). */
  commands?: readonly CommandInfo[];
}

export interface SessionOptions {
  id: string;
  scope: Scope;
  device: DeviceClass;
  /** The Mac's shown layout file. */
  layout: NamedLayout;
  /** The Mac's `layouts/.state/<name>.json`, validated with `ClickStateSchema`. */
  clicks: ClickState | null;
  /** The Mac's live state, for focus commands; without it they are refused. */
  world?: () => SessionWorld;
  /** The device's layout profile (`LayoutProfileStore.device(id)`); default: kept by this session only. */
  profile?: DeviceProfile;
}

export class Session {
  readonly id: string;
  readonly scope: Scope;
  #device: DeviceClass;
  #layout: NamedLayout;
  #clicks: ClickState | null;
  readonly #world?: () => SessionWorld;
  readonly #store: DeviceProfile;
  /** The device's profile section for the shown layout and this class. Replaced, never changed in place. */
  #profile: LayoutProfileSection;
  /** `overridable()` of the tree the profile applies to, as of the last recompose (the graph's `resize` nodes). */
  #slots = new Map<string, OverridableNode>();
  /** This session's `hidden`/`active` clicks by node id; applied over the Mac's and the profile. */
  readonly #overrides = new Map<string, NodeClicks>();
  /** This session's size clicks (`layout.resize` outside the profile) by node id; applied before the profile. */
  readonly #sizes = new Map<string, Size>();
  readonly #focus = new SessionFocus();
  #stack: string[] = [HOME_ROUTE];
  #peek: string | null = null;
  #tree: LayoutNode;
  #graph: ScreenGraph;

  constructor(o: SessionOptions) {
    this.id = o.id;
    this.scope = o.scope;
    this.#device = o.device;
    this.#layout = o.layout;
    this.#clicks = o.clicks;
    this.#world = o.world;
    this.#store = o.profile ?? LayoutProfileStore.memory().device(o.id);
    this.#profile = this.#store.section(o.layout.name, o.device);
    [this.#tree, this.#graph] = this.#recompose(true);
  }

  get device(): DeviceClass {
    return this.#device;
  }

  /** The ScreenGraph for `hello.screens` / `patch.screens`: this session's stack, plus its peek sheet. */
  get graph(): ScreenGraph {
    const g = this.#graph;
    const peek = this.#peek;
    return {
      ...g,
      stack: [...this.#stack],
      sheets: peek
        ? [...g.sheets, {
          id: `peek:${peek}`,
          edge: "bottom",
          align: "center",
          screen: { kind: "terminal", id: `peek:${peek}`, terminal: peek },
        }]
        : g.sheets,
    };
  }

  /** This session's effective layout: `hello.layout`, and what `layout()` returns for calls it originates. */
  get layout(): NamedLayout {
    return { name: this.#layout.name, tree: this.#tree };
  }

  /** The terminal this session peeks at (`terminal.peek`), or `null`. */
  get peek(): string | null {
    return this.#peek;
  }

  /** This session's `focused()`, or `null` without Mac state. */
  focused(): Focused | null {
    const w = this.#world?.();
    return w ? this.#focus.current(w) : null;
  }

  /** The zoomed pane of the shown tab; always `null` on a phone (one pane at a time; zoom is a no-op). */
  zoomed(): string | null {
    const w = this.#world?.();
    return w && this.#device !== "phone" ? this.#focus.zoomed(w) : null;
  }

  /**
   * This session's `spaces()`, `panes()`, `agents()` and `focused()`: the Mac's lists with this device's own selection,
   * focus and zoom (none on a phone), as its snapshot and — for the lead session — the mod hosts read them; `null`
   * without Mac state.
   */
  view(): SessionView | null {
    const w = this.#world?.();
    return w ? this.#focus.view(w, this.#device !== "phone") : null;
  }

  /**
   * The device class changed (rotation, Split View): recompose with that class's profile section and reopen at its
   * initial stack.
   */
  setDevice(device: DeviceClass): SessionOutcome {
    return this.#track(() => {
      if (device === this.#device) return false;
      this.#device = device;
      this.#profile = this.#store.section(this.#layout.name, device);
      return true;
    });
  }

  /**
   * The Mac's layout file or clicks changed. The same layout keeps this session's clicks, stack and profile section
   * (unknown ids are ignored; sizes are clamped to the file's bounds again); another layout (`layout.switch`) starts
   * over with that layout's section.
   */
  setLayout(layout: NamedLayout, clicks: ClickState | null): SessionOutcome {
    return this.#track(() => {
      const switched = layout.name !== this.#layout.name;
      if (switched) {
        this.#overrides.clear();
        this.#sizes.clear();
        this.#profile = this.#store.section(layout.name, this.#device);
      }
      this.#layout = layout;
      this.#clicks = clicks;
      return switched;
    });
  }

  /** Another session of this device changed its layout profile: reads this layout and class's section again. */
  reloadProfile(): SessionOutcome {
    return this.#track(() => {
      this.#profile = this.#store.section(this.#layout.name, this.#device);
    });
  }

  /**
   * A client `layout` message. `set`: the changes, each to a different `overridable()` node, applied to this layout
   * and class's section all or none (a size of the node's kind, `collapsed` on R2 panels; other fields of an entry
   * kept); a node not resizable here, a size of the other kind, `collapsed` on a node that cannot collapse, a node
   * listed twice, a change with neither and a profile over its cap refuse the whole message. `reset`: one node's entry
   * or, without `node`, the whole section.
   */
  layoutProfile(msg: LayoutMessage): SessionOutcome {
    return this.#track((o) => {
      if (msg.action === "reset") {
        if (msg.node === undefined) return this.#putProfile({}, o);
        if (!Object.hasOwn(this.#profile, msg.node)) return;
        const rest = { ...this.#profile };
        delete rest[msg.node];
        return this.#putProfile(rest, o);
      }
      // A Map, not object assignment: a node id may be `__proto__`.
      const next = new Map(Object.entries(this.#profile));
      const seen = new Set<string>();
      for (const c of msg.changes) {
        if (seen.has(c.node)) return fail(o, "refused", `${c.node} is listed twice`);
        seen.add(c.node);
        const slot = this.#slots.get(c.node);
        if (!slot) return fail(o, "refused", `${c.node} is not resizable on this device`);
        if (c.size === undefined && c.collapsed === undefined) {
          return fail(o, "refused", `${c.node}: size or collapsed is required`);
        }
        const entry: NodeProfile = { ...next.get(c.node) };
        if (c.size !== undefined) {
          const size: Size = "px" in c.size ? { px: c.size.px } : { weight: c.size.weight };
          const kind = "px" in size ? "px" : "weight";
          if (kind !== slot.kind) return fail(o, "refused", `${c.node} takes a ${slot.kind} size, not ${kind}`);
          setSize(entry, size);
        }
        if (c.collapsed !== undefined) {
          if (!slot.collapsible) return fail(o, "refused", `${c.node} cannot collapse`);
          entry.collapsed = c.collapsed;
        }
        next.set(c.node, entry);
      }
      this.#putProfile(Object.fromEntries(next), o);
    });
  }

  /** A client `nav` message. `pop` closes the peek sheet first. */
  nav(msg: Pick<Nav, "action" | "route" | "stack" | "child">): SessionOutcome {
    return this.#track((o) => {
      if (msg.action === "select") {
        if (!msg.stack || !msg.child) return fail(o, "refused", "select needs stack and child");
        return this.#select(msg.stack, msg.child, o);
      }
      if (msg.action === "pop") {
        if (this.#peek !== null) this.#peek = null;
        else if (this.#stack.length > 1) this.#remove(this.#stack[this.#stack.length - 1], o);
        return;
      }
      const route = this.#graph.routes.find((r) => r.path === msg.route);
      if (!route) return fail(o, "refused", `no route ${msg.route ?? "(none)"}`);
      if (msg.action === "push") this.#push(route, o);
      else this.#replace(route, o);
    });
  }

  /**
   * Decides a `run(name, args)` from a mod copy acting for this session, or a client `command`: `session` commands are
   * applied here; `mod` and `passthrough` need `act` scope; `structural` and unknown names are refused.
   */
  run(name: string, args: JsonObject | undefined, ctx: RunContext): RunOutcome {
    const action = parseAction(name, args, ctx.commands ?? []);
    const c = classifyCommand(action.name, ctx.modFolders);
    switch (c.class) {
      case "session":
        return { class: "session", ...this.intercept(c.name, action.args) };
      case "structural":
        return { class: "refused", error: "structural", message: c.message };
      case "unknown":
        return { class: "refused", error: "refused", message: `unknown command: ${c.name}` };
    }
    if (this.scope !== "act") return { class: "refused", error: "read-only-device", message: "read-only device" };
    if (c.class === "mod") return { class: "mod", folder: c.folder, command: c.command };
    const filled: JsonObject = { ...action.args };
    const f = this.focused();
    for (const key of c.fill) if (filled[key] === undefined && f?.[key]) filled[key] = f[key];
    return { class: "passthrough", name: c.name, args: filled };
  }

  /** Applies one `session`-class command (commands.json) to this session. */
  intercept(name: string, args: JsonObject): SessionOutcome {
    return this.#track((o) => {
      const phone = this.#device === "phone";
      switch (name) {
        case "layout.select":
          if (typeof args.stack !== "string" || typeof args.child !== "string") {
            return fail(o, "refused", "stack and child are required");
          }
          return this.#select(args.stack, args.child, o);
        case "layout.show":
        case "layout.hide":
        case "layout.toggle":
          if (typeof args.id !== "string") return fail(o, "refused", "id is required");
          return this.#visibility(args.id, name === "layout.toggle" ? "toggle" : name === "layout.show", o);
        case "layout.resize":
          return phone ? undefined : this.#resize(args, o);
        case "terminal.peek":
          if (typeof args.terminal !== "string" || args.terminal === "") {
            return fail(o, "refused", "terminal is required");
          }
          this.#peek = args.terminal;
          return;
        case "mod.open":
          if (typeof args.name !== "string" || args.name === "") return fail(o, "refused", "name is required");
          o.effects.push({ kind: "overlay.open", mod: args.name });
          return;
        case "overlay.close":
          if (typeof args.id === "string") o.effects.push({ kind: "overlay.close", id: args.id });
          else if (this.#peek !== null) this.#peek = null;
          else o.effects.push({ kind: "overlay.close" });
          return;
      }
      if (!isFocusCommand(name)) return fail(o, "refused", `${name} is not a session command`);
      if (name === "pane.zoom" && phone) return;
      const w = this.#world?.();
      if (!w) return fail(o, "refused", "Herdr's state is not available yet");
      const error = this.#focus.apply(name, args, w);
      if (error) return fail(o, "refused", error);
      // Phone: show the pane group's route (DESIGN.md §3); zoom stays where it is.
      const panes = phone && name !== "pane.zoom" ? routeWithKind(this.#graph, "panes") : undefined;
      if (panes) this.#push(panes, o);
    });
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  /**
   * Runs a change, recomposes and reports what changed. Every change validates before it mutates, so a refused one
   * leaves the session as it was. `change` returns `true` to reopen at the class's initial stack.
   */
  #track(change: (o: SessionOutcome) => boolean | void): SessionOutcome {
    const before = [JSON.stringify(this.graph), JSON.stringify(this.#tree), JSON.stringify(this.view())];
    const o: SessionOutcome = {
      ok: true,
      nav: [],
      changed: { screens: false, layout: false, focus: false, profile: false },
      effects: [],
    };
    const reset = change(o) === true;
    if (o.ok) [this.#tree, this.#graph] = this.#recompose(reset);
    o.changed = {
      screens: JSON.stringify(this.graph) !== before[0],
      layout: JSON.stringify(this.#tree) !== before[1],
      focus: JSON.stringify(this.view()) !== before[2],
      profile: o.changed.profile,
    };
    return o;
  }

  /**
   * Recomposes and settles the stack (`reset`: the class's initial stack): the Mac's layout and clicks, this session's
   * size clicks, then the profile section (`overridden`: `profiledNodes()`, the nodes an entry actually changes), then
   * this session's hidden/active clicks — which do not change what `overridable()` names, so `#slots` are exactly the
   * graph's `resize` nodes. Ties push/sheet routes to their panels' `hidden` in this session's clicks, so `layout()`
   * matches the navigator.
   */
  #recompose(reset: boolean): [LayoutNode, ScreenGraph] {
    const clicked = applyClicks(this.#layout.tree, this.#clicks);
    const sized = this.#sizes.size === 0
      ? clicked
      : applyClicks(clicked, { nodes: Object.fromEntries([...this.#sizes].map(([id, size]) => [id, { size }])) });
    this.#slots = overridable(sized, this.#device);
    const overridden = profiledNodes(sized, this.#profile, this.#device);
    const base = applyProfile(sized, this.#profile, this.#device);
    const build = (): [LayoutNode, ScreenGraph] => {
      const tree = applyClicks(base, { nodes: Object.fromEntries(this.#overrides) });
      const graph = recomposeTree(this.#layout.name, tree, this.#device);
      if (overridden.length > 0) graph.overridden = overridden;
      return [tree, graph];
    };
    let [tree, graph] = build();
    const stack = reset
      ? graph.stack
      : [HOME_ROUTE, ...this.#stack.filter((p) => p !== HOME_ROUTE && graph.routes.some((r) => r.path === p))];
    let tied = false;
    for (const r of graph.routes) {
      if (r.open !== "push" && r.open !== "sheet") continue;
      const shown = stack.includes(r.path);
      if (r.mounted === shown) continue;
      this.#click(r.node, { hidden: !shown });
      tied = true;
    }
    if (tied) [tree, graph] = build();
    // A hidden drawer cannot stay open.
    this.#stack = stack.filter((p) => p === HOME_ROUTE || graph.routes.some((r) => r.path === p && r.mounted));
    return [tree, graph];
  }

  /** Replaces this layout and class's profile section in the store (refused over its cap) and here. */
  #putProfile(section: LayoutProfileSection, o: SessionOutcome): void {
    try {
      this.#store.put(this.#layout.name, this.#device, section);
    } catch (e) {
      if (e instanceof ProfileRefusal) return fail(o, "refused", e.message);
      throw e;
    }
    this.#profile = section;
    o.changed.profile = true;
  }

  #click(id: string, patch: NodeClicks): void {
    this.#overrides.set(id, { ...this.#overrides.get(id), ...patch });
  }

  #isDrawer(path: string): boolean {
    return this.#graph.routes.some((r) => r.path === path && r.open === "drawer");
  }

  /** Brings a route to the top: back to it when on the stack, else on top (closing the drawer for any other route). */
  #push(route: ScreenRoute, o: SessionOutcome): void {
    o.nav.push({ action: "push", route: route.path });
    if (route.path === HOME_ROUTE) {
      this.#stack = [HOME_ROUTE];
      return;
    }
    const stack = route.open === "drawer" ? this.#stack : this.#stack.filter((p) => !this.#isDrawer(p));
    const at = stack.indexOf(route.path);
    this.#stack = at >= 0 ? stack.slice(0, at + 1) : [...stack, route.path];
  }

  /** Shows a route in place of the top one (back to it when on the stack; on top of `/`). */
  #replace(route: ScreenRoute, o: SessionOutcome): void {
    o.nav.push({ action: "replace", route: route.path });
    if (route.path === HOME_ROUTE) {
      this.#stack = [HOME_ROUTE];
      return;
    }
    const stack = route.open === "drawer" ? this.#stack : this.#stack.filter((p) => !this.#isDrawer(p));
    const at = stack.indexOf(route.path);
    if (at >= 0) this.#stack = stack.slice(0, at + 1);
    else this.#stack = stack.length > 1 ? [...stack.slice(0, -1), route.path] : [...stack, route.path];
  }

  /** Takes a route (and everything above it) off the stack. */
  #remove(path: string, o: SessionOutcome): void {
    const at = this.#stack.indexOf(path);
    if (at <= 0) return;
    o.nav.push({ action: "pop", route: path });
    this.#stack = this.#stack.slice(0, at);
  }

  /** `layout.select` / `nav select`: phone navigation per DESIGN.md §3. */
  #select(stackId: string, child: string, o: SessionOutcome): void {
    const node = findNode(this.#tree, stackId);
    if (!node || node.type !== "stack" || !(node.children ?? []).some((c) => c.id === child)) {
      return fail(o, "refused", `no stack ${stackId} with child ${child}`);
    }
    this.#click(stackId, { active: child });
    if (this.#device !== "phone") return;
    const route = routeContaining(this.#graph, stackId);
    if (route && route.path !== this.#stack[this.#stack.length - 1]) this.#replace(route, o);
  }

  /** `layout.show/hide/toggle`: a routed panel is shown by being on the stack; any other node by `hidden`. */
  #visibility(id: string, show: boolean | "toggle", o: SessionOutcome): void {
    const node = findNode(this.#tree, id);
    if (!node) return fail(o, "refused", `no layout node ${id}`);
    const found = routeOfNode(this.#graph, id);
    const route = found && found.path !== HOME_ROUTE ? found : undefined;
    const shown = route ? this.#stack.includes(route.path) : node.hidden !== true;
    const want = show === "toggle" ? !shown : show;
    if (!route) return this.#click(id, { hidden: !want });
    if (route.open === "drawer") this.#click(id, { hidden: !want });
    if (want) this.#push(route, o);
    else this.#remove(route.path, o);
  }

  /**
   * `layout.resize {id, px | weight}` (not on a phone): an `overridable()` node given a size of its kind keeps it in
   * the device's profile (its `collapsed` stays); any other node takes it as a size click of this session only.
   */
  #resize(args: JsonObject, o: SessionOutcome): void {
    if (typeof args.id !== "string" || !findNode(this.#tree, args.id)) return fail(o, "refused", "no such layout node");
    const px = typeof args.px === "number" && args.px >= 0 ? args.px : undefined;
    const weight = typeof args.weight === "number" && args.weight >= 0 ? args.weight : undefined;
    if (px === undefined && weight === undefined) return fail(o, "refused", "px or weight is required");
    const size: Size = px !== undefined ? { px } : { weight: weight! };
    if (this.#slots.get(args.id)?.kind !== ("px" in size ? "px" : "weight")) {
      this.#sizes.set(args.id, size);
      return;
    }
    const entry: NodeProfile = Object.hasOwn(this.#profile, args.id) ? { ...this.#profile[args.id] } : {};
    setSize(entry, size);
    this.#putProfile({ ...this.#profile, [args.id]: entry }, o);
  }
}

/** A node size a profile entry or size click sets: fixed `px` or a `weight` share. */
type Size = { px: number } | { weight: number };

/** Sets a profile entry's size, dropping one of the other kind. */
function setSize(entry: NodeProfile, size: Size): void {
  delete entry.px;
  delete entry.weight;
  Object.assign(entry, size);
}

function fail(o: SessionOutcome, error: AckError, message: string): void {
  o.ok = false;
  o.error = error;
  o.message = message;
}

function findNode(n: LayoutNode, id: string): LayoutNode | undefined {
  if (n.id === id) return n;
  for (const c of [...(n.children ?? []), ...(n.floating ?? [])]) {
    const hit = findNode(c, id);
    if (hit) return hit;
  }
  return undefined;
}
