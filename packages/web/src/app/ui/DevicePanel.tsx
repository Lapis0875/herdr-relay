/**
 * "Device & Notifications": the connection (state, layout and how many of its sizes this device overrides, session,
 * this device's scope), resetting this device's layout profile (where the graph lets it resize something), the Web Push
 * switch (D11; "Needs you" / "Finished" from the bridge) with a test notification and the service worker's state, the
 * mod hosts the bridge reported, installing the app (Android's install prompt; Home Screen on iPhone/iPad, which Web
 * Push requires there) and the keyboard diagnostics.
 */

import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { type ScreenGraph, screenNodes } from "@herdr-relay/protocol";
import { bridge } from "../client.ts";
import { isAppleMobile, isStandalone } from "../env.ts";
import {
  disablePush,
  enablePush,
  type PushDetails,
  pushDetails,
  type PushStatus,
  pushStatus,
  type PushTestResult,
  sendTestPush,
} from "../push.ts";
import { setSoundMuted, useSoundMuted } from "../sound.ts";
import { setState, useApp } from "../store.ts";
import { Icon } from "./icons.tsx";
import { setKeyboardDiagnostics, useKeyboardDiagnostics } from "./KeyboardDiagnostics.tsx";
import { Sheet } from "./Sheet.tsx";
import { connTone, formatTime } from "./Status.tsx";

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

let installPrompt: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();

/** Keeps Chrome's install prompt for the "Install App" button (call once at boot). */
export function captureInstallPrompt(): void {
  addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e as InstallPromptEvent;
    for (const l of installListeners) l();
  });
  addEventListener("appinstalled", () => {
    installPrompt = null;
    for (const l of installListeners) l();
  });
}

export function DevicePanel(): ReactElement | null {
  const open = useApp((s) => s.panel === "device");
  const phone = useApp((s) => s.deviceClass === "phone");
  if (!open) return null;
  return (
    <Sheet
      side={phone ? "bottom" : "right"}
      label="Device and notifications"
      title="Device & Notifications"
      size={phone ? "86vh" : "min(92vw, 400px)"}
      onClose={() => setState({ panel: "none" })}
    >
      <div className="panel">
        <ConnectionSection />
        <LayoutSection />
        <PushSection />
        <SoundSection />
        <InstallSection />
        <HostsSection />
        <DiagnosticsSection />
      </div>
    </Sheet>
  );
}

const TONE_LABEL = { live: "Connected", connecting: "Connecting…", offline: "Offline" } as const;

function ConnectionSection(): ReactElement {
  const tone = useApp(connTone);
  const hello = useApp((s) => s.hello);
  const graph = useApp((s) => s.graph);
  const sizable = useSizable(graph);
  const gate = useApp((s) => s.gate);
  const stale = useApp((s) => s.stale);
  const conn = useApp((s) => s.conn);
  const device = gate.kind === "ready" ? gate.device : null;
  const scope = hello?.scope ?? device?.scope;
  return (
    <section className="panel__section" aria-labelledby="panel-connection">
      <h3 id="panel-connection" className="panel__heading">Connection</h3>
      <dl className="facts">
        <div className="facts__row">
          <dt>Status</dt>
          <dd>
            <span className="status-dot" data-tone={tone} aria-hidden="true" />
            {TONE_LABEL[tone]}
            {conn.kind === "retry" ? <span className="facts__note">{conn.why}</span> : null}
          </dd>
        </div>
        {stale
          ? (
            <div className="facts__row">
              <dt>Showing</dt>
              <dd>{`Data from ${formatTime(stale.since)}`}</dd>
            </div>
          )
          : null}
        {device
          ? (
            <div className="facts__row">
              <dt>Device</dt>
              <dd>{device.name}</dd>
            </div>
          )
          : null}
        <div className="facts__row">
          <dt>Access</dt>
          <dd>{scope === "act" ? "View and act" : scope === "read" ? "View only" : "—"}</dd>
        </div>
        {graph
          ? (
            <div className="facts__row">
              <dt>Layout</dt>
              <dd>
                <span translate="no">{graph.layout}</span>
                {sizable
                  ? <span className="facts__aside">{`· ${overridesText(graph.overridden?.length ?? 0)}`}</span>
                  : null}
              </dd>
            </div>
          )
          : null}
        {hello
          ? (
            <div className="facts__row">
              <dt>Session</dt>
              <dd className="facts__mono" translate="no">{hello.session}</dd>
            </div>
          )
          : null}
      </dl>
      <button
        type="button"
        className="button"
        onClick={() => bridge.reconnectNow()}
        disabled={conn.kind === "connecting"}
      >
        <Icon name="refresh" size={18} />
        Reconnect Now
      </button>
    </section>
  );
}

function overridesText(n: number): string {
  if (n === 0) return "no overrides on this device";
  return `${n} ${n === 1 ? "override" : "overrides"} on this device`;
}

/** Whether this device may resize anything on its graph (a node marked `resize`), or already overrides something. */
function useSizable(graph: ScreenGraph | null): boolean {
  return useMemo(
    () =>
      !!graph && ((graph.overridden?.length ?? 0) > 0 ||
        graph.routes.some((r) => [...screenNodes(r.screen)].some((n) => "resize" in n && n.resize !== undefined))),
    [graph],
  );
}

/** This device's layout profile (tablet and desktop: phones resize nothing): dropping its sizes for this layout. */
function LayoutSection(): ReactElement | null {
  const graph = useApp((s) => s.graph);
  const live = useApp((s) => s.conn.kind === "live");
  const sizable = useSizable(graph);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const count = graph?.overridden?.length ?? 0;
  useEffect(() => {
    if (count > 0) setDone(false);
  }, [count]);
  if (!sizable) return null;
  // `aria-disabled`, not `disabled`: the button keeps focus once its reset leaves nothing to reset.
  const off = count === 0 || !live || busy;
  const reset = async () => {
    if (off) return;
    setBusy(true);
    const ack = await bridge.resetLayout();
    setBusy(false);
    setDone(ack.ok);
  };
  return (
    <section className="panel__section" aria-labelledby="panel-layout">
      <h3 id="panel-layout" className="panel__heading">Panel Sizes</h3>
      <p className="panel__text">
        Panel sizes you drag here are kept for this device and orientation. The Mac’s layout does not change.
      </p>
      <button type="button" className="button" aria-disabled={off} onClick={() => void reset()}>
        <Icon name="refresh" size={18} />
        {busy ? "Resetting…" : "Reset Layout for This Device"}
      </button>
      <p className="panel__text" role="status">
        {done ? "This device shows the Mac’s sizes again." : ""}
      </p>
    </section>
  );
}

function pushText(status: PushStatus): string {
  switch (status.kind) {
    case "unsupported":
    case "error":
      return status.why;
    case "needs-install":
      return "On iPad and iPhone, notifications work only in the Home Screen app. In Safari, tap Share → Add to Home " +
        "Screen, then open herdr from the Home Screen and turn this on there.";
    case "denied":
      return isAppleMobile()
        ? "Notifications are turned off for this app. Turn them on in Settings → Notifications → herdr (its Home " +
          "Screen name) → Allow Notifications, then come back here."
        : "Notifications are blocked for this site. Allow them in the browser’s site settings, then come back here.";
    case "off":
      return status.why ?? "Get a notification when an agent needs you or finishes, while this device is not looking.";
    case "on":
      return "You get a notification when an agent needs you or finishes.";
  }
}

const WORKER_TEXT: Record<PushDetails["worker"], string> = {
  unavailable: "Not available here",
  none: "Not registered",
  installing: "Installing…",
  waiting: "Waiting to start",
  active: "Active",
};

const PERMISSION_TEXT: Record<NotificationPermission, string> = {
  granted: "Allowed",
  denied: "Blocked",
  default: "Not asked yet",
};

/**
 * The Web Push switch, a test notification once it is on, and what the browser reports (service worker, permission,
 * push service) for debugging. Re-read when the page comes back into view (after Settings) or a worker takes over.
 */
function PushSection(): ReactElement {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [details, setDetails] = useState<PushDetails | null>(null);
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<PushTestResult | "sending" | null>(null);
  const mounted = useRef(false);
  /** Bumped when a toggle starts and ends: a read begun before that cannot overwrite the toggle's outcome. */
  const turn = useRef(0);
  const apply = (mine: number, s: PushStatus, d: PushDetails) => {
    if (!mounted.current || mine !== turn.current) return;
    setStatus(s);
    setDetails(d);
  };
  const read = async () => {
    const mine = turn.current;
    const s = await pushStatus();
    apply(mine, s, await pushDetails());
  };
  useEffect(() => {
    mounted.current = true;
    const refresh = () => void read();
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    refresh();
    document.addEventListener("visibilitychange", onVisible);
    const sw = isSecureContext && "serviceWorker" in navigator ? navigator.serviceWorker : null;
    sw?.addEventListener("controllerchange", refresh);
    void sw?.ready.then(refresh);
    return () => {
      mounted.current = false;
      document.removeEventListener("visibilitychange", onVisible);
      sw?.removeEventListener("controllerchange", refresh);
    };
  }, []);
  const on = status?.kind === "on";
  const usable = status !== null && (status.kind === "on" || status.kind === "off" || status.kind === "error");
  const toggle = () => {
    // First, in the tap itself: `enablePush` asks for permission before it awaits anything (iOS prompts only then).
    const next = on ? disablePush() : enablePush();
    turn.current++;
    setBusy(true);
    setTest(null);
    void next.then(async (s) => {
      const d = await pushDetails();
      if (!mounted.current) return;
      setBusy(false);
      apply(++turn.current, s, d);
    });
  };
  const sendTest = async () => {
    setTest("sending");
    const result = await sendTestPush();
    if (mounted.current) setTest(result);
  };
  return (
    <section className="panel__section" aria-labelledby="panel-push">
      <h3 id="panel-push" className="panel__heading">Notifications</h3>
      <div className="switch-row">
        <span className="switch-row__label" id="push-label">Agent needs you · finished</span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={on}
          aria-labelledby="push-label"
          aria-describedby="push-text"
          disabled={!usable || busy}
          onClick={toggle}
        >
          <span className="switch__thumb" aria-hidden="true" />
        </button>
      </div>
      <p
        id="push-text"
        className="panel__text"
        data-tone={status?.kind === "error" ? "error" : undefined}
        aria-live="polite"
      >
        {busy ? "Working…" : status === null ? "Checking…" : pushText(status)}
      </p>
      {on && !busy
        ? (
          <button type="button" className="button" disabled={test === "sending"} onClick={() => void sendTest()}>
            <Icon name="bell" size={18} />
            Send Test Notification
          </button>
        )
        : null}
      <p
        className="panel__text"
        role="status"
        data-tone={test !== null && test !== "sending" && !test.ok ? "error" : undefined}
      >
        {test === "sending" ? "Sending…" : test?.text ?? ""}
      </p>
      {details
        ? (
          <dl className="facts">
            <div className="facts__row">
              <dt>Service worker</dt>
              <dd>
                {WORKER_TEXT[details.worker]}
                {details.worker === "active" && !details.controlled
                  ? <span className="facts__note">Not serving this page yet</span>
                  : null}
              </dd>
            </div>
            {details.scope
              ? (
                <div className="facts__row">
                  <dt>Scope</dt>
                  <dd className="facts__mono" translate="no">{details.scope}</dd>
                </div>
              )
              : null}
            <div className="facts__row">
              <dt>Permission</dt>
              <dd>{details.permission ? PERMISSION_TEXT[details.permission] : "Not available here"}</dd>
            </div>
            <div className="facts__row">
              <dt>Push service</dt>
              <dd>
                {details.service ? <span className="facts__mono" translate="no">{details.service}</span> : "None"}
              </dd>
            </div>
          </dl>
        )
        : null}
    </section>
  );
}

/** Per-device mute for the Mac's sounds (`sound.ts`). */
function SoundSection(): ReactElement {
  const muted = useSoundMuted();
  return (
    <section className="panel__section" aria-labelledby="panel-sound">
      <h3 id="panel-sound" className="panel__heading">Sounds</h3>
      <div className="switch-row">
        <span className="switch-row__label" id="sound-label">Play the Mac’s sounds here</span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={!muted}
          aria-labelledby="sound-label"
          onClick={() => setSoundMuted(!muted)}
        >
          <span className="switch__thumb" aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}

function InstallSection(): ReactElement | null {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    installListeners.add(l);
    return () => void installListeners.delete(l);
  }, []);
  if (isStandalone()) return null;
  if (installPrompt) {
    return (
      <section className="panel__section" aria-labelledby="panel-install">
        <h3 id="panel-install" className="panel__heading">App</h3>
        <p className="panel__text">Install herdr-relay to open it like an app, full screen.</p>
        <button
          type="button"
          className="button button--primary"
          onClick={async () => {
            const p = installPrompt;
            if (!p) return;
            await p.prompt();
            await p.userChoice;
            installPrompt = null;
            force((n) => n + 1);
          }}
        >
          Install App
        </button>
      </section>
    );
  }
  if (!isAppleMobile()) return null;
  return (
    <section className="panel__section" aria-labelledby="panel-install">
      <h3 id="panel-install" className="panel__heading">App</h3>
      <p className="panel__text">
        Share → Add to Home Screen opens herdr-relay full screen and enables notifications.
      </p>
    </section>
  );
}

function HostsSection(): ReactElement | null {
  const hosts = useApp((s) => s.hello?.hosts);
  if (!hosts || hosts.length === 0) return null;
  return (
    <section className="panel__section" aria-labelledby="panel-hosts">
      <h3 id="panel-hosts" className="panel__heading">Mods on the Mac</h3>
      <ul className="hosts" role="list">
        {hosts.map((h) => (
          <li key={h.folder} className="hosts__row" data-state={h.state}>
            <span className="hosts__name" translate="no">{h.folder}</span>
            <span className="hosts__state">{h.state}</span>
            {h.reason ? <span className="hosts__reason">{h.reason}</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The keyboard diagnostics switch (`KeyboardDiagnostics.tsx`). */
function DiagnosticsSection(): ReactElement {
  const on = useKeyboardDiagnostics();
  return (
    <section className="panel__section" aria-labelledby="panel-diagnostics">
      <h3 id="panel-diagnostics" className="panel__heading">Diagnostics</h3>
      <div className="switch-row">
        <span className="switch-row__label" id="kbd-diag-label">Keyboard diagnostics</span>
        <button
          type="button"
          role="switch"
          className="switch"
          aria-checked={on}
          aria-labelledby="kbd-diag-label"
          aria-describedby="kbd-diag-text"
          onClick={() => setKeyboardDiagnostics(!on)}
        >
          <span className="switch__thumb" aria-hidden="true" />
        </button>
      </div>
      <p className="panel__text" id="kbd-diag-text">
        Lists the last 30 key, input and composition events and the focused field over the app. Copy them to report a
        keyboard or input-language problem. The characters you type are never listed, only their kind and count. Turns
        off when the page reloads.
      </p>
    </section>
  );
}
