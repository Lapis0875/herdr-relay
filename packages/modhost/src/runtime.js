// Mod host runtime shared by every shim: the copy context (AsyncLocalStorage store `{copy, origin}`), the control
// channel sink, RPC/emit to the bridge, the `cx` object, render scheduling, key dispatch through the `cx.bind_keys`
// keymap (`keymap.js`) and the element recorder.
//
// One instance per mod host process = per mod folder; copies of that folder share it, as Herdr shares module code
// between copies ("Module code runs once per source version and is shared by copies"). `main.js` installs the sink
// before any mod code runs. A mod can import this file by URL (it is inside the host's read scope), but everything it
// could do with it is attributed to its own folder by the bridge, so it gains nothing it could not do through `herdr`.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  flushKeys,
  Keymap,
  parseBindings,
  parseKeyContext,
  PENDING_INPUT_MS,
  resolveKey,
  typedKeystroke,
} from "./keymap.js";

// Captured before any mod code runs, so a mod replacing these globals cannot redirect other copies' work.
const timeout = globalThis.setTimeout.bind(globalThis);
const interval = globalThis.setInterval.bind(globalThis);
const clearT = globalThis.clearTimeout.bind(globalThis);
const clearI = globalThis.clearInterval.bind(globalThis);
const now = performance.now.bind(performance);
const stderr = Deno.stderr.writeSync.bind(Deno.stderr);
const encoder = new TextEncoder();

const als = new AsyncLocalStorage();
const alsRun = als.run.bind(als);
const alsStore = als.getStore.bind(als);

/** Lazy lists record at most this many rows, as a client's first window would show. */
export const LIST_WINDOW = 50;
/** At most one render per copy per this many ms (DESIGN-v2 §1.7). */
export const RENDER_INTERVAL_MS = 16;

/** Live herdr data pushed by the bridge in `boot`/`state`/`shared`; the sync `herdr` getters read it. */
export const host = { state: null };
/** The copies of this folder, by copy id. */
export const copies = new Map();
/**
 * `cx.bind_keys` bindings. Herdr's keymap is the app's; here it is the host's, shared by every copy of the folder (a
 * folder's bindings never reach another folder's views, which live in another process).
 */
const keymap = new Keymap();

// ---------------------------------------------------------------------------------------------------------------------
// Control channel sink and diagnostics.

let sink = null;

/** Installs the control channel writer. `main.js` calls it once, before the mod is imported; later calls throw. */
export function setSink(fn) {
  if (sink !== null) throw new Error("the control channel sink is already installed");
  sink = fn;
}

/** Queues one host → bridge message. `false` when it was not sent (no channel, or over the line limit). */
export function post(msg) {
  return sink === null ? false : sink(msg);
}

/** One line on stderr (piped to the bridge log, never parsed as protocol). */
export function diag(text) {
  try {
    stderr(encoder.encode(`herdr-modhost: ${text}\n`));
  } catch {
    // stderr closed: nothing else to tell.
  }
}

/** API names the mods touched that the host does not implement, with counts (diagnostics). */
export const unknown = new Map();

/**
 * Counts one use of an unimplemented API. The first use of each name is also reported to the bridge as
 * `error {where:"unknown-api", error:"<area>:<name>"}` and logged on stderr.
 */
export function noteUnknown(area, name) {
  const key = `${area}:${String(name)}`;
  const n = (unknown.get(key) ?? 0) + 1;
  unknown.set(key, n);
  if (n === 1) {
    diag(`unknown api ${key}`);
    post({ t: "error", copy: currentCopyId(), where: "unknown-api", error: key });
  }
}

/** Counts the call and returns the error the unsupported API throws or rejects with. */
export function unsupported(area, name) {
  noteUnknown(area, name);
  return new Error(`not supported remotely: ${area}.${String(name)}`);
}

export function errorText(error, max = 2000) {
  return String(error?.stack ?? error).slice(0, max);
}

/** Reports a failure in mod or host code (`error` message; the bridge strips paths before devices see it). */
export function report(copy, where, error) {
  post({ t: "error", copy: copy?.id ?? null, where, error: errorText(error) });
}

// ---------------------------------------------------------------------------------------------------------------------
// Copy context.

/** The current context `{copy, origin}`: the copy a host call belongs to and the device session it came from. */
export const currentStore = () => alsStore() ?? null;

function currentCopyId() {
  return (rendering ?? alsStore()?.copy)?.id ?? null;
}

/** The copy of the current host call; throws when called outside one (module scope, foreign timers). */
export function currentCopy(fn) {
  const store = alsStore();
  if (!store) throw outside(fn);
  return store.copy;
}

/** The origin to inherit when `copy` schedules more work from the current context. */
function inheritedOrigin(copy) {
  const store = alsStore();
  return store && store.copy === copy ? store.origin : null;
}

/** Runs `fn` as a host call of `copy` (a fresh store, so the origin of one entry never leaks into another). */
export function enter(copy, fn, origin = null) {
  return alsRun({ copy, origin }, fn);
}

function guarded(copy, where, origin, fn) {
  return enter(copy, () => {
    try {
      const r = fn();
      if (r && typeof r.then === "function") r.then(undefined, (e) => report(copy, where, e));
      return r;
    } catch (e) {
      report(copy, where, e);
    }
  }, origin);
}

// ---------------------------------------------------------------------------------------------------------------------
// RPC and emits. The bridge attributes every message to the connection's folder, never to the `copy`/`origin` carried
// here; `origin` only names the device session the call came from (a forged one can only reduce privileges).

let rpcSeq = 0;
const pending = new Map();

function outside(fn) {
  return new Error(`${fn}() called outside a copy's host call`);
}

/** A request the bridge answers with `rpc-result`; the copy and origin come from the current context. */
export function rpc(method, args) {
  const store = alsStore();
  if (!store) return Promise.reject(outside(method));
  return rpcAs(store.copy, store.origin, method, args);
}

/** A request on behalf of an explicit copy (host-initiated work such as persisting `localStorage`). */
export function rpcAs(copy, origin, method, args) {
  const id = ++rpcSeq;
  const { promise, resolve, reject } = Promise.withResolvers();
  pending.set(id, { resolve, reject });
  const msg = { t: "rpc", id, copy: copy.id, method, args };
  if (origin) msg.origin = origin;
  if (!post(msg)) {
    pending.delete(id);
    reject(new Error(`${method}: not sent (no control channel, or over the 4 MiB line limit)`));
  }
  return promise;
}

/** A fire-and-forget effect; the copy and origin come from the current context. */
export function emit(method, args) {
  const store = alsStore();
  if (!store) throw outside(method);
  const msg = { t: "emit", copy: store.copy.id, method, args };
  if (store.origin) msg.origin = store.origin;
  post(msg);
}

/** Resolves or rejects the pending request named by an `rpc-result`. */
export function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.value ?? null);
  else p.reject(new Error(String(msg.error ?? "refused by the bridge")));
}

// ---------------------------------------------------------------------------------------------------------------------
// Copies.

export class Copy {
  /** `storage` is the persisted `localStorage` from `create.storage` (protocol `StorageMap`); absent = empty. */
  constructor(id, props, placement, storage) {
    this.id = id;
    this.props = props;
    this.placement = placement ?? null;
    this.view = null;
    this.closed = false;
    /** Render scheduling. */
    this.scheduled = false;
    this.renderTimer = null;
    this.lastRender = -Infinity;
    /** Renders sent (`tree.n` of the latest); an `event` for another render runs no handler. */
    this.renders = 0;
    /** Handler ids of the latest sent render → functions; ids restart at 1 on every render. */
    this.handlers = new Map();
    this.handlerSeq = 0;
    /** The root element record of the latest sent render: where a key press finds its element's path. */
    this.root = null;
    /** Presses held as a chord prefix, `{entries, timer}` (`dispatchKey`). */
    this.pendingKeys = null;
    /** Undelivered commands `{command, origin}` and waiting `nextCommand()` calls `{store, resolve}`. */
    this.commands = [];
    this.waiters = [];
    this.timers = new Set();
    this.event = null;
    this.focusSeq = 0;
    this.focused = 0;
    /**
     * `localStorage` (seeded from `create.storage`, persisted through `storage.set`) and `sessionStorage` (memory) of
     * this copy.
     */
    this.local = new Map(Object.entries(storage ?? {}).map(([k, v]) => [k, String(v)]));
    this.session = new Map();
    this.persisting = null;
    this.persisted = null;
  }
}

/**
 * The copy's next command (`herdr.nextCommand()`). A delivered command's origin is written into the waiting caller's
 * context store, so the continuation after `await nextCommand()` — and what it starts — carries the session that sent
 * the command. Stores are per entry (`enter`, `cx.spawn`), so this never reaches another entry's work.
 */
export function nextCommand() {
  const store = alsStore();
  if (!store) throw outside("nextCommand");
  const copy = store.copy;
  const queued = copy.commands.shift();
  if (queued) {
    store.origin = queued.origin;
    return Promise.resolve(queued.command);
  }
  const { promise, resolve } = Promise.withResolvers();
  copy.waiters.push({ store, resolve });
  return promise;
}

/** Hands a bridge `command` to the copy's oldest `nextCommand()` waiter, or queues it. */
export function deliverCommand(copy, command, origin) {
  const waiter = copy.waiters.shift();
  if (waiter) {
    waiter.store.origin = origin;
    waiter.resolve(command);
  } else {
    copy.commands.push({ command, origin });
  }
}

/** Sends this copy's whole `localStorage` to the bridge (`storage.set [entries]`), coalesced per macrotask. */
export function persistLocalStorage(copy) {
  if (copy.persisting) return copy.persisting;
  const { promise, resolve, reject } = Promise.withResolvers();
  copy.persisting = promise;
  timeout(() => {
    copy.persisting = null;
    copy.persisted = promise;
    rpcAs(copy, null, "storage.set", [Object.fromEntries(copy.local)]).then(resolve, reject);
  }, 0);
  promise.catch((e) => report(copy, "localStorage", e));
  return promise;
}

/** Resolves once the pending `localStorage` write was accepted by the bridge. */
export function flushLocalStorage(copy) {
  return copy.persisting ?? copy.persisted ?? Promise.resolve();
}

export function closeCopy(copy) {
  copy.closed = true;
  if (copy.renderTimer !== null) clearT(copy.renderTimer);
  copy.renderTimer = null;
  for (const id of copy.timers) {
    clearT(id);
    clearI(id);
  }
  copy.timers.clear();
  copy.handlers.clear();
  copy.root = null;
  copy.pendingKeys = null;
  copy.waiters.length = 0;
}

// ---------------------------------------------------------------------------------------------------------------------
// cx.

let rendering = null;
export const renderingCopy = () => rendering;

function task(onCancel) {
  const t = { done: false, cancelled: false };
  return {
    t,
    handle: {
      cancel() {
        t.cancelled = true;
        onCancel?.();
      },
      is_done: () => t.done,
    },
  };
}

/** `cx.focus_handle()`: the JSON a tree carries for it is `{focus_handle: n}` (`track_focus`, `emit focus`). */
export function makeFocusHandle(copy) {
  const n = ++copy.focusSeq;
  const desc = { focus_handle: n };
  const handle = {
    focus() {
      copy.focused = n;
      emitFor(copy, "focus", [desc]);
    },
    is_focused: () => copy.focused === n,
    release: () => true,
  };
  hostObjects.set(handle, desc);
  return handle;
}

/** An emit attributed to `copy` with the current context's origin (when it belongs to that copy). */
export function emitFor(copy, method, args) {
  const msg = { t: "emit", copy: copy.id, method, args };
  const origin = inheritedOrigin(copy);
  if (origin) msg.origin = origin;
  post(msg);
}

const CX_UNSUPPORTED = new Set(["phase", "theme", "open_url", "read_from_clipboard", "new"]);
const NOT_API = new Set(["then", "toJSON", "constructor"]);

export function makeCx(copy) {
  const impl = {
    notify(target) {
      if (rendering === copy) throw new Error("cx.notify() during render");
      if (target !== undefined) noteUnknown("cx", "notify(target)");
      markDirty(copy);
    },
    /**
     * `App::bind_keys`: validates the whole list, then installs it in the keymap and answers how many. Illegal from
     * any render.
     */
    bind_keys(bindings) {
      if (rendering !== null) throw new Error("cx.bind_keys() during render");
      return keymap.add(parseBindings(bindings));
    },
    spawn(body) {
      const { t, handle } = task();
      enter(copy, () => {
        try {
          Promise.resolve(body(makeCx(copy))).then(
            () => (t.done = true),
            (e) => report(copy, "cx.spawn", e),
          );
        } catch (e) {
          report(copy, "cx.spawn", e);
        }
      }, inheritedOrigin(copy));
      return handle;
    },
    timer: {
      after(ms, handler) {
        const origin = inheritedOrigin(copy);
        const id = timeout(() => {
          copy.timers.delete(id);
          if (!t.cancelled && !copy.closed) guarded(copy, "cx.timer.after", origin, () => handler(makeCx(copy)));
          t.done = true;
        }, ms);
        const { t, handle } = task(() => {
          clearT(id);
          copy.timers.delete(id);
        });
        copy.timers.add(id);
        return handle;
      },
      every(ms, handler) {
        const origin = inheritedOrigin(copy);
        const id = interval(() => {
          if (!t.cancelled && !copy.closed) guarded(copy, "cx.timer.every", origin, () => handler(makeCx(copy)));
        }, ms);
        const { t, handle } = task(() => {
          clearI(id);
          copy.timers.delete(id);
        });
        copy.timers.add(id);
        return handle;
      },
    },
    stop_propagation() {
      if (copy.event) copy.event.stopped = true;
    },
    propagate() {
      if (copy.event) copy.event.stopped = false;
    },
    focus_handle() {
      if (rendering === copy) throw new Error("cx.focus_handle() during render");
      return makeFocusHandle(copy);
    },
    write_to_clipboard(text) {
      emitFor(copy, "write_to_clipboard", [String(text)]);
    },
    sleep(ms = 0) {
      const { promise, resolve } = Promise.withResolvers();
      timeout(resolve, ms);
      return promise;
    },
  };
  return new Proxy(impl, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== "string" || NOT_API.has(prop)) return undefined;
      noteUnknown("cx", prop);
      if (CX_UNSUPPORTED.has(prop)) {
        return () => {
          throw new Error(`not supported remotely: cx.${prop}`);
        };
      }
      return undefined;
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering and events.

/** Schedules a render of `copy`, at most one per `RENDER_INTERVAL_MS`. */
export function markDirty(copy) {
  if (copy.closed || copy.scheduled) return;
  copy.scheduled = true;
  const wait = Math.max(0, RENDER_INTERVAL_MS - (now() - copy.lastRender));
  copy.renderTimer = timeout(() => renderCopy(copy), wait);
}

export function markAllDirty() {
  for (const c of copies.values()) markDirty(c);
}

/**
 * Renders `copy` now and sends its whole `RecordedTree`; a failed render sends `error {where:"render"}` instead and
 * keeps the handlers and element records of the last tree sent (the bridge still shows that tree).
 */
export function renderCopy(copy) {
  if (copy.renderTimer !== null) clearT(copy.renderTimer);
  copy.renderTimer = null;
  copy.scheduled = false;
  if (copy.closed || !copy.view) return;
  const { handlers, handlerSeq } = copy;
  copy.handlers = new Map();
  copy.handlerSeq = 0;
  const t0 = now();
  let tree = null;
  let root = null;
  let failure = null;
  enter(copy, () => {
    rendering = copy;
    try {
      const out = copy.view.render(makeCx(copy));
      tree = serialize(out);
      root = records.get(out) ?? null;
    } catch (e) {
      failure = e;
    } finally {
      rendering = null;
    }
  });
  copy.lastRender = now();
  if (failure !== null) {
    copy.handlers = handlers;
    copy.handlerSeq = handlerSeq;
    return report(copy, "render", failure);
  }
  copy.root = root;
  copy.renders++;
  post({ t: "tree", copy: copy.id, n: copy.renders, ms: copy.lastRender - t0, tree });
}

/**
 * Runs handler `id` of the copy's latest sent render with the event's origin: `{ok}` or `{ok:false, error}`. `n` is
 * the render the bridge took `id` from (`null`: not given); when it is not the latest, or `id` is not one of that
 * render's handlers, no handler runs and the result is `{ok:false, stale:true, error}` — a click that raced a
 * re-render never reaches a handler of the newer tree. A key press sent to an `on_key_down` listener goes through the
 * keymap first ({@link dispatchKey}).
 */
export function dispatch(copy, id, args, origin, n = null) {
  if (n !== null && n !== copy.renders) {
    return { ok: false, stale: true, error: `stale handler ${id}: render ${n}, current ${copy.renders}` };
  }
  const fn = copy.handlers.get(id);
  if (!fn) return { ok: false, stale: true, error: `stale handler ${id}` };
  const press = { fn, args, origin, where: `handler ${id}` };
  const route = keymap.size > 0 ? keyRoute(copy, id, args[0]) : null;
  const r = route === null ? run(copy, press) : dispatchKey(copy, route, press);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * Runs listener `call.fn(...call.args, cx)` as a host call of `copy` with `call.origin`: `{ok, error?, stopped}`.
 * `stopped` is the propagation state the listener starts with and may change (`cx.stop_propagation()`,
 * `cx.propagate()`); a listener that throws keeps the event.
 */
function run(copy, call, stopped = false) {
  const event = { stopped };
  copy.event = event;
  try {
    enter(copy, () => {
      const r = call.fn(...call.args, makeCx(copy));
      if (r && typeof r.then === "function") r.then(undefined, (e) => report(copy, call.where, e));
    }, call.origin);
    return { ok: true, stopped: event.stopped };
  } catch (e) {
    report(copy, call.where, e);
    return { ok: false, error: errorText(e, 500), stopped: true };
  } finally {
    copy.event = null;
  }
}

/** Appends to `path` the element records from `rec` down to the one holding handler `id`; `false` when none does. */
function pathTo(rec, id, path) {
  path.push(rec);
  if (rec.handlers.some((h) => h.id === id)) return true;
  for (const slot of Object.values(rec.slots ?? {})) if (pathTo(slot, id, path)) return true;
  for (const c of rec.children) if (recordSet.has(c) && pathTo(c, id, path)) return true;
  path.pop();
  return false;
}

/** What element `rec` brings to key dispatch: its `key_context` and its `on_action` listeners; `null`: neither. */
function keyFrame(copy, rec) {
  let context = null;
  for (const [name, value] of rec.style) {
    if (name !== "key_context") continue;
    try {
      context = parseKeyContext(value);
    } catch {
      // Reported when it was recorded; this call leaves the context unset.
    }
  }
  const actions = [];
  for (const h of rec.handlers) {
    const fn = h.event === "on_action" && typeof h.args?.[0] === "string" ? copy.handlers.get(h.id) : undefined;
    if (fn) actions.push({ action: h.args[0], fn });
  }
  return context === null && actions.length === 0 ? null : { context, actions };
}

/**
 * The keymap route of a device event sent to handler `id` of the latest render: when that handler is an
 * `on_key_down` listener and the event a `KeyEvent`, the typed stroke and the key frames of the elements from the
 * root down to the listener's element (the focus path the press travelled), with their context stack. `null`
 * otherwise.
 */
function keyRoute(copy, id, event) {
  const stroke = typedKeystroke(event);
  if (stroke === null || copy.root === null) return null;
  const path = [];
  if (!pathTo(copy.root, id, path)) return null;
  if (path.at(-1).handlers.find((h) => h.id === id).event !== "on_key_down") return null;
  const frames = [];
  for (const rec of path) {
    const frame = keyFrame(copy, rec);
    if (frame !== null) frames.push(frame);
  }
  return { stroke, frames, contexts: frames.flatMap((f) => (f.context === null ? [] : [f.context])) };
}

/**
 * GPUI `Window::dispatch_action_on_node`, bubble phase: the `on_action` listeners for `action` from the innermost
 * element of `frames` outwards. A listener stops the action unless it calls `cx.propagate()`; the outcome of the one
 * that stopped it, or `null` when none did.
 */
function dispatchAction(copy, frames, action, origin) {
  for (let i = frames.length - 1; i >= 0; i--) {
    for (const a of frames[i].actions) {
      if (a.action !== action) continue;
      const r = run(copy, { fn: a.fn, args: [{ action }], origin, where: `action ${action}` }, true);
      if (r.stopped) return r;
    }
  }
  return null;
}

/** A held press whose chord did not complete: its bindings' actions, else its own key listener. */
function replayKey(copy, frames, entry, bindings) {
  for (const b of bindings) if (dispatchAction(copy, frames, b.action, entry.origin) !== null) return;
  run(copy, entry);
}

function takePendingKeys(copy) {
  const p = copy.pendingKeys;
  if (p === null) return [];
  copy.pendingKeys = null;
  clearT(p.timer);
  copy.timers.delete(p.timer);
  return p.entries;
}

/** Holds `entries` as the copy's chord prefix; after `PENDING_INPUT_MS` without a next stroke they are replayed. */
function holdKeys(copy, entries, route) {
  const timer = timeout(() => {
    copy.timers.delete(timer);
    if (copy.closed || copy.pendingKeys?.timer !== timer) return;
    copy.pendingKeys = null;
    for (const r of flushKeys(keymap, entries, route.contexts)) replayKey(copy, route.frames, r.entry, r.bindings);
  }, PENDING_INPUT_MS);
  copy.timers.add(timer);
  copy.pendingKeys = { entries, timer };
}

/**
 * GPUI `Window::dispatch_key_event` for press `press` on `route`: the copy's held chord prefix plus this stroke is
 * matched against the keymap in the route's context stack. Earlier held presses that complete nothing are replayed
 * first; a prefix of a longer chord is held; a completed binding dispatches its action up the route, best binding
 * first, and the press reaches its `on_key_down` listener only when no action listener stopped it.
 */
function dispatchKey(copy, route, press) {
  const r = resolveKey(keymap, takePendingKeys(copy), { ...press, stroke: route.stroke }, route.contexts);
  for (const replay of r.replay) replayKey(copy, route.frames, replay.entry, replay.bindings);
  if (r.pending !== null) {
    holdKeys(copy, r.pending, route);
    return { ok: true };
  }
  for (const b of r.bindings) {
    const handled = dispatchAction(copy, route.frames, b.action, press.origin);
    if (handled !== null) return handled;
  }
  return run(copy, press);
}

// ---------------------------------------------------------------------------------------------------------------------
// Element recorder. Every builder method is accepted and recorded; a few have structural meaning. The output is the
// protocol `RecordedTree` (PROTOCOL.md, T02 addition 7): refinements in `states`, integer handler ids, factory data
// under `props`, slots by name, children only elements / `{text}` / `{entity}`.

/** Proxy → its record. */
const records = new WeakMap();
const consumed = new WeakSet();
/** Host objects (focus handles, paths, backgrounds, retained states) → the JSON a tree carries for them. */
export const hostObjects = new WeakMap();
export const isElement = (v) => v !== null && (typeof v === "object" || typeof v === "function") && records.has(v);
export const entityMark = Symbol("entity");

const REFINEMENTS = new Set([
  "hover",
  "active",
  "focus",
  "range_style",
  "cell_style",
  "cell_active_style",
  "caret_style",
]);
const SLOTS = new Set([
  "content",
  "image",
  "fallback",
  "header",
  "footer",
  "panel",
  "trigger",
  "input",
  "decrement_button",
  "increment_button",
]);
/** `TextViewElement` options: recorded as `props` (widget options), not as style calls. */
const TEXT_VIEW_OPTIONS = new Set(["selectable", "scrollable"]);
const NOT_METHODS = new Set(["then", "toJSON", "constructor"]);

/** A recorder element. `props` is the factory data (`src`, `path`/`paint`, `format`/`source`, `state`, …). */
export function element(tag, props) {
  const rec = { tag, id: null, style: [], handlers: [], children: [], states: null, slots: null, props: props ?? null };
  const proxy = new Proxy(Object.create(null), {
    get(_t, prop) {
      if (typeof prop !== "string" || NOT_METHODS.has(prop)) return undefined;
      return (...args) => call(proxy, rec, prop, args);
    },
    set() {
      return false;
    },
  });
  records.set(proxy, rec);
  return proxy;
}

/** Registers `fn` as a handler of the copy being rendered; `null` outside any copy. */
function registerHandler(fn) {
  const copy = rendering ?? alsStore()?.copy;
  if (!copy) return null;
  const id = ++copy.handlerSeq;
  copy.handlers.set(id, fn);
  return id;
}

/** Records `fn` as handler `event` of element `el` (used by factories that synthesise handlers). */
export function addHandler(el, event, fn, args = []) {
  const rec = records.get(el);
  const id = registerHandler(fn);
  if (id === null) return noteUnknown("element", "handler-outside-render");
  rec.handlers.push(args.length > 0 ? { event, id, args } : { event, id });
}

/** Sets one factory prop of element `el`. */
export function setProp(el, key, value) {
  const rec = records.get(el);
  (rec.props ??= {})[key] = value;
}

/** The `cx` a list renderer is handed: the copy being rendered (or the current host call's), else `undefined`. */
export function listCx() {
  const copy = rendering ?? alsStore()?.copy;
  return copy ? makeCx(copy) : undefined;
}

/**
 * A lazy list (`list`, `uniform_list`, `v_virtual_list`, `h_virtual_list`): the element id is the list id, `props`
 * carry `count`, the `keys` of the recorded rows (what `on_item_click` reports) and any `extra` factory data, and the
 * children are the first `LIST_WINDOW` rows (`addRows(el, n)`).
 */
export function lazyList(tag, id, count, extra, getKey, addRows) {
  const total = Number.isFinite(Number(count)) ? Math.max(0, Math.trunc(Number(count))) : 0;
  const n = Math.min(total, LIST_WINDOW);
  const keys = Array.from({ length: n }, (_, i) => String(getKey(i)));
  const el = element(tag, { count: total, keys, ...extra }).id(String(id));
  addRows(el, n);
  return el;
}

function call(proxy, rec, name, args) {
  switch (name) {
    case "id":
      rec.id = String(args[0]);
      return proxy;
    case "child":
      addChild(rec, args[0]);
      return proxy;
    case "children":
      for (const c of args[0] ?? []) addChild(rec, c);
      return proxy;
    case "when": {
      if (args[0]) {
        const r = args[1]?.(proxy);
        return r === undefined ? proxy : r;
      }
      return proxy;
    }
    case "map":
      return args[0](proxy);
  }
  if (REFINEMENTS.has(name) && typeof args.at(-1) === "function") {
    if (args.length !== 1) noteUnknown("element", `${name}(${args.length} args)`);
    const detached = element("refinement");
    args.at(-1)(detached);
    const d = records.get(detached);
    if (d.handlers.length || d.children.length || d.states || d.slots) {
      noteUnknown("element", `non-style call in ${name}`);
    }
    const states = (rec.states ??= {});
    states[name] = [...(states[name] ?? []), ...d.style];
    return proxy;
  }
  if (SLOTS.has(name) && args.length === 1 && isElement(args[0])) {
    (rec.slots ??= {})[name] = consume(args[0]);
    return proxy;
  }
  if (rec.tag === "TextView" && TEXT_VIEW_OPTIONS.has(name)) {
    (rec.props ??= {})[name] = args.length === 0 ? true : ser(args[0]);
    return proxy;
  }
  if (args.some((a) => typeof a === "function")) {
    const rest = args.filter((a) => typeof a !== "function").map((a) => ser(a));
    for (const fn of args) {
      if (typeof fn !== "function") continue;
      const id = registerHandler(fn);
      if (id === null) noteUnknown("element", "handler-outside-render");
      else rec.handlers.push(rest.length > 0 ? { event: name, id, args: rest } : { event: name, id });
    }
    return proxy;
  }
  if (name === "key_context") checkKeyContext(args[0]);
  rec.style.push([name, ...args.map((a) => ser(a))]);
  return proxy;
}

/** Unparsable `key_context` values already reported, at most `BAD_CONTEXTS_MAX` of them. */
const badContexts = new Set();
const BAD_CONTEXTS_MAX = 64;

/** Herdr reports an unparsable `key_context` and leaves the context unset (key dispatch skips it). */
function checkKeyContext(value) {
  try {
    parseKeyContext(value);
  } catch (e) {
    const text = String(value);
    if (badContexts.has(text) || badContexts.size >= BAD_CONTEXTS_MAX) return;
    badContexts.add(text);
    post({ t: "error", copy: currentCopyId(), where: "key_context", error: `${JSON.stringify(text)}: ${e.message}` });
  }
}

function consume(el) {
  const r = records.get(el);
  if (consumed.has(r)) noteUnknown("element", "reused-element (Herdr throws)");
  consumed.add(r);
  return r;
}

const recordSet = new WeakSet();

function addChild(rec, c) {
  if (typeof c === "boolean") return; // declared child type; `cond && el` leaves nothing
  if (c === null || c === undefined) return noteUnknown("element", `child(${c})`);
  if (typeof c === "string" || typeof c === "number") rec.children.push({ text: String(c) });
  else if (isElement(c)) {
    const r = consume(c);
    recordSet.add(r);
    rec.children.push(r);
  } else if (c[entityMark]) rec.children.push({ entity: String(c[entityMark]) });
  else noteUnknown("element", `child(${Array.isArray(c) ? "array" : typeof c})`);
}

function toTree(rec) {
  const out = { tag: rec.tag };
  if (rec.id !== null) out.id = rec.id;
  out.style = rec.style;
  out.handlers = rec.handlers;
  out.children = rec.children.map((c) => (recordSet.has(c) ? toTree(c) : c));
  if (rec.states) out.states = rec.states;
  if (rec.slots) out.slots = Object.fromEntries(Object.entries(rec.slots).map(([k, v]) => [k, toTree(v)]));
  if (rec.props && Object.keys(rec.props).length > 0) out.props = rec.props;
  return out;
}

/** What `render()` returned → `RecordedTree`. Anything but an element, a string or an entity is a render error. */
export function serialize(root) {
  if (isElement(root)) return toTree(consume(root));
  if (typeof root === "string" || typeof root === "number") return { text: String(root) };
  if (root && root[entityMark]) return { entity: String(root[entityMark]) };
  throw new TypeError(`render() returned ${root === null ? "null" : typeof root}, not an element`);
}

/** A JSON value for a recorded argument. */
export function ser(v, depth = 0) {
  if (v === undefined) return null;
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "function") return "[function]";
  if (isElement(v)) return toTree(consume(v));
  const h = hostObjects.get(v);
  if (h !== undefined) return typeof h === "function" ? h() : h;
  if (depth > 6) return "[deep]";
  if (Array.isArray(v)) return v.map((x) => ser(x, depth + 1));
  if (typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x, depth + 1)]));
  return String(v);
}
