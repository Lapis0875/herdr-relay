# herdr-relay — exec / file policy

Split from [DESIGN-v2.md](DESIGN-v2.md) §2 and §8 (U1–U3) by T00 on 2026-11-09; text copied verbatim. Implemented by
**T05** (`packages/bridge/src/policy/**`), command classes by **T04**, tested by **T23**. Until those tasks land, the
copied text below is the specification; evidence legend as in DESIGN-v2 (**[V]** read on this Mac · **[M]** measured by
a spike · **[I]** inference).

Wave 4 (T34 profiles, T35 shipped-mod rows, T12 mirror) changed §2.1, rows E4, E6, E7, E11, E12, E14 of §2.3, §2.6 and
added §2.7; those parts describe the landed code. Evidence with `file:line`: [AMENDMENTS-c1-wave4.md](AMENDMENTS-c1-wave4.md).

The review fixes (independent review of `50f1629`; commits `846f8c6`, `fce82d7`) changed rows E2, E4 and E5 of §2.3
and §2.7, added §2.8 and closed the U1–U3 section (last section). Their `file:line` citations are the working tree at
`bb9d83d`; short paths `policy/X` = `packages/bridge/src/policy/X`, `herdr/X` = `packages/bridge/src/herdr/X`,
`protocol/X` = `packages/protocol/src/X`. Evidence:
[AMENDMENTS-c1-wave4.md](AMENDMENTS-c1-wave4.md#review-fixes-independent-review-of-50f1629). The device auth gate
(including its one cross-site exception) is in [SECURITY.md](SECURITY.md) §2 and row S33, not here.

---

## 2. Exec / file policy (bridge-side, `packages/bridge/src/policy/`)

Deny by default. Every decision is logged `{folder, method, argv, decision}` to `<state>/log/policy.ndjson` (ring, 10 MB).

### 2.1 Read policy (`readTextFile`, `watchFolder`, `svg()/image()` static route)

Roots are **per mod folder**, decided by the folder's policy profile (§2.7), and realpath'ed on first use and again when
the space folders or cockpit's install change:
- `<appHome>/mods/<folder>` and `<appHome>/data/<folder>` — always;
- every `spaces[].folder` from the core `herdr-app` document (refreshed on `doc` events) — unless the profile sets
  `reads.spaces: false`;
- the profile's `reads.appHome` patterns (relative to `<appHome>`) and `reads.extra` paths (`~/…`, `/…`,
  `$cockpit.cache/…`, `$cockpit.home/…`; the last two only while `cockpit.json` names them). Pattern rules: a last
  segment `**` = the folder and everything under it; a last segment with `*` = the matching entries of that folder;
  otherwise exactly that file; `{folder}` = the mod folder's name; no `.`, `..` or empty segments.

The built-in profiles' extra roots are in the §2.7 table; a folder no profile names (`default`) has only the roots above.

**Behaviour change (T34):** before profiles every folder could read all of `<appHome>`, the space folders,
`~/.config/cockpit/config.json` (and the same file under cockpit's `home`), cockpit's `cache` and `~/.cache/lstack-herdr`.
Only `lstack-herdr` keeps those roots. Herdr's shipped mods read their own roots, the spaces, `icons/**`, `my-icons/**`
and `layouts/*.svg`, so `files` and `changes` now refuse a pane folder outside every space folder (for example inside
`<appHome>`) that used to work.

Algorithm (spike `policyRead` **[M]**, kept): lexical check `resolve(appHome, p)` under a root → `realPath` → real path under a **real** root → read ≤ 1 MiB (else refused "over 1 MiB"). Missing file → `null` (Herdr semantics). Never follow a path whose realpath leaves the roots (`appHome/../../x`, symlinks) **[M]**.

Static route `/herdr-relay/assets/*` (icons for `svg("mods/x/icons/y.svg")`, and the sound files of `sound` messages; `svg()`/`image()` paths resolve against `<appHome>`, gpui-kit.d.ts): not per folder (no profile applies); allowlist `mods/**/*.svg|png|jpg|webp` and `mods/**/*.mp3|wav|ogg` (served as `audio/mpeg`, `audio/wav`, `audio/ogg`), `frame/<name>/**` images (svg, png, jpg, jpeg, webp, gif, ico; T35: `workspace-chrome` draws `frame/welcome/herdr.png`), `icons/**`, `my-icons/**`, `layouts/*.svg`, `data/cockpit/show/**` under `<appHome>`; same realpath rule; `Content-Type` by extension only; `Cache-Control: private, max-age=300`. A mod's `playSound(path)` reaches a device only for a file this route serves as audio; any other path is refused and logged (method `playSound`, rule `read`); Herdr's named app sounds (`"done"`, `"blocked"`) are not files and are refused too.

### 2.2 Symlink and realpath rules

- **Load-time audit** (`symlinkAudit`, spike **[M]**): walk the mod folder; any symlink whose realpath is outside the folder's realpath (or dangling) → the folder does **not** start; the block shows "mod folder contains a link outside itself: <relative path>". Re-run on every folder change before restart.
- **Runtime**: Seatbelt denies the read in the kernel even if a link appears after the audit **[M]**.
- **Bridge**: every path argument from a mod (read, `-C`, `cwd`, script path, picture destination) is realpath'ed and checked against the relevant roots **after** a lexical check; never trust the lexical form alone.
- appHome itself may be a symlink (e.g. dotfiles repo): all roots are realpaths; the `--allow-read` flags use realpaths.

### 2.3 Exec allowlist (argument level)

`exec(command, argv, {cwd, on, timeout})` and `hc(argv)` arrive as RPC and are decided under the requesting folder's policy profile (§2.7): `default` refuses every exec and hc; E3, E8, E12, E13 and E16 are refused whatever the profile; E9 (the bridge's `run()` pass-through) has no folder and is not profile-gated; every other row must be in the profile's `exec.rows`, which is checked before the row's arguments and before its named refusals. `on` ≠ null → refused ("remote machines are out of scope"; the desktop path T14 proposes the patch). `cwd` must realpath under the folder's read roots. Timeout: min(mod `timeout`, 60 s); output capped 4 MiB per stream. The allowlist is a data table `packages/bridge/src/policy/exec.table.ts` + tests; the rows below are derived from every `exec`/`hc` call site in Herdr 0.1.14's shipped mods, re-derived for 0.1.15 (`fixtures/generic-home/mods`, now at `v0.1.15`; [COMPATIBILITY.md](COMPATIBILITY.md) §7), and the lstack fork **[V]**. A named refusal is a refusal whose toast (warning) also reaches the device that asked:

| # | Caller(s) [V] | Argv form | Decision | Executed as |
|---|---|---|---|---|
| E1 | `lh-tree-data.js:92/153/213/252`, `lh-transcript.js:80` (both `lstack-herdr-cockpit` and `lstack-herdr/components`) | `node <appHome>/mods/<F>/lh-scan.mjs tree\|detail\|run\|call\|transcript <args…>` | **allow** if the script realpath ∈ **known scripts** (§2.5) and ≤ 3 more args, none starting with `-` | scoped `deno run` profile `lh-scan` |
| E2 | `lh-watch.js:167`, `lstack-herdr/main.js:32` | `node <appHome>/mods/lstack-herdr/sync.mjs [--json]` | **refuse** (rewrites `mods/lstack-herdr-cockpit/**`, `layouts/lstack-herdr.*`, `keys.json` and needs a Herdr restart per its own toast **[V]**) — toast "Run Sync on the Mac"; **U2** decided: refused for every scope ([DECISIONS.md](DECISIONS.md); `policy/user-decisions.ts:19-20`) | scoped `deno run` profile `sync` (only if U2 were allow) |
| E3 | any `node` with a flag (`-e`, `--eval`, `-r`, `--import`, `--loader`…) or an unknown/foreign script | `node -e …` | **refuse** **[M]** | — |
| E4 | `changes/main.js:74/77/129`, `files/main.js:92/96`, `spaces/main.js:206/207/218/219`, `menu/main.js:18–19`, `worktree/main.js:31/33/65/72/73/76/85/90/100/101/142/188/213`, `sidebar.js:128`, `code.js:153` | `git [-C <dir>] [--git-dir <dir>] [--no-optional-locks] [-c core.fsmonitor=false] [-c diff.autoRefreshIndex=false] <RO> …` where `RO` ∈ {`rev-parse` (incl. `--git-dir`, `--git-common-dir`, `--absolute-git-dir`, `--path-format=absolute`, `<rev>:<path>`), `status`, `diff` (inside a work tree; operands relative, without `..`), `log`, `show`, `branch` (listing only; names only as patterns of a listing mode), `ls-files`, `for-each-ref`, `show-ref [--verify] [--quiet\|-q] <ref>`, `symbolic-ref [-q\|--quiet] <name>`, `cat-file -e <object>`, `rev-list -n1 --all --not --remotes [<rev>]`, `rev-list --left-right --count <range>`, `worktree list [--porcelain\|-z\|-v\|--verbose]`, `config (--file <f>\|--blob <rev:path>) [-z\|--null] --get-regexp <name-re> [<value-re>]`, `--version`} (`policy/exec.table.ts:50-65`) | **allow** when the profile enables E4; `-c` only with exactly those two `key=value`s; `-C`, `cwd`, `--git-dir` and `config --file` realpath under the folder's read roots; `--git-dir`, `--file`, `--blob` only by that full spelling and with the profile's `exec.git.gitDirUnderRoots` (built-in: `worktree` only) (`policy/exec.ts:391-408,500-501`). **Refused before `--`:** `-c<k=v>`, `-u…`, `--config-env`, `--exec-path`, `--upload-pack`, `--receive-pack`, `--ext-diff`, `--textconv`, `--output`, `--git-dir`, `--work-tree`, `--namespace`, `--no-index` (also with a suffix such as `=…`), and **every abbreviation of those long options**: a long option whose name up to `=` has at least 3 characters (`--` and one letter) and is a prefix of one of them, because git accepts any unambiguous prefix (`--out=/tmp/x`, `--git-d`, `--no-ind`, `--ext`; `--text`, a git option of its own, is refused too) (`policy/exec.table.ts:248-284`; `policy/exec.ts:417-419`); `rev-parse --git-dir` is exempt by its full spelling only. **`branch`** (`policy/exec.table.ts:321-366`; `policy/exec.ts:422-424,526-556`): every option by its full spelling from the listing lists, so an abbreviated writing option (`--set-up` for `--set-upstream-to`) is refused; a name, before or after `--`, only as a pattern with a listing-mode flag (`--list`, `-l`, `--contains`, `--no-contains`, `--merged`, `--no-merged`, `--points-at`), since otherwise git creates a branch of that name; `--color` and `--abbrev` take a value only as `--opt=value` (an argument after them is a name); `--format`, `--sort`, `--contains`, `--no-contains`, `--merged`, `--no-merged`, `--points-at` take `--opt=value` or the next argument. **`symbolic-ref`** (Herdr 0.1.15 `spaces`): exactly one name, options only `-q`/`--quiet`; a second name (which sets the ref), `-d`/`--delete`, `-m`, `--short` or `--` are refused. **`rev-list`**: exactly `-n1 --all --not --remotes` and at most one revision, or (Herdr 0.1.15 `spaces`) exactly `--left-right --count` and one range; operands never start with `-` (`policy/exec.ts:438-458`; `policy/exec.table.ts:295-307`). **`diff`** (`policy/exec.ts:425-427,558-604`): no operand — a non-option argument before `--` (an option value given as its own argument counts) or any argument after it — may be absolute or have a `..` segment; and unless `--git-dir` is given, `-C` (else `cwd`) must lie in a work tree git finds: a `.git` directory or gitfile in it or above it on the same filesystem, owned (with a gitfile's git directory) by the owner of `$HOME`. Outside one, git switches to `--no-index` by itself and reads any two files; there is no implicit `--no-index`. `diff`/`show`/`log` get `--no-ext-diff --no-textconv`; needs `cwd` or `-C` (except `--version`); **`worktree add\|remove` → named refusal**, toast "Worktree changes — use the Herdr window" | `git` (bridge `--allow-run=git`), cleared env `{HOME, PATH, TMPDIR, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0}` |
| E5 | `changes/main.js:160–161` | `git add -A`, `git commit -m <message>` (cwd = repo root) | **U1** (decided, [DECISIONS.md](DECISIONS.md)): **allow only when `origin.session` is a connected `act`-scope device**; refused otherwise; `commit` must have exactly `-m <msg>` | `git` with `GIT_AUTHOR_*` left to the user's config |
| E6 | `spaces/main.js:127`, `picker/main.js:56`, `machine-add/main.js:98`, `win98/dialog.js:68`, `editor.js:22` | `hc machine ls --json` | **allow** when the profile enables E6 | `hc`, cleared env `{HOME, PATH}` |
| E7 | `spaces/main.js:147` (`machine rm`/`machine add`), `machine-add/main.js:127` (not reached: host-only overlay, §2.7) | `hc ls --json`, `hc terminal list --json`, `hc terminal get <id> --json`, `hc schema`, `hc --version` | **allow** those read-only forms when the profile enables E7; **`hc machine add\|rm …` → named refusal**, toast "Machine changes — use the Herdr window"; every other form (incl. `hc connect`, `kill`, `terminal run`, `doc set`) refused | `hc`, cleared env `{HOME, PATH}` |
| E8 | `code.js:37` | `env HERDR_APP_HOME=… <home>/.local/bin/herdr-app do pane.split <json>` | **refuse** (structural, D3); the mod's fallback `run("pane.split")` is refused too → one toast "needs the Herdr window" | — |
| E9 | bridge `run()` pass-through (not an exec call by mods) | `herdr-app do <name> <json>` | allowed only for names in `commands.json → passthrough` (§2.4) and `act` scope | `herdr-app`, env `HERDR_APP_HOME` |
| E10 | `hub.js:116` via `cockpit()` | `env HOME=<install.home> HERDR_APP_HOME=<appHome> COCKPIT_FRONTEND=app [K=V…] <install.bin> hub start` | **allow** `hub start` only; env keys ∈ {HOME, HERDR_APP_HOME, COCKPIT_FRONTEND} ∪ keys of `cockpit.json`.`env` (the bridge reads `cockpit.json` itself and requires exact value match); `bin` must equal `cockpit.json`.`bin` realpath and be the `cockpit` on `PATH` (bridge `--allow-run=cockpit`); `DYLD_*`/`LD_*`/`NODE_OPTIONS`/`PATH` keys refused **[M]** | `cockpit` |
| E11 | `hub.js:19`, `win98/kit.js:398` | `<this platform's URL opener> <http(s) url>` — `open` on macOS, `xdg-open` on Linux (`packages/bridge/src/platform.ts`) | **intercept** when the profile enables E11 (U3): not executed on the computer; toast `{title:"Open link", body:url, action:{open:url}}` to the connected device that asked; no such device → refused ("no device to open the link on"); the opener with `-a` is E13; any other argument (file path, non-http scheme, more than one) refused | — |
| E12 | `hub.js:20–21`, `files/main.js:22`, `win98/kit.js:398` | another platform's opener — the platform's `foreign` list in `platform.ts`: on macOS `xdg-open`, `cmd`, `cmd.exe`, `powershell`, `powershell.exe`, `pwsh`, `start`; on Linux `open` and the same Windows names | **refuse** ("`<name>` does not exist on `<platform label>`"), whatever the profile | — |
| E13 | `editor.js:38/41/45`, `code.js:208` | `<editor> <folder>`, `code -g <file:line>`, `code --folder-uri …`, `open -a <App> <folder>` | **refuse** ("opens an app on the Mac; not available remotely") | — |
| E14 | `files/main.js:28–30` | `sh -c <L1> files <path>` | **allow** when the profile enables E14 and pins `sha256(L1)` as `listing` (`shLiterals`) and — Herdr's own literal — the running Herdr version ships it (`HERDR_SH_LITERALS`, keyed by version: `0.1.13`, `0.1.14` and `0.1.15` → `a3163594…`); the version is the mirror's `updates().app.version`, else `herdr-app --version` run once at bridge start; unknown or unlisted version → refused (the `files` mod shows the refusal text); `<path>` under the folder's read roots | **native** listing (`packages/bridge/src/policy/listing.ts`): the same `kind\0name\0` stream, ≤ 501 entries, skips `.git`, exit 0 iff a directory — no shell |
| E15 | `show.js:238–244` | `sh -c <L2[remote\|local][macos]> sh <appHome>/data/cockpit/show/<key> <src>` — 4 literal variants pinned by hash **[V]** | **allow** by hash; destination realpath under `<appHome>/data/cockpit/show/`; `src` is `http(s)://` (remote variant) or a file under read roots (local) | scoped `deno run` of **bridge-authored** `packages/bridge/scripts/fetch-picture.ts` (profile `picture`, §2.5), output identical to `sips -g pixelWidth -g pixelHeight` format |
| E16 | any other `sh`, `bash`, `zsh`, `env`, `cat`, `ls`, `curl`, `python`, `osascript`, `sips`… | — | **refuse** **[M]** | — |

Refusals resolve the mod's promise with `{code: 126, stdout:"", stderr:"herdr-relay: <reason>"}` (mods handle non-zero codes; `code.js:37` already catches). Unknown-method RPCs are refused **[M]**.

### 2.4 `run()` command classes (`packages/bridge/src/policy/commands.json`)

| Class | Commands | Handling |
|---|---|---|
| `session` (intercepted, never sent to the Mac) | `layout.select`, `layout.show`, `layout.hide`, `layout.toggle`, `layout.resize`, `agent.focus`, `pane.focus`, `pane.zoom`, `space.select`, `tab.select`, `terminal.peek` | applied to the session's navigator/focus state (DESIGN §3 interception table) |
| `mod` (routed to copies) | names containing a `.` whose prefix is a loaded mod folder (`lstack-herdr-cockpit.show:inbox`, `lstack-herdr-cockpit.queue`, …) and `keys.json` chord targets | `command` to the matching copies' `nextCommand()`; `read` scope refused |
| `structural` (refused, D3) | `tab.new`, `tab.close`, `tab.settle`, `tab.move`, `pane.split`, `pane.close`, `pane.swap`, `space.new`, `space.close`, `space.rename`, `layout.save`, `layout.delete`, `app.quit`, `window.*` | `toast "Structural change — use the Herdr window"` |
| `passthrough` (`herdr-app do`, `act` only) | the remainder of `herdr-app commands` output that is non-structural (`agent.*` interactions, `terminal.*` non-creating, `theme.*`, `notify`, …) | E9 |

The seed for this file is `fixtures/herdr-app-commands.json` = output of `herdr-app commands` captured by **Main** (request M1, §7). Deny-by-default: a name in none of the lists is refused and logged; the test fails if any name in the fixture is unclassified.

### 2.5 Scoped `deno run` profiles for exec'd scripts (`packages/bridge/src/policy/scripts.ts`)

Known scripts are keyed by **path relative to `<appHome>`** (realpath'ed; must be under `mods/<folder>` of a *loaded* folder) — not by hash, because `sync.mjs` rewrites the fork and Herdr updates ship new `lh-scan.mjs`; the **profile** is what is pinned:

| Profile | Script | Flags (all with `--no-prompt --no-config --no-remote --no-npm --no-lock`, `clearEnv`, `DENO_DIR=<run>/deno-dir/scripts`) | Measured |
|---|---|---|---|
| `lh-scan` | `mods/lstack-herdr-cockpit/lh-scan.mjs`, `mods/lstack-herdr/lh-scan.mjs` | `--allow-read=$HOME --deny-read=<same deny list as bridge>,<state> --allow-write=$HOME/.cache/lstack-herdr --allow-env=HOME --allow-sys=homedir --allow-run=/bin/ps`; env `{HOME, NO_COLOR:1}`; argv = `<script> <sub> <≤3 args>`; timeout 30 s | ran unmodified, exit 0, 46–64 ms, wrote its cache; a probe under the same flags could not read the secret **[M]**. `$HOME` not narrower because the script `fs.statSync(cwd)`s arbitrary terminal cwds (`lh-scan.mjs:170` **[V]**) |
| `sync` (U2) | `mods/lstack-herdr/sync.mjs` | `--allow-read=<appHome> --allow-write=<appHome>/mods/lstack-herdr-cockpit,<appHome>/layouts/lstack-herdr.json,<appHome>/layouts/lstack-herdr.svg,<appHome>/keys.json --allow-env=HOME --allow-sys=homedir`; `--check` first; timeout 60 s | not measured; T05 runs `--check` under these flags against a scratch copy of the fixture |
| `picture` | `packages/bridge/scripts/fetch-picture.ts` (bridge-authored, replaces E15 literals) | remote: `--allow-net=<url host>:<port> --allow-write=<appHome>/data/cockpit/show --allow-run=/usr/bin/sips`; local: `--allow-read=<src> --allow-write=<appHome>/data/cockpit/show --allow-run=/usr/bin/sips`; timeout 25 s; max 20 MiB | new |

Unknown scripts → E3 refusal. Node is never used.

### 2.6 Writes

| Writer | May write | Notes |
|---|---|---|
| `herdr.writeTextFile` (mods) | **nothing in v1** — refused with "editing files from a device is out of scope" | only caller is `code.js:131` (save) **[V]**; D2/D3 keep editing out |
| `setShared` from devices | session overlay only (D8) | `shared.json` is never written |
| mod `localStorage`/`sessionStorage` | `storage.set` RPC → `<state>/storage/<folder>.json` (≤ 1 MiB, debounced 1 s) | used by `agentsui.js:329` **[V]**; per folder, like Herdr's per-mod realm |
| `lh-scan` profile | `~/.cache/lstack-herdr/` | via scoped runner |
| `picture` profile | `<appHome>/data/cockpit/show/` | via scoped runner |
| `sync` profile (U2) | fork + layout + keys | refused by default |
| bridge itself | `<state>`, `<run>`, `<appHome>/data/herdr-relay/` (mirror snapshot cache) | `--allow-write` list in §1.2 |
| mirror mod (D5, inside Herdr; T12) | nothing; it reads `<state>/mirror-endpoint.json`, `<state>/token` and `<appHome>/shared.json` and POSTs to the bridge | the bridge writes the discovery file and `<appHome>/data/herdr-relay/mirror.json` |

### 2.7 Policy profiles (T34, `packages/bridge/src/policy/profiles.ts`)

A profile is a data file that opts known mod folders into more than `default`. Contract: `PolicyProfile` in
`packages/protocol/src/profile.ts` and `packages/protocol/schema/policy-profile.schema.json`; a file holds one profile or
a list of them.

| Field | Meaning |
|---|---|
| `id`, `folders` | id (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`, `default` reserved) and the exact mod folder names it governs |
| `priority` | 0–1000; default 0 (built-in) or 10 (user) |
| `requires.herdr` | e.g. `>=0.1.13`; checked once the mirror reports the Herdr version; a mismatch is logged and the profile still applies |
| `reads` | `appHome` patterns, `spaces` (default true), `extra` paths (§2.1) |
| `writes` | documentation only: what the profile's code-defined runners write. The bridge does not read it and it grants nothing; what a runner may write is fixed in code (§2.5, §2.6) |
| `exec.rows` | rows the folder may use: any of E1, E2, E4, E5, E6, E7, E10, E11, E14, E15 |
| `exec.git.gitDirUnderRoots` | E4 `--git-dir`, `config --file`/`--blob` with values under the read roots |
| `scripts` | `mods/<folder>/…` path → runner `lh-scan` (E1) or `sync` (E2) |
| `shLiterals` | sha256 of an `sh -c` literal → `listing` (E14), `picture-remote` / `picture-local` (E15) |
| `net.hubPortFrom` | `cockpit.json`: `net.connect` to 127.0.0.1 at the cockpit hub's port; absent → `net` refused |
| `net.writes` | how each `net.write` on such a connection is decided (§2.8): `act` (the default) or `cockpit-hub` (`protocol/profile.ts:58-67,128-135`; `policy/profiles.ts:77-85`) |
| `overlay` | `device` (default) or `host-only`: `openOverlay`/`mod.open` of the mod on a device toasts "`<mod>` opens only in the Herdr window" and creates no copy |

Rules: rows stay code; a profile only enables rows and names values the rows look up. A script must lie in one of the
profile's folders and its row must be enabled; a literal's row must be enabled; ids are unique. Built-ins live in
`packages/bridge/profiles/*.json` — one that does not validate stops the bridge. User profiles live in
`<state>/profiles/*.json`; a file is used only when it is a regular file (not a link), owned by the owner of
`<state>/profiles`, without group or other permission bits (0600 or stricter), at most 256 KiB and valid — otherwise it
is logged and ignored, and so is a file whose profile id is already taken (a user profile never replaces a built-in by
id; it names the folders with a higher priority). A folder named by several profiles gets the highest `priority`, then
a user profile over a built-in, then the lower id; overlaps are logged at load. A folder no profile names gets
`default`: its own roots (§2.1), no exec, hc or net, overlays on devices.

Built-in profiles:

| Profile | Folders | Extra reads | `exec.rows` and pins | Other |
|---|---|---|---|---|
| `herdr-shipped` | `agents changes confirm files help menu new-menu pane peek picker prompt spaces tabs terminals-bar terminals-pane toast win98 workspace-chrome workspace-status` | `icons/**`, `my-icons/**`, `layouts/*.svg` | E4 E5 E6 E7 E11 E14; listing literal `a3163594…` | `requires.herdr >=0.1.13` |
| `herdr-shipped-worktree` | `worktree` | as `herdr-shipped` | E4 with `gitDirUnderRoots` | `requires.herdr >=0.1.13` |
| `herdr-shipped-machine-add` | `machine-add` | as `herdr-shipped` | E6 E7 | `overlay: host-only`; `requires.herdr >=0.1.13` |
| `cockpit` | `cockpit` | `cockpit.json`, `data/cockpit/**`, `~/.config/cockpit/config.json`, `$cockpit.home/.config/cockpit/config.json`, `$cockpit.cache/**` | E4 E6 E7 E10 E11 E15; 4 picture literals | `net.hubPortFrom: cockpit.json`, `net.writes: cockpit-hub` (`packages/bridge/profiles/cockpit.json:23`) |
| `lstack-herdr` | `lstack-herdr`, `lstack-herdr-cockpit` | all of `<appHome>`, cockpit's two config files and cache, `~/.cache/lstack-herdr/**` (the roots before profiles) | E1 E2 E4 E6 E7 E10 E11 E14 E15; scripts `lh-scan` ×2, `sync`; listing + 4 picture literals | `net.hubPortFrom: cockpit.json`, `net.writes: cockpit-hub` (`packages/bridge/profiles/lstack-herdr.json:39`) |

Reported: the applied id is in `hello.hosts[].profile` and in every policy record made for a folder
(`PolicyLogRecord.profile`, PROTOCOL.md). Not profile-gated: E9 and the static asset route (§2.1).

### 2.8 Cockpit hub requests (`net.writes`; `policy/hub.ts`, `policy/hub.table.ts`)

`net.connect` (§2.7 `net.hubPortFrom`) only opens the TCP connection to the hub. Every `net.write` on it is decided for
the origin of the call — the device session the view manager resolved from the call's origin token (SECURITY.md S19;
a downgraded origin and a call without one name no device) — under the folder's `net.writes`
(`herdr/net.ts:9-16,212-256`; `policy/profiles.ts:77-85`):

- **`act`** (the default when a profile enables net and names no `writes`, `protocol/profile.ts:58-67`): the write is
  sent as written only for a connected device with `act` scope. A `read` device, a downgraded origin and a mod's own
  task (`init`, a timer) send nothing: refused "Writing to the cockpit hub needs a connected device with act scope"; a
  connected `read` device gets the toast "Read-only device" (`herdr/net.ts:235-238`; `policy/hub.ts:74-84`).
- **`cockpit-hub`** (built-ins `cockpit` and `lstack-herdr`): the bridge reads the writes as the hub's
  newline-delimited JSON requests `{op, token, frontend?, …}` and decides each line by its `op` with the table below
  (`policy/hub.ts:111-150`).

Framing (`policy/hub.ts:1-16,173-221`; `herdr/net.ts:18-23,53-80,179-192,258-318`):

- A write is sent only when every complete line in it is admitted, and then only those lines. A trailing partial line
  is held by the bridge, never sent, until the write that completes it; it is decided then.
- A refused line — an unknown op, a line that is not a JSON object with a non-empty string `op`, a line (also a partial
  one) over 1 MiB of UTF-8 (`policy/hub.table.ts:167-168`), or a request the table refuses for this caller — sends
  nothing of that write, rejects the `net.write` with the reason and closes the connection; calls already queued on it
  reject with "the connection is closed", later ones with "no such connection". Decisions stop at the first refused
  line.
- Reads and writes are separate lanes. Writes run one at a time in call order and never wait behind a pending
  `net.read`. Reads are answered in call order from one queue of the connection's bytes in the order they came: the
  bridge's own `open_url` answers and the hub's bytes, which a single `tcp.read` fetches while a read waits (never more
  than one in flight). So an `open_url` answer given while a read waits answers that read at once, and what the
  `tcp.read` in flight then brings is kept for the next read; once the hub ends the stream and the queue is empty,
  every read answers `null`; closing the connection rejects the waiting reads with "the connection is closed"
  (`herdr/net.ts:18-23,53-80,179-192,258-301,325-335`).

The table is taken from the cockpit mod's own client (the lstack fork in `fixtures/private/`); the hub itself is not in
this repository, so a request whose effect the client does not show is never decided as a read
(`policy/hub.table.ts:1-27`). Checked in this order (`policy/hub.ts:115-150`):

| Request | Decision | Source |
|---|---|---|
| `subscribe`, `view`, `search`, `events`, `history` | **allow** for anyone, also with no origin (a copy's subscription loop runs from `init`) | `policy/hub.table.ts:29-41` |
| `fetch` of kind `ci_log`, `failed_tests`, `review_threads`, `pr_files`, `pr_merge`, `ticket_card`, `start_plan` | **allow** for anyone ("details on demand", fetched while a row is shown) | `policy/hub.table.ts:43-62` |
| `fetch` of another kind | as an act (last row) | `policy/hub.ts:130-134` |
| `go` | **refuse** for every origin: "Showing an item in the Herdr window needs the Herdr window", toasted to the connected device that asked (the hub moves every subscriber's focus, the Mac's included) | `policy/hub.table.ts:67-75`; `policy/hub.ts:135` |
| any other op but `act`; `act` without a string `app` and `action` | **refuse** ("unknown hub request `<op>`", "an act request names an app and an action") | `policy/hub.ts:136-140` |
| `act` of the Herdr-window list below | **refuse** for every origin; toast "`<what>` needs the Herdr window" to the connected device that asked | `policy/hub.ts:86-90,141-145`; `policy/hub.table.ts:77-127` |
| `act <app> open_url [<url>]` (any app) | **intercept**: answered by the bridge, never sent (below) | `policy/hub.ts:146,152-171` |
| `act routines <action>` outside the routines list below | **refuse** for every origin: "Running a routine needs the Herdr window" | `policy/hub.ts:147-148`; `policy/hub.table.ts:129-150` |
| any other `act` (e.g. `agents seen`, `inbox merge`, `routines pause`) | **allow** only for a connected `act` device; a connected `read` device is refused with the toast "Read-only device" / "`<app> <action>` needs act scope"; a downgraded origin or none is refused without a toast | `policy/hub.ts:74-84,149` |

Herdr-window list (`policy/hub.table.ts:77-127`) — starting, running or resuming an agent opens a terminal in Herdr,
and focus or pages opened on the Mac are the Herdr window's (D3, U3):

| App | Action: toast `<what>` |
|---|---|
| `agents` | `fork`: "Forking an agent"; `focus`: "Going to an agent" |
| `home` | `resume`: "Resuming agents" |
| `inbox` | `fix_ci`: "Fixing CI with an agent"; `start`: "Starting work with an agent"; `remove_worktree`: "Removing a worktree" |
| `palette` | `fork`: "Forking into a new tab" |
| `runbook` | `focus_session`: "Going to a runbook's session"; `open_pr`: "Opening a PR from a runbook"; `run_step`: "Running a runbook step"; `talk`: "Talking a runbook over with an agent" |
| `routines` | `edit`: "Editing a routine's file"; `open_worktree`: "Opening a routine's worktree"; `cleanup`: "Removing a routine's worktree" |

Routines list (`policy/hub.table.ts:129-150`): `read`, `read_all`, `request_refresh`, `update`, `add`, `stop`, `pause`,
`model`, `looked` — the client's own literal sends — are decided as acts. Every other `routines` action (`run`,
`resume`, the actions the hub's model names) is refused for everyone: running a routine resumes its last agent run.

**`open_url`** (`policy/hub.ts:152-171`; `policy/hub.table.ts:152-165`; `herdr/net.ts:244-254`): with U3 on
(`USER_DECISIONS.openUrlOnDevice`), exactly one http(s) URL argument, a connected device of either scope, and nothing
sent yet on this connection, the device that asked gets the toast `{title:"Open link", body:url, action:{open:url}}`
(as E11) and the connection's reads get `{"note":"opened <url>","pending":{},"refreshing":{}}` before anything the
hub sends; a `net.read` already waiting gets it at once.
Otherwise refused: "opening links from mods is off", "open_url only opens http(s) links, on your device", "no device to
open the link on" (also when the toast cannot be shown), or "open_url after another request on the same hub
connection" (requests carry no id, so the bridge's answer can only come first).

Logged (rule `net`, with the folder's profile): every `net.connect`; on `net.write`, each refusal (`refuse`) and each
answered `open_url` (`intercept`), naming the request only, never the hub token (PROTOCOL.md wave 4 item 5). Admitted
request lines are not logged.

Tests: `packages/bridge/test/security/hub_gate_test.ts` (through `HerdrSource` and a fake loopback hub),
`packages/bridge/test/unit/policy/hub_stream_test.ts` (framing), `packages/bridge/test/unit/herdr/net_duplex_test.ts`
(lanes), `packages/bridge/test/unit/herdr/net_wake_test.ts` (an `open_url` answer wakes a waiting read).

---

## User decisions U1–U3 (decided; superseded)

Formerly "Pending user decisions (DESIGN-v2 §8)". The user decided all three on 2026-11-09; [DECISIONS.md](DECISIONS.md)
rows U1–U3 are the record and supersede the options and recommendations this section listed. The bridge applies them as
`USER_DECISIONS` (`policy/user-decisions.ts:16-23`).

| # | Question | Decision ([DECISIONS.md](DECISIONS.md)) | Applied in |
|---|---|---|---|
| **U1** | `changes` mod commits from a device (`git add -A && git commit -m <msg>`, `changes/main.js:157` **[V]**) | allowed for `act`-scope devices only | E5 |
| **U2** | Regenerating the lstack fork from a device (`sync.mjs`, rewrites `mods/lstack-herdr-cockpit/**`, `layouts/lstack-herdr.*`, `keys.json`; needs a Herdr restart **[V]**) | refused; toast "Run Sync on the Mac" | E2 |
| **U3** | `open <url>` from mods (`hub.js:19` **[V]**) | opens on the device that triggered it (toast with a link), never on the Mac | E11; the cockpit hub's `open_url` (§2.8) |

Risk carried from DESIGN-v2 §9: **R5 `herdr-app commands` classification** (§2.4) needs M1; until then `passthrough` is
empty and every non-session, non-mod command is refused — safe default. M1 is now delivered
(`fixtures/herdr-app-commands.json`, 71 commands, see [EVIDENCE-M1-M3.md](EVIDENCE-M1-M3.md)).
