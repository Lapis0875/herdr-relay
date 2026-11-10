/**
 * The device's connection to the bridge (PROTOCOL.md §1): `GET api/hello` decides pairing vs app; each socket starts
 * with a one-time ticket (`GET api/ticket`), sends `hello {since}` and applies the bridge's `t`-messages, validated
 * with `@herdr-relay/protocol`, to the store. Reconnects back off 1 → 2 → 5 → 10 → 30 s (DESIGN.md §4) and resume
 * from the last `seq`; while the socket is down the last data stays on screen, marked stale, and is cached in
 * IndexedDB for the next launch. Requests carry ids; their acks resolve the returned promise or time out at 15 s.
 */

import {
  type Ack,
  type BridgeHello,
  type BridgeMessage,
  type ClientMessage,
  decodeBridgeMessage,
  decodeTerminalFrame,
  type EventKind,
  type JsonObject,
  type LayoutChange,
  type NodeProfile,
  PROTOCOL_VERSION,
  type PushSubscription as WirePushSubscription,
} from "@herdr-relay/protocol";
import { fetchHello, fetchTicket, HttpError } from "./api.ts";
import { type CacheRecord, clearCache, loadCache, saveCache } from "./cache.ts";
import { currentClass, currentViewport, deviceLabel, socketUrl } from "./env.ts";
import { applyPatch, PatchError } from "./jsonpatch.ts";
import { applyNav, type NavRequest } from "./nav.ts";
import { type AppState, getState, type LiveState, pushToast, setState, shownGraph } from "./store.ts";
import { playSound } from "./sound.ts";
import { applyTheme } from "./theme.ts";

/** Reconnect delays (DESIGN.md §4); the last one repeats. */
export const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
/** A request without an ack by then is reported (DESIGN.md §4: 15 s, the core's default). */
export const ACK_TIMEOUT_MS = 15_000;
/** A socket that has not received the bridge's `hello` by then is dropped and retried. */
export const HELLO_TIMEOUT_MS = 15_000;
const SAVE_DELAY_MS = 1_000;
/** How long a connect waits for the cache (the session to resume) before opening without it. */
const CACHE_WAIT_MS = 400;
/**
 * How long a confirmed `layout set` stays drawn without the `patch.screens` that should carry it (the bridge flushes
 * patches after its ack; a change that left the graph as it was sends none).
 */
const SIZING_HOLD_MS = 2_000;

/** A request message before the client assigns its `id`. */
type Request = ClientMessage extends infer M ? M extends { id: number } ? Omit<M, "id"> : never : never;

export type BinaryListener = (channel: number, bytes: Uint8Array) => void;

interface Pending {
  resolve: (ack: Ack) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string | null;
}

/** Delay before attempt `attempt` (1-based) of a reconnect series. */
export function backoffDelay(attempt: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempt, 1), BACKOFF_MS.length) - 1];
}

/** The live state a `snapshot` carries. */
function liveOf(m: Extract<BridgeMessage, { t: "snapshot" }>): LiveState {
  return {
    spaces: m.spaces,
    agents: m.agents,
    terminals: m.terminals,
    panes: m.panes,
    focused: m.focused,
    shared: m.shared,
  };
}

const ACK_TEXT: Record<string, string> = {
  "read-only-device": "This device can only view: it was paired read-only.",
  "structural": "Structural changes are made in the Herdr window on the Mac.",
  "host-down": "That mod is not running on the Mac right now.",
};

export class BridgeClient {
  #ws: WebSocket | null = null;
  #attempt = 0;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #helloTimer: ReturnType<typeof setTimeout> | undefined;
  #saveTimer: ReturnType<typeof setTimeout> | undefined;
  #nextId = 1;
  readonly #pending = new Map<number, Pending>();
  readonly #binary = new Set<BinaryListener>();
  #launchTerminal: string | null = null;
  /** The device class the current socket's `hello` asked for. */
  #sentClass: string | null = null;
  #started = false;
  /** A bridge `hello` arrived in this page: from then on the cache is never shown (the bridge's state wins). */
  #live = false;
  /** Settles when the IndexedDB cache was read (and shown, when nothing live arrived first). */
  #cacheRead: Promise<void> = Promise.resolve();
  /** The access check in flight; one at a time. */
  #gate: Promise<void> | null = null;
  /** Bumped by every connect and drop: a connect that sees another value was superseded and opens nothing. */
  #connectGen = 0;
  /** Per node, the `setLayout` whose change `sizing` draws (a later one for the same node supersedes it). */
  readonly #sizingTurn = new Map<string, number>();
  /** Nodes whose `sizing` the bridge confirmed: the next `patch.screens` carries them. */
  readonly #sizingDone = new Set<string>();
  #sizingSeq = 0;

  /**
   * Reads the cache and checks access in parallel, then connects. The cache only fills the screen until the bridge
   * answers: once a live `hello` arrived it is ignored, however late IndexedDB is. `launchTerminal`: a terminal to
   * focus once live (a tapped push notification's `?terminal=`).
   */
  async start(launchTerminal: string | null = null): Promise<void> {
    this.#launchTerminal = launchTerminal;
    if (this.#started) return;
    this.#started = true;
    addEventListener("online", () => this.reconnectNow());
    addEventListener("pagehide", () => this.#saveNow());
    document.addEventListener("visibilitychange", () => {
      const visible = document.visibilityState === "visible";
      this.#sendRaw({ t: "visible", visible });
      const conn = getState().conn.kind;
      if (visible && (conn === "retry" || conn === "idle")) this.reconnectNow();
      if (!visible) this.#saveNow();
    });
    this.#cacheRead = loadCache().then((cached) => {
      if (cached && !this.#live && !getState().hello) this.#showCache(cached);
    });
    await this.#checkGate();
  }

  /** Called after pairing succeeded or when the person asks to retry. */
  async recheck(): Promise<void> {
    this.#clearRetry();
    await this.#checkGate();
  }

  /** Drops any wait and connects at once (network back, app foregrounded, "Reconnect now"). */
  reconnectNow(): void {
    if (getState().gate.kind !== "ready") {
      void this.recheck();
      return;
    }
    const conn = getState().conn.kind;
    if (conn === "connecting" || (conn === "live" && this.#ws?.readyState === WebSocket.OPEN)) return;
    this.#attempt = 0;
    this.#clearRetry();
    this.#drop();
    void this.#connect();
  }

  /** Reconnects with a new `hello` (the device class changed: the bridge recomposes for the new class). */
  rehello(): void {
    if (!this.#ws) return;
    this.#attempt = 0;
    this.#drop();
    void this.#connect();
  }

  onBinary(listener: BinaryListener): () => void {
    this.#binary.add(listener);
    return () => this.#binary.delete(listener);
  }

  /** Sends a request and resolves with its ack (a local refusal when offline or unanswered). */
  request(msg: Request, label: string | null = null): Promise<Ack> {
    const id = this.#nextId++;
    const full = { ...msg, id } as ClientMessage;
    if (!this.#isLive() || !this.#sendRaw(full)) {
      return Promise.resolve({ t: "ack", id, ok: false, error: "refused", message: "offline" });
    }
    const { promise, resolve } = Promise.withResolvers<Ack>();
    const timer = setTimeout(() => {
      this.#pending.delete(id);
      if (label) pushToast({ title: `No answer from the Mac: ${label}`, level: "warning", local: true });
      resolve({ t: "ack", id, ok: false, error: "refused", message: "timed out" });
    }, ACK_TIMEOUT_MS);
    this.#pending.set(id, { resolve, timer, label });
    return promise;
  }

  /** Navigates: applied on screen at once, confirmed (or undone) by the bridge. Offline it stays local. */
  async nav(req: NavRequest): Promise<void> {
    const s = getState();
    const graph = shownGraph(s);
    if (!graph) return;
    const next = applyNav(graph, req);
    if (!next) return;
    setState({ optimistic: next });
    if (!this.#isLive()) return;
    const ack = await this.request({ t: "nav", ...req }, null);
    if (!ack.ok) {
      setState({ optimistic: null });
      if (ack.message !== "offline") this.#reportAck(ack);
    }
  }

  /** A command (`keys.json` chord, toast action, shell action). */
  async command(name: string, args?: JsonObject): Promise<Ack> {
    const ack = await this.request(args ? { t: "command", name, args } : { t: "command", name }, name);
    if (!ack.ok) this.#reportAck(ack);
    return ack;
  }

  /**
   * Shows a terminal's pane in this session (a tapped push notification). `pane.focus` is a session-class command,
   * which `read` devices may send too.
   */
  focusTerminal(terminal: string): void {
    void this.command("pane.focus", { terminal });
  }

  /** A handler of a rendered view (T16). Stale handlers are refused silently by protocol. */
  async event(view: string, handler: number, kind: EventKind, data: unknown): Promise<Ack> {
    const ack = await this.request({ t: "event", view, handler, kind, data } as Request, null);
    if (!ack.ok && ack.error !== "stale-handler") this.#reportAck(ack);
    return ack;
  }

  async pushSubscription(subscription: WirePushSubscription): Promise<Ack> {
    return await this.request({ t: "push.sub", subscription }, "notifications");
  }

  /**
   * Sets nodes of this device's layout profile in one `layout set` (a divider between two weighted siblings: both).
   * The changes are drawn at once (`sizing`) and kept until the bridge's `patch.screens` carries them; the bridge
   * applies all or none, so a refusal or a lost connection undoes them all and says why.
   */
  async setLayout(changes: LayoutChange[]): Promise<Ack> {
    const turn = ++this.#sizingSeq;
    for (const c of changes) {
      this.#sizingTurn.set(c.node, turn);
      this.#sizingDone.delete(c.node);
    }
    setState((s) => ({
      sizing: { ...s.sizing, ...Object.fromEntries(changes.map((c) => [c.node, profileOf(c)])) },
    }));
    const ack = await this.request({ t: "layout", action: "set", changes }, "resize");
    // Nodes a later `setLayout` took over follow that one.
    const mine = changes.map((c) => c.node).filter((node) => this.#sizingTurn.get(node) === turn);
    if (ack.ok) {
      for (const node of mine) this.#sizingDone.add(node);
      setTimeout(() => this.#unsize(mine, turn), SIZING_HOLD_MS);
    } else {
      this.#unsize(mine, turn);
      this.#reportLayoutAck(ack);
    }
    return ack;
  }

  /** Drops this device's layout profile for the layout and class it shows (`layout reset`), or one node's entry. */
  async resetLayout(node?: string): Promise<Ack> {
    const msg: Request = node === undefined ? { t: "layout", action: "reset" } : { t: "layout", action: "reset", node };
    const ack = await this.request(msg, "reset layout");
    if (!ack.ok) this.#reportLayoutAck(ack);
    return ack;
  }

  /** Sends a terminal binary frame (typed input of an `act` device; T17). */
  sendBinary(frame: Uint8Array): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.#isLive()) return false;
    ws.send(frame);
    return true;
  }

  // --- access --------------------------------------------------------------------------------------------------------

  /** One access check at a time: a second caller (pairing, "Try again", foregrounding) waits for the running one. */
  #checkGate(): Promise<void> {
    this.#gate ??= this.#runGate().finally(() => (this.#gate = null));
    return this.#gate;
  }

  async #runGate(): Promise<void> {
    if (getState().gate.kind !== "ready") setState({ gate: { kind: "checking" } });
    try {
      const h = await fetchHello();
      if (h.via === "tailnet" && !h.paired) {
        this.#drop();
        await this.#forget();
        setState({ gate: { kind: "pair", pairing: h.pairing, login: h.login } });
        return;
      }
      setState({ gate: { kind: "ready", via: h.via, device: h.device } });
      this.#attempt = 0;
      // Not awaited: the socket's own failures schedule retries (and a refused ticket re-checks access).
      void this.#connect();
    } catch (e) {
      if (e instanceof HttpError) {
        this.#drop();
        setState({ gate: { kind: "denied", status: e.status, why: e.message }, conn: { kind: "idle" } });
        return;
      }
      // Network down or the bridge is not running: keep what is on screen and try again.
      this.#scheduleRetry(errorText(e), () => this.#checkGate());
    }
  }

  // --- socket --------------------------------------------------------------------------------------------------------

  async #connect(): Promise<void> {
    const gen = ++this.#connectGen;
    this.#clearRetry();
    this.#attempt++;
    setState({ conn: { kind: "connecting", attempt: this.#attempt } });
    let ticket: string;
    try {
      ticket = await fetchTicket();
    } catch (e) {
      if (gen !== this.#connectGen) return;
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) {
        void this.#checkGate();
        return;
      }
      this.#scheduleRetry(errorText(e), () => this.#connect());
      return;
    }
    // The cache (read in parallel) names the session to resume; wait for it briefly, never for a slow IndexedDB.
    await Promise.race([this.#cacheRead, new Promise((r) => setTimeout(r, CACHE_WAIT_MS))]);
    if (gen !== this.#connectGen) return;
    const ws = new WebSocket(socketUrl(ticket));
    ws.binaryType = "arraybuffer";
    this.#ws = ws;
    ws.onopen = () => {
      const s = getState();
      const cls = currentClass();
      this.#sentClass = cls;
      // `session` + `since` ask to continue the session we hold data for (the bridge answers `resumed: true`).
      const resume = s.seq !== null && s.hello ? { since: s.seq, session: s.hello.session } : {};
      const hello: ClientMessage = {
        t: "hello",
        v: PROTOCOL_VERSION,
        device: deviceLabel(),
        class: cls,
        viewport: currentViewport(),
        ...resume,
      };
      ws.send(JSON.stringify(hello));
      this.#helloTimer = setTimeout(() => {
        if (this.#ws === ws) this.#lost(ws, "no hello from the bridge");
      }, HELLO_TIMEOUT_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      if (this.#ws !== ws) return;
      if (typeof ev.data === "string") this.#text(ev.data);
      else this.#frame(new Uint8Array(ev.data as ArrayBuffer));
    };
    ws.onclose = (ev: CloseEvent) => {
      if (this.#ws !== ws) return;
      if (ev.code === 1008 && /revoked/.test(ev.reason)) {
        this.#ws = null;
        void this.#forget().then(() => this.#checkGate());
        return;
      }
      this.#lost(ws, ev.reason || (ev.code === 1006 ? "connection lost" : `closed (${ev.code})`));
    };
    ws.onerror = () => {};
  }

  /** The socket is gone: keep the data, mark it stale, retry with backoff. */
  #lost(ws: WebSocket, why: string): void {
    if (this.#ws !== ws) return;
    this.#drop();
    this.#scheduleRetry(why, () => this.#connect());
  }

  #drop(): void {
    clearTimeout(this.#helloTimer);
    this.#connectGen++;
    const ws = this.#ws;
    this.#ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) {
      ws.onclose = null;
      ws.close(1000, "reconnecting");
    }
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.resolve({ t: "ack", id, ok: false, error: "refused", message: "offline" });
    }
    this.#pending.clear();
    const s = getState();
    if (s.conn.kind === "live") {
      setState({ conn: { kind: "idle" }, stale: { since: s.receivedAt ?? Date.now() }, optimistic: null });
    }
  }

  #scheduleRetry(why: string, again: () => Promise<void>): void {
    this.#clearRetry();
    const attempt = Math.max(this.#attempt, 1);
    const delay = backoffDelay(attempt);
    const s = getState();
    setState({
      conn: { kind: "retry", attempt: attempt + 1, retryAt: Date.now() + delay, why },
      stale: s.stale ?? (s.hello ? { since: s.receivedAt ?? Date.now() } : null),
    });
    this.#retryTimer = setTimeout(() => void again(), delay);
  }

  #clearRetry(): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #isLive(): boolean {
    return getState().conn.kind === "live" && this.#ws?.readyState === WebSocket.OPEN;
  }

  #sendRaw(msg: ClientMessage): boolean {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // --- bridge messages -----------------------------------------------------------------------------------------------

  #text(data: string): void {
    const r = decodeBridgeMessage(data);
    if (!r.ok) {
      const e = r.errors[0];
      console.warn(`herdr-relay: dropped an invalid bridge message (${e ? `${e.path || "/"}: ${e.message}` : "?"})`);
      return;
    }
    try {
      this.#apply(r.value);
    } catch (e) {
      if (!(e instanceof PatchError)) throw e;
      // Our copy diverged from the bridge's: start over without `since`.
      console.warn(`herdr-relay: ${e.message}; resyncing`);
      setState({ seq: null });
      this.rehello();
      return;
    }
    this.#scheduleSave();
  }

  #apply(m: BridgeMessage): void {
    const seq = (s: AppState, n: number) => Math.max(s.seq ?? 0, n);
    switch (m.t) {
      case "hello":
        return this.#hello(m);
      case "snapshot":
        setState((s) => ({ live: liveOf(m), seq: seq(s, m.seq), receivedAt: Date.now() }));
        return;
      case "patch":
        setState((s) => {
          const out: Partial<AppState> = { seq: seq(s, m.seq), receivedAt: Date.now() };
          if (m.views.length) {
            const views = { ...s.views };
            for (const v of m.views) {
              const tree = views[v.view];
              if (!tree) throw new PatchError(`patch for view ${v.view} before its view.tree`);
              views[v.view] = applyPatch(tree, v.ops);
            }
            out.views = views;
          }
          if (m.state?.length) {
            if (!s.live) throw new PatchError("state patch before a snapshot");
            out.live = applyPatch(s.live, m.state);
          }
          if (m.screens) {
            out.graph = m.screens;
            out.optimistic = null;
            const sizing = this.#settleSizing(s.sizing);
            if (sizing !== s.sizing) out.sizing = sizing;
          }
          return out;
        });
        return;
      case "view.tree":
        setState((s) => ({ views: { ...s.views, [m.view]: m.tree }, receivedAt: Date.now() }));
        return;
      case "overlay":
        setState((s) => ({ overlays: [...s.overlays.filter((o) => o.id !== m.id), m] }));
        return;
      case "overlay.close":
        setState((s) => ({ overlays: s.overlays.filter((o) => o.id !== m.id) }));
        return;
      case "ack": {
        const p = this.#pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.#pending.delete(m.id);
        p.resolve(m);
        return;
      }
      case "toast": {
        const { t: _t, ...toast } = m;
        pushToast(toast);
        return;
      }
      case "look":
        // The Mac's theme, settings or fonts changed: the same fields as `hello`, kept there for the cache.
        applyTheme(m.theme, m.settings, m.fonts);
        setState((s) => ({
          hello: s.hello ? { ...s.hello, theme: m.theme, settings: m.settings, fonts: m.fonts } : s.hello,
        }));
        return;
      case "clipboard":
        // Browsers write the clipboard only in a user gesture: offer it with a Copy button.
        pushToast({ title: "Text from the Mac", body: m.text, copy: m.text });
        return;
      case "sound":
        // A mod's `playSound`: now or never (not while hidden, never queued).
        void playSound(m.src);
        return;
      case "term.size":
        setState((s) => ({ terms: { ...s.terms, [m.terminal]: m } }));
        return;
      case "reset":
        // The bridge lost its state: drop ours and start a fresh session.
        setState({ seq: null, views: {}, overlays: [], terms: {}, live: null, optimistic: null });
        this.rehello();
        return;
    }
  }

  /**
   * The bridge's `hello` starts or continues a session. `resumed: true` (its `seq` repeats our `since`) keeps the view
   * trees, overlays and live state we hold; the kept messages after `since` follow. Otherwise they are dropped and the
   * `snapshot`/`view.tree`s that follow replace them. Terminal channels belong to one socket and always start over.
   */
  #hello(m: BridgeHello): void {
    clearTimeout(this.#helloTimer);
    this.#live = true;
    const resumed = m.resumed === true;
    this.#attempt = 0;
    this.#sizingTurn.clear();
    this.#sizingDone.clear();
    applyTheme(m.theme, m.settings, m.fonts);
    setState((s) => ({
      // A new graph from the bridge: its stack is shown as it is, not animated from what was on screen.
      graphEpoch: s.graphEpoch + 1,
      hello: m,
      graph: m.screens,
      optimistic: null,
      sizing: {},
      seq: m.seq,
      views: resumed ? s.views : {},
      overlays: resumed ? s.overlays : [],
      terms: {},
      live: resumed ? s.live : null,
      stale: null,
      receivedAt: Date.now(),
      conn: { kind: "live", since: Date.now() },
      // The bridge's class is what the session navigates; the navigator recomposes locally only until it answers.
      deviceClass: m.screens.class,
    }));
    this.#sendRaw({ t: "visible", visible: document.visibilityState === "visible" });
    dispatchEvent(new CustomEvent("herdr-relay:live"));
    const terminal = this.#launchTerminal;
    if (terminal) {
      this.#launchTerminal = null;
      this.focusTerminal(terminal);
    }
    // The viewport changed class while this socket was opening.
    if (currentClass() !== this.#sentClass) this.rehello();
  }

  #frame(bytes: Uint8Array): void {
    let frame: { channel: number; bytes: Uint8Array };
    try {
      frame = decodeTerminalFrame(bytes);
    } catch {
      return;
    }
    for (const l of this.#binary) l(frame.channel, frame.bytes);
  }

  #reportAck(ack: Ack): void {
    const text = (ack.error && ACK_TEXT[ack.error]) ?? ack.message ?? "The Mac refused that.";
    pushToast({ title: text, level: ack.error === "read-only-device" ? "info" : "warning", local: true });
  }

  /** A refused `layout` request (a timeout was already reported by `request`). */
  #reportLayoutAck(ack: Ack): void {
    if (ack.message === "timed out") return;
    const why = ack.message === "offline" ? "this device is offline" : ack.message || "the Mac refused it";
    pushToast({ title: `Layout not changed: ${why}.`, level: "warning", local: true });
  }

  /** Stops drawing the `sizing` of `setLayout` turn `turn` for `nodes` (each unless a later turn replaced it). */
  #unsize(nodes: readonly string[], turn: number): void {
    const gone = nodes.filter((node) => this.#sizingTurn.get(node) === turn);
    if (gone.length === 0) return;
    for (const node of gone) {
      this.#sizingTurn.delete(node);
      this.#sizingDone.delete(node);
    }
    setState((s) => {
      if (!gone.some((node) => Object.hasOwn(s.sizing, node))) return {};
      const rest = { ...s.sizing };
      for (const node of gone) delete rest[node];
      return { sizing: rest };
    });
  }

  /** `sizing` without the confirmed changes a new `patch.screens` carries (the same object when none). */
  #settleSizing(sizing: AppState["sizing"]): AppState["sizing"] {
    if (this.#sizingDone.size === 0) return sizing;
    const rest = { ...sizing };
    for (const node of this.#sizingDone) {
      delete rest[node];
      this.#sizingTurn.delete(node);
    }
    this.#sizingDone.clear();
    return rest;
  }

  // --- cache ---------------------------------------------------------------------------------------------------------

  #showCache(c: CacheRecord): void {
    applyTheme(c.hello.theme, c.hello.settings, c.hello.fonts);
    setState((s) => ({
      graphEpoch: s.graphEpoch + 1,
      hello: c.hello,
      graph: c.graph,
      live: c.live,
      views: c.views,
      seq: c.seq,
      receivedAt: c.receivedAt,
      stale: { since: c.receivedAt },
    }));
  }

  #scheduleSave(): void {
    if (this.#saveTimer !== undefined) return;
    this.#saveTimer = setTimeout(() => {
      this.#saveTimer = undefined;
      this.#saveNow();
    }, SAVE_DELAY_MS);
  }

  #saveNow(): void {
    const s = getState();
    if (!s.hello || !s.graph || s.conn.kind !== "live") return;
    void saveCache({
      v: 1,
      receivedAt: s.receivedAt ?? Date.now(),
      hello: s.hello,
      graph: s.graph,
      live: s.live,
      views: { ...s.views },
      seq: s.seq,
    });
  }

  /** This device is not (or no longer) paired: forget everything it showed. */
  async #forget(): Promise<void> {
    await clearCache();
    setState({
      hello: null,
      graph: null,
      optimistic: null,
      sizing: {},
      live: null,
      views: {},
      overlays: [],
      seq: null,
      stale: null,
    });
  }
}

function errorText(e: unknown): string {
  if (e instanceof DOMException && e.name === "TimeoutError") return "the bridge did not answer";
  if (e instanceof TypeError) return "the bridge is unreachable";
  return e instanceof Error ? e.message : String(e);
}

/** The profile entry a `layout set` change asks for (what `sizing` draws until the bridge's graph shows it). */
function profileOf(change: LayoutChange): NodeProfile {
  const out: NodeProfile = {};
  if (change.size && "px" in change.size) out.px = change.size.px;
  if (change.size && "weight" in change.size) out.weight = change.size.weight;
  if (change.collapsed !== undefined) out.collapsed = change.collapsed;
  return out;
}

/** The app's one bridge connection. */
export const bridge: BridgeClient = new BridgeClient();
