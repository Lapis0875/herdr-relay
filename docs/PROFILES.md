# Policy profiles: declaring what a mod needs

A device never runs mod code. The bridge runs each mod folder in a sandboxed host on the Mac and decides every request
that leaves that host — `exec`, `hc`, `readTextFile`, `watchFolder`, `net.*` — under the folder's **policy profile**
(OSS-PLAN §1). A folder that no profile names gets `default`: it reads its own files and nothing runs. A profile is a
JSON data file that names mod folders and opts them into more.

This guide is for mod authors and for users who install a mod. Section 10 writes a complete profile for
`fixtures/probe-mods/lstack-shape` from this document alone.

Path shorthand: `bridge/` = `packages/bridge/src/`, `protocol/` = `packages/protocol/src/`. Line numbers refer to the
tree this document was written against; the §2 `net.connect` row, the §4 contract lines and `net.*` rows and the §6 E4
row cite the working tree at `bb9d83d`, after the review fixes ([AMENDMENTS-c1-wave4.md](AMENDMENTS-c1-wave4.md#review-fixes-independent-review-of-50f1629)).

Contents: [1 Limits](#1-what-a-profile-can-and-cannot-do) · [2 Default](#2-default-a-folder-without-a-profile) ·
[3 Files](#3-where-profiles-live) · [4 Fields](#4-field-reference) · [5 Precedence](#5-precedence) ·
[6 Rows](#6-exec-rows-a-profile-can-enable) · [7 `sh -c` pins](#7-why-sh--c-literals-are-hash-pinned-per-herdr-version) ·
[8 Examples](#8-examples) · [9 Testing](#9-testing-a-profile) · [10 lstack-shape](#10-worked-example-lstack-shape)

---

## 1. What a profile can and cannot do

A profile can:

- switch on exec rows that exist in code (`exec.rows`);
- add read roots (`reads`);
- name script paths for the two code-defined script runners (`scripts`);
- pin the SHA-256 of an `sh -c` literal to one of three native replacements (`shLiterals`);
- allow `net.connect` to the cockpit hub and choose how its writes are decided (`net`);
- keep the mod's overlays in the Herdr window (`overlay`).

A profile cannot add a program, an argument form, a write, a network destination, or loosen a row's checks. Rows are
code (`bridge/policy/exec.table.ts:27-148`, `bridge/policy/exec.ts:204-310`). A profile only enables rows and names
values the rows look up (`protocol/profile.ts:1-8`). `writeTextFile` is refused for every folder
(`bridge/herdr/source.ts:16-18`); only code-defined runners write.

The bridge's own Deno permissions stay the outer bound. Its `--allow-read` is `$HOME`, `/tmp` and its own files, and its
`--deny-read` lists credential and browser-data folders (`deno.json:64`, `bridge/platform.ts:110-147`). A profile
root outside them stays unreadable.

Profiles do not affect:

- the host-state functions (`spaces()`, `terminals()`, `theme()`, …), which every folder gets
  (`bridge/herdr/source.ts:12-15`);
- the `run()` pass-through (E9, `bridge/policy/exec.ts:705-721`);
- the static asset route ([POLICY.md](POLICY.md) §2.1).

## 2. Default: a folder without a profile

Every folder no profile names gets `DEFAULT_PROFILE` (`bridge/policy/profiles.ts:35-42`):

| Request | Outcome |
|---|---|
| `readTextFile`, `watchFolder` | `<appHome>/mods/<folder>/**`, `<appHome>/data/<folder>/**` and every space folder (`bridge/policy/read.ts:72-90`); files ≤ 1 MiB (`read.ts:166`) |
| `exec`, `hc` | refused: `no profile for <folder>: exec and hc are off` (`bridge/policy/exec.ts:216`) |
| `net.connect` | refused: `no profile for <folder>: net is off` (`bridge/herdr/net.ts:132`) |
| `openOverlay` | opens on devices (`overlay: "device"`) |

A refused `exec`/`hc` resolves with exit code 126 and stderr `herdr-relay: <reason>`
(`bridge/policy/decision.ts:33-39`). Mods already handle non-zero codes.

## 3. Where profiles live

| Source | Location | Default priority | A file that does not load |
|---|---|---|---|
| built-in | `packages/bridge/profiles/*.json` (`bridge/policy/profiles.ts:28`) | 0 | stops the bridge (`ProfileError`, `profiles.ts:119-128`) |
| user | `<state>/profiles/*.json`; `<state>` = `~/.herdr/herdr-relay` (`bridge/config.ts:64-66`, `bridge/app.ts:95-98`) | 10 | logged and ignored; the bridge keeps running |

A file holds one profile or a non-empty list of them (`protocol/profile.ts:125`). Ids are unique within a file
(`profile.ts:157-167`) and across everything loaded (§5).

**User file rules** (`bridge/policy/profiles.ts:194-235`). Only `*.json` directly in the folder count, read in name
order (`profiles.ts:177-181`). Each file must be:

| Rule | Log line when broken (`<file>: <problem>; ignored`) |
|---|---|
| a regular file, not a symlink | `not a regular file` |
| no group or other permission bits (0600; 0400 passes too) | `must be readable and writable by its owner only (0600), is 0644` |
| owned by the owner of `<state>/profiles` | `not owned by the owner of its folder` |
| at most 262144 bytes (256 KiB, `profiles.ts:30`) | `over 262144 bytes` |
| valid JSON, schema and consistency (§4) | the first five problems (`profiles.ts:213-216`), e.g. for `"folders": "x"`: `/: does not match any allowed shape; closest mismatch:; /folders: must be array, got string` |

A missing `<state>/profiles` means no user profiles (`profiles.ts:199`). A non-folder there logs
`<path> is not a folder; no user profiles` (`profiles.ts:202-205`). The folder's own mode is not checked; it sits in
`<state>`, which the bridge keeps at 0700 (`bridge/auth/token.ts:14-17`).

Profiles load once, when the bridge starts (`bridge/app.ts:94-98`). Restart the bridge after you add or edit one.

Installing a mod's profile:

```sh
mkdir -p ~/.herdr/herdr-relay/profiles
cp my-mod/herdr-relay.profile.json ~/.herdr/herdr-relay/profiles/my-mod.json
chmod 600 ~/.herdr/herdr-relay/profiles/my-mod.json
```

A profile that every user of a mod needs can also be proposed as a built-in under `packages/bridge/profiles/`.

## 4. Field reference

Contract: `PolicyProfile` in `protocol/profile.ts:88-138`; JSON Schema
`packages/protocol/schema/policy-profile.schema.json`. Unknown keys are rejected at every level
(`"additionalProperties": false`, schema lines 56, 83, 107, 139, 143, 191, 206). `id` and `folders` are required.
After the schema, `profileProblems` (`protocol/profile.ts:152-168`) checks what the schema cannot.

| Field | Type, limits, default | Effect | Example |
|---|---|---|---|
| `$schema` | string; ignored by the bridge (`profile.ts:85`) | editor validation only | `"$schema": "../../protocol/schema/policy-profile.schema.json"` (from `packages/bridge/profiles/`) |
| `id` | required; `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `default` is reserved (`profile.ts:34-37,139`) | reported in `hello.hosts[].profile` and every policy record (§9) | `"id": "status-board"` |
| `description` | string | not read by the bridge; for readers | `"description": "Read-only dashboard: hc reads and one config file"` |
| `folders` | required; ≥ 1 exact mod folder names (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, `protocol/control.ts:61`); no duplicates (`profile.ts:140-141`) | the folders this profile governs; no wildcards | `"folders": ["status-board"]` |
| `priority` | integer 0–1000; default 0 built-in, 10 user (`profile.ts:87-91`) | wins when several profiles name a folder (§5) | `"priority": 20` |
| `requires.herdr` | comparators `>=` `<=` `>` `<` `=` (none means `=`), space-separated, all must hold (`profile.ts:71-72,181-200`) | once the mirror mod reports Herdr's version, a mismatch is logged and the profile **still applies** (`bridge/policy/profiles.ts:160-169`, `bridge/herdr/source.ts:295-296`) | `"requires": { "herdr": ">=0.1.13 <0.2.0" }` |
| `reads.appHome` | patterns relative to `<appHome>`, ≤ 512 characters (§4.1) | adds read roots (`bridge/policy/read.ts:80`) | `"reads": { "appHome": ["icons/**", "layouts/*.svg", "data/{folder}/cache.json"] }` |
| `reads.spaces` | boolean; default `true` | `false` drops the space folders from the roots (`read.ts:77-79`) | `"reads": { "spaces": false }` |
| `reads.extra` | paths starting `~/`, `/`, `$cockpit.cache/` or `$cockpit.home/`, ≤ 1024 characters | adds read roots; a `$cockpit.*` path is dropped while `<appHome>/cockpit.json` names no `cache`/`home` (`read.ts:55-66,81-84`) | `"reads": { "extra": ["~/.config/status-board/config.json"] }` |
| `writes.appHome` | as `reads.appHome` | **grants nothing**: no bridge code reads it. It records what the profile's code-defined runners write (`profile.ts:100-102`) | `"writes": { "appHome": ["data/cockpit/show/**"] }` |
| `writes.extra` | as `reads.extra` | as `writes.appHome` | `"writes": { "extra": ["~/.cache/lstack-herdr/**"] }` |
| `exec.rows` | any of `E1 E2 E4 E5 E6 E7 E10 E11 E14 E15` (`profile.ts:40`); default none | a row not listed is refused: `<row> is not enabled for <folder> (profile <id>)` (`bridge/policy/exec.ts:226-228`); §6 lists what each row still checks | `"exec": { "rows": ["E6", "E7"] }` |
| `exec.git.gitDirUnderRoots` | boolean; default `false` | E4 also accepts `--git-dir <dir>` and `git config --file <f>` / `--blob <rev:path>`, with values under the read roots (`exec.ts:396-400,466-500`) | `"exec": { "rows": ["E4"], "git": { "gitDirUnderRoots": true } }` |
| `scripts` | object: path relative to `<appHome>` inside `mods/<folder>/` → `lh-scan` (E1) or `sync` (E2). The folder must be one of `folders` and the runner's row enabled (`profile.ts:109-112,143-147`) | `node <that path> …` runs as that code-defined runner (§6, `exec.ts:313-330`) | `"scripts": { "mods/lstack-herdr/components/lh-scan.mjs": "lh-scan" }` |
| `shLiterals` | object: lowercase 64-hex SHA-256 → `listing` (E14), `picture-remote` or `picture-local` (E15); the row must be enabled (`profile.ts:113-116,148-150`) | `sh -c <literal>` with that hash is replaced by bridge-native code (§7) | `"shLiterals": { "a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231": "listing" }` |
| `net.hubPortFrom` | `"cockpit.json"` (the only value, `protocol/profile.ts:55-56,128-135`) | `net.connect` to `127.0.0.1`/`localhost` at the port `<cockpit cache>/hub.json` names, ≤ 16 connections per folder (`bridge/herdr/net.ts:49,114-164`) | `"net": { "hubPortFrom": "cockpit.json" }` |
| `net.writes` | `"act"` (default) or `"cockpit-hub"`; only beside `net.hubPortFrom` (`protocol/profile.ts:58-67,128-135`; schema lines 180-186) | how each `net.write` is decided for the device the call came from (`bridge/policy/profiles.ts:77-85`, `bridge/herdr/net.ts:212-256`). `act`: the write is sent as written only for a connected `act`-scope device; a `read` device, a downgraded origin and a mod's own task (`init`, a timer) send nothing. `cockpit-hub`: the bridge reads the cockpit hub's newline-delimited JSON requests and decides each by its `op` — reads for anyone, actions for a connected `act` device, changes only the Herdr window makes for no one, `open_url` as a link on the device ([POLICY.md](POLICY.md) §2.8, `bridge/policy/hub.table.ts`). A refused write sends nothing, rejects with the reason and closes the connection. The built-ins `cockpit` and `lstack-herdr` use `cockpit-hub` (`packages/bridge/profiles/cockpit.json:23`, `lstack-herdr.json:39`); `cockpit-hub` fits only a client that speaks the cockpit hub's request format | `"net": { "hubPortFrom": "cockpit.json", "writes": "act" }` |
| `overlay` | `"device"` (default) or `"host-only"` (`profile.ts:53,120`) | `host-only`: opening the mod's overlay from a device toasts `<mod> opens only in the Herdr window` and creates no copy (`bridge/views/overlays.ts:8-10,61`, `bridge/herdr/source.ts:543-546`) | `"overlay": "host-only"` |

### 4.1 Path patterns (`reads`, `writes`)

Rules from `protocol/profile.ts:10-14` and `bridge/policy/read.ts:46-66,150-154`:

- Segments are `/`-separated. A `.`, `..` or empty segment is invalid.
- `{folder}` stands for the governed folder's name, in any segment.
- A last segment `**` is the folder and everything under it. `**` alone is `<appHome>` itself.
- A last segment containing `*` matches the folder's direct entries by name (`*` = any characters except `/`).
  `layouts/*.svg` covers `layouts/a.svg`, not `layouts/x/a.svg`.
- Any other last segment is exactly that file.
- `*` and `{…}` (other than `{folder}`) may not appear in a non-last segment.
- Roots are compared by real path. A link inside a root that resolves outside every root is refused
  (`read.ts:168-180`). A root that does not exist yet is resolved again when a check needs it (`read.ts:98-101`).

## 5. Precedence

When several profiles name the same folder, exactly one applies (`bridge/policy/profiles.ts:71-79,101-110`):

1. the highest `priority` (default 0 built-in, 10 user);
2. then a user profile before a built-in;
3. then the lower `id` (string order).

Each overlap is logged once at load:
`<folder>: profile <id> (<source>, priority <n>) applies over <id> (<source>, priority <n>)`.

Ids never replace each other. A user file in which any profile reuses an id already loaded (built-in or an earlier
user file in name order) is ignored whole: `<file>: profile id <id> is already used; ignored`
(`profiles.ts:131-135`). To override a built-in, name its folders in a profile with a new id; the user default
priority 10 already beats a built-in's 0.

## 6. Exec rows a profile can enable

Every request is classified to one row by its argv (`bridge/policy/exec.table.ts:407-476`). The profile only decides
whether the row is on. These checks always apply:

- `options.on` (another machine) is refused (`exec.ts:231`);
- `cwd` must be a folder under the read roots (`exec.ts:233-235`);
- the timeout defaults to 30 s and is capped at 60 s (`bridge/policy/spawn.ts:13-35`);
- programs are named as on `PATH` (`git`, `hc`); a path is E16, except cockpit.json's `bin` (`exec.table.ts:443-444`).

| Row | Request | Checks code still applies under the profile |
|---|---|---|
| E1 | `node <script> tree\|detail\|run\|call\|transcript …` | `<script>`'s real path is a `scripts` key mapped to `lh-scan`, inside a folder whose host is running, else E3; ≤ 3 arguments after the subcommand, none starting with `-`. Runs under `deno run` with the `lh-scan` permissions, never node (`exec.ts:240-248,313-330`, `bridge/policy/scripts.ts:40-43,100-118`) |
| E2 | `node <script> [--json] [--check]` | U2 is off: always refused with `Run Sync on the Mac: …` (`exec.ts:249-258`, `bridge/policy/user-decisions.ts:19-20`) |
| E4 | `git` read forms | read-only subcommands (`exec.table.ts:220-235`); denied options before `--`, also any abbreviation of a denied long option of at least 3 characters (`--out=x`, `--git-d`) (`exec.table.ts:240-276`, `exec.ts:415-417`); `--git-dir`, `config --file`/`--blob` by full spelling only; `git branch` only lists, every option by its full spelling, a name only as a pattern of `--list`/`-l`/`--contains`/`--merged`/… (`exec.ts:512-542`); `git diff` only inside a work tree owned by the owner of `$HOME`, with relative operands without `..` (`exec.ts:544-590`); `-C`/`cwd` under the read roots; `--no-ext-diff --no-textconv` added to `diff`/`show`/`log`; cleared environment (`exec.ts:377-470`). `git worktree add\|remove` is a named refusal with a toast (`exec.ts:338-357`). Details: [POLICY.md](POLICY.md) §2.3 E4 |
| E5 | `git add -A`, `git commit -m <msg>` | `act`-scope device session; `cwd` is the repository root (`exec.ts:261-273`) |
| E6 | `hc machine ls --json` | cleared environment `{HOME, PATH}` (`exec.ts:274-286`) |
| E7 | `hc ls --json`, `hc terminal list --json`, `hc terminal get <id> --json`, `hc schema`, `hc --version` | every other form refused; `hc machine add\|rm` is a named refusal with a toast (`exec.table.ts:301-310`, `exec.ts:274-286,333-352`) |
| E10 | `env HOME=… HERDR_APP_HOME=… COCKPIT_FRONTEND=app [K=V…] <bin> hub start` | `<bin>` is `<appHome>/cockpit.json`'s `bin` and the program the bridge's `--allow-run=cockpit` resolved; each assignment matches cockpit.json; `DYLD_*`, `LD_*`, `NODE_OPTIONS`, `PATH` never pass (`exec.ts:524-562,639-650`, `exec.table.ts:316-321`) |
| E11 | `open <http(s) url>` (`xdg-open` on Linux) | opened on the device that triggered it (U3), never on the Mac (`exec.ts:289-301`) |
| E14 | `sh -c <pinned listing literal> files <dir>` | `<dir>` under the read roots; answered by the native listing (`exec.ts:302-305`, `bridge/policy/listing.ts:1-12`); Herdr's own literal also needs a known Herdr version (§7) |
| E15 | `sh -c <pinned picture literal> sh <appHome>/data/cockpit/show/<key> <src>` | destination fixed by code to `data/cockpit/show`; remote `<src>` http(s) only; local `<src>` under the read roots; runs `fetch-picture.ts` (`exec.ts:564-610`, `scripts.ts:147-175`) |

Never enabled by any profile (`exec.ts:218-225`): E3 (`node` with flags or an unknown script), E8 (`herdr-app` from a
mod), E12 (another platform's opener), E13 (editors, `open -a`), E16 (anything else: `sh`, `bash`, `curl`, `cat`, …).
E9 is the bridge's own `run()` pass-through, not a mod exec.

E1 and E2 are the lstack mods' runners. Their permissions and CLI shape are code (`scripts.ts:100-144`). A script that
needs other permissions needs a new runner in code, not a profile.

## 7. Why `sh -c` literals are hash-pinned per Herdr version

The bridge never runs a shell for a mod. `sh -c …` is E16 unless the SHA-256 of the exact string after `-c` is pinned
(`exec.table.ts:461-470`). A pinned literal is not executed either: E14 answers with a native directory listing that
reproduces Herdr's `files` script byte for byte (`listing.ts:1-12`), and E15 runs `fetch-picture.ts` in a scoped
`deno run` (`scripts.ts:155-175`). The hash names *which script the native code stands in for*:

- Any change to the string (one space, one flag) gives a new hash, so the mod falls back to E16 and gets exit 126.
  Nothing unreviewed ever reaches a shell.
- The kind (`listing`, `picture-remote`, `picture-local`) says which replacement answers. Pinning your own unrelated
  script as `listing` gets a directory listing back, not your script's output.

Herdr's own literals are additionally pinned **per Herdr version** (`HERDR_SH_LITERALS`, `exec.table.ts:168-193`:
0.1.13, 0.1.14 and 0.1.15). The native listing reproduces what Herdr 0.1.15's `files/main.js:28` prints (the same file
as in 0.1.13 and 0.1.14). A later Herdr may change that script or its output format, and a pin that outlived it would
answer in the old format. So when a profile pins a hash that is one of Herdr's literals (any profile, any folder), the
bridge also requires (`exec.ts:361-377`):

- the running Herdr version is known: the mirror mod's `updates().app.version`, else `herdr-app --version` at start
  (`bridge/herdr/version.ts:110-113`); otherwise `the running Herdr version is not known: its sh -c literals stay off`;
- that version is listed in `HERDR_SH_LITERALS`; otherwise `Herdr <v> is not a version this bridge knows: its sh -c
  literals stay off`;
- that version ships this literal as this kind; otherwise `this sh -c literal is not one Herdr <v> ships`.

`deno task contract:update --tag v<ver>` re-extracts the listing literal from `mods/files/main.js` at each Herdr tag
and reports a missing pin ([COMPATIBILITY.md](COMPATIBILITY.md)). Literals that are not Herdr's (cockpit's four picture
literals, your own) are the profile's alone and have no version check.

**Getting the hash.** It is the SHA-256 of the UTF-8 bytes of the runtime string (after JavaScript unescaping, not the
source text) (`exec.table.ts:359-362,463`). The easiest source is the bridge's own log: an unpinned `sh -c` is
refused and recorded with its argv (`decision.ts:57-73`). This prints the hash of every `sh -c` a folder issued:

```sh
deno eval '
const [folder] = Deno.args;
const log = `${Deno.env.get("HOME")}/.herdr/herdr-relay/log/policy.ndjson`;
for (const line of Deno.readTextFileSync(log).split("\n")) {
  if (line === "") continue;
  const r = JSON.parse(line);
  if (r.folder !== folder || r.argv[0] !== "sh" || r.argv[1] !== "-c") continue;
  if (r.argv[2].length > 2048) { console.log("literal over 2048 characters is cut in the log: hash it yourself"); continue; }
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(r.argv[2]));
  console.log([...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join(""), r.rule, r.decision);
}' my-mod
```

## 8. Examples

### 8.1 A read-only dashboard mod

`status-board` shows machines and terminals and reads one config file of its own. It writes nothing and needs no git,
links or space folders.

```json
{
  "id": "status-board",
  "description": "Read-only dashboard: hc reads and its own config file; no space folders.",
  "folders": ["status-board"],
  "reads": { "spaces": false, "extra": ["~/.config/status-board/config.json"] },
  "exec": { "rows": ["E6", "E7"] }
}
```

What it gets:

- `readTextFile` of its own folder, `data/status-board/` and `~/.config/status-board/config.json`.
- `hc machine ls --json` (E6), and `hc ls --json` / `hc terminal list --json` (E7).

What stays refused:

- a space folder: `… is outside the readable folders` (rule `read`);
- `git status`: `E4 is not enabled for status-board (profile status-board)`;
- `hc machine rm <m>`: the named refusal `hc machine rm needs the Herdr window (structural change)`, plus a toast on the
  device.

### 8.2 A mod calling `git log`

`commit-feed` lists recent commits of each space's repository.

```json
{
  "id": "commit-feed",
  "description": "Recent commits of the space folders (git log only).",
  "folders": ["commit-feed"],
  "exec": { "rows": ["E4"] }
}
```

`reads.spaces` defaults to `true`, so the space folders are read roots. The mod calls:

```js
exec("git", ["-C", space.folder, "log", "--oneline", "-n", "20"]);
```

The bridge runs
`git -C <real path> log --no-ext-diff --no-textconv --oneline -n 20` with the environment cleared to `HOME`, `PATH`,
`GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0` (`exec.ts:445-458`). The two added flags stop a configured external
diff or textconv filter from running.

Refused, with the reason the mod receives on stderr:

| Call | Reason |
|---|---|
| `git -C /etc log` | `git -C /etc is outside the readable folders` (logged under E4) |
| `git -C <space> log --output=/tmp/x` | `git option --output=/tmp/x is not allowed` |
| `git -C <space> log --out=/tmp/x` (an abbreviation git would accept) | `git option --out=/tmp/x is not allowed` |
| `git log` without `-C` or `cwd` | `git needs a folder (cwd or -C)` |
| `git -C <space> push` | `git push is not a read-only subcommand` |
| `git --git-dir <dir> log` | `git --git-dir is not enabled for this mod folder` (needs `exec.git.gitDirUnderRoots`) |
| `/usr/bin/git log` | E16: `/usr/bin/git is not on the exec allowlist` |

Repositories outside the spaces need a root, e.g. `"reads": { "extra": ["~/src/**"] }`.

## 9. Testing a profile

1. **Check it with the real loader, without starting the bridge.** From the herdr-relay clone, this runs the same
   `ProfileSet.load` as the bridge, including the file rules of §3. It prints the loader's log lines, then the profile
   each named folder gets:

   ```sh
   deno eval --config deno.json --cached-only '
   import { ProfileSet } from "./packages/bridge/src/policy/profiles.ts";
   const set = await ProfileSet.load({ userDir: `${Deno.env.get("HOME")}/.herdr/herdr-relay/profiles`, log: console.log });
   for (const folder of Deno.args) console.log(`${folder} -> ${set.profileFor(folder).id}`);
   ' status-board commit-feed
   ```

   A good file prints `<file>: user profile <id> (priority 10) for <folders>` (`profiles.ts:140-144`). `default`
   after `->` means the folder is not named by any loaded profile.

2. **Start the bridge and read its stderr.** Loader lines carry the prefix `herdr-relay: profiles: `
   (`bridge/app.ts:95-98`): user profiles loaded, files ignored and why (§3), overlaps (§5). Once the mirror mod
   reports the Herdr version, a `requires.herdr` mismatch prints
   `<file>: profile <id> requires Herdr <range>, this is <version>; applied anyway`.

3. **Check `hello.hosts[].profile` on a device.** The WebSocket `hello` lists every mod host as
   `{folder, state, reason?, profile?}`; `profile` is the id applied to that folder (`bridge/app.ts:189`,
   `bridge/hosts/supervisor.ts:1124-1125`, `bridge/views/manager.ts:409-424`, [PROTOCOL.md](PROTOCOL.md)).

4. **Read the decision log.** Every exec, hc, net and read decision for a folder is one line in
   `~/.herdr/herdr-relay/log/policy.ndjson` with `rule`, `decision`, `reason` and `profile`
   (`bridge/policy/decision.ts:60-73,78-113`). For example, the refused `sync.mjs` call of §10 (appHome path
   shortened):

   ```json
   {"ts":1789000000000,"folder":"lstack-herdr","method":"exec","argv":["node","<appHome>/mods/lstack-herdr/sync.mjs","--json"],"decision":"refuse","rule":"E2","reason":"E2 is not enabled for lstack-herdr (profile lstack-shape)","profile":"lstack-shape"}
   ```

5. **Read the mod's own result.** A refusal reaches the mod as exit code 126 with `herdr-relay: <reason>` on stderr.

## 10. Worked example: `lstack-shape`

`fixtures/probe-mods/lstack-shape/main.js` is a synthetic mod that repeats the call shapes of the private lstack mods.
The method below works for any mod: list every call, find its row, write down exactly what that row looks up.

**Step 1: list the calls.** `render()` issues five `exec` calls (`main.js:11-17`). `app` = `appHome()`, `user` =
`home()`.

| # | Call | Row (§6) | What the profile must give it |
|---|---|---|---|
| 1 | `node <app>/mods/lstack-herdr/components/lh-scan.mjs tree` | E1 | `E1`; a `scripts` key `mods/lstack-herdr/components/lh-scan.mjs` → `lh-scan`; folder `lstack-herdr` in `folders` |
| 2 | `node <app>/mods/lstack-herdr/sync.mjs --json` | E2 | nothing: U2 refuses E2 for every profile, so it stays off |
| 3 | `env HOME=<user> HERDR_APP_HOME=<app> COCKPIT_FRONTEND=app <user>/.local/bin/cockpit hub start` | E10 | `E10`; the rest is checked against `<appHome>/cockpit.json` |
| 4 | `sh -c <listing> files <app>` | E14 | `E14`; the literal's hash → `listing`; `<app>` itself readable |
| 5 | `sh -c <picture> sh <app>/data/cockpit/show/picture https://example.com/image.png` | E15 | `E15`; the literal's hash → `picture-remote` |

**Step 2: the folder name.** Call 1 names its script by absolute path under `mods/lstack-herdr/`. E1 resolves that
real path, requires it to be a `scripts` key, and requires the folder in its second segment to be a running host
(`exec.ts:313-330`). The probe is therefore installed as `<appHome>/mods/lstack-herdr/`, and the profile names
folder `lstack-herdr`.

**Step 3: the hashes.** Both literals are byte-identical to known ones (`main.js:4-5`):

- the listing literal is Herdr's own `files/main.js:28` literal,
  `a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231` (`exec.table.ts:158-160,176-193`). It is a Herdr
  literal, so E14 also needs the running Herdr to be 0.1.13, 0.1.14 or 0.1.15 (§7);
- the picture literal is cockpit's curl + sips variant,
  `36d9dd22119b98c3137469d3a81cb794dddef92e72b28b4927a743832c5f3077` → `picture-remote` (`exec.table.ts:162`).

**Step 4: the read roots.** Call 4 lists `<app>` itself. A read root that contains `<appHome>` is only `**`
(§4.1), so `reads.appHome` is `["**"]`. No call reads a space folder, so `reads.spaces` is `false`. Calls 1, 3 and 5
read no path argument under the roots: the script, `cockpit.json`'s `bin` and the picture folder are fixed by code.

**Step 5: the profile.** `writes` lists what the code-defined runners write: `lh-scan` writes `~/.cache/lstack-herdr`
(`scripts.ts:109`) and the picture runner writes `data/cockpit/show` (`scripts.ts:165`). The id must differ from the
built-in `lstack-herdr`.

```json
{
  "$schema": "../../../packages/protocol/schema/policy-profile.schema.json",
  "id": "lstack-shape",
  "description": "fixtures/probe-mods/lstack-shape installed as mods/lstack-herdr: the lh-scan script (E1), cockpit hub start (E10), Herdr's files listing (E14) and cockpit's remote picture (E15). sync.mjs (E2) stays off (U2).",
  "folders": ["lstack-herdr"],
  "requires": { "herdr": ">=0.1.13" },
  "reads": { "appHome": ["**"], "spaces": false },
  "writes": { "appHome": ["data/cockpit/show/**"], "extra": ["~/.cache/lstack-herdr/**"] },
  "exec": { "rows": ["E1", "E10", "E14", "E15"] },
  "scripts": { "mods/lstack-herdr/components/lh-scan.mjs": "lh-scan" },
  "shLiterals": {
    "a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231": "listing",
    "36d9dd22119b98c3137469d3a81cb794dddef92e72b28b4927a743832c5f3077": "picture-remote"
  },
  "overlay": "device"
}
```

**Step 6: what the context must hold.** Three things come from the Mac, not the profile:

- the `lstack-herdr` host is running (E1);
- `<appHome>/cockpit.json` has `"bin": "<user>/.local/bin/cockpit"`, and that is the `cockpit` the bridge's
  `--allow-run` resolved (E10);
- the running Herdr is 0.1.13, 0.1.14 or 0.1.15 (E14).

**Step 7: the outcome.** Loaded through `ProfileSet.load` as a 0600 user file, with the context of step 6:

| # | Row | Decision |
|---|---|---|
| 1 | E1 | allowed: scoped `deno run` of `<app>/mods/lstack-herdr/components/lh-scan.mjs tree` |
| 2 | E2 | refused: `E2 is not enabled for lstack-herdr (profile lstack-shape)` |
| 3 | E10 | allowed: `<user>/.local/bin/cockpit hub start`, environment `HOME`, `HERDR_APP_HOME`, `COCKPIT_FRONTEND`, `PATH` |
| 4 | E14 | allowed: native listing of `<app>` |
| 5 | E15 | allowed: `fetch-picture.ts remote <app>/data/cockpit/show/picture https://example.com/image.png` |

With an unknown Herdr version, call 4 is refused (`the running Herdr version is not known: its sh -c literals stay
off`). If no profile names the folder (built-ins and this file both absent), all five are refused (`no profile for
lstack-herdr: exec and hc are off`). With the built-ins also loaded, the built-in `lstack-herdr` profile names the same
folder and the bridge logs `lstack-herdr: profile lstack-shape (user, priority 10) applies over lstack-herdr (builtin,
priority 0)`.
