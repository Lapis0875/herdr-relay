/**
 * Seatbelt, the macOS mod-host sandbox provider ({@link seatbeltSandbox}, `./sandbox.ts`; DESIGN-v2 §1.3): one
 * deny-by-default profile per mod folder, generated from `seatbelt.template.sb` into `<run>/seatbelt/<folder>.sb`. Every
 * path is a real path. The deno runtime closure (its binary, the non-system dylibs it loads and the links on the way) is
 * measured once per bridge run by `scripts/deno-runtime.ts`, run under the same `deno` the hosts use, because the
 * bridge's own `--allow-read` does not cover the deno install.
 *
 * A host then runs as `sandbox-exec -f <profile> <runtime.exec> run <§1.2 mod-host flags>` with its working directory
 * set to the mod folder (spawned by the name `sandbox-exec`, the bridge's `--allow-run` entry).
 */

import { dirname, fromFileUrl, join } from "@std/path";
import { within } from "../policy/paths.ts";
import { resolveAllowedCommand } from "../policy/spawn.ts";
import type { Sandbox } from "./sandbox.ts";

/** The subdirectory of `<run>` holding the profiles. */
const PROFILE_DIR = "seatbelt";

/** What `scripts/deno-runtime.ts` prints. */
export interface DenoRuntime {
  /**
   * `Deno.execPath()` of the probe, spawned as `resolveAllowedCommand("deno")` (the absolute path the bridge's
   * `--allow-run=deno` resolved, also used for scoped runners): that path itself, or the binary a wrapper script execs.
   */
  exec: string;
  /** Its real path. */
  real: string;
  /** Real files to read and map: the binary and every non-system dylib it loads. */
  files: string[];
  /** Symlinks met while resolving those (metadata only). */
  links: string[];
}

export interface SeatbeltInput {
  runtime: DenoRuntime;
  /** Real path of `<repo>/packages/modhost`. */
  modhost: string;
  /** Real path of `<appHome>/mods/<folder>`. */
  folder: string;
  /** Real path of `<run>/deno-dir/<folder>`. */
  denoDir: string;
  /** The bridge's control port on 127.0.0.1. */
  ctlPort: number;
  /** The host's working directory (real): the mod folder (or inside it, or inside `modhost`); nothing else is visible. */
  cwd: string;
}

const TEMPLATE_URL = new URL("./seatbelt.template.sb", import.meta.url);
const RUNTIME_SCRIPT = new URL("../../scripts/deno-runtime.ts", import.meta.url);

/** An SBPL string literal; paths with control characters are refused rather than escaped. */
function quote(path: string): string {
  // deno-lint-ignore no-control-regex
  if (!path.startsWith("/") || /[\x00-\x1f\x7f]/.test(path)) {
    throw new Error(`seatbelt: unusable path ${JSON.stringify(path)}`);
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

const filters = (kind: "literal" | "subpath", paths: Iterable<string>) =>
  [...new Set(paths)].sort().map((p) => `(${kind} ${quote(p)})`).join(" ");

/** The profile text for one host. Throws when the template has a placeholder this generator does not fill. */
export function seatbeltProfile(template: string, input: SeatbeltInput): string {
  if (!Number.isInteger(input.ctlPort) || input.ctlPort < 1 || input.ctlPort > 65535) {
    throw new Error(`seatbelt: bad control port ${input.ctlPort}`);
  }
  if (!within(input.cwd, input.folder) && !within(input.cwd, input.modhost)) {
    throw new Error("seatbelt: the host's working directory must be inside the mod folder or the modhost package");
  }
  const { runtime } = input;
  const values: Record<string, string> = {
    DENO_EXEC: filters("literal", [runtime.exec, runtime.real]),
    DENO_FILES: filters("literal", runtime.files),
    DENO_LINKS: filters("literal", runtime.links),
    READ_TREES: filters("subpath", [input.modhost, input.folder]),
    DENO_DIR: filters("subpath", [input.denoDir]),
    CTL: `"localhost:${input.ctlPort}"`,
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, name: string) => {
    if (!(name in values)) throw new Error(`seatbelt: template placeholder ${m} has no value`);
    return values[name];
  });
}

export async function loadSeatbeltTemplate(): Promise<string> {
  return await Deno.readTextFile(TEMPLATE_URL);
}

/** Runs of `scripts/deno-runtime.ts` before giving up (Homebrew needs 6: bin → Cellar → dylib dirs → their links). */
const PROBE_MAX_ROUNDS = 24;

/**
 * The directory of the bridge's own deno's real path (`Deno.realPath(Deno.execPath())`, OSS-PLAN G8), when the bridge
 * may resolve it: e.g. `~/.deno/bin` (official installer) or a mise/asdf install under `$HOME`. A Homebrew deno lies
 * outside the bridge's `--allow-read`, so the probe then starts from the spawned binary's own directory alone.
 */
function ownDenoRealDir(): string | null {
  try {
    const exec = Deno.execPath();
    if (Deno.permissions.querySync({ name: "read", path: exec }).state !== "granted") return null;
    const dir = dirname(Deno.realPathSync(exec));
    // A comma would split the --allow-read list; "/" would grant everything.
    return dir === "/" || dir.includes(",") ? null : dir;
  } catch {
    return null;
  }
}

/**
 * Measures the deno runtime closure: runs `scripts/deno-runtime.ts` under the `deno` the bridge may run (the absolute
 * path from `resolveAllowedCommand`, never `Deno.execPath()`, which under `deno task` is the Cellar real path), with an
 * environment of `HOME` alone (its default `DENO_DIR` lives there) and `--allow-read` starting from the directory of
 * that binary and, when the bridge can resolve it, the real directory of its own deno ({@link ownDenoRealDir}), plus
 * whatever the script asks for (`{need}`): link targets' and dylibs' directories from the Mach-O load commands, and a
 * parent only while a link sits above a directory. No install-layout prefix is assumed; a grant only lets the probe
 * read, while the profile is built from what the binary itself loads.
 */
export async function probeDenoRuntime(): Promise<DenoRuntime> {
  const deno = resolveAllowedCommand("deno");
  if (!deno.startsWith("/")) {
    throw new Error(
      "seatbelt: `deno` is not on PATH as the bridge's --allow-run=deno entry; cannot measure its runtime",
    );
  }
  const home = Deno.env.get("HOME");
  const grants = new Set([dirname(deno)]);
  const own = ownDenoRealDir();
  if (own !== null) grants.add(own);
  const dec = new TextDecoder();
  for (let round = 1; round <= PROBE_MAX_ROUNDS; round++) {
    const out = await new Deno.Command(deno, {
      args: [
        "run",
        "--no-prompt",
        "--no-config",
        "--no-remote",
        "--no-npm",
        "--no-lock",
        `--allow-read=${[...grants].join(",")}`,
        fromFileUrl(RUNTIME_SCRIPT),
      ],
      clearEnv: true,
      env: home ? { HOME: home } : {},
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) throw new Error(`seatbelt: deno-runtime.ts failed: ${dec.decode(out.stderr).trim()}`);
    const reply = JSON.parse(dec.decode(out.stdout)) as Partial<DenoRuntime> & { need?: unknown };
    if (Array.isArray(reply.need)) {
      const fresh = reply.need.filter((p): p is string => typeof p === "string" && !grants.has(p));
      if (fresh.length === 0) throw new Error(`seatbelt: deno-runtime.ts keeps asking for ${reply.need.join(", ")}`);
      for (const p of fresh) {
        // A comma would split the --allow-read list; "/" would grant everything.
        if (!p.startsWith("/") || p === "/" || p.includes(",")) throw new Error(`seatbelt: refusing to grant ${p}`);
        grants.add(p);
      }
      continue;
    }
    if (
      typeof reply.exec !== "string" || typeof reply.real !== "string" || !Array.isArray(reply.files) ||
      !Array.isArray(reply.links)
    ) {
      throw new Error("seatbelt: deno-runtime.ts printed an unexpected shape");
    }
    return { exec: reply.exec, real: reply.real, files: reply.files, links: reply.links };
  }
  throw new Error(`seatbelt: deno-runtime.ts did not settle in ${PROBE_MAX_ROUNDS} runs`);
}

/** Writes `<run>/seatbelt/<name>.sb` (directory 0700, file 0600) and returns its path. */
export async function writeSeatbeltProfile(run: string, name: string, profile: string): Promise<string> {
  const dir = join(run, PROFILE_DIR);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${name}.sb`);
  await Deno.writeTextFile(path, profile, { mode: 0o600 });
  return path;
}

/**
 * The Seatbelt provider. `trueBin` (the platform's, `/usr/bin/true`) is what {@link Sandbox.available} runs under an
 * allow-all profile to tell whether `sandbox-exec` works here. `prepare` measures the deno runtime and loads the
 * template once per bridge run; each host then gets its own profile.
 */
export function seatbeltSandbox(trueBin: string): Sandbox {
  return {
    id: "seatbelt",
    label: "Seatbelt",
    unavailable: "sandbox-exec is not available, so mod hosts cannot be confined by Seatbelt",
    async available() {
      try {
        const out = await new Deno.Command("sandbox-exec", {
          args: ["-p", "(version 1)(allow default)", trueBin],
          clearEnv: true,
          stdin: "null",
          stdout: "null",
          stderr: "null",
        }).output();
        return out.code === 0;
      } catch {
        return false;
      }
    },
    async prepare(run) {
      const runtime = await probeDenoRuntime();
      const template = await loadSeatbeltTemplate();
      return {
        subdir: PROFILE_DIR,
        async command(host) {
          const profile = seatbeltProfile(template, {
            runtime,
            modhost: host.modhost,
            folder: host.folder,
            denoDir: host.denoDir,
            ctlPort: host.ctlPort,
            cwd: host.folder,
          });
          const path = await writeSeatbeltProfile(run, host.name, profile);
          return { command: "sandbox-exec", args: ["-f", path, runtime.exec, ...host.denoArgs] };
        },
      };
    },
  };
}
