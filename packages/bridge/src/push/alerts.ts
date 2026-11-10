/**
 * When to push (DESIGN.md §4 Push, DESIGN-v2 T11, AMENDMENTS T11b): from the core client's `events.subscribe` mirror,
 * a terminal whose status leaves `working` for `blocked` ("Needs you"), `done` or `idle` ("Finished"), or `error`
 * ("Failed") — omp reports `working → done` at the end of a turn. Each fires once per `(address, turn)`: the core
 * raises `turn` every time a status leaves `working` (`hc schema`), so one turn ends in one alert however often the
 * same facts are reported again (repeated events, `missed` snapshots, reconnects); later moves that do not start from
 * `working` (e.g. `done → idle` once the user looked) never alert.
 */

import type { CoreClientEvent, CoreTerminal } from "../core/mod.ts";

/** The statuses a terminal leaving `working` for alerts. */
export const ALERT_KINDS = ["blocked", "done", "idle", "error"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_TITLES: Readonly<Record<AlertKind, string>> = {
  blocked: "Needs you",
  done: "Finished",
  idle: "Finished",
  error: "Failed",
};

/** One notification to send. */
export interface PushAlert {
  kind: AlertKind;
  /** The terminal's address (`t7`, `machine/t7`). */
  terminal: string;
  /** The turn the alert is for; null when the terminal reports none (then it is not deduplicated). */
  turn: number | null;
  title: string;
  /** The terminal's name, program or title, and the status message when there is one. */
  body: string;
}

/** `(address, turn)` pairs remembered for deduplication; the oldest are forgotten first. */
export const MAX_REMEMBERED_ALERTS = 4096;

const LABEL_MAX = 80;
const DETAIL_MAX = 160;

/** Turns core client events into alerts. Pure: no I/O, no clock. */
export class AlertTracker {
  /** Last known `status.state` by address (null: no status). */
  readonly #states = new Map<string, string | null>();
  /** `address\nturn` of alerts already produced, oldest first. */
  readonly #sent = new Set<string>();

  /**
   * Feeds one event; `terminals` is the core client's mirror with the event applied. The first `reset` only learns
   * the states; later ones (reconnected, missed) alert on transitions that happened while events were not seen.
   */
  update(event: CoreClientEvent, terminals: ReadonlyMap<string, CoreTerminal>): PushAlert[] {
    if (event.type === "down") return [];
    if (event.type === "reset") {
      const before = event.reason === "connected" ? null : new Map(this.#states);
      this.#states.clear();
      const alerts: PushAlert[] = [];
      for (const terminal of event.terminals) {
        const state = terminal.status?.state ?? null;
        this.#states.set(terminal.address, state);
        const alert = before && this.#transition(before.get(terminal.address) ?? null, state, terminal, null);
        if (alert) alerts.push(alert);
      }
      return alerts;
    }
    const address = event.terminal;
    if (!address) return [];
    const terminal = terminals.get(address);
    switch (event.kind) {
      case "status": {
        const reported = event.data.status;
        const state = terminal?.status?.state ??
          (typeof reported === "object" && reported !== null && "state" in reported &&
              typeof reported.state === "string"
            ? reported.state
            : null);
        const before = this.#states.get(address) ?? null;
        this.#states.set(address, state);
        const alert = this.#transition(before, state, terminal ?? { address }, event.data);
        return alert ? [alert] : [];
      }
      case "created":
      case "restarted":
        this.#states.set(address, terminal?.status?.state ?? null);
        return [];
      case "finished":
      case "lost":
        this.#states.set(address, null);
        return [];
      case "removed":
        this.#states.delete(address);
        return [];
    }
    return [];
  }

  #transition(
    before: string | null,
    after: string | null,
    terminal: Pick<CoreTerminal, "address"> & Partial<CoreTerminal>,
    data: Record<string, unknown> | null,
  ): PushAlert | null {
    const kind = ALERT_KINDS.find((k) => k === after);
    if (before !== "working" || !kind) return null;
    const turn = typeof data?.turn === "number" ? data.turn : typeof terminal.turn === "number" ? terminal.turn : null;
    if (turn !== null) {
      const key = `${terminal.address}\n${turn}`;
      if (this.#sent.has(key)) return null;
      this.#sent.add(key);
      for (const old of this.#sent) {
        if (this.#sent.size <= MAX_REMEMBERED_ALERTS) break;
        this.#sent.delete(old);
      }
    }
    const label = clip(
      [terminal.name, terminal.status?.app, terminal.title].find((s) => typeof s === "string" && s.trim() !== "") ??
        terminal.address,
      LABEL_MAX,
    );
    const detail = terminal.status?.msg || (kind === "blocked" ? terminal.status?.kind : null);
    return {
      kind,
      terminal: terminal.address,
      turn,
      title: ALERT_TITLES[kind],
      body: typeof detail === "string" && detail.trim() !== "" ? `${label} — ${clip(detail, DETAIL_MAX)}` : label,
    };
  }
}

/** One line, at most `max` characters. */
function clip(text: string, max: number): string {
  // deno-lint-ignore no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
