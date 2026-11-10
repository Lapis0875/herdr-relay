/**
 * `<state>` (`~/.herdr/herdr-relay`, mode 0700) and the loopback bearer token in `<state>/token` (0600), as
 * Shepherdr keeps `~/.herdr/shepherdr/token`: local clients (the CLI, the mirror mod, simulators via a WS ticket)
 * present it on 127.0.0.1, never together with an `Origin` header.
 */

import { hex, randomBytes } from "./secret.ts";

export const TOKEN_FILE = "token";

const TOKEN_SHAPE = /^[0-9a-f]{48}$/;

/** Creates `<state>` if needed and makes it 0700. */
export async function ensureStateDir(stateDir: string): Promise<void> {
  await Deno.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await Deno.chmod(stateDir, 0o700);
}

/** The token, or `null` when the bridge never ran with this state directory. Throws on a malformed file. */
export async function readToken(stateDir: string): Promise<string | null> {
  let text: string;
  try {
    text = await Deno.readTextFile(`${stateDir}/${TOKEN_FILE}`);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
  const token = text.trim();
  if (!TOKEN_SHAPE.test(token)) throw new Error(`${stateDir}/${TOKEN_FILE} is not a herdr-relay token`);
  return token;
}

/** Reads the token, creating it (24 random bytes, hex, 0600) on first run. */
export async function ensureToken(stateDir: string): Promise<string> {
  const path = `${stateDir}/${TOKEN_FILE}`;
  const existing = await readToken(stateDir);
  if (existing) {
    await Deno.chmod(path, 0o600);
    return existing;
  }
  const token = hex(randomBytes(24));
  await Deno.writeTextFile(path, `${token}\n`, { createNew: true, mode: 0o600 });
  return token;
}
