/**
 * Publishing scrub check (OSS-PLAN §7.2): fails when a file that would be published carries a personal or secret token.
 *
 *   deno run --allow-run=git --allow-read=. tools/scrub/check.ts [--root <dir>]
 *
 * "Would be published" means every file `git add -A` would commit: tracked files plus untracked files that are not
 * ignored. Ignored paths (`fixtures/private/`, `.tmp/`, `node_modules/`, font binaries) are never read. Each file is
 * checked by its path and, unless it is binary (a NUL byte in its first 8 KiB), by its text; a symlink by its target.
 *
 * Exit 0: nothing found, nothing printed. Exit 1: one line per finding, `path:line:col rule-id match`, with secret
 * matches redacted. Exit 2: usage error, or `git` failed.
 */

export interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
  /** The match is a credential: report its length, never its text. */
  readonly secret?: boolean;
}

export interface Allowed {
  readonly id: string;
  readonly pattern: RegExp;
  readonly why: string;
}

export interface Finding {
  readonly path: string;
  /** 1-based; 0 when the path itself matched. */
  readonly line: number;
  readonly column: number;
  readonly rule: string;
  readonly match: string;
}

/** The author's identifiers. Exported so the tests can plant real ones without spelling them out. */
export const IDENTITIES = ["lapis0875", "minjun"] as const;

/** Placeholder home folders the docs, samples and fixtures may use (`/Users/<name>`). */
export const PLACEHOLDER_USERS = ["sam", "example", "x", "Shared"] as const;

/**
 * The only places the author's name may appear (decision O6). Each match is blanked before the rules run, so whatever
 * is left on the line is still checked. Case-sensitive on purpose: the published spelling is exactly this.
 */
export const ALLOWED: readonly Allowed[] = [
  {
    id: "repository",
    pattern: /(?:github\.com\/|(?<![\w./-]))Lapis0875\/(?:herdr-relay|homebrew-herdr-relay)(?![\w-])/g,
    why: "the public repository and its Homebrew tap",
  },
  {
    id: "reverse-dns",
    pattern: /(?<![\w.-])io\.github\.lapis0875(?:\.[a-z0-9-]+)+/g,
    why: "the launchd label and bundle ids",
  },
  {
    id: "copyright",
    pattern: /\bCopyright (?:\(c\) )?\d{4}(?:-\d{4})? Lapis0875\b/g,
    why: "the copyright line",
  },
];

const placeholders = PLACEHOLDER_USERS.join("|");

/** Checked against every line of text and against every path. */
export const CONTENT_RULES: readonly Rule[] = [
  {
    id: "author-name",
    pattern: new RegExp(IDENTITIES[0], "gi"),
    why: "the author's user name (allowed only as listed in ALLOWED)",
  },
  { id: "author-host", pattern: new RegExp(IDENTITIES[1], "gi"), why: "the author's Mac host name" },
  {
    id: "tailnet-host",
    pattern: /\btail[0-9a-f]+\.ts\.net\b/gi,
    why: "a real tailnet DNS name (write <mac>.<tailnet>.ts.net)",
  },
  {
    id: "home-path",
    pattern: new RegExp(`/Users/(?!(?:${placeholders})(?![\\w.-]))[A-Za-z0-9][\\w.-]*`, "g"),
    why: `a real macOS home folder (write <HOME>, or /Users/${PLACEHOLDER_USERS[0]} in samples)`,
  },
  { id: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g, why: "a PEM private key", secret: true },
  {
    id: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g,
    why: "a GitHub token",
    secret: true,
  },
  {
    id: "hub-token",
    pattern: new RegExp(
      [
        String.raw`"port"\s*:\s*\d+\s*,\s*"token"\s*:\s*"[^"]{8,}"`,
        String.raw`"token"\s*:\s*"[^"]{8,}"\s*,\s*"port"\s*:\s*\d+`,
        String.raw`"op"\s*:\s*"[^"]*"\s*,\s*"token"\s*:\s*"[^"]{8,}"`,
      ].join("|"),
      "g",
    ),
    why: "a cockpit hub token: hub.json's {port, token}, or a hub request line {op, token, …}",
    secret: true,
  },
];

/** Checked against paths only: files that must never be published at all. */
export const PATH_RULES: readonly Rule[] = [
  { id: "private-fixture", pattern: /^fixtures\/private\//g, why: "personal fixtures stay untracked (decision O7)" },
  { id: "hub-json", pattern: /(?:^|\/)hub\.json$/g, why: "cockpit hub state: port and token" },
  { id: "lstack-sync", pattern: /(?:^|\/)\.lstack-sync\.json$/g, why: "the lstack fork's sync state" },
];

/** This file spells out the identifiers it looks for, so its text is not checked (its path still is). */
const SELF = "tools/scrub/check.ts";

const blank = (line: string): string => {
  let out = line;
  for (const { pattern } of ALLOWED) out = out.replace(pattern, (m) => " ".repeat(m.length));
  return out;
};

const hits = (text: string, rules: readonly Rule[]): Array<{ rule: Rule; index: number; match: string }> => {
  const out: Array<{ rule: Rule; index: number; match: string }> = [];
  for (const rule of rules) {
    for (const m of text.matchAll(rule.pattern)) out.push({ rule, index: m.index, match: m[0] });
  }
  return out.sort((a, b) => a.index - b.index);
};

const shown = (rule: Rule, match: string): string => rule.secret ? `<redacted, ${match.length} chars>` : match;

/** Findings for one published path and its text (`null`: binary, path only). Line 0 means the path matched. */
export function scanFile(path: string, text: string | null): Finding[] {
  const findings: Finding[] = [];
  for (const h of hits(blank(path), [...PATH_RULES, ...CONTENT_RULES])) {
    findings.push({ path, line: 0, column: h.index + 1, rule: h.rule.id, match: shown(h.rule, h.match) });
  }
  if (text === null || path === SELF) return findings;
  // Blanking keeps every length, so offsets in the blanked text are offsets in the file. Rules see the whole text:
  // a pretty-printed {port, token} spans lines.
  const blanked = text.split("\n").map(blank).join("\n");
  const starts = [0];
  for (let i = blanked.indexOf("\n"); i >= 0; i = blanked.indexOf("\n", i + 1)) starts.push(i + 1);
  for (const h of hits(blanked, CONTENT_RULES)) {
    let line = 0;
    for (let lo = 0, hi = starts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= h.index) [line, lo] = [mid, mid + 1];
      else hi = mid - 1;
    }
    findings.push({
      path,
      line: line + 1,
      column: h.index - starts[line] + 1,
      rule: h.rule.id,
      match: shown(h.rule, h.match),
    });
  }
  return findings;
}

const decoder = new TextDecoder();

async function git(root: string, args: string[]): Promise<string> {
  const out = await new Deno.Command("git", { args: ["-C", root, ...args], stdout: "piped", stderr: "piped" }).output();
  if (!out.success) throw new Error(`git ${args.join(" ")}: ${decoder.decode(out.stderr).trim()}`);
  return decoder.decode(out.stdout);
}

/** Every path `git add -A` would commit, relative to the work tree's top. */
async function publishedPaths(top: string): Promise<string[]> {
  const listed = await git(top, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  return [...new Set(listed.split("\0").filter(Boolean))].sort();
}

/** The text git would commit for `path`: a symlink's target, a regular file's UTF-8 text, `null` when binary. */
async function readPublished(full: string): Promise<string | null | undefined> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(full);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return undefined; // deleted in the work tree: not published
    throw e;
  }
  if (info.isSymlink) return await Deno.readLink(full);
  if (!info.isFile) return undefined; // a submodule or other gitlink
  const bytes = await Deno.readFile(full);
  if (bytes.subarray(0, 8192).includes(0)) return null;
  return decoder.decode(bytes);
}

/** All findings in the work tree that contains `root`, in path order. */
export async function scan(root: string): Promise<Finding[]> {
  const top = (await git(root, ["rev-parse", "--show-toplevel"])).trim();
  const findings: Finding[] = [];
  for (const path of await publishedPaths(top)) {
    const text = await readPublished(`${top}/${path}`);
    if (text !== undefined) findings.push(...scanFile(path, text));
  }
  return findings;
}

if (import.meta.main) {
  const args = [...Deno.args];
  let root = ".";
  const at = args.indexOf("--root");
  if (at >= 0) {
    if (!args[at + 1]) {
      console.error("usage: check.ts [--root <dir>]");
      Deno.exit(2);
    }
    root = args[at + 1];
    args.splice(at, 2);
  }
  if (args.length > 0) {
    console.error(`check.ts: unknown argument ${args[0]}\nusage: check.ts [--root <dir>]`);
    Deno.exit(2);
  }
  let findings: Finding[];
  try {
    findings = await scan(root);
  } catch (e) {
    console.error(`check.ts: ${e instanceof Error ? e.message : String(e)}`);
    Deno.exit(2);
  }
  for (const f of findings) console.log(`${f.path}:${f.line}:${f.column} ${f.rule} ${f.match}`);
  if (findings.length > 0) {
    console.error(`scrub: ${findings.length} finding(s); rules and allowlist in ${SELF}`);
    Deno.exit(1);
  }
}
