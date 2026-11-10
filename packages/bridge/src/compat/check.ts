/**
 * Version and drift detection (OSS-PLAN §2.3, T46). At start the bridge observes the running Herdr's contract
 * surfaces, reading its app home only: `herdr.d.ts`, the newest `gpui-kit.d.ts` among the shipped mods' folders,
 * `installed.json` (Herdr's hash of every shipped file), and what `herdr-app commands` lists. {@link compatReport}
 * compares them with the pins of the running version, else of the newest pinned one (`./pins.ts`). The outcome goes
 * to devices as `hello.compat` ({@link helloCompat}: a banner when the version is untested or anything drifted) and
 * to `herdr-relay doctor` as {@link compatSummary} lines.
 *
 * Commands: every name `herdr-app commands` lists that `../policy/commands.json` does not classify is counted and
 * reported as drift; devices are refused such a name (deny by default, `../session/commands.ts`).
 *
 * Drift is a difference observed. A surface that cannot be read (no `installed.json`, `herdr-app` not on PATH) is a
 * note for doctor, not drift. Drift details name files and commands, never paths: they reach devices.
 */

import type { CompatDrift, CompatSurface, HelloCompat } from "@herdr-relay/protocol";
import { join } from "@std/path";
import { messageOf } from "../core/errors.ts";
import { herdrVersionOf } from "../policy/mod.ts";
import { classifyCommand } from "../session/mod.ts";
import { compareVersions, CONTRACT_PINS, type ContractPins, SUPPORTED_FROM, testedVersions } from "./pins.ts";

/** What `herdr-app commands` gave at start; `malformed`: it ran but did not print the JSON command list. */
export type CommandsCapture =
  | { ok: true; names: string[] }
  | { ok: false; reason: string; malformed: boolean };

/** `installed.json`: shipped mod (or `layout:<name>`) → file → hash. */
export type InstalledHashes = Record<string, Record<string, string>>;

/** One app home's contract surfaces as read at start. */
export interface CompatObservation {
  /** sha256 of `<appHome>/herdr.d.ts` (null: not read, see `notes`). */
  herdrDts: string | null;
  /** The newest `mods/<shipped>/gpui-kit.d.ts` (Herdr rewrites the copies of the mods it loads; null: none). */
  gpuiKit: { mod: string; sha256: string } | null;
  /** `<appHome>/installed.json` (`absent`: not read, see `notes`; `invalid`: not the expected shape). */
  installed: InstalledHashes | "absent" | "invalid";
  commands: CommandsCapture;
  /** Surfaces that could not be read, for doctor. */
  notes: string[];
}

/** The running Herdr against the pins. */
export interface CompatReport {
  /** `major.minor.patch[-pre]` of the running Herdr (null: unknown). */
  herdrVersion: string | null;
  /** The running version is a pinned one. */
  tested: boolean;
  /** The pinned versions, oldest first. */
  testedWith: string[];
  /** The pinned version the surfaces were compared with (null: nothing pinned). */
  comparedWith: string | null;
  drift: CompatDrift[];
  notes: string[];
  /** `herdr-app commands`: how many names it listed and those herdr-relay does not classify (null: no list). */
  commands: { listed: number; unclassified: string[] } | null;
  /** The device banner (absent: tested and nothing drifted). */
  banner?: string;
}

/** Longest drift detail (the protocol's bound). */
const DETAIL_MAX = 500;
/** Names listed in one detail before "and N more". */
const NAMES_SHOWN = 6;
/** A mod folder name read from `installed.json` that may be joined under `<appHome>/mods/`. */
const MOD_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** Parses `herdr-app commands` output: a JSON list of `{name, args, about}`; only the names are read. */
export function parseCommandsCapture(stdout: string): CommandsCapture {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    value = undefined;
  }
  if (!Array.isArray(value) || !value.every((c) => typeof c?.name === "string" && c.name !== "")) {
    return { ok: false, reason: "herdr-app commands did not print its JSON command list", malformed: true };
  }
  return { ok: true, names: [...new Set(value.map((c): string => c.name))].sort() };
}

/** Reads the contract surfaces of `appHome` (nothing is written). */
export async function observeCompat(
  appHome: string,
  commands: CommandsCapture,
  pins: ContractPins = CONTRACT_PINS,
): Promise<CompatObservation> {
  const notes: string[] = [];
  const dts = await readSurface(join(appHome, "herdr.d.ts"), "herdr.d.ts", notes);
  const installedBytes = await readSurface(join(appHome, "installed.json"), "installed.json", notes);
  const installed = installedBytes === null ? "absent" : parseInstalled(new TextDecoder().decode(installedBytes));
  const shipped = new Set(Object.values(pins.versions).flatMap((v) => Object.keys(v.installed)));
  if (typeof installed === "object") { for (const key of Object.keys(installed)) shipped.add(key); }
  const mods = [...shipped].filter((k) => !k.startsWith("layout:") && MOD_NAME.test(k)).sort();
  const gpuiKit = await newestGpuiKit(appHome, mods, notes);
  if (!commands.ok && !commands.malformed) notes.push(commands.reason);
  return { herdrDts: dts === null ? null : await sha256(dts), gpuiKit, installed, commands, notes };
}

/** Compares an observation with the pins of `version` (the mirror's or `herdr-app --version`; null: unknown). */
export function compatReport(
  obs: CompatObservation,
  version: string | null,
  pins: ContractPins = CONTRACT_PINS,
): CompatReport {
  const herdrVersion = version ? herdrVersionOf(version) ?? version : null;
  const testedWith = testedVersions(pins);
  const tested = herdrVersion !== null && Object.hasOwn(pins.versions, herdrVersion);
  const comparedWith = tested ? herdrVersion : testedWith.at(-1) ?? null;
  const pin = comparedWith === null ? null : pins.versions[comparedWith];
  const drift: CompatDrift[] = [];
  const theirs = `Herdr ${comparedWith}'s`;
  if (pin && obs.herdrDts !== null && obs.herdrDts !== pin.herdrDts) {
    drift.push(entry("herdr.d.ts", `herdr.d.ts differs from ${theirs}`));
  }
  if (pin && obs.gpuiKit !== null && obs.gpuiKit.sha256 !== pin.gpuiKitDts) {
    drift.push(entry("gpui-kit.d.ts", `mods/${obs.gpuiKit.mod}/gpui-kit.d.ts differs from ${theirs}`));
  }
  if (obs.installed === "invalid") {
    drift.push(entry("installed.json", "installed.json is not the list of shipped-file hashes herdr-relay reads"));
  } else if (pin && obs.installed !== "absent") {
    const changes = installedChanges(obs.installed, pin.installed);
    if (changes) drift.push(entry("installed.json", `shipped files differ from ${theirs}: ${changes}`));
  }
  let commands: CompatReport["commands"] = null;
  if (obs.commands.ok) {
    const names = obs.commands.names;
    if (pin) {
      const pinned = new Set(pin.commands);
      const listed = new Set(names);
      const parts = [
        listOf("new", names.filter((n) => !pinned.has(n))),
        listOf("gone", pin.commands.filter((n) => !listed.has(n))),
      ].filter(Boolean);
      if (parts.length > 0) {
        drift.push(entry("commands", `herdr-app commands differs from ${theirs}: ${parts.join("; ")}`));
      }
    }
    const unclassified = names.filter((n) => classifyCommand(n).class === "unknown");
    commands = { listed: names.length, unclassified };
    if (unclassified.length > 0) {
      const what = unclassified.length === 1 ? "1 command" : `${unclassified.length} commands`;
      drift.push(
        entry("commands", `${what} herdr-relay does not classify, refused on devices: ${shortList(unclassified)}`),
      );
    }
  } else if (obs.commands.malformed) {
    drift.push(entry("commands", obs.commands.reason));
  }
  const report: CompatReport = { herdrVersion, tested, testedWith, comparedWith, drift, notes: obs.notes, commands };
  const banner = bannerOf(report);
  return banner === undefined ? report : { ...report, banner };
}

/** `hello.compat`. */
export function helloCompat(report: CompatReport): HelloCompat {
  const out: HelloCompat = { herdrVersion: report.herdrVersion, tested: report.tested, drift: report.drift };
  if (report.banner !== undefined) out.banner = report.banner;
  return out;
}

/** `herdr-relay doctor`'s Herdr compatibility lines (the first names the version and whether it was tested). */
export function compatSummary(report: CompatReport): string[] {
  const tested = report.testedWith.join(", ") || "none";
  const lines = [
    `Herdr ${report.herdrVersion ?? "version unknown"}: ${
      report.tested ? "tested" : "not tested"
    } (herdr-relay was tested with Herdr ${tested})`,
  ];
  if (report.comparedWith !== null && report.drift.length === 0) {
    lines.push(`no drift from Herdr ${report.comparedWith}'s pinned contract`);
  }
  for (const d of report.drift) lines.push(`drift (${d.surface}): ${d.detail}`);
  if (report.commands !== null) {
    lines.push(
      `commands: ${report.commands.listed} listed by herdr-app commands, ${report.commands.unclassified.length} unclassified (refused on devices)`,
    );
  }
  for (const note of report.notes) lines.push(`not compared: ${note}`);
  if (report.banner !== undefined) lines.push(`device banner: ${report.banner}`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------------

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** A surface's bytes, or null with a note when it cannot be read. */
async function readSurface(path: string, name: string, notes: string[]): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    return await Deno.readFile(path);
  } catch (e) {
    notes.push(e instanceof Deno.errors.NotFound ? `${name} is not in the app home` : `${name}: ${messageOf(e)}`);
    return null;
  }
}

/** `installed.json`: an object of objects of hash strings, else `invalid`. */
function parseInstalled(text: string): InstalledHashes | "invalid" {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return "invalid";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid";
  for (const files of Object.values(value)) {
    if (typeof files !== "object" || files === null || Array.isArray(files)) return "invalid";
    if (!Object.values(files).every((h) => typeof h === "string")) return "invalid";
  }
  return value as InstalledHashes;
}

/** The most recently written `gpui-kit.d.ts` among `mods` (ties: the first by name), hashed. */
async function newestGpuiKit(
  appHome: string,
  mods: readonly string[],
  notes: string[],
): Promise<CompatObservation["gpuiKit"]> {
  let newest: { mod: string; at: number } | null = null;
  for (const mod of mods) {
    let at: number;
    try {
      const info = await Deno.stat(join(appHome, "mods", mod, "gpui-kit.d.ts"));
      if (!info.isFile) continue;
      at = info.mtime?.getTime() ?? 0;
    } catch {
      continue;
    }
    if (newest === null || at > newest.at) newest = { mod, at };
  }
  if (newest === null) {
    notes.push("no shipped mod folder has a gpui-kit.d.ts");
    return null;
  }
  const bytes = await readSurface(join(appHome, "mods", newest.mod, "gpui-kit.d.ts"), "gpui-kit.d.ts", notes);
  return bytes === null ? null : { mod: newest.mod, sha256: await sha256(bytes) };
}

/** Which shipped mods and layouts changed, appeared or went away (null: none). */
function installedChanges(
  installed: InstalledHashes,
  pinned: Readonly<Record<string, Readonly<Record<string, string>>>>,
): string | null {
  const changed: string[] = [];
  const missing: string[] = [];
  for (const [key, files] of Object.entries(pinned)) {
    if (!Object.hasOwn(installed, key)) missing.push(key);
    else if (!sameHashes(installed[key], files)) changed.push(key);
  }
  const added = Object.keys(installed).filter((key) => !Object.hasOwn(pinned, key)).sort();
  const parts = [listOf("changed", changed), listOf("new", added), listOf("missing", missing)].filter(Boolean);
  return parts.length > 0 ? parts.join("; ") : null;
}

function sameHashes(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

/** `<label> a, b, c` (empty when there are none). */
function listOf(label: string, names: readonly string[]): string {
  return names.length === 0 ? "" : `${label} ${shortList(names)}`;
}

/** The first {@link NAMES_SHOWN} names, then "and N more". */
function shortList(names: readonly string[]): string {
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN ? `${shown} and ${names.length - NAMES_SHOWN} more` : shown;
}

/** A drift entry, its detail bounded for the protocol. */
function entry(surface: CompatSurface, detail: string): CompatDrift {
  return { surface, detail: detail.length > DETAIL_MAX ? `${detail.slice(0, DETAIL_MAX - 1)}…` : detail };
}

/** The device banner: why this Herdr was not tested, then which surfaces drifted. */
function bannerOf(r: CompatReport): string | undefined {
  const newest = r.testedWith.at(-1);
  const tested = r.testedWith.join(", ") || "none";
  let head: string | undefined;
  if (r.herdrVersion === null) {
    head = `herdr-relay cannot tell which Herdr version is running; it was tested with Herdr ${tested}.`;
  } else if (!r.tested) {
    const v = r.herdrVersion;
    if (compareVersions(v, SUPPORTED_FROM) < 0) {
      head = `Herdr ${v} is older than herdr-relay supports (${SUPPORTED_FROM} or newer).`;
    } else if (newest !== undefined && compareVersions(v, newest) > 0) {
      head = `Herdr ${v} is newer than herdr-relay was tested with (${newest}).`;
    } else {
      head = `herdr-relay was not tested with Herdr ${v} (tested: ${tested}).`;
    }
  }
  const surfaces = [...new Set(r.drift.map((d) => d.surface))];
  if (surfaces.length === 0) return head;
  const tail = r.tested
    ? `This Herdr ${r.herdrVersion} differs from the one herdr-relay was tested with (${surfaces.join(", ")}); ` +
      "some views or commands may not work."
    : `Changed since Herdr ${r.comparedWith}: ${surfaces.join(", ")}.`;
  return head === undefined ? tail : `${head} ${tail}`;
}
