/**
 * deno-runtime.ts — prints what the `deno` binary needs from the file system to start, for the mod-host Seatbelt
 * profile (`packages/bridge/src/hosts/seatbelt.ts`). The bridge cannot read the deno install itself (its `--allow-read`
 * is `$HOME` and `/tmp`), so `probeDenoRuntime()` runs this script under the very `deno` it spawns for hosts and
 * scoped runners, with `--allow-read` limited to the paths this script asked for so far:
 *
 *   deno run --no-prompt --no-config --no-remote --no-npm --no-lock --allow-read=<granted paths> deno-runtime.ts
 *
 * Output (one JSON object on stdout, exit 0):
 * - `{need: [paths]}` — it hit a path outside its grants. The caller adds exactly those paths and runs it again, until
 *   a fixed point. What it asks for is derived from the binary itself: the directory of `Deno.execPath()`, each link
 *   target's directory, and the directories of the dylibs named in the Mach-O load commands (climbing to a parent only
 *   while a directory's real path differs from its lexical path, i.e. a link sits above it).
 * - `{exec, real, files, links}` — the executable as invoked, its real path, every real file to map (the binary and
 *   each non-system dylib it loads, transitively; `/usr/lib` and `/System` come from the dyld shared cache and
 *   `system.sb`), and every symlink the kernel traverses on the way, ancestors included (Seatbelt needs
 *   `file-read-metadata` on each, measured: a missing directory link such as `/opt/homebrew/opt/sqlite` or leaf link
 *   such as `…/lib/libsqlite3.dylib` makes dyld fail).
 *
 * Load commands are read from the Mach-O headers directly (thin or universal), so no `otool` is needed. No imports.
 */

const LC_REQ_DYLD = 0x80000000;
const LC_LOAD_DYLIB = 0xc;
const LC_LOAD_WEAK_DYLIB = 0x18 | LC_REQ_DYLD;
const LC_REEXPORT_DYLIB = 0x1f | LC_REQ_DYLD;
const LC_LAZY_LOAD_DYLIB = 0x20;
const LC_LOAD_UPWARD_DYLIB = 0x23 | LC_REQ_DYLD;
const LC_RPATH = 0x1c | LC_REQ_DYLD;
const DYLIB_COMMANDS = new Set([
  LC_LOAD_DYLIB,
  LC_LOAD_WEAK_DYLIB,
  LC_REEXPORT_DYLIB,
  LC_LAZY_LOAD_DYLIB,
  LC_LOAD_UPWARD_DYLIB,
]);
const CPU_TYPE: Record<string, number> = { aarch64: 0x0100000c, x86_64: 0x01000007 };
const SYSTEM = /^\/(usr\/lib|System)\//;
const MAX_LINK_HOPS = 64;

function fail(message: string): never {
  console.error(`deno-runtime: ${message}`);
  Deno.exit(1);
}

/** A path outside this run's `--allow-read`: the caller grants it and runs the script again. */
class Need extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`needs read access to ${path}`);
    this.path = path;
  }
}

/** Runs `fn`; Deno's `NotCapable` for `path` becomes `Need(path)`. */
async function guard<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof Deno.errors.NotCapable) throw new Need(path);
    throw e;
  }
}

async function readAt(file: Deno.FsFile, offset: number, length: number): Promise<Uint8Array> {
  await file.seek(offset, Deno.SeekMode.Start);
  const buf = new Uint8Array(length);
  let n = 0;
  while (n < length) {
    const got = await file.read(buf.subarray(n));
    if (got === null) break;
    n += got;
  }
  return buf.subarray(0, n);
}

function cString(bytes: Uint8Array, at: number): string {
  let end = at;
  while (end < bytes.length && bytes[end] !== 0) end++;
  return new TextDecoder().decode(bytes.subarray(at, end));
}

interface LoadCommands {
  dylibs: { name: string; weak: boolean }[];
  rpaths: string[];
}

/** The dylib and rpath load commands of the slice matching this machine. */
async function loadCommands(path: string): Promise<LoadCommands> {
  const file = await guard(path, () => Deno.open(path, { read: true }));
  try {
    let base = 0;
    const head = new DataView((await readAt(file, 0, 8)).buffer);
    if (head.getUint32(0, false) === 0xcafebabe) {
      const count = head.getUint32(4, false);
      const table = new DataView((await readAt(file, 8, count * 20)).buffer);
      const want = CPU_TYPE[Deno.build.arch];
      let found = -1;
      for (let i = 0; i < count; i++) {
        if (table.getUint32(i * 20, false) === want) found = table.getUint32(i * 20 + 8, false);
      }
      if (found < 0) fail(`${path}: no ${Deno.build.arch} slice`);
      base = found;
    }
    const header = new DataView((await readAt(file, base, 32)).buffer);
    if (header.getUint32(0, true) !== 0xfeedfacf) fail(`${path}: not a 64-bit Mach-O image`);
    const ncmds = header.getUint32(16, true);
    const sizeofcmds = header.getUint32(20, true);
    const cmds = await readAt(file, base + 32, sizeofcmds);
    const view = new DataView(cmds.buffer, cmds.byteOffset, cmds.byteLength);
    const out: LoadCommands = { dylibs: [], rpaths: [] };
    for (let i = 0, off = 0; i < ncmds && off + 8 <= cmds.length; i++) {
      const cmd = view.getUint32(off, true);
      const size = view.getUint32(off + 4, true);
      const name = () => cString(cmds, off + view.getUint32(off + 8, true));
      if (DYLIB_COMMANDS.has(cmd)) out.dylibs.push({ name: name(), weak: cmd === LC_LOAD_WEAK_DYLIB });
      else if (cmd === LC_RPATH) out.rpaths.push(name());
      if (size < 8) break;
      off += size;
    }
    return out;
  } finally {
    file.close();
  }
}

function dirOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

function joinAll(dir: string, names: readonly string[]): string {
  return names.reduce((p, n) => (p === "/" ? `/${n}` : `${p}/${n}`), dir);
}

/** Directories whose real path equals their lexical path (so none of their components is a link), and their parents. */
const linkFree = new Set<string>(["/"]);
const notLinkFree = new Set<string>();

/** Whether no component of `dir` is a link. Needs read access to `dir` unless already known. */
async function isLinkFree(dir: string): Promise<boolean> {
  if (linkFree.has(dir)) return true;
  if (notLinkFree.has(dir)) return false;
  if ((await guard(dir, () => Deno.realPath(dir))) !== dir) {
    notLinkFree.add(dir);
    return false;
  }
  for (let d = dir; !linkFree.has(d); d = dirOf(d)) linkFree.add(d);
  return true;
}

/**
 * Resolves `p` as the kernel does, adding every symlink traversed to `links`; returns the real path. `cur` is always a
 * real directory (no link among its components), so a `..` or a relative link target is resolved lexically against it.
 * To avoid reading ancestors it has no grant for, it fast-forwards through the deepest directory proven link-free and
 * only `lstat`s the components below that.
 */
async function walk(p: string, links: Set<string>): Promise<string> {
  let cur = "/";
  let queue = p.split("/").filter((s) => s !== "" && s !== ".");
  for (let hops = 0; queue.length > 0;) {
    if (queue[0] === "..") {
      queue.shift();
      cur = dirOf(cur);
      continue;
    }
    let plain = 0;
    while (plain < queue.length && queue[plain] !== "..") plain++;
    // Directories that may be skipped: every plain component except a final leaf.
    let k = plain === queue.length ? plain - 1 : plain;
    while (k > 0 && !(await isLinkFree(joinAll(cur, queue.slice(0, k))))) k--;
    cur = joinAll(cur, queue.slice(0, k));
    queue = queue.slice(k);
    if (queue.length === 0 || queue[0] === "..") continue;
    const next = joinAll(cur, [queue.shift()!]);
    const st = await guard(next, () => Deno.lstat(next));
    if (!st.isSymlink) {
      cur = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) fail(`${p}: too many links`);
    links.add(next);
    const target = await guard(next, () => Deno.readLink(next));
    queue = [...target.split("/").filter((s) => s !== "" && s !== "."), ...queue];
    if (target.startsWith("/")) cur = "/";
  }
  return cur;
}

const needs = new Set<string>();

/** `fn()`, or null after recording what it needs. */
async function attempt<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof Need)) throw e;
    needs.add(e.path);
    return null;
  }
}

const exec = Deno.execPath();
const links = new Set<string>();
const files = new Set<string>();
const real = await attempt(() => walk(exec, links));
const pending: string[] = real === null ? [] : [real];
while (pending.length > 0) {
  const image = pending.pop()!;
  if (files.has(image)) continue;
  const commands = await attempt(() => loadCommands(image));
  if (commands === null) continue;
  files.add(image);
  const expand = (p: string) =>
    p.replace(/^@loader_path(?=\/|$)/, dirOf(image)).replace(/^@executable_path(?=\/|$)/, dirOf(real!));
  for (const dylib of commands.dylibs) {
    const candidates = dylib.name.startsWith("@rpath/")
      ? commands.rpaths.map((r) => `${expand(r)}/${dylib.name.slice("@rpath/".length)}`)
      : [expand(dylib.name)];
    if (candidates.every((c) => SYSTEM.test(c))) continue;
    let resolved: string | null = null;
    let blocked = false;
    for (const c of candidates) {
      if (SYSTEM.test(c)) continue;
      try {
        resolved = await walk(c, links);
        break;
      } catch (e) {
        if (e instanceof Need) {
          needs.add(e.path);
          blocked = true;
          break;
        }
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    }
    if (blocked) continue;
    if (resolved === null) {
      if (dylib.weak) continue;
      fail(`${image}: cannot find ${dylib.name}`);
    }
    pending.push(resolved);
  }
}

console.log(
  JSON.stringify(
    needs.size > 0 ? { need: [...needs].sort() } : { exec, real, files: [...files].sort(), links: [...links].sort() },
  ),
);
