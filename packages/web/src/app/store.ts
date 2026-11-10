/**
 * The app's state: one immutable snapshot replaced on every change, read by React through `useApp(selector)`
 * (`useSyncExternalStore`). Bridge data (hello, ScreenGraph, live state, view trees, overlays) is updated by
 * `client.ts`; the navigator's optimistic graph, toasts and shell panels by the UI.
 */

import { useSyncExternalStore } from "react";
import type {
  BridgeHello,
  DeviceClass,
  ElementNode,
  NodeProfile,
  Overlay,
  ScreenGraph,
  Snapshot,
  TermSize,
  Toast,
} from "@herdr-relay/protocol";
import type { DeviceView } from "./api.ts";

/** The live state of a `snapshot`, minus its envelope (`patch.state` pointers address this object). */
export type LiveState = Omit<Snapshot, "t" | "seq">;

/** Whether this browser may reach the bridge, and as whom. */
export type Gate =
  | { kind: "checking" }
  | { kind: "ready"; via: "local" | "tailnet"; device: DeviceView | null }
  | { kind: "pair"; pairing: boolean; login: string | null }
  | { kind: "denied"; status: number; why: string };

/** The device socket. `retry`: waiting `retryAt` (epoch ms) before attempt `attempt`. */
export type Conn =
  | { kind: "idle" }
  | { kind: "connecting"; attempt: number }
  | { kind: "live"; since: number }
  | { kind: "retry"; attempt: number; retryAt: number; why: string };

export interface ToastItem extends Omit<Toast, "t"> {
  key: number;
  /** Shown since (epoch ms). */
  at: number;
  /** Local toasts (connection, refusals) vs the bridge's. */
  local?: boolean;
  /** A mod's `write_to_clipboard` text, offered with a Copy button (`clipboard`). */
  copy?: string;
}

export type ShellPanel = "none" | "device";

export interface AppState {
  gate: Gate;
  conn: Conn;
  hello: BridgeHello | null;
  /** The bridge's ScreenGraph (`hello.screens`, then `patch.screens`). */
  graph: ScreenGraph | null;
  /** A navigation applied locally and not yet answered by the bridge. */
  optimistic: ScreenGraph | null;
  /**
   * Layout profile changes this device sent (`layout set`) that the bridge's ScreenGraph does not show yet, by node id:
   * drawn at once, dropped when `patch.screens` carries them or the bridge refuses.
   */
  sizing: Readonly<Record<string, NodeProfile>>;
  /**
   * Bumped whenever the graph is replaced wholesale (a bridge `hello`, the cache): the navigator shows that graph's
   * stack as it is, without enter/exit animations; only navigation within one epoch animates.
   */
  graphEpoch: number;
  live: LiveState | null;
  views: Readonly<Record<string, ElementNode>>;
  overlays: readonly Overlay[];
  terms: Readonly<Record<string, TermSize>>;
  /** Highest `seq` received (`hello.since` on reconnect). */
  seq: number | null;
  /** Showing data the bridge has not confirmed this connection (cache or a lost socket), received at `since`. */
  stale: { since: number } | null;
  /** When the data shown was last confirmed live (epoch ms). */
  receivedAt: number | null;
  toasts: readonly ToastItem[];
  deviceClass: DeviceClass;
  panel: ShellPanel;
}

type Listener = () => void;

/** Nothing received yet: the state `boot` starts from, and what a renderer outside the app (tests, server rendering) reads. */
export function blankState(deviceClass: DeviceClass): AppState {
  return {
    gate: { kind: "checking" },
    conn: { kind: "idle" },
    hello: null,
    graph: null,
    optimistic: null,
    sizing: {},
    graphEpoch: 0,
    live: null,
    views: {},
    overlays: [],
    terms: {},
    seq: null,
    stale: null,
    receivedAt: null,
    toasts: [],
    deviceClass,
    panel: "none",
  };
}

let state: AppState = blankState("phone");
const listeners = new Set<Listener>();

export function initStore(initial: AppState): void {
  state = initial;
}

export function getState(): AppState {
  return state;
}

/** Replaces part of the state and notifies subscribers (no-op when nothing changed by reference). */
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
  const p = typeof patch === "function" ? patch(state) : patch;
  let changed = false;
  for (const key of Object.keys(p) as (keyof AppState)[]) {
    if (state[key] !== p[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return;
  state = { ...state, ...p };
  for (const l of listeners) l();
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Subscribes a component to `select(state)`; `select` must return stable references for unchanged data. */
export function useApp<T>(select: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}

/** The graph on screen: the optimistic one while a navigation is in flight. */
export function shownGraph(s: AppState): ScreenGraph | null {
  return s.optimistic ?? s.graph;
}

let toastKey = 0;

/** Shows a toast; returns its key. */
export function pushToast(t: Omit<ToastItem, "key" | "at">): number {
  const key = ++toastKey;
  setState((s) => ({ toasts: [...s.toasts.slice(-4), { ...t, key, at: Date.now() }] }));
  return key;
}

export function dismissToast(key: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.key !== key) }));
}
