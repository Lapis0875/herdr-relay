/**
 * `herdr-relay` — the launcher and Mac-side CLI (DESIGN.md §4 "Device pairing", DESIGN-v2 T10, OSS-PLAN §5 T44).
 * State: `$HOME/.herdr/herdr-relay`.
 *
 *   herdr-relay start [--print-flags]                    the bridge, with flags computed for this machine (./start.ts)
 *   herdr-relay install-mod [--app-home DIR]             copy the mirror mod into Herdr's app home (./install-mod.ts)
 *   herdr-relay doctor                                   check versions, sandbox, Tailscale, Herdr, lock, mirror
 *   herdr-relay pair [--scope read|act] [--name NAME]    one-time 6-digit code from the running bridge (2 min)
 *   herdr-relay devices                                  paired devices
 *   herdr-relay revoke <id|name>                         unpair; the device's open sessions close within 2 s
 *   herdr-relay serve [--dry-run]                        tailscale serve --bg --set-path /herdr-relay <port>
 *
 * `--port N` overrides `HERDR_RELAY_PORT` (default 7781). Exit 0 on success, 1 on failure or refusal, 2 on usage or
 * configuration; `start` exits with the bridge's own code.
 *
 * Run through the `./herdr-relay` shim (`deno task herdr-relay`, `~/.local/bin/herdr-relay`, launchd), which holds
 * this process's permissions and makes sure `deno.lock`'s modules are cached first.
 */

import {
  DeviceStore,
  readToken,
  serve,
  type ServeOutcome,
  type TailscaleRun,
  tailscaleRunner,
} from "../src/auth/mod.ts";
import { ConfigError, homeFrom, MOUNT, parsePort, stateDirOf } from "../src/config.ts";
import { doctor } from "./doctor.ts";
import { denoLauncherHost, type LauncherHost } from "./host.ts";
import { installMod } from "./install-mod.ts";
import { start } from "./start.ts";

const USAGE = `usage:
  herdr-relay start [--print-flags]
  herdr-relay install-mod [--app-home DIR]
  herdr-relay doctor [--port N]
  herdr-relay pair [--scope read|act] [--name NAME] [--port N]
  herdr-relay devices
  herdr-relay revoke <id|name>
  herdr-relay serve [--dry-run] [--port N]`;

class UsageError extends Error {}

interface Parsed {
  command: string | undefined;
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS: Readonly<Record<string, true>> = { scope: true, name: true, port: true, "app-home": true };
const BOOLEAN_FLAGS: Readonly<Record<string, true>> = { "dry-run": true, help: true, "print-flags": true };
const COMMANDS: Readonly<Record<string, { flags: readonly string[]; arity: number }>> = {
  start: { flags: ["print-flags"], arity: 0 },
  "install-mod": { flags: ["app-home"], arity: 0 },
  doctor: { flags: ["port"], arity: 0 },
  pair: { flags: ["scope", "name", "port"], arity: 0 },
  devices: { flags: [], arity: 0 },
  revoke: { flags: [], arity: 1 },
  serve: { flags: ["dry-run", "port"], arity: 0 },
};

export function parseArgs(args: string[]): Parsed {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
    if (BOOLEAN_FLAGS[name] && eq < 0) flags.set(name, true);
    else if (VALUE_FLAGS[name]) {
      const value = eq < 0 ? args[++i] : a.slice(eq + 1);
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags.set(name, value);
    } else throw new UsageError(`unknown option ${a}`);
  }
  return { command: positional.shift(), positional, flags };
}

export interface CliEnv {
  stateDir: string;
  port: number;
  /** Tailscale CLI (stubbed in tests). */
  tailscale: TailscaleRun;
  out: (line: string) => void;
  err: (line: string) => void;
  /** What `start`, `install-mod` and `doctor` read the machine through; default this process. */
  host?: LauncherHost;
}

/** Runs one command; resolves to the exit code. */
export async function cli(args: string[], env: CliEnv): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(args);
    if (p.flags.has("port")) env = { ...env, port: parsePort(String(p.flags.get("port"))) };
  } catch (e) {
    if (!(e instanceof UsageError || e instanceof ConfigError)) throw e;
    env.err(`herdr-relay: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (p.flags.has("help") || p.command === "help") {
    env.out(USAGE);
    return 0;
  }
  const command = p.command ?? "";
  const spec = COMMANDS[command];
  if (!spec) {
    env.err(`herdr-relay: ${command ? `unknown command ${command}` : "missing command"}\n${USAGE}`);
    return 2;
  }
  const extra = [...p.flags.keys()].find((f) => !spec.flags.includes(f));
  if (extra || p.positional.length !== spec.arity) {
    env.err(`herdr-relay: bad arguments for ${command}\n${USAGE}`);
    return 2;
  }
  const host = env.host ?? denoLauncherHost;
  switch (command) {
    case "start":
      return await start({
        host,
        stateDir: env.stateDir,
        printOnly: p.flags.has("print-flags"),
        out: env.out,
        err: env.err,
      });
    case "install-mod": {
      const flag = p.flags.get("app-home");
      let appHome: string;
      try {
        appHome = typeof flag === "string" ? flag : host.env.get("HERDR_APP_HOME") ||
          `${homeFrom(host.env)}/.config/herdr-app`;
      } catch (e) {
        if (!(e instanceof ConfigError)) throw e;
        env.err(`herdr-relay: ${e.message}`);
        return 2;
      }
      return await installMod({ appHome, out: env.out, err: env.err });
    }
    case "doctor":
      return await doctor({ host, stateDir: env.stateDir, tailscale: env.tailscale, port: env.port, out: env.out });
    case "pair":
      return await pair(env, p.flags.get("scope"), p.flags.get("name"));
    case "devices":
      return await devices(env);
    case "revoke":
      return await revoke(env, p.positional[0]);
    default:
      return report(env, await serve(env.tailscale, { port: env.port, dryRun: p.flags.has("dry-run") }));
  }
}

async function pair(env: CliEnv, scope: string | true | undefined, name: string | true | undefined): Promise<number> {
  if (scope !== undefined && scope !== "read" && scope !== "act") {
    env.err("herdr-relay: --scope must be read or act");
    return 2;
  }
  const token = await readToken(env.stateDir);
  if (!token) {
    env.err(`herdr-relay: no loopback token in ${env.stateDir}; start the bridge first (herdr-relay start)`);
    return 1;
  }
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${env.port}${MOUNT}/api/pair/code`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ scope: scope ?? "read", ...(name === undefined ? {} : { name }) }),
    });
  } catch {
    env.err(`herdr-relay: the bridge is not running on 127.0.0.1:${env.port} (herdr-relay start)`);
    return 1;
  }
  if (!res.ok) {
    env.err(`herdr-relay: ${(await res.text()).trim()} (HTTP ${res.status})`);
    return 1;
  }
  const r: unknown = await res.json();
  if (!isPairCode(r)) {
    env.err("herdr-relay: unexpected answer from the bridge");
    return 1;
  }
  const until = new Date(r.expiresAt).toLocaleTimeString();
  env.out(`Pairing code: ${r.code.slice(0, 3)} ${r.code.slice(3)}`);
  env.out(`One use, scope ${r.scope}${r.name ? `, name "${r.name}"` : ""}, expires at ${until} (2 min).`);
  env.out(
    r.url
      ? `On the device, open ${r.url} and enter the code.`
      : "Tailscale is not running on this Mac: devices cannot reach the bridge until it is (then herdr-relay serve).",
  );
  return 0;
}

interface PairCode {
  code: string;
  scope: string;
  name: string | null;
  expiresAt: string;
  url: string | null;
}

function isPairCode(v: unknown): v is PairCode {
  if (typeof v !== "object" || v === null) return false;
  const o: Record<string, unknown> = { ...v };
  return typeof o.code === "string" && /^\d{6}$/.test(o.code) && typeof o.scope === "string" &&
    (o.name === null || typeof o.name === "string") && typeof o.expiresAt === "string" &&
    (o.url === null || typeof o.url === "string");
}

async function devices(env: CliEnv): Promise<number> {
  let list;
  try {
    list = await new DeviceStore(env.stateDir).list();
  } catch (e) {
    env.err(`herdr-relay: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  if (list.length === 0) {
    env.out("No paired devices.");
    return 0;
  }
  env.out(`${"ID".padEnd(14)}${"SCOPE".padEnd(7)}${"PAIRED".padEnd(18)}NAME`);
  for (const d of list) {
    const when = new Date(d.created);
    const stamp = `${when.toLocaleDateString("sv-SE")} ${when.toTimeString().slice(0, 5)}`;
    env.out(`${d.id.padEnd(14)}${d.scope.padEnd(7)}${stamp.padEnd(18)}${d.name}`);
  }
  return 0;
}

async function revoke(env: CliEnv, target: string): Promise<number> {
  try {
    const d = await new DeviceStore(env.stateDir).revoke(target);
    env.out(`Revoked ${d.id} (${d.name}, ${d.scope}); its open sessions close within 2 s.`);
    return 0;
  } catch (e) {
    env.err(`herdr-relay: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

function report(env: CliEnv, o: ServeOutcome): number {
  if (o.argv && o.plan?.kind === "run") env.out(`plan: ${o.argv.join(" ")}`);
  (o.ok ? env.out : env.err)(o.ok ? o.message : `herdr-relay: ${o.message}`);
  return o.ok ? 0 : 1;
}

if (import.meta.main) {
  let env: CliEnv;
  try {
    env = {
      stateDir: stateDirOf(homeFrom(Deno.env)),
      port: parsePort(Deno.env.get("HERDR_RELAY_PORT")),
      tailscale: tailscaleRunner(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    };
  } catch (e) {
    console.error(`herdr-relay: ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(2);
  }
  Deno.exit(await cli(Deno.args, env));
}
