/**
 * seatbelt-derive.ts — the Seatbelt derivation/regression check for mod hosts (DESIGN-v2 §1.3, §5.3 "any macOS
 * upgrade re-runs the Seatbelt derivation check"). For each mod folder it runs a real mod host twice, unconfined and
 * under the profile generated from `src/hosts/seatbelt.template.sb`, through the same control-channel conversation
 * (hello → boot → loaded → create → tree → ping/pong → exit), and requires identical behaviour. Then it runs kernel
 * probes with Deno's own permissions wide open (`-A`) so only Seatbelt stands in the way: a symlink inside the mod
 * folder pointing at a secret (the spike's S03 case), a direct read outside, a write outside DENO_DIR, a process
 * spawn and a connection to another port. Each must be denied under the profile and succeed unconfined.
 *
 * Why behaviour and not `log show`: on macOS 27.0 the kernel's Sandbox denials of processes started by
 * `sandbox-exec` are not written to the unified log (T05 measured: none for `cat` denied a read, none for
 * `(allow (with report) default)`), and `(trace …)` writes nothing. A denial therefore shows only as a failing
 * operation; the benign run must match the unconfined run exactly and print no sandbox error.
 *
 *   deno run --allow-read --allow-write --allow-net=127.0.0.1 --allow-env --allow-run=deno,sandbox-exec \
 *     packages/bridge/scripts/seatbelt-derive.ts [--app-home <dir>] [--modhost <dir>] [--entry src/main.js] \
 *     [--folders a,b] [--template <file.sb>] [--keep]
 *
 * Exit 0 when every check holds; the JSON report is printed on stdout.
 */

import { join } from "@std/path";
import {
  type DenoRuntime,
  loadSeatbeltTemplate,
  probeDenoRuntime,
  seatbeltProfile,
  writeSeatbeltProfile,
} from "../src/hosts/seatbelt.ts";

const REPO = new URL("../../../", import.meta.url);
const repoPath = (rel: string) => decodeURIComponent(new URL(rel, REPO).pathname);

function option(name: string): string | undefined {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
}

const appHome = await Deno.realPath(option("--app-home") ?? repoPath("fixtures/generic-home"));
const modhost = await Deno.realPath(option("--modhost") ?? repoPath("packages/modhost"));
const entry = join(modhost, option("--entry") ?? "src/main.js");
const template = option("--template") ? await Deno.readTextFile(option("--template")!) : await loadSeatbeltTemplate();
const keep = Deno.args.includes("--keep");
const folders = option("--folders")?.split(",") ??
  [...Deno.readDirSync(join(appHome, "mods"))].filter((e) => e.isDirectory).map((e) => e.name).sort();
const state = JSON.parse(await Deno.readTextFile(repoPath("packages/protocol/samples/shapes/HostState.json")));
const run = await Deno.realPath(await Deno.makeTempDir({ prefix: "herdr-relay-seatbelt-" }));
const runtime: DenoRuntime = await probeDenoRuntime();
const enc = new TextEncoder();
const dec = new TextDecoder();

/** Lines a process prints when the sandbox refused something. */
const SANDBOX_MARKERS = /Operation not permitted|PermissionDenied|blocked by sandbox|sandbox_apply|deny\(/;

interface HostRun {
  mode: "unconfined" | "seatbelt";
  hello: boolean;
  loaded: { ok: boolean; error?: string } | null;
  trees: Record<string, number>;
  hostErrors: string[];
  rpcs: string[];
  pong: boolean;
  exit: number | null;
  signal: string | null;
  stderr: string;
}

async function writeLine(conn: Deno.Conn, obj: unknown): Promise<void> {
  const bytes = enc.encode(JSON.stringify(obj) + "\n");
  for (let off = 0; off < bytes.length;) off += await conn.write(bytes.subarray(off));
}

async function* lines(conn: Deno.Conn): AsyncGenerator<Record<string, unknown>> {
  let pending = "";
  for await (const chunk of conn.readable) {
    pending += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
}

function deadline<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  const { promise, resolve } = Promise.withResolvers<"timeout">();
  const timer = setTimeout(() => resolve("timeout"), ms);
  return Promise.race([p, promise]).finally(() => clearTimeout(timer));
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function hostRun(folder: string, mode: HostRun["mode"]): Promise<HostRun> {
  const folderDir = await Deno.realPath(join(appHome, "mods", folder));
  const denoDir = join(run, "deno-dir", `${folder}.${mode}`);
  await Deno.mkdir(denoDir, { recursive: true, mode: 0o700 });
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const ctlPort = (listener.addr as Deno.NetAddr).port;
  const token = crypto.randomUUID();
  const flags = [
    "run",
    "--no-prompt",
    "--no-remote",
    "--no-npm",
    "--no-lock",
    `--config=${join(modhost, "deno.json")}`,
    `--allow-read=${folderDir},${modhost}`,
    `--allow-net=127.0.0.1:${ctlPort}`,
    "--v8-flags=--max-old-space-size=256",
    entry,
    String(ctlPort),
    folder,
  ];
  let command = runtime.exec;
  let args = flags;
  if (mode === "seatbelt") {
    const profile = seatbeltProfile(template, {
      runtime,
      modhost,
      folder: folderDir,
      denoDir,
      ctlPort,
      cwd: folderDir,
    });
    command = "sandbox-exec";
    args = ["-f", await writeSeatbeltProfile(run, `${folder}.${ctlPort}`, profile), runtime.exec, ...flags];
  }
  const child = new Deno.Command(command, {
    args,
    cwd: folderDir,
    clearEnv: true,
    env: { DENO_DIR: denoDir, NO_COLOR: "1", TZ: Deno.env.get("TZ") ?? "UTC" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(enc.encode(`${token}\n`));
  await w.close();
  const stderrText = new Response(child.stderr).text();
  const stdoutDrain = new Response(child.stdout).arrayBuffer();
  const result: HostRun = {
    mode,
    hello: false,
    loaded: null,
    trees: {},
    hostErrors: [],
    rpcs: [],
    pong: false,
    exit: null,
    signal: null,
    stderr: "",
  };
  const conversation = (async () => {
    const accepted = await deadline(listener.accept(), 5000);
    if (accepted === "timeout") return;
    const conn = accepted;
    const copies = [`${folder}:derive-a`, `${folder}:derive-b`];
    let created = false;
    let lastTree = 0;
    const it = lines(conn);
    const pump = (async () => {
      for await (const m of it) {
        if (m.t === "hello" && m.token === token) {
          result.hello = true;
          await writeLine(conn, {
            t: "boot",
            state: { ...state, folder, appHome },
            harden: true,
            mainUrl: `file://${folderDir}/main.js`,
          });
        } else if (m.t === "loaded") {
          result.loaded = typeof m.error === "string" ? { ok: false, error: m.error.split("\n")[0] } : { ok: true };
          if (!created) {
            created = true;
            for (const copy of copies) await writeLine(conn, { t: "create", copy, props: {}, placement: null });
          }
        } else if (m.t === "tree") {
          result.trees[String(m.copy)] = (result.trees[String(m.copy)] ?? 0) + 1;
          lastTree = Date.now();
        } else if (m.t === "rpc") {
          result.rpcs.push(String(m.method));
          await writeLine(conn, { t: "rpc-result", id: m.id, ok: false, error: "seatbelt-derive: no bridge policy" });
        } else if (m.t === "error") {
          result.hostErrors.push(`${m.where}: ${String(m.error).split("\n")[0]}`);
        } else if (m.t === "pong") {
          result.pong = true;
        }
      }
    })();
    const start = Date.now();
    while (Date.now() - start < 8000) {
      await sleep(50);
      const settled = result.loaded !== null &&
        (result.loaded.ok === false || Object.keys(result.trees).length >= copies.length);
      if (settled && Date.now() - lastTree > 500) break;
    }
    await writeLine(conn, { t: "ping", n: 1 }).catch(() => {});
    await sleep(300);
    await writeLine(conn, { t: "exit" }).catch(() => {});
    await deadline(pump, 3000);
    try {
      conn.close();
    } catch {
      // closed by the host
    }
  })();
  await deadline(conversation, 15_000);
  const status = await deadline(child.status, 3000);
  if (status === "timeout") {
    child.kill("SIGKILL");
    const s = await child.status;
    result.exit = s.code;
    result.signal = s.signal ?? "SIGKILL";
  } else {
    result.exit = status.code;
    result.signal = status.signal;
  }
  listener.close();
  await stdoutDrain;
  result.stderr = (await stderrText).trim();
  return result;
}

/** Same observable behaviour, and no sandbox error printed under the profile. */
function compare(a: HostRun, b: HostRun): string[] {
  const out: string[] = [];
  if (!b.hello) out.push("no hello under seatbelt");
  if (JSON.stringify(a.loaded) !== JSON.stringify(b.loaded)) out.push(`loaded differs: ${JSON.stringify(b.loaded)}`);
  if (JSON.stringify(Object.keys(a.trees).sort()) !== JSON.stringify(Object.keys(b.trees).sort())) {
    out.push("rendered copies differ");
  }
  if (JSON.stringify(a.hostErrors) !== JSON.stringify(b.hostErrors)) out.push(`host errors differ: ${b.hostErrors}`);
  if (JSON.stringify(a.rpcs.sort()) !== JSON.stringify(b.rpcs.sort())) out.push("rpc calls differ");
  if (a.pong !== b.pong) out.push("pong differs");
  if (a.exit !== b.exit || a.signal !== b.signal) out.push(`exit differs: ${b.exit}/${b.signal}`);
  if (SANDBOX_MARKERS.test(b.stderr)) out.push(`sandbox error on stderr: ${b.stderr.slice(0, 300)}`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Kernel probes: Deno permissions wide open (-A), only the profile in the way.

interface Probe {
  name: string;
  code: string;
}

async function probeRun(code: string, mode: "unconfined" | "seatbelt", folderDir: string, ctlPort: number) {
  const denoDir = join(run, "deno-dir", `probe.${mode}`);
  await Deno.mkdir(denoDir, { recursive: true, mode: 0o700 });
  const flags = ["run", "--no-prompt", "--no-config", "--no-remote", "--no-npm", "--no-lock", "-A", "-"];
  let command = runtime.exec;
  let args = flags;
  if (mode === "seatbelt") {
    const profile = seatbeltProfile(template, {
      runtime,
      modhost,
      folder: folderDir,
      denoDir,
      ctlPort,
      cwd: folderDir,
    });
    command = "sandbox-exec";
    args = ["-f", await writeSeatbeltProfile(run, `probe.${ctlPort}`, profile), runtime.exec, ...flags];
  }
  const child = new Deno.Command(command, {
    args,
    cwd: folderDir,
    clearEnv: true,
    env: { DENO_DIR: denoDir, NO_COLOR: "1" },
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(enc.encode(code));
  await w.close();
  const out = await child.output();
  return { stdout: dec.decode(out.stdout).trim(), stderr: dec.decode(out.stderr).trim(), code: out.code };
}

async function probes() {
  const evil = join(run, "probe-home", "mods", "evil");
  const secretDir = join(run, "probe-secret");
  await Deno.mkdir(join(evil, "data"), { recursive: true });
  await Deno.mkdir(secretDir, { recursive: true });
  const secret = join(secretDir, "devices.json");
  await Deno.writeTextFile(secret, '{"canary":"HERDR-RELAY-SEATBELT-CANARY"}');
  await Deno.symlink(secret, join(evil, "data", "link.json"));
  const outside = join(run, "probe-outside.txt");
  const sideListener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const sidePort = (sideListener.addr as Deno.NetAddr).port;
  const ctlListener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const ctlPort = (ctlListener.addr as Deno.NetAddr).port;
  (async () => {
    for await (const c of sideListener) c.close();
  })();
  (async () => {
    for await (const c of ctlListener) c.close();
  })();
  const report = (body: string) =>
    `try { const r = await (async () => { ${body} })(); console.log("ALLOWED " + String(r).slice(0, 60)); } ` +
    `catch (e) { console.log("BLOCKED " + e.name + ": " + e.message.split("\\n")[0]); }`;
  const list: Probe[] = [
    {
      name: "symlink in the mod folder → secret (S03)",
      code: report(`return await Deno.readTextFile(${JSON.stringify(join(evil, "data/link.json"))});`),
    },
    {
      name: "import() of the same link",
      code: report(
        `return JSON.stringify((await import(${
          JSON.stringify(`file://${join(evil, "data/link.json")}`)
        }, { with: { type: "json" } })).default);`,
      ),
    },
    { name: "read outside the folder", code: report(`return await Deno.readTextFile(${JSON.stringify(secret)});`) },
    {
      name: "write outside DENO_DIR",
      code: report(`await Deno.writeTextFile(${JSON.stringify(outside)}, "x"); return "written";`),
    },
    {
      name: "spawn a process",
      code: report(`return (await new Deno.Command("/bin/echo", { args: ["spawned"] }).output()).code;`),
    },
    {
      name: "connect to another loopback port",
      code: report(
        `const c = await Deno.connect({ hostname: "127.0.0.1", port: ${sidePort} }); c.close(); return "connected";`,
      ),
    },
    {
      name: "listen",
      code: report(`const l = Deno.listen({ hostname: "127.0.0.1", port: 0 }); l.close(); return "listening";`),
    },
  ];
  const controls: Probe[] = [
    {
      name: "control: read inside the folder",
      code: report(`return (await Deno.readDir(${JSON.stringify(evil)})[Symbol.asyncIterator]().next()).value?.name;`),
    },
    {
      name: "control: connect to the control port",
      code: report(
        `const c = await Deno.connect({ hostname: "127.0.0.1", port: ${ctlPort} }); c.close(); return "connected";`,
      ),
    },
  ];
  const results = [];
  for (const p of [...list, ...controls]) {
    const unconfined = await probeRun(p.code, "unconfined", evil, ctlPort);
    const seatbelt = await probeRun(p.code, "seatbelt", evil, ctlPort);
    await Deno.remove(outside).catch(() => {});
    const control = p.name.startsWith("control:");
    const ok = control
      ? unconfined.stdout.startsWith("ALLOWED") && seatbelt.stdout.startsWith("ALLOWED")
      : unconfined.stdout.startsWith("ALLOWED") && seatbelt.stdout.startsWith("BLOCKED");
    results.push({
      name: p.name,
      ok,
      unconfined: unconfined.stdout || unconfined.stderr,
      seatbelt: seatbelt.stdout || seatbelt.stderr,
    });
  }
  sideListener.close();
  ctlListener.close();
  return results;
}

const report: Record<string, unknown> = {
  macos: dec.decode((await new Deno.Command("sw_vers", { args: ["-productVersion"], stdout: "piped" }).output()).stdout)
    .trim(),
  deno: Deno.version.deno,
  runtime,
  appHome,
  modhost,
  entry,
  folders: {},
};
let ok = true;
for (const folder of folders) {
  const a = await hostRun(folder, "unconfined");
  const b = await hostRun(folder, "seatbelt");
  const diffs = compare(a, b);
  if (!a.hello || a.exit !== 0) {
    diffs.push(`unconfined run itself failed (hello ${a.hello}, exit ${a.exit}): ${a.stderr.slice(0, 300)}`);
  }
  if (diffs.length) ok = false;
  (report.folders as Record<string, unknown>)[folder] = { ok: diffs.length === 0, diffs, unconfined: a, seatbelt: b };
}
const probeResults = await probes();
if (probeResults.some((p) => !p.ok)) ok = false;
report.probes = probeResults;
report.ok = ok;
console.log(JSON.stringify(report, null, 2));
if (!keep) await Deno.remove(run, { recursive: true });
else console.error(`kept ${run}`);
Deno.exit(ok ? 0 : 1);
