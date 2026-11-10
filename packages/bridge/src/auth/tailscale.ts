/**
 * The tailnet side (DESIGN.md §4 "Network/identity", D7), after Shepherdr's `tailscale.ts`: the machine owner's
 * login and MagicDNS name from `tailscale status --json`, and publishing `127.0.0.1:<port>` at
 * `https://<dns>/herdr-relay` with `tailscale serve --bg --set-path /herdr-relay <port>`. Never Funnel: the helper
 * refuses while Funnel is on anywhere on this node, and undoes its own share if Funnel shows up for it afterwards.
 *
 * Every call goes through a {@link TailscaleRun} so tests can stub the CLI; the real one runs the platform's Tailscale
 * CLI (`../platform.ts`, G7) with `TAILSCALE_BE_CLI=1` (what `~/.local/bin/tailscale` sets for the macOS app binary;
 * without it that binary launches the app; other CLIs ignore it).
 */

import { MOUNT } from "../config.ts";
import { hostPlatform } from "../platform.ts";

export type TailscaleRun = (args: string[]) => Promise<{ ok: boolean; out: string }>;

export function tailscaleRunner(bin: string = hostPlatform().tailscaleBin): TailscaleRun {
  return async (args) => {
    try {
      const r = await new Deno.Command(bin, {
        args,
        env: { TAILSCALE_BE_CLI: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      const out = new TextDecoder().decode(r.stdout);
      return { ok: r.success, out: r.success ? out : out + new TextDecoder().decode(r.stderr) };
    } catch (e) {
      return { ok: false, out: e instanceof Error ? e.message : String(e) };
    }
  };
}

/** Who may use the bridge over the tailnet, and the only `Host` it answers there. */
export interface TailnetIdentity {
  /** `Tailscale-User-Login` of the machine owner, e.g. `owner@github`. */
  owner: string;
  /** MagicDNS name without the trailing dot, lowercase, e.g. `<mac>.<tailnet>.ts.net`. */
  dns: string;
}

/** The owner and DNS name from `tailscale status --json`, or `null` when Tailscale is not running/logged in. */
export function parseStatus(json: string): TailnetIdentity | null {
  try {
    const s = JSON.parse(json);
    if (s?.BackendState !== undefined && s.BackendState !== "Running") return null;
    const self = s?.Self;
    // Matched by the parsed `ID`, not by the map key: both sides go through the same number parse.
    const owners = Object.values<{ ID?: unknown; LoginName?: unknown }>(s?.User ?? {})
      .filter((u) => u?.ID === self?.UserID)
      .map((u) => u?.LoginName);
    const owner = owners.length === 1 && typeof owners[0] === "string" ? owners[0] : null;
    const dns = typeof self?.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
    if (!owner || !dns || self?.UserID === undefined) return null;
    return { owner, dns };
  } catch {
    return null;
  }
}

export async function whoami(run: TailscaleRun): Promise<TailnetIdentity | null> {
  const r = await run(["status", "--json"]);
  return r.ok ? parseStatus(r.out) : null;
}

/** What `tailscale serve status --json` says about this node and the mount. */
export interface ServeState {
  /** `host:port` entries with Funnel on (any of them stops the helper). */
  funnel: string[];
  /** Where the mount points on this node's MagicDNS name now, and on which HTTPS port. */
  proxy: string | null;
  httpsPort: string | null;
}

export function parseServeStatus(json: string, dns: string, mount: string = MOUNT): ServeState {
  const s = JSON.parse(json || "{}") ?? {};
  const funnel = Object.entries<unknown>(s.AllowFunnel ?? {}).filter(([, on]) => on === true).map(([hp]) => hp);
  for (const [hostPort, web] of Object.entries<{ Handlers?: Record<string, { Proxy?: unknown }> }>(s.Web ?? {})) {
    const at = hostPort.lastIndexOf(":");
    if (hostPort.slice(0, at).toLowerCase() !== dns) continue;
    const h = web?.Handlers?.[mount];
    if (h) return { funnel, proxy: typeof h.Proxy === "string" ? h.Proxy : null, httpsPort: hostPort.slice(at + 1) };
  }
  return { funnel, proxy: null, httpsPort: null };
}

export type ServePlan =
  | { kind: "refuse"; reason: string }
  | { kind: "already"; proxy: string }
  | { kind: "run"; args: string[] };

/** The loopback target `tailscale serve <port>` creates. */
export const proxyFor = (port: number): string => `http://127.0.0.1:${port}`;

export function planServe(state: ServeState, port: number, mount: string = MOUNT): ServePlan {
  if (state.funnel.length > 0) {
    return {
      kind: "refuse",
      reason: `Funnel is on for ${state.funnel.join(", ")}; herdr-relay is tailnet-only and will not be served`,
    };
  }
  if (state.proxy === proxyFor(port)) return { kind: "already", proxy: state.proxy };
  if (state.proxy !== null) return { kind: "refuse", reason: `${mount} is already shared to ${state.proxy}` };
  return { kind: "run", args: ["serve", "--bg", "--set-path", mount, String(port)] };
}

export interface ServeOutcome {
  ok: boolean;
  message: string;
  /** The decided plan, when the status could be read. */
  plan?: ServePlan;
  /** The Tailscale invocation the plan runs (printed for `--dry-run`). */
  argv?: string[];
}

/** Reads `tailscale serve status --json` for this node; a string is the reason it could not be read. */
async function readServeState(run: TailscaleRun, dns: string, mount: string): Promise<ServeState | string> {
  const status = await run(["serve", "status", "--json"]);
  if (!status.ok) return `cannot read tailscale serve status: ${status.out.trim()}`;
  try {
    return parseServeStatus(status.out, dns, mount);
  } catch {
    return "tailscale serve status --json is not JSON";
  }
}

/** Decides and (unless `dryRun`) applies `tailscale serve --bg --set-path <mount> <port>`, then re-verifies it. */
export async function serve(
  run: TailscaleRun,
  o: { port: number; dryRun: boolean; mount?: string; bin?: string },
): Promise<ServeOutcome> {
  const mount = o.mount ?? MOUNT;
  const me = await whoami(run);
  if (!me) return { ok: false, message: "Tailscale is not running or not logged in on this Mac" };
  const state = await readServeState(run, me.dns, mount);
  if (typeof state === "string") return { ok: false, message: state };
  const plan = planServe(state, o.port, mount);
  const url = `https://${me.dns}${mount}/`;
  if (plan.kind === "refuse") return { ok: false, message: `refusing to serve: ${plan.reason}`, plan };
  if (plan.kind === "already") return { ok: true, message: `already serving ${url} → ${plan.proxy}`, plan };
  const argv = [o.bin ?? hostPlatform().tailscaleBin, ...plan.args];
  if (o.dryRun) return { ok: true, message: `would serve ${url} → ${proxyFor(o.port)} (dry run)`, plan, argv };

  const r = await run(plan.args);
  if (!r.ok) return { ok: false, message: `tailscale serve failed: ${r.out.trim()}`, plan, argv };
  const now = await readServeState(run, me.dns, mount);
  if (typeof now === "string") return { ok: false, message: `served, but ${now}; verify by hand`, plan, argv };
  if (now.funnel.length > 0) {
    await run(["serve", `--https=${now.httpsPort ?? 443}`, "--set-path", mount, "off"]);
    return { ok: false, message: `Funnel turned on (${now.funnel.join(", ")}); ${mount} share removed`, plan, argv };
  }
  if (now.proxy !== proxyFor(o.port)) {
    return { ok: false, message: `${mount} points to ${now.proxy ?? "nothing"} after tailscale serve`, plan, argv };
  }
  return { ok: true, message: `serving ${url} → ${proxyFor(o.port)}`, plan, argv };
}
