/**
 * Policy profiles (OSS-PLAN §1) as the bridge applies them: loading the built-ins (`packages/bridge/profiles/*.json`)
 * and the user's (`<state>/profiles/*.json`), resolving a mod folder to the one profile that governs it (else
 * {@link DEFAULT_PROFILE}), and each folder's read roots under it.
 *
 * Loading: a file holds one profile or a list of them (`policy-profile.schema.json`, then `profileProblems`). A
 * built-in that does not validate stops the bridge ({@link ProfileError}). A user file is used only when it is a
 * regular file (not a link) owned by the owner of `<state>/profiles`, without group or other permission bits (0600 or
 * stricter), at most {@link PROFILE_MAX_BYTES} and valid; otherwise it is logged and ignored, and so is a profile whose
 * id is already taken (a user profile never replaces a built-in by id: it names the folders with a higher priority).
 *
 * Resolution: among the profiles naming a folder, the highest `priority` applies (default
 * {@link BUILTIN_PROFILE_PRIORITY} built-in, {@link USER_PROFILE_PRIORITY} user); at equal priority a user profile wins,
 * then the lower id. Overlaps are logged once at load.
 */

import { fromFileUrl, join } from "@std/path";
import {
  DEFAULT_NET_WRITE_MODE,
  DEFAULT_PROFILE_ID,
  herdrSatisfies,
  type NetWriteMode,
  type PolicyProfile,
  type ProfileFileValidation,
  validateProfileFile,
} from "@herdr-relay/protocol";
import { folderRootSpecs, ReadRoots, type ReadRootsInput } from "./read.ts";

/** `packages/bridge/profiles`. */
export const BUILTIN_PROFILES_DIR = fromFileUrl(new URL("../../profiles/", import.meta.url));
/** Largest user profile file. */
export const PROFILE_MAX_BYTES = 256 * 1024;
export const BUILTIN_PROFILE_PRIORITY = 0;
export const USER_PROFILE_PRIORITY = 10;

/** The profile of every folder no profile names: its own folder, `data/<folder>` and the spaces; no exec, hc or net. */
export const DEFAULT_PROFILE: PolicyProfile = {
  id: DEFAULT_PROFILE_ID,
  folders: [],
  description:
    "Folders no profile names: read their own folder, data/<folder> and the space folders; no exec, hc or net.",
  reads: { spaces: true },
  overlay: "device",
};

export type ProfileSource = "builtin" | "user";

export interface ProfileEntry {
  profile: PolicyProfile;
  source: ProfileSource;
  /** The file it came from (logs). */
  file: string;
}

/** A built-in profile that does not load, or an inconsistent {@link ProfileSet}. */
export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

export interface LoadProfilesOptions {
  /** Built-in profiles; default {@link BUILTIN_PROFILES_DIR}. Every `*.json` in it must be valid. */
  builtinDir?: string;
  /** `<state>/profiles`; absent or null: no user profiles. A missing folder means none. */
  userDir?: string | null;
  /** Ignored files, loaded user profiles, overlaps and `requires` mismatches. */
  log?: (line: string) => void;
}

/** The priority a profile applies with. */
export function profilePriority(e: ProfileEntry): number {
  return e.profile.priority ?? (e.source === "user" ? USER_PROFILE_PRIORITY : BUILTIN_PROFILE_PRIORITY);
}

/**
 * How `net.write` is decided for a folder under `profile` (OSS-PLAN §1, `../herdr/net.ts`): null when the profile does
 * not enable net (`default`, or no `net.hubPortFrom`); otherwise its `net.writes`, by default
 * {@link DEFAULT_NET_WRITE_MODE}.
 */
export function netWriteMode(profile: PolicyProfile): NetWriteMode | null {
  if (profile.id === DEFAULT_PROFILE_ID || profile.net?.hubPortFrom !== "cockpit.json") return null;
  return profile.net.writes ?? DEFAULT_NET_WRITE_MODE;
}

/** Precedence order: highest priority, then user before built-in, then lower id. */
function precedence(a: ProfileEntry, b: ProfileEntry): number {
  return profilePriority(b) - profilePriority(a) || (a.source === b.source ? 0 : a.source === "user" ? -1 : 1) ||
    (a.profile.id < b.profile.id ? -1 : a.profile.id > b.profile.id ? 1 : 0);
}

/** Every loaded profile and the folder → profile resolution. */
export class ProfileSet {
  readonly entries: readonly ProfileEntry[];
  readonly #byFolder = new Map<string, ProfileEntry>();
  readonly #log: (line: string) => void;
  #herdrChecked: string | null = null;

  /** Validates every profile (throws {@link ProfileError}) and resolves each named folder, logging overlaps. */
  constructor(entries: readonly ProfileEntry[], log: (line: string) => void = defaultLog) {
    this.entries = entries;
    this.#log = log;
    const ids = new Set<string>();
    const named = new Map<string, ProfileEntry[]>();
    for (const e of entries) {
      const v = validateProfileFile(e.profile);
      if (!v.ok) throw new ProfileError(`${e.file}: ${v.problems.join("; ")}`);
      if (ids.has(e.profile.id)) throw new ProfileError(`${e.file}: profile id ${e.profile.id} is used twice`);
      ids.add(e.profile.id);
      for (const folder of e.profile.folders) named.set(folder, [...(named.get(folder) ?? []), e]);
    }
    for (const [folder, list] of named) {
      list.sort(precedence);
      this.#byFolder.set(folder, list[0]);
      if (list.length > 1) {
        const others = list.slice(1).map((e) => `${e.profile.id} (${e.source}, priority ${profilePriority(e)})`);
        log(
          `${folder}: profile ${list[0].profile.id} (${list[0].source}, priority ${profilePriority(list[0])}) ` +
            `applies over ${others.join(", ")}`,
        );
      }
    }
  }

  /** Loads the built-ins (a bad one throws {@link ProfileError}) and the user's profiles (a bad one is logged). */
  static async load(o: LoadProfilesOptions = {}): Promise<ProfileSet> {
    const log = o.log ?? defaultLog;
    const entries: ProfileEntry[] = [];
    const ids = new Set<string>();
    const builtinDir = o.builtinDir ?? BUILTIN_PROFILES_DIR;
    for (const file of await jsonFiles(builtinDir)) {
      const v = parseProfileFile(await Deno.readTextFile(file));
      if (!v.ok) throw new ProfileError(`built-in profile ${file}: ${v.problems.join("; ")}`);
      for (const profile of v.profiles) {
        if (ids.has(profile.id)) throw new ProfileError(`built-in profile ${file}: id ${profile.id} is used twice`);
        ids.add(profile.id);
        entries.push({ profile, source: "builtin", file });
      }
    }
    if (o.userDir) {
      for (const { file, profiles } of await loadUserFiles(o.userDir, log)) {
        const taken = profiles.find((p) => ids.has(p.id));
        if (taken !== undefined) {
          log(`${file}: profile id ${taken.id} is already used; ignored`);
          continue;
        }
        for (const profile of profiles) {
          ids.add(profile.id);
          const entry: ProfileEntry = { profile, source: "user", file };
          entries.push(entry);
          log(
            `${file}: user profile ${profile.id} (priority ${profilePriority(entry)}) for ${
              profile.folders.join(", ")
            }`,
          );
        }
      }
    }
    return new ProfileSet(entries, log);
  }

  /** The profile governing `folder`: the one with precedence among those naming it, else {@link DEFAULT_PROFILE}. */
  profileFor(folder: string): PolicyProfile {
    return this.#byFolder.get(folder)?.profile ?? DEFAULT_PROFILE;
  }

  /**
   * The running Herdr's version became known: every profile whose `requires.herdr` it does not satisfy is logged
   * (once per version) and still applies.
   */
  checkHerdr(version: string): void {
    if (version === "" || version === this.#herdrChecked) return;
    this.#herdrChecked = version;
    for (const { profile, file } of this.entries) {
      const range = profile.requires?.herdr;
      if (range !== undefined && herdrSatisfies(range, version) === false) {
        this.#log(`${file}: profile ${profile.id} requires Herdr ${range}, this is ${version}; applied anyway`);
      }
    }
  }
}

function defaultLog(line: string): void {
  console.error(`herdr-relay profiles: ${line}`);
}

/** `*.json` directly in `dir`, sorted by name. */
async function jsonFiles(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const e of Deno.readDir(dir)) if (e.name.endsWith(".json")) names.push(e.name);
  return names.sort().map((n) => join(dir, n));
}

function parseProfileFile(text: string): ProfileFileValidation {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, problems: [`not JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return validateProfileFile(value);
}

/** The valid user profile files of `dir`; every other `*.json` in it is logged. */
async function loadUserFiles(dir: string, log: (line: string) => void) {
  let st: Deno.FileInfo;
  try {
    st = await Deno.lstat(dir);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return [];
    throw e;
  }
  if (!st.isDirectory) {
    log(`${dir} is not a folder; no user profiles`);
    return [];
  }
  const out: { file: string; profiles: PolicyProfile[] }[] = [];
  for (const file of await jsonFiles(dir)) {
    const problem = await userFileProblem(file, st.uid);
    if (problem !== null) {
      log(`${file}: ${problem}; ignored`);
      continue;
    }
    const v = parseProfileFile(await Deno.readTextFile(file));
    if (!v.ok) {
      log(`${file}: ${v.problems.slice(0, 5).join("; ")}${v.problems.length > 5 ? "; …" : ""}; ignored`);
      continue;
    }
    out.push({ file, profiles: v.profiles });
  }
  return out;
}

/** Why a user profile file may not be used, or null. */
async function userFileProblem(file: string, ownerUid: number | null): Promise<string | null> {
  const st = await Deno.lstat(file);
  if (!st.isFile) return "not a regular file";
  if (st.mode !== null && (st.mode & 0o077) !== 0) {
    return `must be readable and writable by its owner only (0600), is ${
      (st.mode & 0o777).toString(8).padStart(4, "0")
    }`;
  }
  if (ownerUid !== null && st.uid !== null && st.uid !== ownerUid) return "not owned by the owner of its folder";
  if (st.size > PROFILE_MAX_BYTES) return `over ${PROFILE_MAX_BYTES} bytes`;
  return null;
}

/** A folder's applied profile and the read roots it gives. */
export interface FolderPolicy {
  profile: PolicyProfile;
  roots: ReadRoots;
}

/** Each folder's profile and read roots; roots are resolved on first use and again after {@link update}. */
export class FolderPolicies {
  readonly profiles: ProfileSet;
  #input: ReadRootsInput;
  #cache = new Map<string, Promise<FolderPolicy>>();

  constructor(profiles: ProfileSet, input: ReadRootsInput) {
    this.profiles = profiles;
    this.#input = input;
  }

  /** The space folders or cockpit's install changed: every folder's roots are resolved again on next use. */
  update(input: ReadRootsInput): void {
    this.#input = input;
    this.#cache = new Map();
  }

  /** The profile governing `folder` (synchronous; no roots). */
  profileFor(folder: string): PolicyProfile {
    return this.profiles.profileFor(folder);
  }

  /** `folder`'s profile and resolved read roots (a failed resolution is tried again next time). */
  policyFor(folder: string): Promise<FolderPolicy> {
    const cache = this.#cache;
    const cached = cache.get(folder);
    if (cached !== undefined) return cached;
    const profile = this.profileFor(folder);
    const input = this.#input;
    const p = ReadRoots.resolve(input.appHome, folderRootSpecs(input, folder, profile)).then((roots) => ({
      profile,
      roots,
    }));
    cache.set(folder, p);
    p.catch(() => {
      if (cache.get(folder) === p) cache.delete(folder);
    });
    return p;
  }
}
