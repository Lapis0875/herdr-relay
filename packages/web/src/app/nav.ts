/**
 * Navigator logic over a ScreenGraph (DESIGN.md §3). The bridge's session owns the stack (`nav` → `patch.screens`);
 * the client applies the same operation locally first so a tap answers at once, and the bridge's graph replaces the
 * guess when it arrives. `applyNav` mirrors `Session.nav` (packages/bridge/src/session/session.ts): `push` brings a
 * route to the top (back to it when already on the stack; any non-drawer route closes the drawer), `replace` swaps
 * the top route, `pop` closes a peek sheet first, then the top route, and `select` switches a stack's destination
 * (on a phone it also replaces the top route with the one showing that stack).
 */

import {
  type DeviceClass,
  HOME_ROUTE,
  routeContaining,
  type ScreenGraph,
  type ScreenNode,
  type ScreenRoute,
} from "@herdr-relay/protocol";

export type NavRequest =
  | { action: "push"; route: string }
  | { action: "replace"; route: string }
  | { action: "pop" }
  | { action: "select"; stack: string; child: string };

export function routeByPath(graph: ScreenGraph, path: string): ScreenRoute | undefined {
  return graph.routes.find((r) => r.path === path);
}

/** The stack entries that name a route of the graph, `/` first. */
export function liveStack(graph: ScreenGraph): ScreenRoute[] {
  const out: ScreenRoute[] = [];
  for (const path of graph.stack) {
    const r = routeByPath(graph, path);
    if (r && !out.includes(r)) out.push(r);
  }
  const home = routeByPath(graph, HOME_ROUTE) ?? graph.routes[0];
  if (out[0] !== home) out.unshift(home);
  return out;
}

/** The route on screen (the last stack entry). */
export function topRoute(graph: ScreenGraph): ScreenRoute {
  const s = liveStack(graph);
  return s[s.length - 1];
}

/** The open drawer route, if the drawer is on the stack. */
export function openDrawer(graph: ScreenGraph): ScreenRoute | undefined {
  return liveStack(graph).find((r) => r.open === "drawer");
}

/** The drawer route of the graph (open or not). */
export function drawerRoute(graph: ScreenGraph): ScreenRoute | undefined {
  return graph.routes.find((r) => r.open === "drawer");
}

/**
 * The bar that carries the shell button at its leading edge: the first row bar of a screen, depth-first (lstack:
 * `topbar`); on a phone, else the block bar the screen starts with (Herdr's `main`: `tabs`), which is then drawn as a
 * row so the button takes its own place beside the bar's mod instead of floating over its first item. Null: the
 * button floats at the top-left.
 */
export function leadingBarOf(node: ScreenNode, deviceClass: DeviceClass): string | null {
  return firstRowBar(node) ?? (deviceClass === "phone" ? topBlockBar(node) : null);
}

function firstRowBar(node: ScreenNode): string | null {
  if (node.kind === "bar" && node.axis === "row") return node.id;
  if (node.kind === "split") {
    for (const c of node.children) {
      const hit = firstRowBar(c);
      if (hit) return hit;
    }
  }
  return null;
}

/** A screen's topmost node when it is a block bar (one mod across the top; its only child is itself), else null. */
function topBlockBar(node: ScreenNode): string | null {
  if (node.kind === "bar") return node.children.length === 1 && node.children[0].id === node.id ? node.id : null;
  if (node.kind === "split" && node.axis === "column" && node.children.length > 0) {
    return topBlockBar(node.children[0]);
  }
  return null;
}

/** Every group node with id `id` anywhere in the graph (routes and sheets). */
function* groups(graph: ScreenGraph): Generator<Extract<ScreenNode, { kind: "group" }>> {
  const visit = function* (n: ScreenNode): Generator<Extract<ScreenNode, { kind: "group" }>> {
    if (n.kind === "group") {
      yield n;
      for (const d of n.destinations) yield* visit(d.screen);
    } else if (n.kind === "split" || n.kind === "bar") {
      for (const c of n.children) yield* visit(c);
    }
  };
  for (const r of graph.routes) yield* visit(r.screen);
  for (const s of graph.sheets) yield* visit(s.screen);
}

export function findGroup(graph: ScreenGraph, id: string): Extract<ScreenNode, { kind: "group" }> | undefined {
  for (const g of groups(graph)) if (g.id === id) return g;
  return undefined;
}

function isDrawer(graph: ScreenGraph, path: string): boolean {
  return graph.routes.some((r) => r.path === path && r.open === "drawer");
}

function pushStack(graph: ScreenGraph, stack: string[], route: ScreenRoute): string[] {
  if (route.path === HOME_ROUTE) return [HOME_ROUTE];
  const s = route.open === "drawer" ? stack : stack.filter((p) => !isDrawer(graph, p));
  const at = s.indexOf(route.path);
  return at >= 0 ? s.slice(0, at + 1) : [...s, route.path];
}

function replaceStack(graph: ScreenGraph, stack: string[], route: ScreenRoute): string[] {
  if (route.path === HOME_ROUTE) return [HOME_ROUTE];
  const s = route.open === "drawer" ? stack : stack.filter((p) => !isDrawer(graph, p));
  const at = s.indexOf(route.path);
  if (at >= 0) return s.slice(0, at + 1);
  return s.length > 1 ? [...s.slice(0, -1), route.path] : [...s, route.path];
}

/**
 * The graph after `req`, or `null` when the request names nothing in this graph (the bridge would refuse it too).
 * The input is not mutated.
 */
export function applyNav(graph: ScreenGraph, req: NavRequest): ScreenGraph | null {
  const stack = liveStack(graph).map((r) => r.path);
  switch (req.action) {
    case "pop": {
      const peek = graph.sheets.findIndex((s) => s.id.startsWith("peek:"));
      if (peek >= 0) return { ...graph, sheets: graph.sheets.filter((_, i) => i !== peek) };
      return stack.length > 1 ? { ...graph, stack: stack.slice(0, -1) } : graph;
    }
    case "push":
    case "replace": {
      const route = routeByPath(graph, req.route);
      if (!route) return null;
      const next = req.action === "push" ? pushStack(graph, stack, route) : replaceStack(graph, stack, route);
      const routes = route.mounted ? graph.routes : graph.routes.map((r) => r === route ? { ...r, mounted: true } : r);
      return { ...graph, routes, stack: next };
    }
    case "select": {
      const group = findGroup(graph, req.stack);
      if (!group || !group.destinations.some((d) => d.id === req.child)) return null;
      const next = structuredClone(graph);
      for (const g of groups(next)) if (g.id === req.stack) g.active = req.child;
      if (graph.class === "phone") {
        const route = routeContaining(next, req.stack);
        const top = stack[stack.length - 1];
        if (route && route.path !== top) next.stack = replaceStack(next, stack, route);
      }
      return next;
    }
  }
}

/** A short title for a route or destination id (`home-agent` → `Home agent`). */
export function titleOf(id: string): string {
  const words = id.replace(/^peek:/, "").replace(/[-_]+/g, " ").trim();
  return words ? words[0].toUpperCase() + words.slice(1) : id;
}
