/**
 * JSON Patch (RFC 6902) between two renders of a view (`patch.views[].ops`) or two snapshots (`patch.state`). Objects
 * are compared key by key; arrays keep their common head and tail and patch the middle in place (paired elements are
 * diffed, the rest added or removed), so a re-render that changes one text or one handler id yields ops for just that.
 * Op values share structure with `to`; neither input is copied or mutated.
 */

import { type JsonPatch, jsonPointer, type JsonValue } from "@herdr-relay/protocol";

/** Ops that turn `from` into `to`, rooted at `path` (`""` = the whole document); `[]` when they are equal. */
export function diffJson(from: JsonValue, to: JsonValue, path = ""): JsonPatch {
  const ops: JsonPatch = [];
  diff(from, to, path, ops);
  return ops;
}

type Obj = { [key: string]: JsonValue };

function isObject(v: JsonValue): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep JSON equality. */
export function jsonEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const k of keys) if (!Object.hasOwn(b, k) || !jsonEqual(a[k], b[k])) return false;
  return true;
}

function diff(a: JsonValue, b: JsonValue, path: string, ops: JsonPatch): void {
  if (a === b) return;
  if (isObject(a) && isObject(b)) return diffObject(a, b, path, ops);
  if (Array.isArray(a) && Array.isArray(b)) return diffArray(a, b, path, ops);
  if (!jsonEqual(a, b)) ops.push({ op: "replace", path, value: b });
}

function diffObject(a: Obj, b: Obj, path: string, ops: JsonPatch): void {
  for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) ops.push({ op: "remove", path: jsonPointer(path, k) });
  for (const k of Object.keys(b)) {
    const at = jsonPointer(path, k);
    if (Object.hasOwn(a, k)) diff(a[k], b[k], at, ops);
    else ops.push({ op: "add", path: at, value: b[k] });
  }
}

function diffArray(a: JsonValue[], b: JsonValue[], path: string, ops: JsonPatch): void {
  const short = Math.min(a.length, b.length);
  let head = 0;
  while (head < short && jsonEqual(a[head], b[head])) head++;
  let tail = 0;
  while (tail < short - head && jsonEqual(a[a.length - 1 - tail], b[b.length - 1 - tail])) tail++;
  const m = a.length - head - tail;
  const n = b.length - head - tail;
  const paired = Math.min(m, n);
  for (let i = 0; i < paired; i++) diff(a[head + i], b[head + i], jsonPointer(path, head + i), ops);
  // Inserted before the common tail, in order; or the surplus middle removed (each removal shifts the next one in).
  for (let i = paired; i < n; i++) ops.push({ op: "add", path: jsonPointer(path, head + i), value: b[head + i] });
  for (let i = paired; i < m; i++) ops.push({ op: "remove", path: jsonPointer(path, head + paired) });
}
