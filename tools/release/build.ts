/**
 * The release tarball (OSS-PLAN §7.4 `release`, T43; decision O4): packs what a user needs to run herdr-relay from a
 * folder (docs/INSTALL.md §2b) into `.tmp/release/`:
 *
 *   herdr-relay-<version>.tar.gz          one top folder `herdr-relay-<version>/`
 *   herdr-relay-<version>.tar.gz.sha256   `<hex>  <file>`, for `shasum -a 256 -c`
 *   herdr-relay-<version>.notes.md        the version's CHANGELOG section (the GitHub release text)
 *
 *   deno task release:dry                 # = deno task bundle:release --dry: release.yml's steps, without a tag
 *   deno task bundle:release --tag v0.1.0 # release.yml on a v* tag; the tag must be `v<version>`
 *
 * `bundle:release` is `deno task bundle && deno run --allow-read=. --allow-write=./.tmp/release --allow-run=git
 * tools/release/build.ts`: the device app is built first (the fonts must be fetched already, `deno task --cwd
 * packages/web fonts`).
 *
 * Version: the first `## [x.y.z]` heading of CHANGELOG.md; the root deno.json's `version`, when it has one, must agree.
 *
 * Contents: the repository files git would publish (`git add -A`: tracked plus untracked-not-ignored) under
 * {@link SHIPPED}, plus the built device app and fonts under {@link BUILT} (gitignored, so read from disk). Never:
 * tests, fixtures other than `fixtures/generic-home`, `fixtures/private`, `.tmp`, `node_modules`, development tools,
 * the Homebrew formula (`packaging/homebrew/`: it names this archive's digest, so it is copied to the tap instead).
 * Every member is checked by `tools/scrub/check.ts`'s rules under its repository path before anything is written; a
 * finding writes nothing. A symbolic link is refused, as is an `app.css` font URL that names a file not packed.
 *
 * The archive is reproducible from the same inputs: ustar, entries sorted, every mtime = HEAD's commit time, owner
 * 0:0, mode 0755 when the file is executable else 0644, gzip without a name or time stamp.
 *
 * Exit 0: written. Exit 1: a check failed (nothing written). Exit 2: usage.
 */

import { scanFile } from "../scrub/check.ts";

const ROOT = decodeURIComponent(new URL("../../", import.meta.url).pathname).replace(/\/$/, "");
const OUT = ".tmp/release";

/** Repository files a user needs, from git's published set: exact paths, or folders ending in `/`. */
const SHIPPED: readonly string[] = [
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.ko.md",
  "README.md",
  "RECIPE.md",
  "SECURITY.md",
  "THIRD_PARTY_NOTICES",
  "deno.json",
  "deno.lock",
  "preview.png",
  "docs/",
  // The default app home of packages/bridge/scripts/seatbelt-derive.ts, the check docs/INSTALL.md §8 runs.
  "fixtures/generic-home/",
  "mods/herdr-relay-mirror/",
  "packages/bridge/bin/",
  "packages/bridge/deno.json",
  "packages/bridge/profiles/",
  "packages/bridge/scripts/",
  "packages/bridge/src/",
  "packages/modhost/",
  "packages/protocol/deno.json",
  "packages/protocol/mod.ts",
  // Read by seatbelt-derive.ts.
  "packages/protocol/samples/shapes/HostState.json",
  "packages/protocol/schema/",
  "packages/protocol/src/",
  "packages/web/deno.json",
  "packages/web/index.html",
  "packages/web/manifest.webmanifest",
  "packages/web/sw.js",
  "tools/launchd/",
  // `deno task sync-config` (docs/DESKTOP.md); its tests stay in the repository.
  "tools/sync-config/mod.ts",
];

/** Built or fetched (gitignored), read from disk: the device app (`deno task bundle`) and its fonts and icons. */
const BUILT: readonly string[] = ["packages/web/dist/", "packages/web/public/"];

/** Under {@link BUILT} but not shipped: the widget stories (`bundle:dev`, served only with HERDR_RELAY_DEV). */
const NOT_BUILT: readonly string[] = ["packages/web/dist/dev/"];

/** Under {@link SHIPPED} but not shipped: the README's intro video and its HyperFrames source (web-only media). */
const NOT_SHIPPED: readonly string[] = ["docs/media/"];

/** Without these the release cannot run. */
const REQUIRED: readonly string[] = [
  "LICENSE",
  "THIRD_PARTY_NOTICES",
  "deno.json",
  "deno.lock",
  "mods/herdr-relay-mirror/mod.json",
  "packages/bridge/bin/herdr-relay",
  "packages/bridge/src/main.ts",
  "packages/web/dist/app.css",
  "packages/web/dist/app.js",
  "packages/web/index.html",
];

const USAGE = "usage: build.ts --dry | --tag v<version>";

class ReleaseError extends Error {}

interface Member {
  /** Relative to the repository root. */
  path: string;
  bytes: Uint8Array<ArrayBuffer>;
  executable: boolean;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function git(args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args: ["-C", ROOT, ...args], stdout: "piped", stderr: "piped" })
    .output();
  if (!out.success) throw new ReleaseError(`git ${args.join(" ")}: ${decoder.decode(out.stderr).trim()}`);
  return decoder.decode(out.stdout);
}

const under = (path: string, entries: readonly string[]): boolean =>
  entries.some((e) => e.endsWith("/") ? path.startsWith(e) : path === e);

/** The version: CHANGELOG.md's first `## [x.y.z]` heading, checked against the root deno.json's `version`. */
async function readVersion(): Promise<{ version: string; notes: string }> {
  const changelog = await Deno.readTextFile(`${ROOT}/CHANGELOG.md`);
  const heading = /^## \[(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\].*$/m.exec(changelog);
  if (!heading) throw new ReleaseError("CHANGELOG.md has no `## [x.y.z]` heading");
  const version = heading[1];
  const config = JSON.parse(await Deno.readTextFile(`${ROOT}/deno.json`)) as { version?: unknown };
  if (config.version !== undefined && config.version !== version) {
    throw new ReleaseError(`deno.json version ${JSON.stringify(config.version)} differs from CHANGELOG.md ${version}`);
  }
  const body = changelog.slice(heading.index + heading[0].length);
  const next = body.search(/^## /m);
  return { version, notes: `${(next < 0 ? body : body.slice(0, next)).trim()}\n` };
}

/** A shipped file, or `undefined` when git lists it but the work tree no longer has it. */
async function readMember(path: string): Promise<Member | undefined> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(`${ROOT}/${path}`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined;
    throw e;
  }
  if (info.isSymlink) throw new ReleaseError(`${path}: a symbolic link (a release ships none)`);
  if (!info.isFile) return undefined; // a gitlink
  return { path, bytes: await Deno.readFile(`${ROOT}/${path}`), executable: ((info.mode ?? 0) & 0o111) !== 0 };
}

/** Every regular file below `dir` (repository-relative, ending in `/`), skipping dot-files. */
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries: Deno.DirEntry[];
  try {
    entries = await Array.fromAsync(Deno.readDir(`${ROOT}/${dir}`));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return out;
    throw e;
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const path = `${dir}${e.name}`;
    if (e.isDirectory) out.push(...await walk(`${path}/`));
    else out.push(path); // links and others are refused by readMember
  }
  return out;
}

async function collect(): Promise<Member[]> {
  const listed = (await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])).split("\0");
  const paths = new Set(listed.filter((p) => p && under(p, SHIPPED) && !under(p, NOT_SHIPPED) && !under(p, BUILT)));
  for (const dir of BUILT) {
    for (const p of await walk(dir)) if (!under(p, NOT_BUILT)) paths.add(p);
  }
  const members: Member[] = [];
  for (const path of [...paths].sort()) {
    const m = await readMember(path);
    if (m) members.push(m);
  }
  const have = new Set(members.map((m) => m.path));
  const missing = REQUIRED.filter((p) => !have.has(p));
  const css = members.find((m) => m.path === "packages/web/dist/app.css");
  if (css) {
    for (const [, url] of decoder.decode(css.bytes).matchAll(/url\("(fonts\/[^"]+)"\)/g)) {
      const path = `packages/web/public/${decodeURI(url)}`;
      if (!have.has(path) && !missing.includes(path)) missing.push(path);
    }
  }
  if (missing.length) {
    throw new ReleaseError(
      `missing (run \`deno task --cwd packages/web fonts\` and \`deno task bundle\` first):\n  ${missing.join("\n  ")}`,
    );
  }
  return members;
}

// ---- ustar + gzip ----

function field(h: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new ReleaseError(`tar: ${JSON.stringify(value)} does not fit ${length} bytes`);
  h.set(bytes, offset);
}

const octal = (h: Uint8Array, offset: number, length: number, n: number) =>
  field(h, offset, length, `${n.toString(8).padStart(length - 1, "0")}\0`);

/** `[prefix, name]` for a path longer than the 100-byte name field. */
function split(path: string): [string, string] {
  if (encoder.encode(path).length <= 100) return ["", path];
  for (let i = path.indexOf("/"); i > 0; i = path.indexOf("/", i + 1)) {
    const prefix = path.slice(0, i);
    const name = path.slice(i + 1);
    if (encoder.encode(prefix).length <= 155 && name && encoder.encode(name).length <= 100) return [prefix, name];
  }
  throw new ReleaseError(`tar: path too long for ustar: ${path}`);
}

function header(path: string, type: "0" | "5", mode: number, size: number, mtime: number): Uint8Array<ArrayBuffer> {
  const h = new Uint8Array(512);
  const [prefix, name] = split(path);
  field(h, 0, 100, name);
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156); // the checksum counts its own field as spaces
  field(h, 156, 1, type);
  field(h, 257, 6, "ustar\0");
  field(h, 263, 2, "00");
  field(h, 345, 155, prefix);
  field(h, 148, 8, `${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `);
  return h;
}

function* tarBlocks(top: string, members: Member[], mtime: number): Generator<Uint8Array<ArrayBuffer>> {
  const dirs = new Set<string>([`${top}/`]);
  for (const m of members) {
    const parts = m.path.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${top}/${parts.slice(0, i).join("/")}/`);
  }
  const entries: Array<{ path: string; member?: Member }> = [
    ...[...dirs].map((path) => ({ path })),
    ...members.map((member) => ({ path: `${top}/${member.path}`, member })),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  for (const { path, member } of entries) {
    if (!member) {
      yield header(path, "5", 0o755, 0, mtime);
      continue;
    }
    yield header(path, "0", member.executable ? 0o755 : 0o644, member.bytes.length, mtime);
    yield member.bytes;
    const pad = (512 - member.bytes.length % 512) % 512;
    if (pad) yield new Uint8Array(pad);
  }
  yield new Uint8Array(1024);
}

async function gzip(blocks: Iterable<Uint8Array<ArrayBuffer>>): Promise<Uint8Array<ArrayBuffer>> {
  const stream = ReadableStream.from(blocks).pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---- main ----

const size = (n: number) => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;

async function main(tag: string | null): Promise<void> {
  const { version, notes } = await readVersion();
  if (tag !== null && tag !== `v${version}`) {
    throw new ReleaseError(`tag ${tag} does not name the CHANGELOG.md version v${version}`);
  }
  const members = await collect();

  const findings = members.flatMap((m) =>
    scanFile(m.path, m.bytes.subarray(0, 8192).includes(0) ? null : decoder.decode(m.bytes))
  );
  if (findings.length) {
    for (const f of findings) console.log(`${f.path}:${f.line}:${f.column} ${f.rule} ${f.match}`);
    throw new ReleaseError(`scrub: ${findings.length} finding(s) in the release contents; nothing written`);
  }

  const name = `herdr-relay-${version}`;
  const mtime = Number((await git(["log", "-1", "--format=%ct", "HEAD"])).trim());
  if (!Number.isSafeInteger(mtime) || mtime <= 0) throw new ReleaseError("HEAD has no commit time");
  const archive = await gzip(tarBlocks(name, members, mtime));
  const digest = await sha256(archive);

  await Deno.mkdir(`${ROOT}/${OUT}`, { recursive: true });
  await Deno.writeFile(`${ROOT}/${OUT}/${name}.tar.gz`, archive);
  await Deno.writeTextFile(`${ROOT}/${OUT}/${name}.tar.gz.sha256`, `${digest}  ${name}.tar.gz\n`);
  await Deno.writeTextFile(`${ROOT}/${OUT}/${name}.notes.md`, notes);

  const groups = new Map<string, { files: number; bytes: number }>();
  for (const m of members) {
    console.log(
      `${m.executable ? "-rwxr-xr-x" : "-rw-r--r--"} ${String(m.bytes.length).padStart(9)} ${name}/${m.path}`,
    );
    const parts = m.path.split("/");
    const group = parts.length === 1 ? "(top level)" : parts.slice(0, parts[0] === "packages" ? 2 : 1).join("/");
    const g = groups.get(group) ?? { files: 0, bytes: 0 };
    g.files++;
    g.bytes += m.bytes.length;
    groups.set(group, g);
  }
  console.log("");
  for (const [group, g] of [...groups].sort()) {
    console.log(`${String(g.files).padStart(5)} files ${size(g.bytes).padStart(10)}  ${group}`);
  }
  const total = members.reduce((a, m) => a + m.bytes.length, 0);
  console.log(`${String(members.length).padStart(5)} files ${size(total).padStart(10)}  total`);
  console.log(`\nscrub: no findings in ${members.length} files`);
  console.log(`${OUT}/${name}.tar.gz  ${size(archive.length)}  sha256 ${digest}`);
  console.log(`${OUT}/${name}.tar.gz.sha256`);
  console.log(`${OUT}/${name}.notes.md`);
  if (tag === null) {
    console.log(
      `dry run: nothing uploaded (release.yml attaches the two archive files to release v${version} on its tag)`,
    );
  }
}

if (import.meta.main) {
  const args = Deno.args;
  // null: --dry; undefined: a usage error.
  const tag = args.length === 1 && args[0] === "--dry"
    ? null
    : args.length === 2 && args[0] === "--tag" && args[1]
    ? args[1]
    : undefined;
  if (tag === undefined) {
    console.error(USAGE);
    Deno.exit(2);
  }
  try {
    await main(tag);
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    console.error(`release: ${e.message}`);
    Deno.exit(1);
  }
}
