# Herdr compatibility

herdr-relay renders Herdr's own mods and runs their requests through a policy built from one Herdr release's code.
When Herdr changes, the bridge notices by comparing the running Herdr with **contract pins**. It reports any
difference to devices and to `herdr-relay doctor`, and it never widens what mods may do.

Path shorthand: `bridge/` = `packages/bridge/src/`. Line numbers refer to the tree this document was written against.

## 1. Tested versions

| Herdr app | Status in this tree | What a device sees |
|---|---|---|
| **0.1.15** | **tested**: pinned (`bridge/compat/pins.json`, generated from `fixtures/contract/0.1.15/`; shipped mods synced at tag `v0.1.15`, commit `9950887361af`, `fixtures/generic-home/MANIFEST.json:2-3`) | no banner when nothing drifted |
| **0.1.14** | **tested**: pinned (`bridge/compat/pins.json`, generated from `fixtures/contract/0.1.14/`; its shipped mods were synced at tag `v0.1.14`, commit `2405bf388c56`, until 0.1.15 replaced them in `fixtures/generic-home`) | no banner when nothing drifted; surfaces compared with 0.1.14's own pins |
| 0.1.13 | supported, **not tested**: no contract pins (`SUPPORTED_FROM = "0.1.13"`, `bridge/compat/pins.ts:29-33`); its E14 listing literal is pinned (below) | banner `herdr-relay was not tested with Herdr 0.1.13 (tested: 0.1.14, 0.1.15).`; surfaces compared with 0.1.15's pins, the newest (§4) |
| < 0.1.13 | unsupported; the bridge still runs | banner `Herdr <v> is older than herdr-relay supports (0.1.13 or newer).` |
| > 0.1.15 | untested; the bridge still runs | banner `Herdr <v> is newer than herdr-relay was tested with (0.1.15).` |
| unknown | the version could not be read | banner `herdr-relay cannot tell which Herdr version is running; it was tested with Herdr 0.1.14, 0.1.15.` |

Banner texts: `bridge/compat/check.ts:281-305`. The built-in profiles for Herdr's shipped mods declare
`requires.herdr: ">=0.1.13"` (`packages/bridge/profiles/herdr-shipped.json`).

**E14 under 0.1.13, 0.1.14 and 0.1.15:** Herdr's `files` listing literal is pinned for all three versions
(`HERDR_SH_LITERALS`, `bridge/policy/exec.table.ts:168-193`), so the `files` mod lists folders on each.
`defaults/mods/files/main.js` is the same git blob at all three tags (§6, §7). The 0.1.13 entry rests on the literal
alone: it adds no contract pins, so 0.1.13 stays "not tested". Any other version refuses the listing with
`Herdr <v> is not a version this bridge knows: its sh -c literals stay off` (`bridge/policy/exec.ts:361-377`).

## 2. The running version

The bridge runs two read-only commands once at start, each with a 5 s deadline and an environment cleared to `HOME`,
`PATH` and `HERDR_APP_HOME` (`bridge/herdr/version.ts:25-71`):

- `herdr-app --version`;
- `herdr-app commands`.

Once the mirror mod reports `updates().app.version`, that value wins (`version.ts:110-113`). The version, and the
compat outcome for it, are logged whenever the version changes, e.g. `Herdr 0.1.15 (herdr-app --version)`
(`version.ts:116-125`).

The same version gates Herdr's own `sh -c` literals (E14, see [PROFILES.md](PROFILES.md) §7). It is also what the
profiles' `requires.herdr` is checked against; that check runs only once the mirror mod has reported
(`bridge/herdr/source.ts:295-296`).

## 3. Contract pins

`deno task contract:update` generates `packages/bridge/src/compat/pins.json` from `fixtures/contract/<ver>/`. Never
edit the file by hand. The bridge ships the pins because releases do not include the fixtures (`bridge/compat/pins.ts:1-5`).
Per pinned version (`pins.ts:9-19`):

| Pin | What it covers | 0.1.14 | 0.1.15 |
|---|---|---|---|
| `herdrDts` | sha256 of `<appHome>/herdr.d.ts`: the 44 `herdr` functions and their docs | `814d0115fbf9…` | `373dd8c46367…` |
| `gpuiKitDts` | sha256 of the `gpui-kit.d.ts` Herdr writes into every mod folder: element and style names | `40558058a396…` | `3b0992fbea25…` |
| `installed` | `<appHome>/installed.json`: Herdr's own 16-hex hash of every file of every shipped mod and layout | 21 mods + `layout:main`, `layout:terminals`, `layout:win98` | the same 24 keys; 11 mods' hashes differ (§7) |
| `commands` | sorted names `herdr-app commands` lists | 71 names | the same 71 names |

Two pins live outside `pins.json`, because they are code:

- Herdr's E14 listing literal per version (0.1.13, 0.1.14, 0.1.15), in `HERDR_SH_LITERALS` (`exec.table.ts:168-193`) and in the
  `herdr-shipped` profile's `shLiterals` (`packages/bridge/profiles/herdr-shipped.json`);
- the class of every command name, in `bridge/policy/commands.json`. A name in no class is refused on devices
  (`bridge/session/commands.ts:1-5,75`).

`fixtures/contract/0.1.14/` and `fixtures/contract/0.1.15/` hold the captured files: `herdr.d.ts`, `gpui-kit.d.ts`,
`installed.json`, `herdr-app-commands.json`, `keys.json`. `keys.json` is Herdr's `defaults/keys.json` at that tag
(`fixtures/generic-home/keys.json` right after the sync), copied by hand; the compat check does not read it.

## 4. What drift means

At start the bridge reads the app home without writing anything (`bridge/compat/check.ts:83-99`):

- `herdr.d.ts`;
- `installed.json`;
- the most recently written `gpui-kit.d.ts` among the shipped mods' folders.

It compares them, and the `herdr-app commands` names, with the pins of the running version. If that version is not
pinned, it compares with the newest pinned version (`check.ts:101-154`).

| Drift entry (`surface`) | Meaning for herdr-relay |
|---|---|
| `herdr.d.ts differs from Herdr <v>'s` | the `herdr` API changed: functions, arguments or documented behaviour the bridge implements (`bridge/herdr/source.ts:12-28`) may differ |
| `mods/<mod>/gpui-kit.d.ts differs from Herdr <v>'s` | gpui-kit's element or style names may differ from what the device renderer knows; a view can lose styling or fail to render |
| `shipped files differ from Herdr <v>'s: changed …; new …; missing …` | Herdr's own mods or layouts changed. The exec rows were derived from the pinned releases' call sites (`exec.table.ts:1-9`); a new call shape that no row describes is refused, so a changed mod may lose a feature on devices. The allowed forms stay the same |
| `installed.json is not the list of shipped-file hashes herdr-relay reads` | the file's format changed |
| `herdr-app commands differs from Herdr <v>'s: new …; gone …` | the command list changed |
| `<n> command(s) herdr-relay does not classify, refused on devices: …` | listed names without a class in `bridge/policy/commands.json`: devices are refused them, deny by default |

A surface that cannot be read (no `installed.json`, `herdr-app` not on `PATH`) is a `not compared:` note for doctor,
not drift (`check.ts:12-13`). Drift details name files and commands, never paths, because they reach devices.

Where it shows:

- **Devices:** `hello.compat = {herdrVersion, tested, drift[], banner?}` (`packages/protocol/src/messages.ts:101-123`,
  `bridge/compat/check.ts:156-161`). There is a banner when the version is untested or anything drifted.
- **`herdr-relay doctor`:** `compatSummary` lines (`check.ts:163-183`, `bridge/compat/doctor.ts`), e.g. with a changed
  `herdr.d.ts` and one new command:

  ```text
  Herdr 0.1.15: tested (herdr-relay was tested with Herdr 0.1.14, 0.1.15)
  drift (herdr.d.ts): herdr.d.ts differs from Herdr 0.1.15's
  drift (commands): herdr-app commands differs from Herdr 0.1.15's: new new.thing
  drift (commands): 1 command herdr-relay does not classify, refused on devices: new.thing
  commands: 72 listed by herdr-app commands, 1 unclassified (refused on devices)
  device banner: This Herdr 0.1.15 differs from the one herdr-relay was tested with (herdr.d.ts, commands); some views or commands may not work.
  ```

- **Bridge log:** the same lines with the prefix `compat: ` (`version.ts:124`).

Drift never changes the policy. Profiles, rows and pins stay as they are. Unknown commands stay refused, and Herdr
literals stay off for versions that are not pinned.

## 5. Pinning a new Herdr version: `deno task contract:update`

```sh
deno task contract:update --tag v<major.minor.patch> [--from <appHome>] [--no-sync] [--check]
```

Defined in `deno.json:68`; implemented in `tools/contract/update.ts:1-16`. Steps:

1. `--from <appHome>` captures `fixtures/contract/<ver>/` from an installed Herdr of exactly that version (read only).
   It runs `herdr-app --version`, which must report `<ver>`, and `herdr-app commands` with `HERDR_APP_HOME=<appHome>`.
   It copies `herdr.d.ts`, `installed.json` and the newest shipped mod's `gpui-kit.d.ts`, which Herdr generates and the
   upstream repository does not contain (`update.ts:89-113`).
2. Unless `--no-sync` or `--check`, it refreshes `fixtures/generic-home` from `herdrdev/herdr-app` at the tag
   (`tools/fixtures/sync.ts`, `update.ts:115-131`). The sync accepts a tag only when `fixtures/contract/<ver>/` already
   holds that version's `herdr.d.ts` and `gpui-kit.d.ts`, and the upstream `defaults/herdr.d.ts` must equal the
   captured one. `deno run --allow-read=fixtures tools/fixtures/sync.ts --check` (offline) verifies
   `fixtures/generic-home` against its `MANIFEST.json` at the newest captured version, or at `--tag`.
3. It hashes `fixtures/contract/<ver>/` into `pins.json`, keeping other versions in order. `--check` only compares and
   reports `pins.json is stale for <ver>: run without --check` (`update.ts:209-220`).
4. It cross-checks what `pins.json` cannot hold (`update.ts:133-177`). Each problem names the entry to add:
   - every listed command has a class in `packages/bridge/src/policy/commands.json`;
   - Herdr's listing literal, re-extracted from `mods/files/main.js` at the tag, is in `HERDR_SH_LITERALS[<ver>]` and in
     the `herdr-shipped` profile;
   - the bundled `packages/bridge/src/herdr/commands.json` matches the newest pinned capture.

Exit codes: 0 when everything agrees (`Herdr <ver>: contract pins, classes and the E14 literal agree`), 1 when any
problem was printed, 2 on bad usage (`update.ts:179-235`).

After pinning a version, copy `fixtures/generic-home/keys.json` into `fixtures/contract/<ver>/keys.json`, review the
diff of `fixtures/generic-home` for changed `exec`/`hc` call shapes before declaring it tested (OSS-PLAN §2.1), and copy
a changed `fixtures/generic-home/programs.json` (Herdr's built-in program table) into
`packages/bridge/src/herdr/programs.json`, keeping its `$comment`: the bridge names and draws terminals from that copy,
and `packages/bridge/test/unit/herdr/programs_test.ts` fails while the two differ.

## 6. Herdr 0.1.13 → 0.1.14

Source: GitHub compare `herdrdev/herdr-app` `v0.1.13...v0.1.14` (45 commits, 60 files, **13 under `defaults/`**)
**[W]** https://github.com/herdrdev/herdr-app/compare/v0.1.13...v0.1.14, fetched 2026-11-10.

| File under `defaults/` | +/− | Relevance to herdr-relay |
|---|---|---|
| `herdr.d.ts` | +8 −3 | `exec` gained a `timeout` option (below); `pane.swap` argument docs; a terminal inside a window reports `pane: null` |
| `AGENTS.md` | +30 −10 | documents `exec` `timeout` ("rejects on timeout") and windows holding terminals; not a pinned surface |
| `frame/palette/main.js` | +3 −2 | Herdr's own frame; not a shipped mod, not pinned |
| `frame/settings/main.js` | +7 −4 | as above |
| `mods/agents/main.js` | +13 −3 | shipped mod: `installed.json` hash changes |
| `mods/changes/main.js` | +4 −1 | layout fix of the changes list (scrollbar); no exec change |
| `mods/confirm/main.js` | +1 −0 | shipped mod: hash changes |
| `mods/machine-add/main.js` | +36 −80 | no longer runs `hc run --bg … hc machine add` or opens an overlay; tells the user to run `hc machine add` in a terminal. herdr-relay keeps the mod host-only either way |
| `mods/menu/main.js` | +11 −4 | shipped mod: hash changes |
| `mods/spaces/main.js` | +26 −13 | shipped mod: hash changes |
| `mods/workspace-chrome/main.js` | +4 −1 | shipped mod: hash changes |
| `mods/worktree/main.js` | +6 −4 | its `git()` helper forwards a `timeout`; `git worktree add` and `git worktree remove` pass `600_000` (`fixtures/generic-home/mods/worktree/main.js:56-57,188,224`) |
| `programs.json` | +2 −2 | `codex` runs with `--no-daemon`; `kimi` gains `match` names |

**`exec` timeout: Herdr allows up to 600 s, herdr-relay caps at 60 s.**

- 0.1.13 documented a fixed 30 s limit. 0.1.14 adds `timeout`: default 30 000 ms, capped at 600 000 ms
  (`fixtures/contract/0.1.14/herdr.d.ts:10-14`).
- The bridge applies the mod's `timeout` up to `EXEC_MAX_TIMEOUT_MS` = 60 000 ms, default 30 000 ms
  (`bridge/policy/spawn.ts:12-15,29-35`). Script runners have their own shorter deadlines (`bridge/policy/scripts.ts:58-62`).
- A timed-out program is killed and the call **resolves** with code 124 and a note on stderr
  (`spawn.ts:16-17,77-80`). Herdr 0.1.14 documents that its own `exec` **rejects** on timeout.
- The only shipped caller of the larger timeout is `worktree`. It uses it for `git worktree add` and
  `git worktree remove`, which herdr-relay refuses with a toast before anything runs (`bridge/policy/exec.ts:333-352`).
  No shipped call that herdr-relay runs asks for more than 60 s.

**E14 literal unchanged.** `mods/files/main.js` is not among the changed files: `defaults/mods/files/main.js` is git blob
`fc3c7582c31371b675966b41aa69ebde0a07cc92` at both `v0.1.13` and `v0.1.14` (GitHub contents API, fetched 2026-11-10),
the same as `fixtures/generic-home/mods/files/main.js`. Herdr's listing literal (`files/main.js:28`) is therefore the same
in both tags, sha256 `a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231`, and E14 is pinned for both.

**Commands unchanged.** Both captures list the same 71 names:

- 0.1.13: `fixtures/herdr-app-commands.json`, evidence M1 in [EVIDENCE-M1-M3.md](EVIDENCE-M1-M3.md);
- 0.1.14: `fixtures/contract/0.1.14/herdr-app-commands.json`.

Every name is classified (0 unclassified at 0.1.14).

**What a 0.1.13 home shows today [I]:** derived from the compares in §6 and §7 and `check.ts:101-154`, not observed on a
0.1.13 install.

- The version banner of §1.
- Compared with 0.1.15's pins, the newest: a `herdr.d.ts` drift entry, because the file changed in both releases.
- A `gpui-kit.d.ts` drift entry, unless 0.1.13 already generated 0.1.15's file (0.1.15's adds `ScrollHandle`, §7).
- An `installed.json` entry listing the shipped mods changed in either release (14): agents, changes, confirm, help,
  machine-add, menu, new-menu, pane, picker, spaces, tabs, toast, workspace-chrome, worktree. The entry names the first
  6 and "and 8 more".
- No command drift.

## 7. Herdr 0.1.14 → 0.1.15

Source: GitHub compare `herdrdev/herdr-app` `v0.1.14...v0.1.15` (41 commits, 72 files, **15 under `defaults/`**)
**[W]** https://github.com/herdrdev/herdr-app/compare/v0.1.14...v0.1.15, fetched 2026-11-11. Pinned with
`deno task contract:update --tag v0.1.15 --from ~/.config/herdr-app` against the installed Herdr 0.1.15 (herdr-core
0.1.20); `fixtures/generic-home` is now the `v0.1.15` set (commit `9950887361af3ba218b9ce7a347cb8ec7b66c71d`).

| File under `defaults/` | +/− | Relevance to herdr-relay |
|---|---|---|
| `herdr.d.ts` | +4 −2 | doc only: `knownAgents` "Rejects if the check fails; failed checks are not cached" (the bridge keeps only a completed answer, `bridge/herdr/source.ts:559-567`); `terminals()` parent addresses use machine names. The `herdrDts` pin changes |
| `AGENTS.md` | +24 −6 | not a pinned surface |
| `frame/settings/main.js`, `frame/welcome/main.js` | +32 −8, +5 −1 | Herdr's own frame; not shipped mods, not pinned |
| `mods/agents/main.js` | +4 −14 | a viewed done agent no longer stays in Done; path titles; no `herdr` call change |
| `mods/changes/main.js` | +7 −4 | tabs in diff lines drawn as spaces; no exec change (E4 at `:74/77/129`, E5 at `:160–161`) |
| `mods/help/main.js` | +1 −1 | the Esc label is a button: `closeOverlay(props().overlay)` |
| `mods/machine-add/main.js` | +17 −4 | the `Include` glob runs a new `sh -c` literal (E16, refused; the overlay is host-only, so it never runs from a device); a Copy button for `hc machine add …` (`cx.write_to_clipboard`); an Esc button |
| `mods/new-menu/main.js` | +3 −3 | "Could not check installed agents" when `knownAgents()` rejects |
| `mods/pane/main.js` | +20 −2 | reads `layout()` to put the header border on top when the pane's header is at the bottom |
| `mods/picker/main.js` | +19 −10 | the "earlier" row is keyboard-selectable; an Esc button; same `run()` names |
| `mods/spaces/main.js` | +30 −23 | git status replaced by ref-only reads (new E4 shapes, below); "needs a login" guidance with Copy (`cx.write_to_clipboard`); the rail head of such a machine runs `app.settings` `{section: "machines"}` (class `mac-window`, already classified) |
| `mods/tabs/main.js` | +14 −2 | imports `ScrollHandle` from `gpui-base` (new in 0.1.15's `gpui-kit.d.ts`), `track_scroll(handle)`, `scroll_to_item(i)`, `on_size_change`: the mod host must export `ScrollHandle`, else `main.js` fails to load |
| `mods/toast/main.js` | +10 −2 | a "needs login; run hc machine login <m>" toast shows the command with Copy (`cx.write_to_clipboard`) |
| `mods/worktree/main.js` | +10 −8 | keyboard focus while loading; `space.new` passes `machine: ""` for this computer (structural, refused on devices as before); no exec change |

Unchanged: `programs.json` (git blob `a1b17af918880f52589528e9ff68298fbb0859d1` at both tags), `keys.json`,
`keys.macos.json`, layouts, themes, icons, and the other 10 shipped mods, `files` included.

**New call shapes.** Every changed mod was diffed for `exec`, `hc`, `net`, `readTextFile`, `run()`, `shared`/`setShared`
and other `herdr` calls. Only `spaces` changed what it runs (`fixtures/generic-home/mods/spaces/main.js:205-220`),
each with `{cwd, on}`:

| Call | 0.1.14 | Decision |
|---|---|---|
| `git rev-parse --path-format=absolute --show-toplevel` | `git rev-parse --show-toplevel` | E4 as before: `rev-parse` is read-only as a whole |
| `git rev-parse --path-format=absolute --git-common-dir` | unchanged | E4 as before |
| `git symbolic-ref -q HEAD` | new (the branch) | **E4 widened:** `symbolic-ref [-q\|--quiet] <name>`, exactly one name; two names (which set the ref), `-d`/`--delete`, `-m`, `--short`, `--` stay refused (`bridge/policy/exec.ts:438-444`) |
| `git rev-list --left-right --count HEAD...@{upstream}` | new (ahead/behind) | **E4 widened:** `rev-list --left-right --count <range>`, exactly one operand that is not an option (`exec.ts:445-458`); the unpushed form is unchanged |
| `git --no-optional-locks -c core.fsmonitor=false status --porcelain=v2 --branch` | removed | still allowed (E4) |

Both new forms only read refs. They run under E4's existing rules: the `herdr-shipped` profile's `exec.rows` (unchanged),
`cwd` under the read roots, the denied-option check, `on` ≠ null refused, the cleared env with
`GIT_TERMINAL_PROMPT=0` and `GIT_OPTIONAL_LOCKS=0`. `machine-add`'s new `sh -c` literal stays E16 (refused). No new
`hc`, `net`, `readTextFile` or `shared` shape; the new `run()` name is `app.settings` (classified); the new `herdr`/`cx`
uses (`layout()`, `closeOverlay`, `cx.write_to_clipboard`) are existing calls; the new `gpui-base` export is
`ScrollHandle`.

**E14 literal unchanged.** `defaults/mods/files/main.js` is git blob `fc3c7582c31371b675966b41aa69ebde0a07cc92` at
`v0.1.13`, `v0.1.14` and `v0.1.15` (GitHub contents API, fetched 2026-11-11), the same as the installed 0.1.15
`mods/files/main.js` and `fixtures/generic-home/mods/files/main.js`. The listing literal is sha256
`a3163594cfb779a6a5beefd7c0aeb4a6838b8fce63061c24c245bbb6513d4231`; `HERDR_SH_LITERALS` pins it for `0.1.15`.

**`gpui-kit.d.ts`** (same gpui-shell 0.7.1 header): adds `ScrollHandle` (`ScrollHandle.new()`, `scroll_to_item(index)`,
`release()`), and `track_scroll` takes a `VirtualListScrollHandle` or a `ScrollHandle`.

**Commands unchanged.** `fixtures/contract/0.1.15/herdr-app-commands.json` is byte-identical to 0.1.14's: 71 names, 0
unclassified.

**Observed on the installed 0.1.15 home** (2026-11-11, `compatDoctorLines`, read only):

```text
Herdr 0.1.15: tested (herdr-relay was tested with Herdr 0.1.14, 0.1.15)
no drift from Herdr 0.1.15's pinned contract
commands: 71 listed by herdr-app commands, 0 unclassified (refused on devices)
```

No device banner. A 0.1.14 home is compared with 0.1.14's own pins and stays "tested" too.
