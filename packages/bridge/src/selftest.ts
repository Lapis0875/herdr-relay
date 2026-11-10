/**
 * `main.ts --self-test` (DESIGN-v2 §5.3 S32): run with the bridge's production flags, it attempts what the bridge must
 * never be able to do and prints one JSON line per probe on stdout, `{"probe", "blocked", "error"}`; the exit code is 0
 * only when every probe was blocked.
 *
 * Blocked means the attempt failed on a permission (`NotCapable`, or `PermissionDenied`), or, for the remote import,
 * on the flag that refused to load it: Deno 2.9 throws a `TypeError` naming `--allow-import` or `--cached-only` there
 * (measured: without `--allow-import`/`--deny-import` the import permission is granted for every host, so only
 * `--cached-only` stops it).
 *
 * No probe leaves a trace when it is not blocked: the write is attempted only while the write permission is not granted
 * (and never over an existing file), connect and listen only while the net permission is not granted (and closed at
 * once if they succeed), the spawns run no-op commands, the reads read `/etc/hosts` and a name that need not exist under
 * `~/.ssh` (a refused read fails before the file is looked up), and the import names a reserved `.invalid` host.
 */

import { join } from "@std/path";

/** One line of the report. */
export interface ProbeResult {
  probe: string;
  blocked: boolean;
  /** `<error name>: <message>` of the attempt; why it was not attempted; `null` when it succeeded. */
  error: string | null;
}

interface Probe {
  probe: string;
  /** When given and granted, the attempt is skipped (it would have an effect) and the probe is not blocked. */
  permission?: Deno.PermissionDescriptor;
  /** The attempt (awaited; its value is dropped); when it succeeds it undoes what it did. */
  attempt(): unknown;
  /** Whether a non-permission error still means the bridge's flags refused it. */
  refusedBy?: RegExp;
}

/** The file the write probe tries to create; it never exists afterwards. */
export const SELF_TEST_FILE = ".herdr-relay-selftest";

/** A remote module on a reserved host (RFC 2606): no request can reach anyone even when the import is allowed. */
const REMOTE_MODULE = "https://herdr-relay-selftest.invalid/selftest.js";

function spawn(command: string, args: string[]): Promise<Deno.CommandOutput> {
  return new Deno.Command(command, { args, stdin: "null", stdout: "null", stderr: "null" }).output();
}

/** The S32 probes for a home directory and app home, in report order. */
export function selfTestProbes(paths: { home: string; appHome: string }): Probe[] {
  const target = join(paths.appHome, SELF_TEST_FILE);
  return [
    { probe: "read /etc/hosts", attempt: () => Deno.readTextFile("/etc/hosts") },
    { probe: "read ~/.ssh", attempt: () => Deno.readTextFile(join(paths.home, ".ssh", SELF_TEST_FILE)) },
    {
      probe: "write appHome",
      permission: { name: "write", path: target },
      attempt: async () => {
        await Deno.writeTextFile(target, "", { createNew: true });
        await Deno.remove(target);
      },
    },
    { probe: "spawn ls", attempt: () => spawn("ls", ["-d", "/"]) },
    { probe: "spawn /bin/sh", attempt: () => spawn("/bin/sh", ["-c", ":"]) },
    // Deviation from S32's `/usr/bin/git`: the bridge's `--allow-run=git` may itself resolve to `/usr/bin/git`, so the
    // probe would fail on such a Mac; S32 means "an unlisted binary", and `curl` is never in `--allow-run`.
    { probe: "spawn /usr/bin/curl", attempt: () => spawn("/usr/bin/curl", ["--version"]) },
    {
      probe: "connect 1.1.1.1:80",
      permission: { name: "net", host: "1.1.1.1:80" },
      attempt: async () => (await Deno.connect({ hostname: "1.1.1.1", port: 80 })).close(),
    },
    {
      probe: "listen 0.0.0.0",
      permission: { name: "net", host: "0.0.0.0:0" },
      attempt: () => Deno.listen({ hostname: "0.0.0.0", port: 0 }).close(),
    },
    {
      probe: "import https://",
      // Dynamic on purpose: the probe is the module-loading permission itself.
      attempt: () => import(REMOTE_MODULE),
      refusedBy: /Requires import access|--cached-only is specified/,
    },
  ];
}

export async function runProbe(p: Probe): Promise<ProbeResult> {
  if (p.permission && (await Deno.permissions.query(p.permission)).state === "granted") {
    return { probe: p.probe, blocked: false, error: `${p.permission.name} permission granted (not attempted)` };
  }
  try {
    await p.attempt();
    return { probe: p.probe, blocked: false, error: null };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const blocked = err instanceof Deno.errors.NotCapable || err instanceof Deno.errors.PermissionDenied ||
      (p.refusedBy?.test(err.message) ?? false);
    return { probe: p.probe, blocked, error: `${err.name}: ${err.message}` };
  }
}

/** Runs every probe in order, printing each result as one JSON line; 0 when all were blocked, else 1. */
export async function selfTest(
  paths: { home: string; appHome: string },
  print: (line: string) => void = (line) => console.log(line),
): Promise<number> {
  let all = true;
  for (const p of selfTestProbes(paths)) {
    const result = await runProbe(p);
    all &&= result.blocked;
    print(JSON.stringify(result));
  }
  return all ? 0 : 1;
}
