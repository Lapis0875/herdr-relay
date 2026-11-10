/**
 * Mod assets for devices (DESIGN-v2 §2.1, DESIGN.md §1.3 gap 6): `GET /herdr-relay/assets/<path relative to
 * appHome>` serves what `svg("mods/<name>/icons/x.svg")` and `image(…)` name, and the sound files a `sound` message
 * points at (`playSound`). The path rules are the read policy's `resolveAsset`: allowlist
 * `mods/**\/*.svg|png|jpg|webp` and `mods/**\/*.mp3|wav|ogg` (audio/mpeg, audio/wav, audio/ogg), `frame/<name>/**`
 * images, `icons/**`, `my-icons/**`, `layouts/*.svg`, `data/cockpit/show/**`; no `.`/`..`/empty segments, backslashes
 * or NULs; the real path (links followed) must be inside the real appHome and allowlisted too, so a link cannot reach a
 * file the allowlist excludes.
 * Content-Type by extension only; `Cache-Control: private, max-age=300`. An SVG is sandboxed by CSP in case it is
 * opened as a page.
 * Anything refused is a plain 404.
 */

import { type ReadRoots, resolveAsset } from "./policy/mod.ts";
import type { Route } from "./server/mod.ts";

/** Mount-relative prefix of the route. */
export const ASSETS_PREFIX = "/assets/";

const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

/** The asset route (`view` level: paired devices and the token-free loopback shell, GET/HEAD only). */
export function assetRoute(roots: () => ReadRoots): Route {
  return {
    prefix: ASSETS_PREFIX,
    level: "view",
    async handle(req, ctx) {
      let rel: string;
      try {
        rel = decodeURIComponent(ctx.path.slice(ASSETS_PREFIX.length));
      } catch {
        return notFound();
      }
      const asset = await resolveAsset(roots(), rel);
      if (asset === null) return notFound();
      const headers: Record<string, string> = {
        "content-type": asset.contentType,
        "cache-control": "private, max-age=300",
      };
      if (asset.contentType === "image/svg+xml") headers["content-security-policy"] = SVG_CSP;
      if (req.method === "HEAD") {
        return new Response(null, { headers: { ...headers, "content-length": String(asset.size) } });
      }
      const file = await Deno.open(asset.path, { read: true });
      const st = await file.stat();
      if (!st.isFile) {
        file.close();
        return notFound();
      }
      return new Response(file.readable, { headers: { ...headers, "content-length": String(st.size) } });
    },
  };
}

function notFound(): Response {
  return new Response("not found\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}
