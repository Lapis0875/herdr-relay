/**
 * Device-safe error text (SECURITY.md S30): mod and host errors carry `Error().stack` frames with absolute paths and
 * `file://` URLs. Known roots become short labels (`<appHome>/mods/x/main.js` → `mods/x/main.js`); any other absolute
 * path or file URL keeps only its last segment (`…/main.js:12:3`). Applied to every host-originated text before it
 * reaches a device (`ack.message`, `toast`, `k:"error"` reasons).
 */

import { toFileUrl } from "@std/path";

/** An absolute directory and the label that replaces `<path>/`. */
export interface PathRoot {
  path: string;
  label: string;
}

/** Characters that end a path inside a stack trace or message. */
const STOP = "\\s)'\"`\\]>,;";
const FILE_URL = new RegExp(`file://[^${STOP}]*`, "g");
/** An absolute path of at least two segments, not inside a URL (`https://a/b`) or a relative path (`x/y`). */
const ABSOLUTE = new RegExp(`(^|[\\s(\\[{"'\`=,;])/(?:[^${STOP}/]+/)+([^${STOP}/]*)`, "g");

/** The longest device-visible error text. */
export const STRIPPED_MAX = 500;

export class PathStripper {
  readonly #roots: readonly (readonly [string, string])[];

  /** `roots` are absolute directories (give real paths and, when different, their lexical forms too). */
  constructor(roots: readonly PathRoot[]) {
    const pairs: [string, string][] = [];
    for (const { path, label } of roots) {
      const dir = path.replace(/\/+$/, "");
      if (!dir.startsWith("/")) continue;
      pairs.push([`${toFileUrl(dir).href}/`, label], [`${dir}/`, label]);
    }
    pairs.sort((a, b) => b[0].length - a[0].length);
    this.#roots = pairs;
  }

  /** `text` without absolute paths, at most {@link STRIPPED_MAX} characters. */
  strip(text: string): string {
    let out = text;
    for (const [root, label] of this.#roots) out = out.replaceAll(root, label);
    out = out.replace(FILE_URL, (url) => `…/${lastSegment(url)}`);
    out = out.replace(ABSOLUTE, (_m, lead: string, last: string) => `${lead}…/${last}`);
    return out.length > STRIPPED_MAX ? `${out.slice(0, STRIPPED_MAX)}…` : out;
  }

  /** The first line of `text`, stripped (for toasts, acks and error blocks). */
  line(text: string): string {
    return this.strip(text.split("\n", 1)[0]);
  }
}

function lastSegment(url: string): string {
  const parts = url.split("/");
  return parts[parts.length - 1];
}
