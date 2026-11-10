/**
 * `run()` command classes (DESIGN-v2 §2.4, D3) from `../policy/commands.json`: `session` (applied to the device's own
 * session), `mod` (`<loaded folder>.<command>` → that folder's copies' `nextCommand()`), `structural` (refused on
 * devices, with a toast), `passthrough` (`herdr-app do`, E9, `act` scope only). Deny by default: a name in none of
 * them is `unknown`, refused and logged by the caller.
 */

import type { CommandInfo, JsonObject } from "@herdr-relay/protocol";
import table from "../policy/commands.json" with { type: "json" };

export type Classification =
  | { class: "session"; name: string }
  | { class: "structural"; name: string; reason: string; message: string }
  | { class: "passthrough"; name: string; fill: readonly ("terminal" | "pane")[] }
  | { class: "mod"; name: string; folder: string; command: string }
  | { class: "unknown"; name: string };

interface PassthroughEntry {
  fill?: readonly string[];
}

const SESSION: Record<string, string> = table.session;
const STRUCTURAL: Record<string, string> = table.structural;
const STRUCTURAL_PATTERNS: Record<string, string> = table.structuralPatterns;
const PASSTHROUGH: Record<string, PassthroughEntry> = table.passthrough;
const REFUSALS: Record<string, string> = table.refusals;
const FILLABLE = ["terminal", "pane"] as const;

/** The table is data: a name listed twice, an unknown refusal reason, a bad pattern or fill stops the bridge at load. */
function checkTable(): void {
  const seen: Record<string, string> = {};
  const lists: [string, Record<string, unknown>][] = [
    ["session", SESSION],
    ["structural", STRUCTURAL],
    ["passthrough", PASSTHROUGH],
  ];
  for (const [cls, names] of lists) {
    for (const name of Object.keys(names)) {
      if (Object.hasOwn(seen, name)) throw new Error(`commands.json: "${name}" is both ${seen[name]} and ${cls}`);
      seen[name] = cls;
    }
  }
  for (const [name, reason] of [...Object.entries(STRUCTURAL), ...Object.entries(STRUCTURAL_PATTERNS)]) {
    if (!Object.hasOwn(REFUSALS, reason)) throw new Error(`commands.json: "${name}" names unknown refusal "${reason}"`);
  }
  for (const pattern of Object.keys(STRUCTURAL_PATTERNS)) {
    if (!/^[a-z_]+\.\*$/.test(pattern)) throw new Error(`commands.json: pattern "${pattern}" is not "<prefix>.*"`);
  }
  for (const [name, entry] of Object.entries(PASSTHROUGH)) {
    for (const f of entry.fill ?? []) {
      if (!(FILLABLE as readonly string[]).includes(f)) throw new Error(`commands.json: "${name}" fills "${f}"`);
    }
  }
}
checkTable();

/**
 * The class of `name`. Herdr's own commands (the table) win over mod prefixes; a mod command is
 * `<folder>.<command>` for a loaded folder (the longest matching folder, since folder names may contain dots).
 */
export function classifyCommand(name: string, modFolders: Iterable<string> = []): Classification {
  if (Object.hasOwn(SESSION, name)) return { class: "session", name };
  const reason = Object.hasOwn(STRUCTURAL, name)
    ? STRUCTURAL[name]
    : Object.entries(STRUCTURAL_PATTERNS).find(([p]) => name.startsWith(p.slice(0, -1)))?.[1];
  if (reason !== undefined) return { class: "structural", name, reason, message: REFUSALS[reason] };
  if (Object.hasOwn(PASSTHROUGH, name)) {
    return { class: "passthrough", name, fill: (PASSTHROUGH[name].fill ?? []) as ("terminal" | "pane")[] };
  }
  let folder = "";
  for (const f of modFolders) {
    if (f.length > folder.length && name.length > f.length + 1 && name.startsWith(`${f}.`)) folder = f;
  }
  if (folder) return { class: "mod", name, folder, command: name.slice(folder.length + 1) };
  return { class: "unknown", name };
}

/**
 * A keys.json action or `run()` name with its arguments. Herdr's `name:value` shorthand fills the command's first
 * argument with the literal string `value` (AGENTS.md "Keys": `tab.select:1`, `pane.split:right`); explicit `args`
 * win. A mod action keeps its colon (`lstack-herdr-cockpit.show:inbox` is delivered whole to `nextCommand()`).
 * `commands` is Herdr's live `commands()` list (argument order).
 */
export function parseAction(
  action: string,
  args: JsonObject | undefined,
  commands: readonly CommandInfo[],
): { name: string; args: JsonObject } {
  const own = { ...(args ?? {}) };
  const colon = action.indexOf(":");
  if (colon <= 0 || commands.some((c) => c.name === action)) return { name: action, args: own };
  const head = action.slice(0, colon);
  const first = commands.find((c) => c.name === head)?.args[0]?.name;
  if (first === undefined) return { name: action, args: own };
  return { name: head, args: { [first]: action.slice(colon + 1), ...own } };
}
