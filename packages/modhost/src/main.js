// The unprivileged mod host: one process per mod folder, no Worker (DESIGN-v2 §1.1–§1.2, §1.5–§1.7). The bridge
// supervisor starts it as
//
//   deno run --no-prompt --no-remote --no-npm --no-lock --config=<repo>/packages/modhost/deno.json \
//     --allow-read=<appHome>/mods/<folder>,<repo>/packages/modhost --allow-net=127.0.0.1:<ctlPort> \
//     <repo>/packages/modhost/src/main.js <ctlPort> <folder>
//
// stdin carries one line `<token>\n` and is then closed; the token is read before any mod code exists, sent once in
// `hello` and never kept. The protocol is NDJSON over TCP 127.0.0.1:<ctlPort> (types in
// packages/protocol/src/control.ts); stdout/stderr are only a log, because mod code can write them without a
// permission. On `boot` the host hardens its realm, installs `window`/`localStorage`/`sessionStorage`, and loads the
// folder's `main.js` with a computed `import()` — the mod's bare imports resolve to ./shims through the config.

import {
  closeCopy,
  copies,
  Copy,
  currentStore,
  deliverCommand,
  diag,
  dispatch,
  enter,
  errorText,
  host,
  makeCx,
  markAllDirty,
  markDirty,
  noteUnknown,
  renderCopy,
  report,
  setSink,
  settle,
  unknown,
} from "./runtime.js";
import { makeStorage, makeWindowGlobal } from "./shims/gpui-kit.js";
import "./shims/gpui-base.js";
import "./shims/herdr.js";
import "./shims/net.js";
import "./shims/buffer.js";

/** Longest control line in bytes, `\n` included (protocol `CONTROL_MAX_LINE_BYTES`). */
const MAX_LINE_BYTES = 4 * 1024 * 1024;
/** Protocol `FOLDER_PATTERN`. */
const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** `close(cx)` gets at most this long, shared across copies, when the host exits (AGENTS.md). */
const CLOSE_BUDGET_MS = 250;

// Captured before any mod code runs.
const stringify = JSON.stringify;
const parse = JSON.parse;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const now = performance.now.bind(performance);
const timeout = globalThis.setTimeout.bind(globalThis);
const exit = Deno.exit.bind(Deno);
const memoryUsage = Deno.memoryUsage.bind(Deno);
const pid = Deno.pid;
function sleep(ms) {
  const { promise, resolve } = Promise.withResolvers();
  timeout(resolve, ms);
  return promise;
}

const [portArg, folder] = Deno.args;
const port = Number(portArg);
if (!Number.isInteger(port) || port < 1 || port > 65535 || !FOLDER.test(folder ?? "")) {
  diag("usage: main.js <ctlPort> <folder>");
  exit(2);
}

// A mod's uncaught exception or unhandled rejection is reported, never fatal (Deno would exit the process).
globalThis.addEventListener("unhandledrejection", (e) => {
  e.preventDefault();
  report(currentStore()?.copy ?? null, "unhandledrejection", e.reason);
});
globalThis.addEventListener("error", (e) => {
  e.preventDefault();
  report(currentStore()?.copy ?? null, "uncaught", e.error ?? e.message);
});

/** The first stdin line; nothing else is read from stdin. */
async function readToken() {
  const buf = new Uint8Array(512);
  let text = "";
  while (!text.includes("\n") && text.length < 4096) {
    const n = await Deno.stdin.read(buf);
    if (n === null) break;
    text += decoder.decode(buf.subarray(0, n), { stream: true });
  }
  try {
    Deno.stdin.close();
  } catch {
    // already closed by the bridge
  }
  return text.split("\n")[0].trim();
}

const firstLine = await readToken();
if (!firstLine) {
  diag("no token on stdin");
  exit(2);
}

let conn;
try {
  conn = await Deno.connect({ hostname: "127.0.0.1", port });
} catch (e) {
  diag(`cannot reach the bridge control port ${port}: ${errorText(e, 300)}`);
  exit(1);
}
const connWrite = conn.write.bind(conn);
const connRead = conn.read.bind(conn);
const connClose = conn.close.bind(conn);

// ---------------------------------------------------------------------------------------------------------------------
// Writing: one JSON object per line, written completely (a partial `Conn.write` corrupted NDJSON in the spike) and in
// order through one queue.

let queue = Promise.resolve();
let exiting = false;

function lost(e) {
  if (exiting) return;
  diag(`control channel write failed: ${errorText(e, 300)}`);
  exiting = true;
  exit(1);
}

async function writeAll(bytes) {
  for (let off = 0; off < bytes.length;) off += await connWrite(bytes.subarray(off));
}

/**
 * Queues one message. `false` when it cannot be sent (not JSON, or over the line limit); that is reported as an
 * `error` on the same copy instead.
 */
function send(msg) {
  let bytes = null;
  let problem = null;
  try {
    bytes = encoder.encode(stringify(msg) + "\n");
    if (bytes.length > MAX_LINE_BYTES) problem = `${bytes.length} bytes, over the 4 MiB control line limit`;
  } catch (e) {
    problem = `not JSON: ${errorText(e, 300)}`;
  }
  if (problem === null) {
    queue = queue.then(() => writeAll(bytes)).catch(lost);
    return true;
  }
  diag(`dropped a ${msg.t} message: ${problem}`);
  if (msg.t !== "error") {
    send({ t: "error", copy: typeof msg.copy === "string" ? msg.copy : null, where: String(msg.t), error: problem });
  }
  return false;
}

setSink(send);
send({ t: "hello", token: firstLine, pid, folder });

// ---------------------------------------------------------------------------------------------------------------------
// Bridge → host messages.

let View = null;
let booted = false;

/** Realm hardening before mod code runs (best effort, not a boundary: process separation and Seatbelt are). */
function harden() {
  delete globalThis.BroadcastChannel;
  delete globalThis.caches;
  delete Deno[Deno.internal];
  const left = [
    "BroadcastChannel" in globalThis && "BroadcastChannel",
    "caches" in globalThis && "caches",
    Deno.internal in Deno && "Deno[Deno.internal]",
  ].filter(Boolean);
  if (left.length > 0) report(null, "harden", `still present: ${left.join(", ")}`);
}

/** The gpui-kit ambient globals: `window` (a `Window`), `localStorage` and `sessionStorage` (per copy). */
function installGlobals() {
  const local = makeStorage("local");
  const session = makeStorage("session");
  const globals = { window: makeWindowGlobal(local, session), localStorage: local, sessionStorage: session };
  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, configurable: false, writable: false, enumerable: true });
  }
}

async function boot(m) {
  if (booted) return report(null, "boot", "boot received twice");
  booted = true;
  host.state = m.state;
  harden();
  installGlobals();
  const t0 = now();
  try {
    const mod = await import(String(m.mainUrl));
    if (typeof mod.default !== "function") throw new TypeError("main.js does not default-export a View class");
    View = mod.default;
    send({ t: "loaded", ms: now() - t0, exports: Object.keys(mod) });
  } catch (e) {
    send({ t: "loaded", ms: now() - t0, error: errorText(e, 3000) });
  }
}

function create(m) {
  if (View === null) return report(null, "create", `${m.copy}: the mod is not loaded`);
  if (copies.has(m.copy)) return report(copies.get(m.copy), "create", `${m.copy} already exists`);
  const storage = m.storage !== null && typeof m.storage === "object" ? m.storage : null;
  const copy = new Copy(String(m.copy), m.props ?? {}, m.placement ?? null, storage);
  copies.set(copy.id, copy);
  const t0 = now();
  enter(copy, () => {
    try {
      copy.view = new View(copy.props);
      const r = copy.view.init?.(copy.props, makeCx(copy));
      if (r && typeof r.then === "function") r.then(undefined, (e) => report(copy, "init", e));
    } catch (e) {
      report(copy, "init", e);
    }
  });
  send({ t: "created", copy: copy.id, ms: now() - t0 });
  markDirty(copy);
}

/** Calls the view's `close(cx)` and stops the copy; resolves when `close` settles. */
function closeOne(id) {
  const copy = copies.get(id);
  if (!copy) return Promise.resolve();
  copies.delete(id);
  const done = enter(copy, () => {
    try {
      return Promise.resolve(copy.view?.close?.(makeCx(copy))).catch((e) => report(copy, "close", e));
    } catch (e) {
      report(copy, "close", e);
    }
  });
  closeCopy(copy);
  return Promise.resolve(done);
}

const originOf = (m) =>
  m.origin !== null && typeof m.origin === "object" && typeof m.origin.session === "string"
    ? { session: m.origin.session }
    : null;

async function shutdown(code) {
  if (exiting) return;
  exiting = true;
  await Promise.race([Promise.allSettled([...copies.keys()].map(closeOne)), sleep(CLOSE_BUDGET_MS)]);
  if (unknown.size > 0) diag(`unknown api counts ${stringify(Object.fromEntries(unknown))}`);
  await Promise.race([queue, sleep(1000)]);
  try {
    connClose();
  } catch {
    // already closed
  }
  exit(code);
}

function handle(m) {
  switch (m.t) {
    case "boot":
      return boot(m);
    case "create":
      return create(m);
    case "state":
      host.state = m.state;
      return markAllDirty();
    case "shared":
      if (host.state) host.state.shared[m.key] = m.value;
      return markAllDirty();
    case "render": {
      const copy = copies.get(m.copy);
      return copy ? renderCopy(copy) : report(null, "render", `no copy ${m.copy}`);
    }
    case "event": {
      const copy = copies.get(m.copy);
      const args = Array.isArray(m.args) ? m.args : [];
      // `n`: the render the bridge took the handler id from; an event for any other render runs nothing (stale).
      const n = m.n ?? null;
      const r = copy ? dispatch(copy, m.handler, args, originOf(m), n) : { ok: false, error: `no copy ${m.copy}` };
      return send({ t: "event-result", copy: m.copy, handler: m.handler, ...r });
    }
    case "command": {
      const copy = copies.get(m.copy);
      return copy ? deliverCommand(copy, String(m.command), originOf(m)) : report(null, "command", `no copy ${m.copy}`);
    }
    case "rpc-result":
      return settle(m);
    case "close":
      return closeOne(m.copy);
    case "ping":
      return send({ t: "pong", n: m.n, copies: [...copies.keys()], heap: memoryUsage().heapUsed });
    case "exit":
      return shutdown(0);
    default:
      return noteUnknown("bridge-message", m?.t);
  }
}

function onLine(line) {
  let m;
  try {
    m = parse(line);
  } catch (e) {
    return report(null, "ctl", `bad line: ${errorText(e, 300)}`);
  }
  if (m === null || typeof m !== "object") return report(null, "ctl", "a line that is not an object");
  try {
    const r = handle(m);
    if (r && typeof r.then === "function") r.then(undefined, (e) => report(null, `ctl ${m.t}`, e));
  } catch (e) {
    report(null, `ctl ${m.t}`, e);
  }
}

async function readLoop() {
  const buf = new Uint8Array(64 * 1024);
  let pending = "";
  for (;;) {
    let n;
    try {
      n = await connRead(buf);
    } catch (e) {
      if (!exiting) diag(`control channel read failed: ${errorText(e, 300)}`);
      break;
    }
    if (n === null) break;
    pending += decoder.decode(buf.subarray(0, n), { stream: true });
    for (let nl = pending.indexOf("\n"); nl >= 0; nl = pending.indexOf("\n")) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line) onLine(line);
    }
    if (pending.length > MAX_LINE_BYTES) {
      diag("bridge line over the 4 MiB limit");
      break;
    }
  }
  await shutdown(0);
}

await readLoop();
