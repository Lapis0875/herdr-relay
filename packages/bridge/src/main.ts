/**
 * The herdr-relay bridge (DESIGN-v2 §1.1): the privileged process — auth, HTTP/WS, policy, tailscale — that never
 * loads mod code. Started by `deno task start` / `start:dev` with the flags in the root `deno.json`.
 *
 * Startup order: the platform and configuration from the environment (exit 2 when invalid: Windows; a platform without
 * a mod-host sandbox provider, i.e. Linux until T39, unless `HERDR_RELAY_DEV=insecure-no-sandbox`); the platform's
 * sandbox (Seatbelt on macOS) must work, else exit 3 unless `insecure-no-sandbox`, which also turns pairing and every
 * tailnet request off so the unconfined mode only ever answers the loopback token; `<state>` (0700) with the loopback
 * token; the device list; the Tailscale identity (refreshed every 30 s); the session layer (`app.ts`: `<run>`,
 * herdr-core client, herdr data, mirror endpoint, terminal relay, push, view manager with the mod host supervisor; exit
 * 1 when it cannot start); the server on `127.0.0.1:<port>` with the session layer behind `/ws` and its routes (mod
 * assets, VAPID key, mirror).
 *
 * SIGINT/SIGTERM: the server closes every socket (1001) and stops listening, then the session layer stops in reverse
 * start order and removes `<run>` (exit 0).
 *
 * `--self-test` (DESIGN-v2 §5.3 S32, `selftest.ts`): with the same flags, only the configuration is loaded (exit 2
 * when invalid), then every probe of what the bridge's flags must refuse is attempted and reported as one JSON line on
 * stdout; exit 0 when all were blocked, 1 otherwise. Nothing else starts.
 */

import {
  Auth,
  DeviceStore,
  ensureStateDir,
  ensureToken,
  PairingCodes,
  PeerCheck,
  runCommand,
  type TailnetIdentity,
  tailscaleRunner,
  TicketBook,
  whoami,
} from "./auth/mod.ts";
import { startSessionLayer } from "./app.ts";
import { type BridgeConfig, ConfigError, type Env, loadConfig, MOUNT } from "./config.ts";
import { messageOf } from "./core/errors.ts";
import { hostPlatform, type Platform } from "./platform.ts";
import { selfTest } from "./selftest.ts";
import { startServer } from "./server/mod.ts";

export const EXIT_FAILURE = 1;
export const EXIT_CONFIG = 2;
export const EXIT_NO_SANDBOX = 3;

const TAILNET_REFRESH_MS = 30_000;

const say = (line: string) => console.error(`herdr-relay: ${line}`);

/** What {@link runBridge} and {@link runSelfTest} read the machine through; tests pass a fake platform and environment. */
export interface BridgeHost {
  /** Resolves the platform (`hostPlatform`); a `ConfigError` where unsupported. */
  platform?: () => Platform;
  env?: Env;
}

/** The configuration, or `null` after saying why it is invalid. */
function configFor(host: BridgeHost): BridgeConfig | null {
  try {
    return loadConfig((host.platform ?? hostPlatform)(), host.env);
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    say(e.message);
    return null;
  }
}

/** `--self-test`: the S32 probes under this process's flags; 0 when all were blocked, 1 otherwise, 2 on bad config. */
export async function runSelfTest(host: BridgeHost = {}): Promise<number> {
  const cfg = configFor(host);
  return cfg === null ? EXIT_CONFIG : await selfTest(cfg);
}

/** Runs the bridge until SIGINT/SIGTERM; resolves to the process exit code. */
export async function runBridge(host: BridgeHost = {}): Promise<number> {
  const cfg = configFor(host);
  if (cfg === null) return EXIT_CONFIG;

  const sandbox = cfg.platform.sandbox;
  if (cfg.dev === "insecure-no-sandbox") {
    say(
      `WARNING: HERDR_RELAY_DEV=insecure-no-sandbox — mod hosts run without ${sandbox?.label ?? "a sandbox"}; ` +
        "pairing and tailnet access are disabled (loopback token only)",
    );
  } else if (sandbox === null || !(await sandbox.available())) {
    say(
      `${sandbox?.unavailable ?? "no mod-host sandbox"}; refusing to start. For local development only, ` +
        "HERDR_RELAY_DEV=insecure-no-sandbox runs without it (pairing and tailnet access off).",
    );
    return EXIT_NO_SANDBOX;
  }

  await ensureStateDir(cfg.stateDir);
  const token = await ensureToken(cfg.stateDir);
  const devices = new DeviceStore(cfg.stateDir);
  await devices.refresh();
  if (devices.error) say(`${devices.error}; no device counts as paired until it is fixed`);

  const peer = new PeerCheck(cfg.port, runCommand, cfg.platform.peerCheck);
  const auth = new Auth({
    port: cfg.port,
    token,
    devices,
    tickets: new TicketBook(),
    pairing: cfg.pairing ? new PairingCodes() : null,
    tailnetEnabled: cfg.pairing,
    extraLoopbackHosts: cfg.dev === "dev" ? ["10.0.2.2"] : [],
    peer: (remotePort) => peer.trusted(remotePort),
  });

  let tailnetTimer: ReturnType<typeof setInterval> | undefined;
  if (cfg.pairing) {
    const run = tailscaleRunner(cfg.platform.tailscaleBin);
    const refresh = async () => {
      const me: TailnetIdentity | null = await whoami(run);
      if (me?.owner !== auth.tailnet?.owner || me?.dns !== auth.tailnet?.dns) {
        say(me ? `tailnet: https://${me.dns}${MOUNT}/ for ${me.owner}` : "tailnet: Tailscale is not running");
      }
      auth.tailnet = me;
    };
    await refresh();
    tailnetTimer = setInterval(refresh, TAILNET_REFRESH_MS);
  }

  let layer;
  try {
    layer = await startSessionLayer({ cfg, auth, log: say });
  } catch (e) {
    clearInterval(tailnetTimer);
    say(`cannot start the session layer: ${messageOf(e)}`);
    return EXIT_FAILURE;
  }

  let server;
  try {
    server = startServer({
      port: cfg.port,
      auth,
      sessions: layer.sessions,
      routes: layer.routes,
      webRoot: cfg.webRoot,
      onListen: (addr) => say(`listening on http://${addr.hostname}:${addr.port}${MOUNT}/ (dev: ${cfg.dev})`),
    });
  } catch (e) {
    clearInterval(tailnetTimer);
    await layer.stop();
    if (!(e instanceof Deno.errors.AddrInUse)) throw e;
    say(`127.0.0.1:${cfg.port} is already in use (set HERDR_RELAY_PORT)`);
    return EXIT_FAILURE;
  }

  const stop = () => {
    clearInterval(tailnetTimer);
    void server.shutdown();
  };
  Deno.addSignalListener("SIGINT", stop);
  Deno.addSignalListener("SIGTERM", stop);
  await server.finished;
  await layer.stop();
  Deno.removeSignalListener("SIGINT", stop);
  Deno.removeSignalListener("SIGTERM", stop);
  say("stopped");
  return 0;
}

if (import.meta.main) Deno.exit(Deno.args[0] === "--self-test" ? await runSelfTest() : await runBridge());
