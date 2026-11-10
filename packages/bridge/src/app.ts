/**
 * The bridge's session layer (DESIGN-v2 §1.1, §1.7): everything behind `/ws` and the extension routes, composed for
 * one bridge run.
 *
 * - `<run>` = `$TMPDIR/herdr-relay/<run-id>/` (0700): the mod hosts' Seatbelt profiles and DENO_DIRs and the scoped
 *   runners' DENO_DIR. The bridge's own file operations use its lexical path (Deno's permission allowlists do not
 *   follow symlinks such as macOS `/var` → `/private/var`); real paths only go into Seatbelt profiles. Removed when
 *   the layer stops.
 * - One {@link CoreClient} (`hc connect`) shared by the herdr data source, the terminal relay and the push triggers.
 * - The policy profiles (OSS-PLAN §1, {@link ProfileSet}): the built-ins and `<state>/profiles/*.json`, loaded once;
 *   an invalid built-in stops the layer, an invalid user file is logged and ignored. Every mod folder's exec, hc, net
 *   and reads are decided under its profile; its id is in `hello.hosts[].profile` and every policy record.
 * - {@link HerdrSource} feeds the {@link ViewManager}, which owns the device sessions and runs mod copies through the
 *   {@link HostSupervisor} (Seatbelt; unconfined only in `insecure-no-sandbox`). What the view manager does not handle
 *   goes on: `term.open`/`term.close` and binary input to the {@link TerminalRelay}, `visible`/`push.sub`/`push.test`
 *   to the {@link PushService}; a closed socket is dropped from both.
 * - The devices' layout profiles ({@link LayoutProfileStore}, `<state>/layout-profiles/`, D12): loaded once; the
 *   profiles of devices no longer paired are removed at start (when the device list is readable; `local` stays) and
 *   after every device-list sweep of the server (`ViewManager.retainDevices`); pending writes are flushed at stop.
 * - The mirror endpoint ({@link MirrorEndpoint}, `/mirror`): the `herdr-relay-mirror` mod's snapshots feed
 *   {@link HerdrSource.mirror}.
 * - Routes: mod assets (`/assets/…`, under the herdr read roots), the VAPID key (`/push/key`) and the mirror.
 *
 * `stop()` runs in reverse start order: view manager → host supervisor → push and relay → mirror → layout profiles →
 * herdr data → core → `<run>`.
 */

import { dirname, join } from "@std/path";
import { type Auth, LOCAL_DEVICE } from "./auth/mod.ts";
import type { BridgeConfig } from "./config.ts";
import { CoreClient } from "./core/mod.ts";
import { messageOf } from "./core/errors.ts";
import { HerdrSource } from "./herdr/mod.ts";
import { HostSupervisor } from "./hosts/mod.ts";
import { fileLog, ProfileSet } from "./policy/mod.ts";
import { MirrorEndpoint } from "./mirror.ts";
import { PushService, subjectOverride, vapidSubject } from "./push/mod.ts";
import type { Route, SessionConnection, SessionHandler } from "./server/mod.ts";
import { LayoutProfileStore } from "./session/profiles.ts";
import { assetRoute } from "./static.ts";
import { TerminalRelay } from "./terminal/mod.ts";
import { type PathRoot, ViewManager } from "./views/mod.ts";

export interface SessionLayerOptions {
  cfg: BridgeConfig;
  /** Its device list decides which push subscriptions stay; its tailnet name is the VAPID subject (unless overridden). */
  auth: Auth;
  /** Teardown failures. */
  log: (line: string) => void;
}

export interface SessionLayer {
  /** The server's `/ws` handler: the view manager (its `revokeDevice`/`retainDevices` serve the device sweep). */
  readonly sessions: ViewManager;
  readonly routes: readonly Route[];
  /** Stops everything in reverse start order and removes `<run>`. Idempotent; never rejects. */
  stop(): Promise<void>;
}

/** Starts the session layer; on failure whatever already started is stopped again and `<run>` is removed. */
export async function startSessionLayer(o: SessionLayerOptions): Promise<SessionLayer> {
  const { cfg, auth, log } = o;
  const teardown: (() => void | Promise<void>)[] = [];
  const unwind = async () => {
    for (const step of teardown.splice(0).reverse()) {
      try {
        await step();
      } catch (e) {
        log(`shutdown: ${messageOf(e)}`);
      }
    }
  };

  try {
    await Deno.mkdir(cfg.runRoot, { recursive: true, mode: 0o700 });
    const run = await Deno.makeTempDir({ dir: cfg.runRoot, prefix: `${Deno.pid}-` });
    teardown.push(() => Deno.remove(run, { recursive: true }));
    await Deno.chmod(run, 0o700);
    // `--allow-read` covers `<repo>/packages`, not the repository root itself.
    const [runReal, home, appHome, packages, modhost] = await Promise.all(
      [run, cfg.home, cfg.appHome, `${cfg.repo}/packages`, cfg.modhost].map((p) => Deno.realPath(p)),
    );
    const repo = dirname(packages);

    const core = new CoreClient();
    teardown.push(() => core.close());
    core.start();

    // Device sockets by session id, for toasts a mod's call raises on the device it came from (E11 `open <url>`).
    const sockets = new Map<string, SessionConnection>();
    const sessionOf = new Map<SessionConnection, string>();
    let supervisor: HostSupervisor | null = null;
    let views: ViewManager | null = null;

    const policyLog = fileLog(cfg.stateDir);
    const profiles = await ProfileSet.load({
      userDir: join(cfg.stateDir, "profiles"),
      log: (line) => log(`profiles: ${line}`),
    });
    const herdr = await HerdrSource.start({
      appHome: cfg.appHome,
      home: cfg.home,
      core,
      // `run` stays lexical: the policy creates the scoped runners' DENO_DIR under it from the bridge.
      paths: { home, appHome, state: cfg.stateDir, run, repo },
      env: cfg.programEnv,
      policyLog,
      profiles,
      platform: cfg.platform,
      loadedFolders: () =>
        new Set(
          (supervisor?.statuses() ?? []).filter((s) => s.state === "starting" || s.state === "running")
            .map((s) => s.folder),
        ),
      toast: (session, toast) => sockets.get(session)?.send(toast) ?? false,
    });
    teardown.push(() => herdr.close());

    const layoutProfiles = await LayoutProfileStore.open(cfg.stateDir, (line) => log(`layout profiles: ${line}`));
    teardown.push(() => layoutProfiles.flush());
    if (auth.devices.error === null) layoutProfiles.retain((id) => id === LOCAL_DEVICE.id || auth.devices.has(id));

    const mirror = await MirrorEndpoint.start({
      appHome: cfg.appHome,
      stateDir: cfg.stateDir,
      port: cfg.port,
      sink: herdr,
      log: (line) => log(`mirror: ${line}`),
      onOutdated: (text) => {
        for (const conn of sockets.values()) conn.send({ t: "toast", title: text, level: "warning" });
      },
    });
    teardown.push(() => mirror.close());

    const relay = new TerminalRelay(core);
    teardown.push(() => relay.dispose());
    const subject = subjectOverride((line) => log(`push: ${line}`));
    const push = new PushService({
      stateDir: cfg.stateDir,
      subject: () => vapidSubject(subject, auth.tailnet?.dns ?? null),
      machineName: () => core.session?.hello.core.name || auth.tailnet?.dns.split(".")[0] || "the Mac",
      devicePaired: (id) => id === LOCAL_DEVICE.id || auth.devices.has(id),
    });
    teardown.push(push.watch(core));

    const next: SessionHandler = {
      open(conn) {
        const id = views?.session(conn.id)?.id;
        if (id === undefined) return;
        sessionOf.set(conn, id);
        sockets.set(id, conn);
      },
      message(conn, msg) {
        switch (msg.t) {
          case "term.open":
          case "term.close":
            return relay.message(conn, msg);
          case "visible":
          case "push.sub":
          case "push.test":
            return push.message(conn, msg);
          default:
            // `nav`, `event`, `command` and `layout` are the view manager's own.
            conn.send({ t: "ack", id: msg.id, ok: false, error: "refused", message: "not available" });
        }
      },
      binary(conn, frame) {
        return relay.input(conn, frame);
      },
      close(conn) {
        relay.drop(conn);
        push.drop(conn);
        const id = sessionOf.get(conn);
        sessionOf.delete(conn);
        if (id !== undefined && sockets.get(id) === conn) sockets.delete(id);
      },
    };

    const roots: PathRoot[] = [
      { path: appHome, label: "" },
      { path: cfg.appHome, label: "" },
      { path: modhost, label: "modhost/" },
      { path: cfg.modhost, label: "modhost/" },
      { path: runReal, label: "run/" },
      { path: run, label: "run/" },
    ];
    views = await ViewManager.start({
      data: herdr,
      roots,
      policyLog,
      profiles: layoutProfiles,
      hosts: async (wiring) => {
        const hosts = await HostSupervisor.create({
          appHome: cfg.appHome,
          modhost: cfg.modhost,
          run,
          stateDir: cfg.stateDir,
          stateFor: wiring.stateFor,
          handlers: wiring.handlers,
          sandbox: cfg.dev === "insecure-no-sandbox" ? null : cfg.platform.sandbox,
          policyLog,
          profileOf: (folder) => profiles.profileFor(folder).id,
        });
        teardown.push(() => hosts.stop());
        supervisor = hosts;
        return hosts;
      },
      next,
    });
    const vm = views;
    teardown.push(() => vm.stop());

    let stopping: Promise<void> | null = null;
    return {
      sessions: vm,
      routes: [assetRoute(() => herdr.roots), push.route(), mirror.route()],
      stop: () => (stopping ??= unwind()),
    };
  } catch (e) {
    await unwind();
    throw e;
  }
}
