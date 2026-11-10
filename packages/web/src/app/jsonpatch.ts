/**
 * RFC 6902 JSON Patch applied immutably: containers on the changed paths are copied, everything else keeps its
 * identity, so a renderer can skip unchanged subtrees by reference. A patch applies atomically: any failing
 * operation (bad pointer, failed `test`) throws {@link PatchError} and the input is untouched.
 */

import type { JsonPatchOperation } from "@herdr-relay/protocol";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

type Container = Record<string, unknown> | unknown[];

function isContainer(v: unknown): v is Container {
  return typeof v === "object" && v !== null;
}

/** RFC 6901 tokens of a pointer (`""` → `[]`). */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new PatchError(`bad pointer ${JSON.stringify(pointer)}`);
  return pointer.slice(1).split("/").map((t) => t.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function arrayIndex(arr: unknown[], token: string, forAdd: boolean): number {
  if (forAdd && token === "-") return arr.length;
  if (!/^(0|[1-9][0-9]*)$/.test(token)) throw new PatchError(`bad array index ${JSON.stringify(token)}`);
  const i = Number(token);
  if (i > arr.length || (!forAdd && i === arr.length)) throw new PatchError(`array index ${i} out of range`);
  return i;
}

function getAt(doc: unknown, tokens: readonly string[]): unknown {
  let cur = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) cur = cur[arrayIndex(cur, t, false)];
    else if (isContainer(cur) && Object.hasOwn(cur, t)) cur = (cur as Record<string, unknown>)[t];
    else throw new PatchError(`no value at /${tokens.join("/")}`);
  }
  return cur;
}

/** Copies the containers along `tokens[0..-1]` and lets `edit` change the (copied) parent of the last token. */
function editParent(doc: unknown, tokens: readonly string[], edit: (parent: Container, last: string) => void): unknown {
  if (tokens.length === 0) throw new PatchError("cannot edit the document root here");
  const walk = (node: unknown, depth: number): unknown => {
    if (!isContainer(node)) throw new PatchError(`no container at /${tokens.slice(0, depth).join("/")}`);
    const copy: Container = Array.isArray(node) ? node.slice() : { ...node };
    const token = tokens[depth];
    if (depth === tokens.length - 1) {
      edit(copy, token);
      return copy;
    }
    if (Array.isArray(copy)) {
      const i = arrayIndex(copy, token, false);
      copy[i] = walk(copy[i], depth + 1);
    } else {
      if (!Object.hasOwn(copy, token)) throw new PatchError(`no value at /${tokens.slice(0, depth + 1).join("/")}`);
      copy[token] = walk(copy[token], depth + 1);
    }
    return copy;
  };
  return walk(doc, 0);
}

function add(doc: unknown, tokens: string[], value: unknown): unknown {
  if (tokens.length === 0) return value;
  return editParent(doc, tokens, (parent, last) => {
    if (Array.isArray(parent)) parent.splice(arrayIndex(parent, last, true), 0, value);
    else parent[last] = value;
  });
}

function remove(doc: unknown, tokens: string[]): unknown {
  if (tokens.length === 0) throw new PatchError("cannot remove the document root");
  return editParent(doc, tokens, (parent, last) => {
    if (Array.isArray(parent)) parent.splice(arrayIndex(parent, last, false), 1);
    else if (Object.hasOwn(parent, last)) delete parent[last];
    else throw new PatchError(`no value at /${tokens.join("/")} to remove`);
  });
}

function replace(doc: unknown, tokens: string[], value: unknown): unknown {
  if (tokens.length === 0) return value;
  return editParent(doc, tokens, (parent, last) => {
    if (Array.isArray(parent)) parent[arrayIndex(parent, last, false)] = value;
    else if (Object.hasOwn(parent, last)) parent[last] = value;
    else throw new PatchError(`no value at /${tokens.join("/")} to replace`);
  });
}

/** Structural JSON equality (`test`). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isContainer(a) || !isContainer(b) || Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => jsonEqual(v, bb[i]));
  }
  const ka = Object.keys(a);
  const bo = b as Record<string, unknown>;
  return ka.length === Object.keys(bo).length &&
    ka.every((k) => Object.hasOwn(bo, k) && jsonEqual((a as Record<string, unknown>)[k], bo[k]));
}

/** Applies `ops` in order and returns the new document (the input is never mutated). */
export function applyPatch<T>(doc: T, ops: readonly JsonPatchOperation[]): T {
  let cur: unknown = doc;
  for (const op of ops) {
    const path = parsePointer(op.path);
    switch (op.op) {
      case "add":
        cur = add(cur, path, op.value);
        break;
      case "remove":
        cur = remove(cur, path);
        break;
      case "replace":
        cur = replace(cur, path, op.value);
        break;
      case "move": {
        const from = parsePointer(op.from);
        if (from.length < path.length && from.every((t, i) => t === path[i])) {
          throw new PatchError(`cannot move ${op.from} into itself`);
        }
        const value = getAt(cur, from);
        cur = add(remove(cur, from), path, value);
        break;
      }
      case "copy":
        cur = add(cur, path, structuredClone(getAt(cur, parsePointer(op.from))));
        break;
      case "test":
        if (!jsonEqual(getAt(cur, path), op.value)) throw new PatchError(`test failed at ${op.path}`);
        break;
    }
  }
  return cur as T;
}
