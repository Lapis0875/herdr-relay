/**
 * Connection status: the shell button (drawer or device panel, with a live/connecting/offline dot), the stale banner
 * (DESIGN.md §4: last data greyed with "stale since HH:MM" while reconnecting) and the first-launch connecting screen.
 */

import { type ReactElement, useEffect, useState } from "react";
import { bridge } from "../client.ts";
import { drawerRoute, openDrawer } from "../nav.ts";
import { type AppState, setState, shownGraph, useApp } from "../store.ts";
import { Icon } from "./icons.tsx";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

export function formatTime(epochMs: number): string {
  return timeFormat.format(new Date(epochMs));
}

/** `live`, `connecting` or `offline`, for dots and labels. */
export function connTone(s: AppState): "live" | "connecting" | "offline" {
  if (s.conn.kind === "live" && s.stale === null) return "live";
  if (s.conn.kind === "connecting" || s.gate.kind === "checking") return "connecting";
  return "offline";
}

export const TONE_TEXT = { live: "connected", connecting: "connecting", offline: "offline" } as const;

/** The current time, re-rendering every second while `active` (countdowns). */
function useNow(active: boolean): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  return Date.now();
}

/** The leading button of the home screen's top bar: the drawer on a phone layout that has one, else the device panel. */
export function ShellButton(): ReactElement {
  const tone = useApp(connTone);
  const graph = useApp(shownGraph);
  const drawer = graph && graph.class === "phone" ? drawerRoute(graph) : undefined;
  const drawerOpen = graph ? openDrawer(graph) !== undefined : false;
  const label = drawer ? `Open ${drawer.node.replace(/[-_]/g, " ")}` : "Device and notifications";
  return (
    <button
      type="button"
      className="shell-button"
      aria-label={`${label} (${TONE_TEXT[tone]})`}
      aria-expanded={drawer ? drawerOpen : undefined}
      onClick={() => drawer ? void bridge.nav({ action: "push", route: drawer.path }) : setState({ panel: "device" })}
    >
      <Icon name={drawer ? "sidebar" : "sliders"} />
      <span className="status-dot" data-tone={tone} aria-hidden="true" />
    </button>
  );
}

/** The visible connection line; counts down to the next attempt. */
function statusLine(s: AppState, now: number): string {
  const c = s.conn;
  if (s.gate.kind === "checking" || c.kind === "connecting") return "Connecting to the Mac…";
  if (c.kind === "retry") {
    const secs = Math.max(0, Math.ceil((c.retryAt - now) / 1000));
    return secs > 0 ? `Reconnecting in ${secs}\u00a0s` : "Reconnecting…";
  }
  if (c.kind === "live") return "Connected";
  return "Offline";
}

/** What screen readers hear: state changes only, never the countdown. */
function statusAnnouncement(s: AppState): string {
  if (s.gate.kind === "checking" || s.conn.kind === "connecting") return "Connecting to the Mac.";
  if (s.conn.kind === "retry") return "Offline. Reconnecting.";
  return s.conn.kind === "live" ? "Connected." : "Offline.";
}

/** Shown above the content while it is not live; once live, the compat banner instead (when the bridge sent one). */
export function StatusBanner(): ReactElement | null {
  const s = useApp((x) => x);
  const show = s.stale !== null || s.conn.kind !== "live";
  const now = useNow(show && s.conn.kind === "retry");
  if (!show) return <CompatBanner />;
  const since = s.stale?.since ?? s.receivedAt;
  const why = s.conn.kind === "retry" ? s.conn.why : null;
  const sub = [why, since ? `showing data from ${formatTime(since)}` : null].filter(Boolean).join(" · ");
  return (
    <div className="banner" data-tone={connTone(s)}>
      <Icon name={s.conn.kind === "retry" ? "offline" : "refresh"} size={18} />
      <span className="banner__text" aria-hidden="true">
        <span className="banner__title">{statusLine(s, now)}</span>
        {sub ? <span className="banner__sub">{sub}</span> : null}
      </span>
      <span className="sr-only" role="status" aria-live="polite">
        {`${statusAnnouncement(s)}${since ? ` Showing data from ${formatTime(since)}.` : ""}`}
      </span>
      {s.conn.kind === "retry" || s.conn.kind === "idle"
        ? <button type="button" className="banner__action" onClick={() => bridge.reconnectNow()}>Retry Now</button>
        : null}
    </div>
  );
}

/**
 * `hello.compat.banner` (OSS-PLAN §2.3): the Mac runs a Herdr herdr-relay was not tested with, or one that differs
 * from it; the drift details underneath. Dismissed until a hello brings a different banner.
 */
function CompatBanner(): ReactElement | null {
  const compat = useApp((s) => s.hello?.compat);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const banner = compat?.banner;
  if (!banner || banner === dismissed) return null;
  const sub = compat.drift.map((d) => d.detail).join(" · ");
  return (
    <div className="banner" data-tone="compat">
      <Icon name="bell" size={18} />
      <span className="banner__text">
        <span className="banner__title" role="status">{banner}</span>
        {sub ? <span className="banner__sub">{sub}</span> : null}
      </span>
      <button type="button" className="banner__action" onClick={() => setDismissed(banner)}>Dismiss</button>
    </div>
  );
}

/** First launch with nothing cached: what the app is waiting for. */
export function ConnectingScreen(): ReactElement {
  const s = useApp((x) => x);
  const now = useNow(s.conn.kind === "retry");
  return (
    <main className="center-screen">
      <div className="center-card">
        <AppMark />
        <h1 className="center-card__title">herdr-relay</h1>
        <p className="center-card__text" aria-hidden="true">{statusLine(s, now)}</p>
        {s.conn.kind === "retry" ? <p className="center-card__text center-card__text--muted">{s.conn.why}</p> : null}
        <span className="sr-only" role="status" aria-live="polite">{statusAnnouncement(s)}</span>
        {s.conn.kind === "retry"
          ? (
            <button type="button" className="button button--primary" onClick={() => bridge.reconnectNow()}>
              <Icon name="refresh" size={18} />
              Retry Now
            </button>
          )
          : <span className="spinner" aria-hidden="true" />}
      </div>
    </main>
  );
}

export function AppMark(): ReactElement {
  return (
    <svg className="app-mark" width="56" height="56" viewBox="0 0 64 64" aria-hidden="true">
      <rect x="2" y="2" width="60" height="60" rx="14" fill="var(--herdr-chrome)" stroke="var(--herdr-border)" />
      <rect x="12" y="14" width="13" height="36" rx="3" fill="var(--herdr-raised)" />
      <rect x="29" y="14" width="23" height="16" rx="3" fill="var(--herdr-accent)" />
      <rect x="29" y="34" width="23" height="16" rx="3" fill="var(--herdr-raised)" />
    </svg>
  );
}
