# herdr-relay — desktop path

Split by T00 on 2026-11-09; §2 below is copied verbatim from [DESIGN.md](DESIGN.md) §2 (v1; DESIGN-v2 keeps it in
force) and the D9 row of [DECISIONS.md](DECISIONS.md). Owner: **T13** (`tools/sync-config/**`, this file); lstack `on:`
patch proposal: **T14**, under the gitignored `fixtures/private/lstack-remote-patch/` because it is derived from the
private fork (O7; OSS-PLAN T13/T14 row), not applied; tests: **T27**. Evidence legend: **[V]** read on this Mac ·
**[B]** stated in the brief · **[I]** inference.

**D9 (binding):** Ship `tools/sync-config` + the lstack `on:` patch proposal; do not apply to `~/.config/herdr-app`
until a PC is set up.

DESIGN-v2 task scope: T13 = `tools/sync-config` (rsync include list from the table below, `keys.json` section merge,
dry-run default) + this document; T14 = lstack `on:`-aware patch proposal (`exec/readTextFile {on: space.machine}` in
`mods/lstack-herdr/components/*` + `hooks.mjs`), checked with `git apply --check` against a scratch copy of
`fixtures/private/herdr-home/mods/lstack-herdr`. What T13 ships is in [sync-config](#sync-config), which generalises
the §2 table for any app home; [The lstack `on:` patch](#the-lstack-on-patch-t14) describes T14.

---

## 2. Desktop path: native Herdr on another PC + `hc machine add` + config sync

Facts **[V]**: Herdr keeps spaces/tabs/splits per machine in that machine's core `herdr-app` document; adding the Mac as a machine shows its spaces with a `<machine>/` id prefix (AGENTS.md "The model"). `hc machine add` is over SSH **[B]**; macOS Remote Login is currently OFF **[B]** → must be enabled (System Settings → General → Sharing → Remote Login), ideally restricted to the Tailscale interface (`tailscale ip`) and key-only auth.

What must sync Mac → PC (one-way, Mac is source of truth; a `herdr-relay sync-config` script over the same SSH/rsync):

| Item | Sync? | Why / conflict |
|---|---|---|
| `layouts/lstack-herdr.json` + `.svg` | yes | the layout itself |
| `mods/lstack-herdr-cockpit/`, `mods/lstack-herdr/` | yes | personal mods (fork + source); exclude `gpui-kit.d.ts`, `jsconfig.json` (app-written), `.lstack-sync.json` ok |
| `mods/workspace-chrome, tabs, files, changes` | **no** | shipped mods, replaced on every start; require the **same Herdr version 0.1.13** on the PC or behaviour drifts |
| `keys.json` section `layout:lstack-herdr` | yes (merge section only) | PC's own global keys must survive |
| `themes/*.json`, `programs.json`, `my-icons/` | yes | look + agent menu |
| `settings.json` | partial | `font: "D2Coding ligature"` must be installed on the PC; `zoom` is per screen |
| `shared.json`, `view.json`, `layouts/.state/*.json`, `window.json`, `seen.json` | **no** | "this screen only" state; syncing would fight the app's writes |
| `cockpit.json`, `~/.cache/cockpit/**`, `~/.config/cockpit/config.json` | **no** — install cockpit on the PC | hub is a 127.0.0.1 process with Mac paths; copying `cockpit.json` makes hub.js exec a non-existent binary |
| `data/**` | no | machine-specific caches |

What breaks for Mac spaces viewed from the PC **[V]**:
- **lstack tree/transcript** (`lh-tree-data.js`, `lh-transcript.js`, `lh-watch.js`): `exec("node", [lh-scan.mjs…])` runs on the PC and reads the PC's `~/.omp` → empty tree / wrong "est" guesses. Fix needs a fork change: pass `{ on: space.machine }` to `exec` and `readTextFile`, make `SCAN()`/`SYNC()` resolve to the Mac's path, and require `node` on the Mac (present: `/opt/homebrew/bin/node`). Edits belong in `mods/lstack-herdr/components/*` + `hooks.mjs`, then `sync.mjs` — the fork must never be edited (main.js header).
- **Cockpit apps** (inbox/meetings/mail/monitor/routines/runbook/show/review): a PC hub fetches its own data (GitHub/Linear/calendar tokens must be configured on the PC); `act` calls with `mac/t7` addresses target the PC's hub, which does not know Mac terminals → degraded.
- **code pane** (`code.js:37` exec of `~/.local/bin/herdr-app do pane.split`) works on the PC (its own window), but file reads are PC-local; needs `on:`.
- **`files`/`changes` shipped mods**: use `exec(..., {on})`? They import `exec, readTextFile, watchFolder` — `watchFolder` is "here only" (herdr.d.ts) → remote spaces fall back to timers; acceptable.
- Simultaneous structural edits: "newest accepted document wins (no merging)" **[V]** — no merge logic needed, but expect lost updates under concurrent drags.

Conclusion: the desktop path is a *configuration + two mod fixes* task, not a product; include the sync script and the `on:`-aware tree fix in the repo (tasks T10/T11) but treat it as secondary to the remote client.

(Task numbers in the conclusion are DESIGN.md v1 numbering; in DESIGN-v2 they are T13 and T14.)

---

## sync-config

`tools/sync-config/mod.ts` plans the Mac → PC copy of §2 for any app home: the user's own layouts and what they need,
never what Herdr ships. It reads the source app home and never writes it, and writes nothing without `--apply`. With
`--apply` it copies into a local folder, or, for `[user@]host:path`, sends the files with rsync over SSH and merges
the PC's `keys.json` ([Remote targets](#remote-targets)); rsync is the only program it runs.

```sh
# Dry run (default): prints the plan, the rsync filter and, for a remote target, the exact rsync lines --apply runs.
deno task sync-config --target me@pc:.config/herdr-app

# Same, from another app home or with review-by-hand files opted in.
deno task sync-config --source /path/to/appHome --target me@pc:.config/herdr-app --include programs.json

# Apply to the PC over SSH (Remote Login on the PC, key auth; the Mac's ssh config applies).
deno task sync-config --target me@pc:.config/herdr-app --apply

# Apply into a local folder: a mounted PC app home, or a staging folder.
deno run --allow-read --allow-env=HOME,HERDR_APP_HOME --allow-write=/path/to/pc-home \
  tools/sync-config/mod.ts --target /path/to/pc-home --apply
```

- `--source`: default `$HERDR_APP_HOME`, else `~/.config/herdr-app` (as the bridge resolves it).
- `--target`: a local folder, or `[user@]host:path` (rsync's rule: a `:` before any `/` is remote). The remote path
  must name the PC's app home (relative paths start at the PC user's home); `host:` alone is refused (it would mean
  the PC's home, not the app home). A remote target keeps to letters, digits and `. _ / ~ @ + -` (`:` only after the
  host, `@` only after the user): see [Remote targets](#remote-targets).
- `--apply`, local target: the folder is created when missing; everything is checked before the first write; files
  keep their modification time; nothing is deleted. Refused when the target is the source or overlaps it, and when a
  path under the target is a symbolic link.
- `--apply`, remote target: see [Remote targets](#remote-targets). Needs `--allow-run=rsync` and write access to the
  system temporary folder (`--allow-write=$TMPDIR`; on Linux without `TMPDIR`, `/tmp`).
- `--rsh <command>`: the remote shell rsync uses (its `-e`), for example `"ssh -p 2222"`; default `$RSYNC_RSH`, else
  `ssh`. Remote targets only.
- `--include <path>`: copy one file from the review list too (anything else is a usage error, exit 2).
- Exit codes: 0 done, 1 error (`sync-config: …` on stderr, nothing more written), 2 usage.

### What sync-config copies

Decided by Main on 2026-11-10 (T13), generalising the §2 table so it holds for generic setups (N2):

1. **User layouts:** every `layouts/<L>.json` that Herdr does not ship, plus the preview its root names
   (`"preview": "layouts/<L>.svg"` or `.png`). Shipped means named in the pinned contract
   (`packages/bridge/src/compat/pins.json`, every tested version's `installed.json` keys `<mod>` and `layout:<L>`) or
   in the source's own `installed.json`; there is no hard-coded list.
2. **The mods those layouts reference** (any `mod`, a string `header`, `terminal_menu`; never inside a mod's
   `props`) that Herdr does not ship, with the other folders of the built-in policy profile governing such a mod
   (`packages/bridge/profiles/*.json` `folders`: a generated fork brings its source). Every regular file under each
   folder, except `gpui-kit.d.ts` and `jsconfig.json` at any depth (Herdr writes them itself). **A user mod that no user
   layout references is not synced.**
3. **The themes those layouts name** (`theme`, or its `light`/`dark`), unless byte-identical to the shipped default.
4. **`keys.json` sections** `layout:<L>` and `mod:<M>` for the layouts and mods synced, when the source has them.
   They are merged, never copied: each replaces the target's section of that name whole; every other target section
   (the PC's `global`, `terminal`, …) stays, in its order; new sections are appended in sorted order. The target's file
   is rewritten (`JSON.stringify(…, null, 2)`, atomically) only when the merge changes it. A target without
   `keys.json` gets none: start Herdr there once, then run again (a file holding only these sections would replace
   Herdr's default keys **[I]**). Local and remote targets merge the same way.

Never synced: anything Herdr ships (its mods, layouts, `icons/`, `frame/`, typings), Herdr's bookkeeping and "this
screen only" files (`shared.json`, `view.json`, `layouts/.state/`, `window(s).json`, `seen.json`, `installed.json`,
`data/`), `cockpit.json`, and `settings.json` (its font must be installed on the PC and its zoom is per screen: set
them there by hand). Symbolic links and special files are never copied; inside a synced layout or mod they are listed
under `skipped`.

**Review by hand:** `themes/*.json` and `programs.json` that differ from the pinned shipped defaults
(`fixtures/generic-home/MANIFEST.json`, Herdr v0.1.14), and every file under `my-icons/`, are listed as
`--include <path>` lines and copied only when that flag is given. Files identical to the shipped defaults are not
mentioned.

The rsync filter selects exactly the planned files with `rsync -rtm` (no symbolic links or special files, empty
folders pruned); `keys.json` is never in it. Checked [V] with Homebrew rsync 3.5.1 and macOS's openrsync (2.6.9
compatible) into a scratch folder: both copied exactly what a local `--apply` copies.

### Worked example: the author's lstack setup

Against `fixtures/private/herdr-home` (the author's app home), sync-config plans [V]:

- copy `layouts/lstack-herdr.json` and `layouts/lstack-herdr.svg` (its preview);
- copy `mods/lstack-herdr-cockpit/**` (the layout references it) and `mods/lstack-herdr/**` (its source: the
  `lstack-herdr` profile governs both folders), without `gpui-kit.d.ts`/`jsconfig.json` anywhere: 201 files;
- merge `keys.json` section `layout:lstack-herdr`;
- review by hand: `--include programs.json` (it adds `omp`).

`workspace-chrome`, `tabs`, `files` and `changes` are shipped and not synced; the themes `atom-one-dark.json` and
`win98.json` are identical to the shipped ones and not mentioned. The other sections in its `keys.json`
(`layout:cockpit`, `mod:recap`, …) belong to layouts or mods that home does not have, so they stay out. Against
`fixtures/generic-home` (Herdr's defaults only) the plan is empty.

**Delta from the §2 table:** `mods/lstack-herdr/` is reached through its policy profile, not the layout;
`themes/*.json`, `programs.json` and `my-icons/` are no longer copied wholesale (only themes a synced layout names;
the rest is the review list); `mod:<M>` sections of synced mods are merged too; `settings.json` ("partial") is not
synced; the PC needs the same Herdr version as the Mac (0.1.14 is the pinned one, not 0.1.13).

### Remote targets

For `[user@]host:path`, `--apply` runs rsync, and only rsync, over the remote shell (`--rsh`, `$RSYNC_RSH` or
`ssh`), in this order; the dry run prints the same lines with `<temp>` for the local temporary folder:

```sh
# 1. Read the PC's keys.json, alone, into a fresh local temporary folder (only when there are sections to merge).
#    The filter makes an absent file no error: it is then neither merged nor created.
rsync -rt -e ssh --include=/keys.json '--exclude=*' me@pc:.config/herdr-app/ <temp>/
# 2. Send the planned files (lstack setup shown). No --delete; folder times on the PC are left alone.
rsync -rtm --omit-dir-times -e ssh --exclude=gpui-kit.d.ts --exclude=jsconfig.json --include=/layouts/ \
  --include=/layouts/lstack-herdr.json --include=/layouts/lstack-herdr.svg --include=/mods/ \
  '--include=/mods/lstack-herdr-cockpit/***' '--include=/mods/lstack-herdr/***' '--exclude=*' \
  <appHome>/ me@pc:.config/herdr-app/
# 3. Send the merged keys.json back over the PC's (only when the merge changed it).
rsync -t --ignore-times -e ssh <temp>/keys.json me@pc:.config/herdr-app/keys.json
```

The merge happens on the Mac, between steps 1 and 2: a `keys.json` that is not a JSON object of sections stops the
run before anything is sent. A failed rsync stops the rest and the error says what was sent. The temporary folder is
removed. The PC's app home must exist (start Herdr there once). Nothing is ever deleted on the PC, so a file a mod
no longer has stays there until removed by hand. Between steps 1 and 3 a change to the PC's `keys.json` would be
overwritten **[I]**: don't edit keys on the PC while syncing.

**Only shell-safe remote paths.** rsync hands the remote path to the PC's shell inside a command line, and macOS's
openrsync cannot protect it (`--protect-args`). So a remote target's `[user@]host` and path, and every planned file
(it lands under that path), may contain only letters, digits and `. _ / ~ @ + -`; `:` only separates the host, `@`
the user. Anything else (a space, `;`, `$`, `` ` ``, quotes, a second `:`, …) is refused before anything runs, also in
a dry run, with exit 2 and a message naming the part: `--target me@pc:my dir: "my dir" has a space or shell
character; use a path without spaces or shell characters (letters, digits and . _ / ~ @ + -)`, or for a file
`mods/<M>/a b.js: a file with a space or shell character can't go to a remote target; … or sync to a local folder`.
Local targets are not affected. `~` stays allowed so `me@pc:~/.config/herdr-app` works.

Checked [V] on this Mac with a stand-in `--rsh` (a script that drops ssh's options and host and runs rsync's
`rsync --server` command locally, from a scratch "remote home"), against a copy of `fixtures/private/herdr-home`,
with Homebrew rsync 3.5.2 and with macOS's openrsync: the target received exactly the 203 planned files, byte for
byte, and kept its own files; `keys.json` kept the PC's `global`/`terminal` and got `layout:lstack-herdr`, with the
same sha256 on fresh targets and as a local `--apply`; a second run sent no keys (`already match`); a target without
`keys.json` got none; the stand-in saw only `rsync --server` commands; the source was unchanged. Not run against a
real second machine.

## The lstack `on:` patch (T14)

`fixtures/private/lstack-remote-patch/lstack-remote.patch` (private, O7) is a unified diff against
`mods/lstack-herdr/` (the source; the generated fork is never edited), with a README. It does the fork change named in
§2: `lh-tree-data.js` resolves a root's machine from its space (`spaces()[i].machine`) and runs `lh-scan.mjs` there
(`exec(…, { on })`, one tree scan per machine); details, runs, calls and transcripts follow their root;
`lh-watch.js` reads `cockpit.json` and the fork's stamp with `readTextFile(…, { on })` on the focused space's machine
and runs its Sync there; `hooks.mjs` adds 7 hooks so cockpit's `code.js` reads a remote file there, read-only
(`writeTextFile` has no `on`). Another machine's app home is assumed to be `~/.config/herdr-app` under the home `exec`
starts in (asked once with `pwd`) **[I]**, and needs `node` there. `git apply --check` against a scratch copy of
`fixtures/private/herdr-home/mods/lstack-herdr` passes [V]. Not applied anywhere (D9): on the Mac, apply it in
`mods/lstack-herdr/`, run `node sync.mjs`, `herdr-app check mods/lstack-herdr-cockpit`, then sync-config.
