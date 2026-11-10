/**
 * The app shell (PWA) from `packages/web`, below the mount: `/` and extensionless paths → `index.html`;
 * `index.html`, `manifest.webmanifest`, `sw.js` from the package root; any other file from `dist/` (the bundle,
 * `app.js`/`app.css`) or else `public/` (fonts, icons). Only listed extensions are served, never dot-files or `..`,
 * and the file's real path must stay inside the real directory it was looked up in. Mod assets from appHome are a
 * separate route (`/assets/*`, DESIGN-v2 §2.1).
 *
 * {@link shellFile} is the one canonical reading of a request path (decoded exactly once): the server uses it both to
 * decide whether a request may have `navigate` access (only the page, `index.html`) and to pick the file it serves,
 * so an encoded path (`app%2ejs`, `%61pp.js`) cannot be classified as a page and then served as an asset.
 *
 * `dev/*` (the widget stories, `deno task --cwd packages/web bundle:dev` → `dist/dev/`; `dev/widgets` is its page)
 * exists only while `HERDR_RELAY_DEV` is set; otherwise every `dev/` path is 404.
 */

import type { Access } from "../auth/mod.ts";
import { parseDevMode } from "../config.ts";

const TOP_LEVEL: Readonly<Record<string, true>> = { "index.html": true, "manifest.webmanifest": true, "sw.js": true };

/** Dev pages are served (`HERDR_RELAY_DEV` is `1` or `insecure-no-sandbox`); `loadConfig` validated it at startup. */
function devPagesFromEnv(): boolean {
  try {
    return parseDevMode(Deno.env.get("HERDR_RELAY_DEV")) !== "off";
  } catch {
    return false;
  }
}

const DEV_PAGES = devPagesFromEnv();

const TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  map: "application/json; charset=utf-8",
  json: "application/json; charset=utf-8",
  webmanifest: "application/manifest+json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  ico: "image/x-icon",
  webp: "image/webp",
  woff2: "font/woff2",
  ttf: "font/ttf",
};

/** A shell file, relative to the web root's bases. */
export interface ShellFile {
  rel: string;
  /** The app's page (`index.html`, for `/` and every client route): the only file `navigate` access may load. */
  page: boolean;
}

/**
 * The shell file a mount-relative, still percent-encoded `path` names, or `null`. Decoded exactly once. Refused:
 * malformed escapes; an encoded `/`, `\` or NUL (`%2f`, `%5c`, `%00`), which decoding would turn into structure; a `%`
 * left after decoding (double encoding); control characters or `\`; empty segments other than one trailing slash;
 * segments starting with `.`; `dev/*` without dev pages; extensions the shell does not serve.
 */
export function shellFile(path: string, dev = DEV_PAGES): ShellFile | null {
  if (/%(2f|5c|00)/i.test(path)) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(path).replace(/^\/+/, "");
  } catch {
    return null;
  }
  // deno-lint-ignore no-control-regex
  if (rel.includes("%") || /[\u0000-\u001f\u007f\\]/.test(rel)) return null;
  const segments = rel.split("/");
  if (segments.slice(0, -1).some((s) => s === "") || segments.some((s) => s.startsWith("."))) return null;
  const last = segments.at(-1) ?? "";
  if (segments[0] === "dev") {
    if (!dev) return null;
    if (rel === "dev/widgets") return { rel: "dev/widgets.html", page: false };
    if (!last.includes(".")) return null;
  } else if (!last.includes(".")) {
    return { rel: "index.html", page: true };
  }
  if (!TYPES[rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()]) return null;
  return { rel, page: rel === "index.html" };
}

/**
 * Serves one shell file; `head` omits the body. With `navigate` access (a possibly cross-site top-level navigation)
 * only the page is served, whatever the caller decided.
 */
export async function serveShell(webRoot: string, file: ShellFile, head: boolean, access: Access): Promise<Response> {
  if (access === "navigate" && !file.page) return notFound();
  const { rel } = file;
  const type = TYPES[rel.slice(rel.lastIndexOf(".") + 1).toLowerCase()];
  if (!type) return notFound();

  const bases = TOP_LEVEL[rel] ? [webRoot] : [`${webRoot}/dist`, `${webRoot}/public`];
  for (const base of bases) {
    let real: string;
    let realBase: string;
    try {
      real = await Deno.realPath(`${base}/${rel}`);
      realBase = await Deno.realPath(base);
    } catch {
      continue;
    }
    if (!real.startsWith(`${realBase}/`)) continue;
    const st = await Deno.stat(real);
    if (!st.isFile) continue;
    const headers = { "content-type": type, "content-length": String(st.size), "cache-control": "no-cache" };
    if (head) return new Response(null, { headers });
    const opened = await Deno.open(real, { read: true });
    return new Response(opened.readable, { headers });
  }
  return rel === "index.html" ? new Response("app shell not built (deno task bundle)\n", { status: 404 }) : notFound();
}

function notFound(): Response {
  return new Response("not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
}
