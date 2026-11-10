/**
 * Offline cache (DESIGN.md §4 "Offline/reconnect"): the last bridge hello (layout, ScreenGraph, theme), live state
 * and view trees in IndexedDB, so a reopened app shows the last known screen greyed with "stale since HH:MM" until
 * the socket is back. One record, replaced at most once a second while live, and on `pagehide`.
 */

import {
  type BridgeHello,
  BridgeHelloSchema,
  type ElementNode,
  type ScreenGraph,
  validate,
} from "@herdr-relay/protocol";
import type { LiveState } from "./store.ts";

const DB_NAME = "herdr-relay";
const STORE = "cache";
const KEY = "last";
const VERSION = 1;

export interface CacheRecord {
  v: typeof VERSION;
  /** When the data was last confirmed by the bridge (epoch ms). */
  receivedAt: number;
  hello: BridgeHello;
  graph: ScreenGraph;
  live: LiveState | null;
  views: Record<string, ElementNode>;
  seq: number | null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const { promise, resolve, reject } = Promise.withResolvers<IDBDatabase>();
  dbPromise = promise;
  promise.catch(() => (dbPromise = null));
  if (typeof indexedDB === "undefined") {
    reject(new Error("IndexedDB is not available"));
    return promise;
  }
  const req = indexedDB.open(DB_NAME, VERSION);
  req.onupgradeneeded = () => {
    if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  return promise;
}

async function run<T>(mode: IDBTransactionMode, body: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const tx = db.transaction(STORE, mode);
  const req = body(tx.objectStore(STORE));
  tx.oncomplete = () => resolve(req.result);
  tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
  tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  return await promise;
}

/** The cached record, or `null` when there is none or it does not match this build's protocol. */
export async function loadCache(): Promise<CacheRecord | null> {
  try {
    const rec = await run("readonly", (s) => s.get(KEY)) as CacheRecord | undefined;
    if (!rec || rec.v !== VERSION || typeof rec.receivedAt !== "number") return null;
    if (!validate(BridgeHelloSchema, rec.hello).ok || !rec.graph || typeof rec.views !== "object") return null;
    return rec;
  } catch {
    return null;
  }
}

export async function saveCache(rec: CacheRecord): Promise<void> {
  try {
    await run("readwrite", (s) => s.put(rec, KEY));
  } catch {
    // Private browsing or quota: the app works without the cache.
  }
}

/** Forgets everything (device unpaired or revoked). */
export async function clearCache(): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch {
    // nothing cached
  }
}
