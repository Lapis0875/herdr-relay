/**
 * Shape checks for the core answers the bridge relies on. They check only the fields this client and its callers
 * read (records stay open); a mismatch is a `CoreError("protocol")`.
 */

import { CoreError } from "./errors.ts";
import type {
  CoreAttachResult,
  CoreDoc,
  CoreHello,
  CoreNotification,
  CoreSchema,
  CoreSnapshot,
  CoreTerminal,
  CoreTerminalList,
} from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isU32 = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isU16 = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff;
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

function fail(what: string, value: unknown): never {
  const text = JSON.stringify(value);
  throw new CoreError(
    "protocol",
    `core answered ${what} with an unexpected shape: ${text === undefined ? String(value) : text.slice(0, 200)}`,
  );
}

export function checkHello(value: unknown): CoreHello {
  if (
    !isRecord(value) || !isU32(value.generation) || typeof value.version !== "string" ||
    typeof value.framed !== "boolean" || !isStrings(value.methods) || !isStrings(value.features) ||
    !isRecord(value.core) || typeof value.core.id !== "string" || typeof value.core.name !== "string"
  ) fail("hello", value);
  return value as CoreHello;
}

export function checkSchema(value: unknown): CoreSchema {
  if (
    !isRecord(value) || !isRecord(value.info) || typeof value.info.version !== "string" ||
    !Array.isArray(value.methods) || !value.methods.every((m) => isRecord(m) && typeof m.name === "string")
  ) fail("rpc.discover", value);
  return value as CoreSchema;
}

export function checkTerminal(value: unknown, what = "terminal.get"): CoreTerminal {
  if (
    !isRecord(value) || typeof value.address !== "string" || typeof value.state !== "string" ||
    !isU16(value.cols) || !isU16(value.rows)
  ) fail(what, value);
  return value as CoreTerminal;
}

export function checkTerminalList(value: unknown): CoreTerminalList {
  if (!isRecord(value) || !Array.isArray(value.terminals)) fail("terminal.list", value);
  for (const terminal of value.terminals) checkTerminal(terminal, "terminal.list");
  return value as CoreTerminalList;
}

export function checkDoc<T>(value: unknown): CoreDoc<T> {
  if (!isRecord(value) || !("value" in value) || !isCount(value.version)) fail("doc.get", value);
  return value as unknown as CoreDoc<T>;
}

export function checkSnapshot(value: unknown): CoreSnapshot {
  if (!isRecord(value) || !isCount(value.seq) || !Array.isArray(value.terminals)) fail("events.subscribe", value);
  if (!isU32(value.channel) || value.channel === 0) {
    throw new CoreError("protocol", "core gave no event channel for events.subscribe on a framed connection");
  }
  for (const terminal of value.terminals) checkTerminal(terminal, "events.subscribe");
  return value as unknown as CoreSnapshot;
}

export function checkAttach(value: unknown): CoreAttachResult {
  if (!isRecord(value) || !isU32(value.channel) || value.channel === 0) fail("terminal.attach", value);
  checkTerminal(value.terminal, "terminal.attach");
  return value as CoreAttachResult;
}

export function checkNotification(value: unknown): CoreNotification {
  if (!isRecord(value) || typeof value.method !== "string" || (value.params !== undefined && !isRecord(value.params))) {
    fail("an event line", value);
  }
  if (value.params === undefined) value.params = {};
  return value as unknown as CoreNotification;
}

/** `version` is a release (`x.y.z`, optional `-pre`/`+build`) at least `minimum`, compared part by part. */
export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (text: string) => text.match(/^(\d+)\.(\d+)\.(\d+)(?:[-+]\S*)?$/)?.slice(1).map(Number);
  const found = parts(version);
  const floor = parts(minimum);
  if (!found || !floor) return false;
  const differs = found.findIndex((part, index) => part !== floor[index]);
  return differs < 0 || found[differs] > floor[differs];
}
