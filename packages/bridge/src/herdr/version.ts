/**
 * The running Herdr's version and its compatibility check (OSS-PLAN §2.3; T35, T46), with the bridge's own read-only
 * `herdr-app` calls — not mod execs, so no policy row: `herdr-app --version` and `herdr-app commands`, each with a
 * cleared environment (HOME, PATH, HERDR_APP_HOME).
 *
 * {@link HerdrVersion} runs both once at start, observes the app home's contract surfaces (`../compat/check.ts`) and
 * logs the version and the compat outcome whenever the version changes. The mirror mod's `updates().app.version`
 * wins over `herdr-app --version` once it reports one (the mirror may never report).
 */

import type { HelloCompat } from "@herdr-relay/protocol";
import { messageOf } from "../core/errors.ts";
import {
  type CommandsCapture,
  type CompatObservation,
  type CompatReport,
  compatReport,
  compatSummary,
  helloCompat,
  observeCompat,
  parseCommandsCapture,
} from "../compat/check.ts";
import { herdrVersionOf, runCapped } from "../policy/mod.ts";

/** Deadline of the version probe. */
export const HERDR_APP_VERSION_TIMEOUT_MS = 5_000;
/** Deadline of the `herdr-app commands` capture. */
export const HERDR_APP_COMMANDS_TIMEOUT_MS = 5_000;

/** What the bridge's own `herdr-app` calls run with. */
export interface HerdrAppEnv {
  home: string;
  appHome: string;
  PATH: string;
}

/**
 * Runs `herdr-app --version` and returns the version it prints, or null when it exits non-zero or prints none.
 * Throws when `herdr-app` cannot start.
 */
export async function probeHerdrAppVersion(o: HerdrAppEnv): Promise<string | null> {
  const r = await runCapped({
    command: "herdr-app",
    args: ["--version"],
    env: { HOME: o.home, PATH: o.PATH, HERDR_APP_HOME: o.appHome },
    clearEnv: true,
    timeoutMs: HERDR_APP_VERSION_TIMEOUT_MS,
  });
  return r.code === 0 ? herdrVersionOf(r.stdout) : null;
}

/** Runs `herdr-app commands` (read-only: it lists the commands keys.json may bind) and reads the names it lists. */
export async function captureHerdrAppCommands(o: HerdrAppEnv): Promise<CommandsCapture> {
  let r;
  try {
    r = await runCapped({
      command: "herdr-app",
      args: ["commands"],
      env: { HOME: o.home, PATH: o.PATH, HERDR_APP_HOME: o.appHome },
      clearEnv: true,
      timeoutMs: HERDR_APP_COMMANDS_TIMEOUT_MS,
    });
  } catch (e) {
    return { ok: false, reason: `herdr-app commands: ${messageOf(e)}`, malformed: false };
  }
  if (r.code !== 0) {
    const why = r.stderr.trim().split("\n").at(-1);
    return { ok: false, reason: `herdr-app commands exited ${r.code}${why ? `: ${why}` : ""}`, malformed: false };
  }
  return parseCommandsCapture(r.stdout);
}

export interface HerdrVersionOptions extends HerdrAppEnv {
  /** The mirror mod's `updates().app.version` (empty or undefined: not reported). */
  mirrorVersion?: () => string | undefined;
  log: (line: string) => void;
}

/** The running Herdr's version and how it compares with the versions herdr-relay was tested with. */
export class HerdrVersion {
  readonly #o: HerdrVersionOptions;
  /** `herdr-app --version` at start (null: unknown). */
  #probed: string | null = null;
  /** The version last logged (undefined: none yet). */
  #noted: string | null | undefined = undefined;
  /** The app home's contract surfaces at start (null: not observed yet). */
  #observed: CompatObservation | null = null;
  /** The last report and the version it is for. */
  #reported: { version: string | null; report: CompatReport } | null = null;

  constructor(o: HerdrVersionOptions) {
    this.#o = o;
  }

  /** `herdr-app --version` and `herdr-app commands` once, then the app home's contract surfaces; logs the outcome. */
  async start(): Promise<void> {
    const [probe, commands] = await Promise.all([
      probeHerdrAppVersion(this.#o).then(
        (version) => ({ version, error: null }),
        (e) => ({ version: null, error: `herdr-app --version: ${messageOf(e)}` }),
      ),
      captureHerdrAppCommands(this.#o),
    ]);
    this.#probed = probe.version;
    this.#observed = await observeCompat(this.#o.appHome, commands);
    if (probe.error !== null) this.#observed.notes.unshift(probe.error);
    this.note();
  }

  /** The running Herdr's version (E14 pins, compat): the mirror's, else `herdr-app --version`'s. */
  current(): string | null {
    return this.#o.mirrorVersion?.() || this.#probed;
  }

  /** Logs the version, and the compat outcome for it, whenever it changes. */
  note(): void {
    const version = this.current();
    if (version === this.#noted) return;
    this.#noted = version;
    const from = this.#o.mirrorVersion?.() ? "mirror mod" : "herdr-app --version";
    this.#o.log(version ? `Herdr ${version} (${from})` : "Herdr version unknown: Herdr's own sh -c literals stay off");
    const report = this.#reportFor(version);
    if (report === null) return;
    for (const line of compatSummary(report).slice(1)) this.#o.log(`compat: ${line}`);
  }

  /** `hello.compat` for the current version (undefined until {@link start} has observed the app home). */
  compat(): HelloCompat | undefined {
    const report = this.#reportFor(this.current());
    return report === null ? undefined : helloCompat(report);
  }

  /** `herdr-relay doctor`'s compat lines for the current version (empty until {@link start} has run). */
  summary(): string[] {
    const report = this.#reportFor(this.current());
    return report === null ? [] : compatSummary(report);
  }

  #reportFor(version: string | null): CompatReport | null {
    if (this.#observed === null) return null;
    if (this.#reported?.version !== version) {
      this.#reported = { version, report: compatReport(this.#observed, version) };
    }
    return this.#reported.report;
  }
}
