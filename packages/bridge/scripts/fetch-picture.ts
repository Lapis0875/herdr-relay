/**
 * fetch-picture.ts — bridge-authored replacement for the show mod's picture `sh -c` literals (DESIGN-v2 §2.3 E15,
 * profile `picture` §2.5). Runs under a scoped `deno run` the bridge builds (`packages/bridge/src/policy/scripts.ts`):
 * network to the URL's host:port only (remote) or read of the one source file (local), write to the picture folder
 * only, run `/usr/bin/sips` only. No imports, so it runs with `--no-config --no-remote`.
 *
 *   deno run … fetch-picture.ts remote <dest> <http(s) url> [maxBytes]
 *   deno run … fetch-picture.ts local  <dest> <source file> [maxBytes]
 *
 * Same steps and output as the literal it replaces:
 *   mkdir -p "$(dirname "$1")" && { [ -s "$1" ] || curl -fsSL --max-time 20 -o "$1" "$2"; } && sips -g pixelWidth -g pixelHeight "$1"
 *   (local: `cp "$2" "$1"` instead of curl) — stdout is `sips`'s own, so the mod's `pixelWidth: N` parsing is unchanged.
 */

const [mode, dest, src, maxArg] = Deno.args;
const MAX_BYTES = Number(maxArg) > 0 ? Number(maxArg) : 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function fail(message: string, code = 1): never {
  console.error(`fetch-picture: ${message}`);
  Deno.exit(code);
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** `[ -s "$1" ]`: exists and is not empty. */
async function nonEmpty(p: string): Promise<boolean> {
  try {
    return (await Deno.stat(p)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Writes the whole picture to `p` in one call, as `curl -o`/`cp` do; the bytes are complete in memory first, so a
 * failed download never leaves a partial file (a rename would need read access to the folder, which the profile
 * does not grant).
 */
async function place(p: string, bytes: Uint8Array): Promise<void> {
  try {
    await Deno.writeFile(p, bytes);
  } catch (e) {
    await Deno.remove(p).catch(() => {});
    throw e;
  }
}

async function download(url: string): Promise<Uint8Array> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) {
    await res.body?.cancel();
    fail(`${url}: HTTP ${res.status}`, 22);
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_BYTES) {
    await res.body?.cancel();
    fail(`${url}: larger than ${MAX_BYTES} bytes`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > MAX_BYTES) fail(`${url}: larger than ${MAX_BYTES} bytes`);
    chunks.push(chunk);
  }
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

async function copy(source: string): Promise<Uint8Array> {
  const st = await Deno.stat(source);
  if (!st.isFile) fail(`${source}: not a file`);
  if (st.size > MAX_BYTES) fail(`${source}: larger than ${MAX_BYTES} bytes`);
  return await Deno.readFile(source);
}

if ((mode !== "remote" && mode !== "local") || !dest?.startsWith("/") || !src) {
  fail("usage: fetch-picture.ts remote|local <dest> <src> [maxBytes]", 2);
}

try {
  await Deno.mkdir(parentOf(dest), { recursive: true });
  if (!(await nonEmpty(dest))) await place(dest, mode === "remote" ? await download(src) : await copy(src));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

const sips = await new Deno.Command("/usr/bin/sips", {
  args: ["-g", "pixelWidth", "-g", "pixelHeight", dest],
  stdin: "null",
  stdout: "inherit",
  stderr: "inherit",
}).output();
Deno.exit(sips.code);
