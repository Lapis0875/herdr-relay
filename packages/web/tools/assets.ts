/**
 * Web asset pipeline (DESIGN-v2 §3.2, §3.3), run from `packages/web`:
 *
 * - `deno run … tools/assets.ts fonts` downloads every font of `public/fonts/fonts.manifest.json` (Geist,
 *   Pretendard, JetBrains Mono, D2Coding; all OFL-1.1), from a file URL or a member of a release ZIP, verifies each
 *   SHA-256 and writes it under `public/fonts/<family>/` (gitignored). The licence texts (`OFL.txt`, committed) are
 *   checked against their pinned hashes too. When `woff2_compress` is on PATH, TrueType files also get a `.woff2`.
 * - `deno run … tools/assets.ts build` (after `deno bundle`) checks the fonts are present and intact — failing with
 *   what to run when they are not — and writes `dist/app.css`: the generated `@font-face` rules, xterm's CSS, then
 *   every `*.css` under `src/styles`, `src/app`, `src/render`, `src/widgets` (in that order, files sorted).
 *
 * Network: cdn.jsdelivr.net, github.com, release-assets.githubusercontent.com, objects.githubusercontent.com.
 */

const WEB = new URL("../", import.meta.url);
const FONTS = new URL("public/fonts/", WEB);
const MANIFEST = new URL("fonts.manifest.json", FONTS);
const XTERM_CSS = new URL("../../node_modules/@xterm/xterm/css/xterm.css", WEB);
const CSS_DIRS = ["src/styles/", "src/app/", "src/render/", "src/widgets/"];

export interface FontFile {
  /** Under `public/fonts/`. */
  path: string;
  sha256: string;
  /** Direct download; or `member` of the family's `archive`. */
  url?: string;
  member?: string;
  format: "woff2" | "truetype";
  /** CSS `font-weight` (a range for variable fonts). */
  weight: string;
  style: "normal" | "italic";
  /** A `.woff2` made from a TrueType file by `woff2_compress`, when it was available at fetch time. */
  woff2?: string;
}

export interface FontFamily {
  family: string;
  role: "ui" | "mono" | "terminal";
  version: string;
  source_url: string;
  license: "OFL-1.1";
  license_file: string;
  license_sha256: string;
  license_url?: string;
  license_member?: string;
  archive?: { url: string; sha256: string };
  files: FontFile[];
}

export interface FontManifest {
  v: 1;
  families: FontFamily[];
}

class AssetError extends Error {}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function readManifest(): Promise<FontManifest> {
  const m = JSON.parse(await Deno.readTextFile(MANIFEST)) as FontManifest;
  if (m.v !== 1 || !Array.isArray(m.families)) throw new AssetError(`${MANIFEST.pathname}: not a v1 font manifest`);
  for (const f of m.families) {
    const paths = [f.license_file, ...f.files.map((x) => x.path)];
    for (const p of paths) {
      if (!p.startsWith(`${f.family.replace(/ /g, "")}/`) || p.includes("..")) {
        throw new AssetError(`${f.family}: path ${p} is outside its family folder`);
      }
    }
  }
  return m;
}

async function download(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new AssetError(`GET ${url}: ${res.status} ${res.statusText}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** The members of a ZIP archive (stored or deflated; no ZIP64), by name. */
export async function unzip(
  zip: Uint8Array<ArrayBuffer>,
  want: ReadonlySet<string>,
): Promise<Map<string, Uint8Array<ArrayBuffer>>> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new AssetError("not a ZIP archive (no end of central directory)");
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array<ArrayBuffer>>();
  const utf8 = new TextDecoder();
  for (let n = 0; n < entries; n++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new AssetError("corrupt ZIP central directory");
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = utf8.decode(zip.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (!want.has(name)) continue;
    if (view.getUint32(local, true) !== 0x04034b50) throw new AssetError(`corrupt ZIP local header for ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.slice(start, start + size);
    if (method === 0) out.set(name, data);
    else if (method === 8) {
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    } else throw new AssetError(`${name}: unsupported ZIP method ${method}`);
  }
  for (const name of want) if (!out.has(name)) throw new AssetError(`archive has no ${name}`);
  return out;
}

async function verify(label: string, bytes: Uint8Array<ArrayBuffer>, expected: string): Promise<void> {
  const got = await sha256(bytes);
  if (got !== expected) throw new AssetError(`${label}: sha256 ${got}, manifest pins ${expected}`);
}

async function hasWoff2Compress(): Promise<boolean> {
  try {
    const out = await new Deno.Command("woff2_compress", { stdout: "null", stderr: "null" }).output();
    return out.code === 0 || out.code === 1;
  } catch {
    return false;
  }
}

async function fetchFonts(): Promise<void> {
  const m = await readManifest();
  const compress = await hasWoff2Compress();
  for (const fam of m.families) {
    const members = new Set<string>();
    for (const f of fam.files) if (f.member) members.add(f.member);
    if (fam.license_member) members.add(fam.license_member);
    let archive = new Map<string, Uint8Array<ArrayBuffer>>();
    if (members.size) {
      if (!fam.archive) throw new AssetError(`${fam.family}: members without an archive`);
      console.log(`${fam.family}: ${fam.archive.url}`);
      const zip = await download(fam.archive.url);
      await verify(`${fam.family} archive`, zip, fam.archive.sha256);
      archive = await unzip(zip, members);
    }
    await Deno.mkdir(new URL(`${fam.family.replace(/ /g, "")}/`, FONTS), { recursive: true });
    const license = fam.license_member ? archive.get(fam.license_member)! : await download(fam.license_url!);
    await verify(fam.license_file, license, fam.license_sha256);
    await Deno.writeFile(new URL(fam.license_file, FONTS), license);
    for (const f of fam.files) {
      const bytes = f.member ? archive.get(f.member)! : await download(f.url!);
      await verify(f.path, bytes, f.sha256);
      const dest = new URL(f.path, FONTS);
      await Deno.writeFile(dest, bytes);
      console.log(`  ${f.path} (${(bytes.length / 1024).toFixed(0)} KiB) ok`);
      if (compress && f.format === "truetype" && f.woff2) {
        const out = await new Deno.Command("woff2_compress", { args: [dest.pathname] }).output();
        if (out.code !== 0) throw new AssetError(`woff2_compress ${f.path} failed`);
        console.log(`  ${f.woff2} (woff2_compress) ok`);
      }
    }
  }
  if (!compress) console.log("woff2_compress not on PATH: D2Coding is served as TrueType.");
}

async function exists(url: URL): Promise<boolean> {
  try {
    return (await Deno.stat(url)).isFile;
  } catch {
    return false;
  }
}

/** `@font-face` rules for every manifest file (a derived `.woff2` first when it exists). */
async function fontFaces(m: FontManifest): Promise<string> {
  const missing: string[] = [];
  const rules: string[] = [];
  for (const fam of m.families) {
    if (!(await exists(new URL(fam.license_file, FONTS)))) missing.push(fam.license_file);
    for (const f of fam.files) {
      const url = new URL(f.path, FONTS);
      if (!(await exists(url))) {
        missing.push(f.path);
        continue;
      }
      await verify(f.path, await Deno.readFile(url), f.sha256);
      const src = [`url("fonts/${encodeURI(f.path)}") format("${f.format}")`];
      if (f.woff2 && await exists(new URL(f.woff2, FONTS))) {
        src.unshift(`url("fonts/${encodeURI(f.woff2)}") format("woff2")`);
      }
      rules.push(
        `@font-face {\n  font-family: "${fam.family}";\n  src: ${src.join(", ")};\n  font-weight: ${f.weight};\n` +
          `  font-style: ${f.style};\n  font-display: swap;\n}`,
      );
    }
  }
  if (missing.length) {
    throw new AssetError(`missing font files (run \`deno task fonts\` in packages/web):\n  ${missing.join("\n  ")}`);
  }
  return `/* fonts (generated from public/fonts/fonts.manifest.json; OFL-1.1) */\n${rules.join("\n")}\n`;
}

async function cssUnder(dir: string): Promise<URL[]> {
  const root = new URL(dir, WEB);
  const out: URL[] = [];
  const walk = async (d: URL) => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(d));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return;
      throw e;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.isDirectory) await walk(new URL(`${e.name}/`, d));
      else if (e.isFile && e.name.endsWith(".css")) out.push(new URL(e.name, d));
    }
  };
  await walk(root);
  return out;
}

async function build(): Promise<void> {
  const parts = [await fontFaces(await readManifest())];
  if (!(await exists(XTERM_CSS))) {
    throw new AssetError(`${XTERM_CSS.pathname} is missing (run \`deno install\` at the repository root)`);
  }
  parts.push(`/* @xterm/xterm/css/xterm.css */\n${await Deno.readTextFile(XTERM_CSS)}`);
  for (const dir of CSS_DIRS) {
    for (const file of await cssUnder(dir)) {
      parts.push(`/* ${file.pathname.slice(WEB.pathname.length)} */\n${await Deno.readTextFile(file)}`);
    }
  }
  const css = parts.join("\n");
  await Deno.mkdir(new URL("dist/", WEB), { recursive: true });
  await Deno.writeTextFile(new URL("dist/app.css", WEB), css);
  console.log(`dist/app.css: ${(css.length / 1024).toFixed(1)} KiB from ${parts.length} parts`);
}

if (import.meta.main) {
  const mode = Deno.args[0];
  try {
    if (mode === "fonts") await fetchFonts();
    else if (mode === "build") await build();
    else throw new AssetError("usage: tools/assets.ts fonts|build");
  } catch (e) {
    if (!(e instanceof AssetError)) throw e;
    console.error(`assets: ${e.message}`);
    Deno.exit(1);
  }
}
