/**
 * Where the panels of a mod's own split (`h_resizable` / `v_resizable`) were dragged to, kept per device in
 * `localStorage` under `herdr-relay:split:<layout name>:<view id>#<group id>` as `{"sizes": [...], "used": <ms>}`.
 * At most {@link MAX_SPLITS} entries: saving one more drops the least recently used (restored or saved longest ago;
 * unreadable entries first). An entry that is not valid JSON of that shape is ignored. Where storage is refused
 * (blocked cookies, a server render) the sizes are kept for this page only.
 */

const PREFIX = "herdr-relay:split:";
export const MAX_SPLITS = 200;

/** Each panel's size along the group's axis (px); `null` for a panel sharing what is left. */
export type SplitSizes = readonly (number | null)[];

interface Entry {
  sizes: SplitSizes;
  used: number;
}

interface KeyValues {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  keys(): string[];
}

const pageOnly = new Map<string, string>();
const PAGE_ONLY: KeyValues = {
  get: (k) => pageOnly.get(k) ?? null,
  set: (k, v) => void pageOnly.set(k, v),
  remove: (k) => void pageOnly.delete(k),
  keys: () => [...pageOnly.keys()],
};

let chosen: KeyValues | null = null;

function store(): KeyValues {
  if (chosen) return chosen;
  try {
    const ls = globalThis.localStorage;
    ls.getItem(PREFIX); // throws where storage is refused
    chosen = {
      get: (k) => ls.getItem(k),
      set: (k, v) => ls.setItem(k, v),
      remove: (k) => ls.removeItem(k),
      keys: () => {
        const out: string[] = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k !== null) out.push(k);
        }
        return out;
      },
    };
  } catch {
    chosen = PAGE_ONLY;
  }
  return chosen;
}

const isSize = (v: unknown): v is number | null =>
  v === null || (typeof v === "number" && Number.isFinite(v) && v >= 0);

function parse(raw: string | null): Entry | null {
  if (raw === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const { sizes, used } = v as { sizes?: unknown; used?: unknown };
  if (!Array.isArray(sizes) || !sizes.every(isSize)) return null;
  return { sizes, used: typeof used === "number" && Number.isFinite(used) ? used : 0 };
}

/** The last `used` stamp written by this page. */
let lastUsed = 0;

function read(key: string): Entry | null {
  try {
    return parse(store().get(key));
  } catch {
    return null;
  }
}

function write(key: string, sizes: SplitSizes): void {
  // Strictly increasing within the page, so two saves in one millisecond still have an order.
  lastUsed = Math.max(Date.now(), lastUsed + 1);
  try {
    store().set(key, JSON.stringify({ sizes, used: lastUsed }));
  } catch {
    // Storage full or refused: the group keeps its sizes on screen, not across reloads.
  }
}

export function splitKey(layout: string, view: string, group: string): string {
  return `${PREFIX}${layout}:${view}#${group}`;
}

/** The sizes kept under `key` for a group of `count` panels; `null` when none (or kept for another panel count). */
export function loadSplit(key: string, count: number): SplitSizes | null {
  const entry = read(key);
  return entry && entry.sizes.length === count ? entry.sizes : null;
}

/** Marks the entry under `key` (if any) as just used, so it is the last to be dropped. */
export function touchSplit(key: string): void {
  const entry = read(key);
  if (entry) write(key, entry.sizes);
}

/** Keeps `sizes` under `key`, then drops the least recently used entries beyond {@link MAX_SPLITS}. */
export function saveSplit(key: string, sizes: SplitSizes): void {
  write(key, sizes);
  try {
    const s = store();
    const keys = s.keys().filter((k) => k.startsWith(PREFIX));
    if (keys.length <= MAX_SPLITS) return;
    const aged = keys.map((k) => ({ k, used: parse(s.get(k))?.used ?? -1 }));
    aged.sort((a, b) => a.used - b.used);
    for (const { k } of aged.slice(0, keys.length - MAX_SPLITS)) s.remove(k);
  } catch {
    // Storage refused mid-way: the next save tries again.
  }
}
