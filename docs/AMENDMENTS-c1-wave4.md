# Implementation amendments — candidate herdr-relay-c1, wave 4 (T08b, T53, T07b, T05d, T08c, T15c, T41, T36, T12, T34, T35, T06c, T24/T37, T38, T46, T08d, T44, S32, T16, T17, T18, T29, T09s, T43; review fixes; iPad real-device fixes; push end to end)

Main-owned. Where these differ from DESIGN-v2, POLICY.md, PROTOCOL.md and earlier amendments, these and the code win.

Commits: `c603eb5` (T08b), `438be9e` (T53, T07b, T05d, T15c web side), `c75eb7f` (T08c), `c07ef41` (T41), `0e3bb75`
(contract capture), `c756e05` (T36, T12), `a697cdd` (T34, harness), `e3b03aa` (T35, T06c, harness golden mode).
Every `path:line` is at `e3b03aa` (`git show e3b03aa:<path>`), except: the T38, T46, T08d, T44 and S32 sections and
places marked "(working tree)" cite `2e1f01a`; the T16, T17, T18, T29, T09s and T43 sections cite `1b0745c`; the "Review
fixes" section cites the working tree at `bb9d83d`; the "iPad real-device fixes" section cites `8a6778f`; the "Push end
to end" section cites `bab8964`. Short paths: `bridge/X` = `packages/bridge/src/X`,
`protocol/X` = `packages/protocol/src/X`, `web/X` = `packages/web/src/app/X`, `modhost/X` = `packages/modhost/src/X`;
other paths are repo-relative. POLICY.md §2.1, §2.3 (E4, E6, E7, E11, E12, E14), §2.6, §2.7 and §2.8 and PROTOCOL.md
"Contract additions, wave 4" and §4 carry the same facts in spec form.

## Composition root (T53, `bridge/app.ts`)
- `startSessionLayer` wires one bridge run (`bridge/app.ts:59-209`); `bridge/main.ts:100,111-113` passes its `sessions`
  and `routes` to the server. Start order: `<run>` → `CoreClient` → policy profiles → `HerdrSource` → `MirrorEndpoint` →
  `TerminalRelay` + `PushService` → `ViewManager` with the `HostSupervisor` (`bridge/app.ts:73-197`). `stop()` runs the
  teardown list in reverse, once; a failed start unwinds what already started (`bridge/app.ts:62-71,199-208`).
- Routes: mod assets, VAPID key, mirror (`bridge/app.ts:202`). The `bridge/main.ts:10` header listed only the first
  two; fixed in the working tree (`bridge/main.ts:9-12`).
- VAPID `sub`: `https://<MagicDNS name>` while the Tailscale identity is known, else
  `PUSH_SUBJECT_FALLBACK = "https://localhost"` (`bridge/app.ts:40-41,128-132`). Replaced in `bab8964`, because Apple's
  push service refuses a `localhost` subject: a valid `HERDR_RELAY_PUSH_SUBJECT` (`mailto:` at a public domain or an
  `https:` URL of a public host), else `https://<MagicDNS name>`, else `https://github.com/Lapis0875/herdr-relay`
  (`bab8964`: `bridge/push/subject.ts:1-69`; `bridge/app.ts:137-143`; "Push end to end" §1).
- Mod hosts run under Seatbelt unless `HERDR_RELAY_DEV=insecure-no-sandbox` (`bridge/app.ts:186`).
- Device messages the view manager does not take: `term.open`/`term.close`/binary → terminal relay, `visible`/`push.sub`
  → push (`push.test` too since `bab8964`, "Push end to end" §2), anything else
  `ack {ok:false, error:"refused", message:"not available"}` (`bridge/app.ts:142-157`). Toasts a
  mod call raises (E11 links, named refusals) go to the socket of the origin session (`bridge/app.ts:88-90,113,136-141,158-164`).

## `<run>` path (T07b)
- The bridge's own file operations use `<run>` as configured (`$TMPDIR/herdr-relay/<pid>-…`): Deno's permission lists
  are lexical (macOS `/var` → `/private/var`). The real path goes only where the kernel checks it — the Seatbelt profile
  and the host's `DENO_DIR` (`bridge/app.ts:5-8,74-77,103-104`; `bridge/hosts/supervisor.ts:156-161,200-201,350-359,644-650,670-679,688`).
- `deno task start`/`start:dev` add `$TMPDIR/herdr-relay` to `--allow-read` (`deno.json:64-65`).
- Device-visible text is stripped of both spellings (`bridge/app.ts:167-174`; `bridge/hosts/supervisor.ts:323-324`).

## Deno runtime probe (T05d)
- `probeDenoRuntime()` runs `packages/bridge/scripts/deno-runtime.ts` under `resolveAllowedCommand("deno")`, the
  absolute path of the `deno` on `PATH` that the bridge's `--allow-run=deno` resolved — never `Deno.execPath()`, which
  under `deno task` is the Cellar real path. No such `deno` on `PATH` is an error (`bridge/hosts/seatbelt.ts:90-103`;
  `bridge/policy/spawn.ts:37-43`).
- Read grants come from the binary, not from an assumed install layout: first the binary's directory; a run may answer
  `{need:[…]}` (link targets' and Mach-O dylibs' directories, a parent only while a link sits above) and runs again with
  those added, at most 24 rounds; `/` and paths with a comma are refused; the environment is `HOME` only
  (`bridge/hosts/seatbelt.ts:87-88,104-145`; `packages/bridge/scripts/deno-runtime.ts:1-20`).
- Hosts start as `sandbox-exec -f <profile> <runtime.exec> run …`; without Seatbelt as the same resolved `deno`
  (`bridge/hosts/supervisor.ts:668-683`).

## Origin-less `run()` (T08c) — replaces wave 3 "`run()` with no origin may only change the lead session"
- A mod `run(name)` without a device origin (from `init`, `render`, a timer or a task no device started) acts on no
  device; it is logged once per copy and command (`bridge/views/manager.ts:29-31,238-239,928-944`).
- With an origin only that connected session changes; a session that is not open is logged and ignored; a refusal
  toasts that device (`bridge/views/manager.ts:945-952`).
- Reason recorded in the code: `tabs` restoring a space's panel from `localStorage` while rendering closed every phone's
  panel route (`bridge/views/manager.ts:932`).

## Web shell startup (T15c)
- The IndexedDB cache and the access check run in parallel; the cache fills the screen only until the first live
  `hello` (`web/client.ts:86-89,95-117,470-472`).
- A connect waits at most 400 ms for the cache, which names the session to resume (`web/client.ts:36-37,271-273`).
- One access check at a time, shared by its callers; the socket connect inside it is not awaited (`web/client.ts:221-240`).
- Every connect and drop bumps a generation; a superseded connect opens no socket (`web/client.ts:92-93,255,263,273,322`).
- Foregrounding reconnects only from `retry`/`idle`; "reconnect now" does nothing while connecting or live
  (`web/client.ts:109-110,131-132`).
- `graphEpoch`: a graph replaced wholesale (bridge `hello` or cache) is shown as it is, without route animations
  (`web/store.ts:57-61`; `web/client.ts:477-478,523-524`; `web/ui/Navigator.tsx:41-53`).

## Protocol follow-ups (T08b) — closes wave 3 "Follow-ups in progress"
- Control `event.n` is the render the bridge took the handler id from; the host runs no handler and answers
  `event-result {ok:false, stale:true}` when `n` is not the copy's latest render (`protocol/control.ts:212-225,300-304,315-323`;
  `modhost/runtime.js:501-506`).
- Bridge → client `look` (theme/settings/fonts changed after `hello`) and `clipboard` (a mod's `write_to_clipboard`, to
  the origin's device, else the lead's) (`protocol/messages.ts:391-404`; `bridge/views/manager.ts:23-24`).
- Resume: client `hello {session, since}`; the bridge answers `hello {resumed:true, seq:since}` and the kept messages
  after `since` when the same paired device takes back its detached session with the same scope and device class;
  otherwise a fresh session (`protocol/messages.ts:192-203,296-314`; `bridge/views/manager.ts:286-299`).
- Ring: the last `RESUME_RING = 512` messages that change what a device holds (`snapshot`, `patch`, `view.tree`,
  `overlay`, `overlay.close`; never `ack`, `toast`, `look`, `clipboard`); a detached session lives
  `RESUME_GRACE_MS = 120_000` ms; a `since` the ring no longer reaches gets `hello` + `snapshot` + overlays + every
  `view.tree` in the same session (`bridge/views/manager.ts:16-21,88-91,380-404`). The web client sends
  `{since, session}` from what it holds (`web/client.ts:281-282`).

## Rename (T41)
- Bridge names: mount `/herdr-relay` (`bridge/config.ts:8`); `<state>` = `~/.herdr/herdr-relay` (`bridge/config.ts:64-66`);
  `<run>` root `$TMPDIR/herdr-relay` (`bridge/config.ts:103`); `HERDR_RELAY_PORT`, default 7781 (`bridge/config.ts:10-11,104`);
  `HERDR_RELAY_DEV` = unset | `1` | `insecure-no-sandbox`, anything else (the old `insecure-no-seatbelt` too) is a
  `ConfigError` (`bridge/config.ts:22-27,76-81`). `insecure-no-sandbox` also turns pairing and every tailnet request off
  (`bridge/config.ts:39-40,106`; `bridge/server/server.ts:128`).
- Device-side names: cookie `__Secure-herdr-relay-device` (`bridge/auth/cookie.ts:7`), header `x-herdr-relay`
  (`bridge/auth/gate.ts:21`), IndexedDB `herdr-relay` (`web/cache.ts:16`), sessionStorage `herdr-relay.token` and
  localStorage `herdr-relay.device` (`web/env.ts:12-13`), window event `herdr-relay:live` (`web/client.ts:494`;
  `web/boot.tsx:81`).
- No migration of paired devices (`docs/OSS-PLAN.md:179`): the bridge reads only the new `<state>` and the new cookie
  name, so a device paired under the working name is unpaired and pairs again; the old state directory is left unused.

## Fixtures (T36, contract capture)
- `fixtures/generic-home/`: Herdr's shipped defaults at `v0.1.14` (commit `2405bf38…`,
  `fixtures/generic-home/MANIFEST.json:2-3`), unmodified, with `LICENSE` and `NOTICE.md`; synthetic
  `layouts/.state/{main,terminals,win98}.json` (`{"nodes":{}}`) and `settings.json` (`{}`); the captured
  `gpui-kit.d.ts` at the root and in every mod folder (`tools/fixtures/sync.ts:77-95`).
- `tools/fixtures/sync.ts --check` verifies every file against `MANIFEST.json` (`tools/fixtures/sync.ts:30-42`). A
  refresh fetches `defaults/{mods,layouts,themes}/**`, `herdr.d.ts`, `keys(.macos).json`, `programs.json` and `LICENSE`
  at the tag's commit, verifies each git blob SHA-1, and requires exactly the 21 shipped mods and an upstream
  `herdr.d.ts` identical to the contract copy (`tools/fixtures/sync.ts:44-82`). Only `v0.1.14` is accepted
  (`tools/fixtures/sync.ts:7-10`).
- `fixtures/contract/0.1.14/`: `gpui-kit.d.ts`, `herdr.d.ts`, `herdr-app-commands.json`, `installed.json` (`0e3bb75`).
  The working tree adds `fixtures/contract/0.1.14/keys.json`, byte-identical to `fixtures/generic-home/keys.json`; the
  compat check does not read it (`tools/contract/update.ts:35`, working tree).
- `fixtures/private/` (personal `herdr-home/`, recorded `trees/`) is gitignored (`.gitignore:16-17`); tests reach it
  through `privateFixture()`, which skips when it is absent (`packages/bridge/test/helpers/private_fixture.ts:1-12`).
- Also committed: `fixtures/probe-mods/lstack-shape/` (`main.js`, `sync.mjs`, `components/lh-scan.mjs`),
  `fixtures/layouts/lstack-herdr.json` + `.state/`, `fixtures/trees/generic/{main,terminals,win98}/`, and the M1 capture
  `fixtures/herdr-app-commands.json`.
- `mods/*/gpui-kit.d.ts` (written by `herdr-app check`) is gitignored and outside the workspace (`.gitignore:19-20`;
  `deno.json:55`).

## Mirror mod and endpoint (T12)
Mod `mods/herdr-relay-mirror/` (repo root):
- `mod.json` has `"place": "none"`, version `0.1.0` (`mods/herdr-relay-mirror/mod.json:1`). It is placed as one floating
  block per layout and `render` returns an empty `div()`, Herdr's way to hide a block (`mods/herdr-relay-mirror/main.js:1-2,52-60`;
  `RECIPE.md:35-39,64-68`).
- One POST with `Authorization: Bearer <token>` carries `theme`, `settings`, `fonts`, `layout`, `focused`, `panes`,
  `updates`, `window`, `commands`, `keys`, every `shared` key and `relayMod`; a value that throws or is null is left out
  (`mods/herdr-relay-mirror/main.js:4-6,83-98,106-142`).
- Discovery: the port from `<state>/mirror-endpoint.json`, the token from `<state>/token`; either missing → nothing is
  sent. Shared keys come from `<appHome>/shared.json` plus `layout`, because `shared("*")` is null in 0.1.14. The mod
  reads these three files and writes none (`mods/herdr-relay-mirror/main.js:7-10,84-88,144-165`; `RECIPE.md:70-71`).
- Timing: a burst of re-renders becomes one POST 250 ms later, only when the body changed; every 10 s an unchanged body
  older than 5 s is sent again; one POST in flight; a POST unanswered after 5 s is abandoned
  (`mods/herdr-relay-mirror/main.js:11-13,33-38,40-103`).

Endpoint `bridge/mirror.ts`:
- `POST /herdr-relay/mirror` is a `device`-level route answered only over loopback (403 "the mirror endpoint is
  loopback-only" otherwise), so only the loopback token reaches it — 401 without the right token, 403 with an `Origin`
  header; body ≤ 1 MiB (`bridge/mirror.ts:6,58-59,226-228,244-246`; `bridge/auth/gate.ts:77-83`).
- Strict validation against the protocol schemas: `relayMod` (`x.y.z[-pre]`) required; one invalid field rejects the
  whole body with 400 and up to 20 JSON-Pointer errors; unknown keys are ignored; a body equal to the last one only
  refreshes freshness (`bridge/mirror.ts:7-11,66-67,92-110,158-161,207-215,261-269`).
- `GET`/`HEAD`: `{state: "none"|"fresh"|"stale", receivedAt, relayMod, staleAfterMs}` (`bridge/mirror.ts:112-121,197-204,247`).
- Stale after `MIRROR_STALE_MS = 30_000` ms without a POST: the sink keeps `theme`, `settings`, `fonts`, `commands`,
  `keys`, `updates` and drops `focused`, `panes`, `shared`, `window`, which fall back to the core document and
  `shared.json` (`bridge/mirror.ts:13-16,56-57,68-69,271-285,331-346`).
- Discovery file `<state>/mirror-endpoint.json` = `{v:1, port, pid}` (0600), written at start, removed at stop when its
  pid is this run's (`bridge/mirror.ts:21-22,130-135,188-195,230-242,348-359`).
- Cache `<appHome>/data/herdr-relay/mirror.json` (0600, atomic) on each change, read at the next start as `stale`; a
  cache that cannot be written is logged once and skipped (`bridge/mirror.ts:17-20,123-128,287-328`).
- `layout` is validated and cached but not fed to `HerdrSource` (`bridge/mirror.ts:24-25`).
- `HerdrSource.mirror()` keeps each field that validates; mirrored values win over derived ones: `focused`/`panes` for
  the Mac's selection, `shared` instead of `shared.json`, `fonts`, `window`, `updates`, `commands`; `shared.layout` names
  the shown layout (`bridge/herdr/source.ts:276-290,568,609-616,634-648,741-745,766-785`).
- Devices do not see the mirror state: `BridgeHello` has no field for it (`protocol/messages.ts:296-314`); the marker is
  the `GET` above and the bridge log (`bridge/mirror.ts:216,283`).
- Deviations from DESIGN-v2 T12: the mod lives at repo-root `mods/herdr-relay-mirror/` (DESIGN-v2 T12 row and §3.1
  updated); it reads three files (POLICY §2.6 and DESIGN-v2 §2.6 updated); `shared("*")` in the T12 row is not used
  (above). `relayMod` was reported and logged but not compared at `e3b03aa` (`bridge/mirror.ts:197-204,216`); the
  working tree compares it with the bundled copy (T44 section).
- Live checks (invisible block, theme within 1 s) are the user's install step (`RECIPE.md:79-86`).

## Policy profiles (T34) → POLICY.md §2.1, §2.7
- Contract: `protocol/profile.ts:1-15,33-56,77-125` and `packages/protocol/schema/policy-profile.schema.json`; checks the
  schema cannot express (script in one of the profile's folders, its row enabled, literal rows enabled, id `default`
  reserved, unique ids) in `protocol/profile.ts:136-167`.
- Loading and precedence: built-ins `packages/bridge/profiles/*.json` (an invalid one stops the bridge), user files
  `<state>/profiles/*.json` (`bridge/app.ts:94-98`); highest `priority` (default 0 built-in, 10 user), then user over
  built-in, then the lower id; overlaps logged at load (`bridge/policy/profiles.ts:1-15,70-79,101-111,114-149`).
- User files are used only when a regular file (not a link), owned by the owner of `<state>/profiles`, without group or
  other permission bits (0600 or stricter), ≤ 256 KiB and valid; otherwise logged and ignored; a file whose id is
  already taken is ignored (`bridge/policy/profiles.ts:6-10,29-30,129-135,193-235`). The folder's own mode is not
  checked (`bridge/policy/profiles.ts:194-205`); it sits in `<state>` (0700, `bridge/auth/token.ts:13-17`).
- Default deny: a folder no profile names gets `default` — reads its own folder, `data/<folder>` and the spaces; no
  exec, hc or net (`bridge/policy/profiles.ts:34-42,151-154`; `bridge/policy/exec.ts:216`; `bridge/herdr/net.ts:65-67`).
- Per-folder read roots (`bridge/policy/read.ts:68-90`), resolved per folder and again after the space folders or
  cockpit's install change (`bridge/policy/profiles.ts:243-282`), used by `readTextFile`, `watchFolder`
  (`bridge/herdr/source.ts:361-384`) and exec paths (`bridge/policy/exec.ts:214-215,233-235`).
- Behaviour change: before T34 every folder read all of `<appHome>`, the space folders, cockpit's config and cache and
  `~/.cache/lstack-herdr` (`a697cdd^:packages/bridge/src/policy/read.ts:37-53`). Shipped mods under `herdr-shipped` now
  read only their roots (`packages/bridge/profiles/herdr-shipped.json:28-31`), so `files`/`changes` refuse a pane folder
  outside every space folder (e.g. inside `<appHome>`) that used to work. `lstack-herdr` keeps the old roots
  (`packages/bridge/profiles/lstack-herdr.json:6-15`).
- Reported: host status `profile` (`bridge/hosts/supervisor.ts:174-175,484-485,1133-1134`) in every `hello.hosts[]`
  (`bridge/views/manager.ts:408-411`; `protocol/messages.ts:84-94`), and `profile` on every policy record made for a
  folder (`protocol/policy-log.ts:63-79`; `bridge/policy/exec.ts:649-658,709-718`; `bridge/herdr/source.ts:400,454`).
- `requires.herdr` is checked only when the mirror reports the Herdr version; a mismatch is logged and the profile still
  applies (`bridge/herdr/source.ts:284-286`; `bridge/policy/profiles.ts:156-169`).
- Not profile-gated: E9 (`bridge/policy/exec.ts:685-721`) and the static asset route, which resolves against `<appHome>`
  only (`bridge/herdr/source.ts:259-262`; `bridge/policy/read.ts:258-276`).

## Shipped-mod rows (T35) → POLICY.md §2.3
- E4 grammar for the shipped mods (`spaces`, `menu`, `worktree`): `bridge/policy/exec.table.ts:50-62,205-294`;
  `bridge/policy/exec.ts:372-516`. `--git-dir`, `config --file|--blob` need the profile's `exec.git.gitDirUnderRoots`
  (`protocol/profile.ts:105-107`), set only for `worktree` (`packages/bridge/profiles/herdr-shipped.json:38-50`).
- Named refusals `git worktree add|remove` and `hc machine add|rm`: a refusal plan with a toast
  ("Worktree changes — use the Herdr window", "Machine changes — use the Herdr window") shown as a warning on the origin
  device; the mod still gets the code-126 refusal (`bridge/policy/exec.ts:154-171,229-230,332-352,612-616,659-664`;
  `bridge/herdr/source.ts:487-490`; `bridge/policy/decision.ts:36-39`). A folder whose profile does not enable the row
  gets the "not enabled" refusal first, without a toast (`bridge/policy/exec.ts:226-230`).
- E11/E12 through the platform seam: the platform's openers decide the row (`bridge/platform.ts:7-35`;
  `bridge/policy/exec.table.ts:472-473`); at `e3b03aa` macOS was the only platform (`bridge/platform.ts:32-35`); T38
  describes Linux openers too (T38 section). E11 toasts "Open link" with `action.open` to the connected origin device, else refuses
  (`bridge/herdr/source.ts:491-501`).
- E14 keyed by Herdr version: `HERDR_SH_LITERALS` (0.1.14 only) (`bridge/policy/exec.table.ts:165-191`; the working
  tree adds `0.1.13`, the same `files/main.js` blob, without contract pins, `exec.table.ts:165-184`); under a
  profile a Herdr literal runs only while the running version ships it (`bridge/policy/exec.ts:94-99,232,354-370`). The
  version is the mirror's `updates().app.version`, else `herdr-app --version` run once at start (working tree:
  `bridge/herdr/version.ts:37-50,95-113`; `bridge/herdr/source.ts:536-540`). Unknown or unlisted → refused; `files`
  shows the refusal text (`fixtures/generic-home/mods/files/main.js:35`).
- `overlay: "host-only"`: `openOverlay`/`mod.open` of that mod on a device toasts "<mod> opens only in the Herdr window"
  and creates no copy (`bridge/views/overlays.ts:8-10,50-61`; `bridge/views/data.ts:108-109`;
  `bridge/views/manager.ts:802-803,962-965`; `bridge/herdr/source.ts:531-534`); built-in for `machine-add`
  (`packages/bridge/profiles/herdr-shipped.json:51-63`).
- Prototype-safe tables in `policy/`: lookups keyed by a mod's strings are `Set`s/`Map`s or use `Object.hasOwn`, so
  `constructor`, `__proto__`, `toString` match nothing (`bridge/policy/exec.table.ts:1-8,188-191,210-310,328-335,464`;
  `bridge/policy/scripts.ts:39-44`; `bridge/policy/read.ts:64,226-236`; `bridge/policy/exec.ts:199,324,537-539`).

## `cx.bind_keys` (T06c, `modhost/keymap.js`, `modhost/runtime.js`)
- `cx.bind_keys(list)` validates the whole list first (keystroke, non-empty action, optional context predicate),
  installs it and returns the count; it throws during any render (`modhost/runtime.js:356-363`;
  `modhost/keymap.js:253-273`). Binding the identical entry again replaces the earlier one (`modhost/keymap.js:283-294`).
- Keymap per host folder: one keymap per mod host, shared by that folder's copies; Herdr's is app-wide
  (`modhost/runtime.js:43-47`).
- Dispatch order (GPUI rules): a device `key` event sent to an `on_key_down` handler is matched, with the copy's held
  chord prefix, against the keymap in the context stack of the elements from the root to that handler's element;
  deepest context, then the latest binding wins; a chord prefix is held up to 1 s (`PENDING_INPUT_MS`) and then
  replayed; a completed binding's action goes to `on_action` listeners from the innermost element outwards, and a
  listener stops it unless it calls `cx.propagate()`; the `on_key_down` handler runs only when no action listener
  stopped the press (`modhost/keymap.js:1-8,296-345`; `modhost/runtime.js:494-511,564-645`).
- An unparsable `key_context` is reported once per value (at most 64) as `error {where:"key_context"}` and left unset
  (`modhost/runtime.js:795,800-814`).
- Known gaps: (1) keys reach the keymap only through an `on_key_down` handler, so an element with `on_action` but no
  `on_key_down` on its path gets no keys and contexts below the handler's element are not seen
  (`modhost/runtime.js:564-582`); (2) a `key` event sent straight to an `on_action` handler runs that action without the
  keymap (`bridge/views/handlers.ts:111-112`); (3) a held chord prefix is cleared only by the next stroke, its timeout or
  the copy closing, not by a focus change (`modhost/runtime.js:296-298,606-625`); (4) `window.dispatch_action` is still
  an unknown API (`modhost/shims/gpui-kit.js:134-141`).

## Coverage harness (T24/T37, `packages/bridge/test/views/generic/render_test.ts`)
- Renders every block of `main`, `terminals` and `win98` from `fixtures/generic-home` under Seatbelt, the overlay mods
  (`main`) and win98's overlays, and pane headers (`render_test.ts:12-23,117-145,197-229,267-274`); asserts every copy
  rendered, no host or conversion diagnostic and no error node (`render_test.ts:209-234`); exec/hc shapes must be in
  the documented OSS-PLAN §2.1 list and are recorded as `calls.json` (`render_test.ts:25-72,168-173,243-249`).
- Golden mode: by default each tree and `calls.json` is compared with `fixtures/trees/generic/<layout>/` (private:
  `fixtures/private/trees/`); files are written only when `HERDR_RELAY_UPDATE_TREES=1` is granted, i.e.
  `deno task test:views:update`; a missing golden fails naming that task (`render_test.ts:100-115,235-249`;
  `deno.json:59,67`). The win98 taskbar clock tooltip is normalised (`render_test.ts:81-98,240`).
- Private lstack run: skips `lstack-herdr-cockpit` copies (no fixture hub) and the shape check
  (`render_test.ts:130-134,171,276`).
- Committed goldens: `main` 19 trees, `terminals` 2, `win98` 8, each plus `calls.json` (`fixtures/trees/generic/`).

## Platform seam (T38, `2e1f01a`)
- `bridge/platform.ts` is the one place OS differences live: `Platform` = `os`, `label`, `openers`, `tailscaleBin`,
  `denyReadUnderHome`, `peerCheck`, `sandbox`, `trueBin`, `tmpDir` (`bridge/platform.ts:30-49`). `resolvePlatform()` reads the
  machine through a `PlatformHost` (permission queries first, so it never prompts; tests pass a fake);
  `hostPlatform()` resolves it once (`bridge/platform.ts:51-77,149-161`).
- macOS: openers `open` (E11) and `xdg-open`, `cmd`, `cmd.exe`, `powershell`, `powershell.exe`, `pwsh`, `start` (E12);
  deny-read `.ssh`, `.gnupg`, `.aws`, `.config/gh`, `Library/Keychains`, `Library/Cookies`; peer check `netstat-lsof`;
  sandbox Seatbelt; `/usr/bin/true`; `TMPDIR` default `/tmp` (`bridge/platform.ts:110-126`). Linux is described —
  `xdg-open` is E11 and `open` E12; deny-read adds `.local/share/keyrings`, `.mozilla`, `.config/google-chrome`,
  `.password-store`, `.docker/config.json`; peer check `proc-net-tcp` (reads `/proc/net/tcp{,6}`, spawns nothing,
  `bridge/auth/peer.ts:17-20`) — but has no sandbox provider until T39 (`bridge/platform.ts:128-147`). Any other OS
  (Windows) is a `ConfigError` "… is not supported yet" (`bridge/platform.ts:149-154`).
- `Sandbox` interface (`bridge/hosts/sandbox.ts:1-49`): `{id, label, unavailable, available(), prepare(run)}`;
  `prepare` returns a `SandboxRun {subdir, command(launch)}` for one bridge run. Seatbelt is the one provider
  (`seatbeltSandbox(trueBin)`, `bridge/hosts/seatbelt.ts:182-226`). The supervisor takes `sandbox: Sandbox | null`
  (`null` = unconfined), defaults to the platform's and throws where the platform has none, and removes the provider's
  `<run>/<subdir>` at stop (`bridge/hosts/supervisor.ts:255-261,356-358,449`); the session layer passes `null` only in
  `insecure-no-sandbox` (`bridge/app.ts:191`).
- `loadConfig(platform, env)`: `TMPDIR` defaults to the platform's; a platform without a sandbox provider is a
  `ConfigError` unless `HERDR_RELAY_DEV=insecure-no-sandbox`; the platform is `cfg.platform`
  (`bridge/config.ts:90-123`).
- Exit codes: `EXIT_CONFIG = 2` (bad configuration, Windows, Linux without `insecure-no-sandbox`), `EXIT_NO_SANDBOX = 3`
  (was `EXIT_NO_SEATBELT`) when the provider is not available here (`bridge/main.ts:5-12,42-44,75-91`).
- Tailscale CLI (G7): `HERDR_RELAY_TAILSCALE_BIN` (must be absolute, else `ConfigError`), else on macOS
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, then the same under `~/Applications`, else `tailscale` in
  each `PATH` directory, else the bare name `tailscale`. A candidate counts when it is a file, or — where the bridge
  may not read it — when its `--allow-run` names exactly that path (`bridge/platform.ts:79-108`). The variable is read
  only when the bridge's `--allow-env` lists it (`bridge/platform.ts:66-67`); `deno task start`/`start:dev` list it
  (`deno.json:64-65`). Used by the tailnet identity refresh and `serve` (`bridge/main.ts:113`;
  `bridge/auth/tailscale.ts:17,142`); `config.ts` no longer exports `TAILSCALE_BIN`.
- Also from the platform: the peer-check strategy (`bridge/main.ts:99`), the scoped runners' deny-read list
  (`bridge/policy/scripts.ts:47-53`), and E11/E12 openers in the exec policy (`bridge/herdr/source.ts:537`;
  `bridge/app.ts:108`).
- Deno probe (G8): it also grants the real directory of the bridge's own `deno` when the bridge may read it (e.g.
  `~/.deno/bin`); a Homebrew `deno` is outside the bridge's `--allow-read`, so the probe starts from the spawned
  binary's directory alone (`bridge/hosts/seatbelt.ts:94-109,129-130`).

## Version and drift detection (T46, `2e1f01a`) → PROTOCOL.md wave 4 item 7
- At start `HerdrVersion.start()` runs the bridge's own read-only `herdr-app --version` and `herdr-app commands`
  (cleared environment `HOME`, `PATH`, `HERDR_APP_HOME`, 5 s each; no policy row), then reads the app home's contract
  surfaces: sha256 of `herdr.d.ts`, the newest `gpui-kit.d.ts` among the shipped mods' folders, `installed.json`, and
  the command names (`bridge/herdr/version.ts:1-8,25-71,95-108`; `bridge/compat/check.ts:1-14,84-99`). It replaces the
  version probe that was in `bridge/herdr/source.ts` and `bridge/policy/exec.ts` at `e3b03aa`.
- The current version is the mirror's `updates().app.version`, else the probe's; it feeds the E14 pins and the compat
  report and is logged, with the compat lines, whenever it changes (`bridge/herdr/version.ts:110-125`;
  `bridge/herdr/source.ts:297,536-540`).
- Report: compared with the pins of that version when pinned (`tested`), else of the newest pinned version. Drift per
  surface: `herdr.d.ts`, `gpui-kit.d.ts`, `installed.json` (shipped files changed, new or gone, or not the expected
  shape), `commands` (new or gone against the pin; names `policy/commands.json` does not classify, which devices are
  refused) (`bridge/compat/check.ts:101-154`). A surface that cannot be read is a doctor note, not drift
  (`bridge/compat/check.ts:12-13`).
- Banner: the version is unknown, older than `SUPPORTED_FROM = "0.1.13"`, newer than the newest pinned version, or
  otherwise untested; then the drifted surfaces (`bridge/compat/check.ts:281-305`; `bridge/compat/pins.ts:29-33`).
- `hello.compat` is sent only in the WebSocket `hello` (`bridge/views/manager.ts:444-445`; `bridge/views/data.ts:114-115`;
  `bridge/herdr/source.ts:548-551`; `protocol/messages.ts:101-123,321-340`); `GET api/hello` does not carry it
  (`bridge/server/server.ts:96-110`). The client shows the banner once live, with the drift details, until dismissed
  (`1b0745c`: `packages/web/src/app/ui/Status.tsx:83,104-124`; the banner landed in `d51caf8`).
- Pins: `bridge/compat/pins.json`, generated and never edited by hand, shipped with the bridge because fixtures are not
  in a release: per version `herdrDts`, `gpuiKitDts`, `installed`, `commands` (`bridge/compat/pins.ts:1-27`).
- `deno task contract:update --tag v<ver> [--from <appHome>] [--no-sync] [--check]` (`deno.json:68`;
  `tools/contract/update.ts:1-17`): captures `fixtures/contract/<ver>/` from an installed Herdr of that version, runs
  the fixture sync, re-hashes the contract into `pins.json` (`--check` only compares), and checks that every listed
  command has a class, that Herdr's E14 literal is pinned in `HERDR_SH_LITERALS` and `herdr-shipped`, and that the
  bundled `herdr/commands.json` matches the newest capture; exit 1 on any problem.
- `compatDoctorLines()` gives `herdr-relay doctor` its Herdr lines (`bridge/compat/doctor.ts:1-14`;
  `packages/bridge/bin/doctor.ts:167-173`).

## Origin tokens (T08d, `2e1f01a`) → PROTOCOL.md wave 4 items 5 and 8, SECURITY.md S19 and §4
- Hosts never see a raw session id. Each delivery of a device `event` or `command` to a host carries a fresh origin
  token `o-<uuid>` as `origin.session`, bound to the device session, the mod folder and the host generation it was
  delivered to, valid `ORIGIN_TTL_MS = 30_000` ms; a delivery that fails revokes its token
  (`bridge/views/origins.ts:1-8,17-18,41-57`; `bridge/views/manager.ts:11-16,490-494,521-523,601-604`;
  `protocol/control.ts:6-10,147-151`).
- `#resolve` maps the token on every `emit`/`rpc`: valid for this folder's current host and its session still open →
  that device's session and scope. Otherwise — unknown (forged, a raw session id), expired, another folder's, an
  earlier host generation's, or its session ended — the origin is downgraded to `{scope: "read", connected: false}`
  (session = the presented token), logged `origin downgraded: <copy> <t> <method> (<why>); counted as read from no
  device` once per token, and recorded with policy rule `origin` (`bridge/views/origins.ts:59-67`;
  `bridge/views/manager.ts:97-98,127-128,606-636,871,955`; `bridge/views/data.ts:13-16,37-45`;
  `protocol/policy-log.ts:41-42,58`). The session layer passes its policy log to the view manager
  (`bridge/app.ts:182`). Expired grants are kept one more lifetime so a late use is reported as "expired token"
  (`bridge/views/origins.ts:44-48`).
- What a downgraded origin gets: exec/hc decided as `read` (`bridge/herdr/source.ts:494-495`), so E2/E5 are refused;
  no named-refusal toast and no E11 link (`bridge/herdr/source.ts:497-511`); `run()` ignored as "for session …, which
  is not open" (`bridge/views/manager.ts:999-1000`); overlays and notifications reach no device
  (`bridge/views/manager.ts:638-643`).
- Behaviour change: a handler, timer or task still running more than 30 s after its event or command loses its device
  (read from no device). Residual (accepted): within one folder, a mod can replay for the rest of the 30 s a token
  that folder legitimately received from an `act` device; never across folders, host restarts or after 30 s
  (`bridge/views/origins.ts:10-12`; SECURITY.md §4).
- `ExecRequest.session`/`scope` comments describe the resolved token (`bridge/policy/exec.ts:148-154`). Test:
  `packages/bridge/test/security/origin_test.ts:11-168` (raw act ids, cross-folder replay, expired replay).

## Launcher and upgrade path (T44, `2e1f01a`)
Short path `bin/X` = `packages/bridge/bin/X`.
- Shim `bin/herdr-relay` (`/bin/sh`): what `deno task herdr-relay`, `~/.local/bin/herdr-relay` (a link to it) and launchd
  run (`deno.json:66`). It follows links to find the repository, then checks that every module `deno.lock` pins for the
  launcher and the bridge is cached (`deno install --entrypoint --cached-only --frozen`) and, if not, fetches them once
  with `deno install --frozen` (the lock is never rewritten). Then it runs `bin/herdr-relay.ts` with the launcher's own
  permissions: read `$HOME`, the repository, the app home and the Tailscale app binary (minus the credential deny
  list); write `<state>`, `<appHome>/mods`, `<appHome>/data/herdr-relay`; net `127.0.0.1`; run `deno`, `herdr-app`,
  `sandbox-exec`, `/usr/bin/sw_vers` and the Tailscale CLI candidates (`bin/herdr-relay:1-14,17-55`).
- Commands (`bin/herdr-relay.ts:1-17,34-61`): `start [--print-flags]`, `install-mod [--app-home DIR]`, `doctor`, and
  the existing `pair`, `devices`, `revoke`, `serve`. Exit 0 success, 1 failure or refusal, 2 usage or configuration;
  `start` exits with the bridge's code.
- `start` computes the bridge's `deno run` flags for this machine and runs `deno` in the repository root
  (`bin/start.ts:1-24,70-107,124-148`); `--print-flags` prints the line instead. On macOS with `TMPDIR` set,
  `HERDR_APP_HOME` and `HERDR_RELAY_TAILSCALE_BIN` unset and Tailscale in `/Applications` it is byte-identical to
  `deno task start` (only `argv[0]` differs). Computed: the Tailscale CLI in `--allow-run` (T38 resolution), the
  sandbox and peer-check programs of the platform, its deny-read list, `<appHome>/data/herdr-relay` of
  `HERDR_APP_HOME` in `--allow-write` (an app home outside `$HOME` and the temporary roots added to `--allow-read`),
  the platform's `/tmp` for an unset `TMPDIR`; a path with a comma is a `ConfigError`. The launcher passes SIGTERM on
  to the bridge, and SIGINT when it has no terminal (`bin/host.ts:58-80`).
- `<state>/environment.json` v1 = `{v, recordedAt, os, arch, osVersion, deno: {path, version}}` (`sw_vers` on macOS,
  else the kernel release). `start` compares it with this machine, prints what changed and the Seatbelt derivation
  command, then rewrites it (0600); a file with a higher `v` is left alone with a message; an invalid one is replaced.
  Failures never stop the start (`bin/environment.ts:1-33,46-145`).
- `devices.json` `v`: a file with a higher `v` than `DEVICES_VERSION = 1` was written by a newer herdr-relay and is
  refused with that message and never rewritten; the bridge then counts no device as paired
  (`bridge/auth/devices.ts:8-10,17-18,218-236`).
- Mirror handshake: the bridge ships `BUNDLED_RELAY_MOD` = `mods/herdr-relay-mirror/mod.json` `version` (a static
  import). A changed snapshot whose `relayMod` is older is logged and toasted (warning) to every connected device,
  once per distinct version; the status and the POST answer carry `bundledMod` and `outdated`
  (`bridge/mirror.ts:23-26,74-78,128-136,226-240,252,294-295`; `bridge/app.ts:124-126`).
- `install-mod [--app-home DIR]` copies the repository's `mods/herdr-relay-mirror/` into `<appHome>/mods/` (app home:
  the flag, else `HERDR_APP_HOME`, else `~/.config/herdr-app`). Absent → installed; older → replaced; same version and
  files → nothing; refused: a newer installed version, the same version with different files, an unreadable version,
  a link or a file in its place. Staged under `<appHome>/data/herdr-relay/` and renamed into place. It never edits
  layouts: it prints the `floating` entry to add and `herdr-app check` (`bin/install-mod.ts:1-15,88-170`;
  `bin/herdr-relay.ts:131-143`).
- `doctor` (read-only, exit 1 when any check fails): deno ≥ 2.9.0, platform against `environment.json`, sandbox,
  access mode (Tailscale only, O3), Tailscale login and `tailscale serve` of the mount (Funnel on = FAIL), Herdr
  compatibility, lock cache (`deno install --cached-only --frozen`), paired devices, installed mirror mod against the
  bundled version, and the running bridge's mirror status (`bin/doctor.ts:1-12,41-57,76-232`).
- launchd: `tools/launchd/io.github.lapis0875.herdr-relay.plist` is a template (`__REPO__`, `__HOME__`): `/bin/sh
  <repo>/packages/bridge/bin/herdr-relay start` in the repository, its own `PATH`, `RunAtLoad`, `KeepAlive` on a
  non-zero exit, `ThrottleInterval` 30 s, stdout and stderr to `~/Library/Logs/herdr-relay.log`
  (`tools/launchd/io.github.lapis0875.herdr-relay.plist:1-43`). Operations: `docs/DEVICES.md` "Operations",
  `docs/INSTALL.md`.

## Bridge self-test (S32, `2e1f01a`)
- `deno … packages/bridge/src/main.ts --self-test` loads only the configuration (exit 2 when invalid), then runs 9 probes
  under the process's own flags and prints one JSON line each, `{probe, blocked, error}`; exit 0 only when all are
  blocked (`bridge/main.ts:17-19,68-72,166`; `bridge/selftest.ts:1-15,100-112`).
- Probes, in order: read `/etc/hosts`; read under `~/.ssh`; write into the app home; spawn `ls`, `/bin/sh`,
  `/usr/bin/curl`; connect `1.1.1.1:80`; listen `0.0.0.0`; import a module from an `https://…invalid` host
  (`bridge/selftest.ts:47-83`). Blocked = a `NotCapable`/`PermissionDenied` error, or for the import a refusal naming
  `--allow-import` or `--cached-only`. Probes that would have an effect are skipped (and count as not blocked) when
  their permission is granted (`bridge/selftest.ts:85-98`).
- Amendment to S32: an unlisted binary is `/usr/bin/curl`, not `/usr/bin/git`, because `--allow-run=git` may itself
  resolve to `/usr/bin/git` (`bridge/selftest.ts:63-65`; DESIGN-v2 and SECURITY S32 rows updated).
- The macOS security test reads `deno task start`'s line from `deno.json`, expands `$HOME`/`$TMPDIR`, appends
  `--self-test` and asserts the 9 probes in order, all blocked, exit 0
  (`packages/bridge/test/security/bridge_flags_test.ts:4-58`), so it runs the production flags including
  `--allow-import=jsr.io:443`.

## Element-tree renderer (T16, `1b0745c`) — `packages/web/src/render/`
Short path `render/X` = `packages/web/src/render/X`.
- `render/mod.tsx` installs `ViewRenderer` as the shell's view renderer before boot (`render/mod.tsx:1-9`;
  `packages/web/src/main.tsx:7`); a view slot shows `ViewPlaceholder` until its first `view.tree`
  (`render/view.tsx:91-97`; `web/slots.tsx:1-11`). A render failure is caught per view and shown in its frame; the
  next tree retries (`render/view.tsx:24-45`).
- Nodes by kind (`el`, `text`, `svg`, `image`, `path`, `terminal`, `view`, `error`), memoised by identity; an unknown
  kind or an asset path outside the app home draws an error block, nothing throws (`render/node.tsx:1-6,202-220`).
  Asset paths become URLs of the bridge's `assets/` route (`render/node.tsx:30-39`).
- Propagation: one DOM event reaches only the innermost element listening for it, per kind — GPUI lets an inner
  handler stop propagation and a device cannot learn whether it did (`render/events.ts:210-224`;
  `render/interact.ts:1-13`).
- Nothing is sent while the data is stale; key events only from an `act` device (`render/view.tsx:94-96`;
  `render/interact.ts:12`).
- `anim.spring` becomes a CSS transition: the spring's response (default 350 ms) with `cubic-bezier(0.2, 0, 0, 1)`, or
  `cubic-bezier(0.34, 1.4, 0.64, 1)` (overshoot) when damping < 1; an explicit transition on the same property wins
  (`render/style.ts:160-163,215-220`).
- `svg(path)` icons are drawn as a CSS mask over the text colour, as GPUI tints them (`render/node.tsx:116-123`;
  `render/render.css:74-83`).
- Widgets: T17 installs one renderer per widget type (`provideWidgetRenderer`, T17 section); a `scrollbar` draws
  nothing (the browser's own), a type without a renderer (a newer bridge) a labelled placeholder
  (`render/widgets.tsx:1-6`). `k:"path"` is painted as SVG path data (`render/path.tsx:1-6`).

## Widgets (T17, `1b0745c`) — `packages/web/src/widgets/`
Short path `widgets/X` = `packages/web/src/widgets/X`.
- `widgets/mod.ts` installs the terminal renderer and one renderer per widget type before boot: `input`/`textarea`
  (`TextInput`), `editor` (read-only `Code`), `markdown`/`html` (`TextView`), `vlist`, `hovercard`, `resizable`
  (`widgets/mod.ts:1-25`; `packages/web/src/main.tsx:8`).
- Terminal: every view follows its terminal in observe mode (`term.open {mode:"observe"}`, the Mac's size, D4); on an
  `act` device the first keystroke upgrades the stream with `term.open {mode:"type"}` and, once acked, the bytes go out
  as binary frames; bytes typed during the upgrade wait for it; nothing is replayed after a reconnect
  (`widgets/terminal/stream.ts:1-13,170,191`; `widgets/terminal/TerminalWidget.tsx:12-32`). Typing is explicit: input
  stays off until a key is pressed in the focused terminal (fine pointers) or the keyboard button is on (touch)
  (`widgets/terminal/TerminalView.tsx:1-10`).
- xterm is loaded lazily, on mount: it needs a DOM, and server rendering and tests import the widgets without one
  (`widgets/terminal/TerminalView.tsx:149-154`).
- Markdown and HTML are sanitised: marked (GFM) then DOMPurify; no scripts, styles, forms, controls, embeds or media
  (markdown images become links, HTML images are dropped); links only `http(s):`/`mailto:`, opened on the device or
  reported to the mod's `on_link_click`; no `id`/`style`, `class` only for highlight.js tokens
  (`widgets/text/sanitize.ts:1-13,34,90-97`; `widgets/text/TextView.tsx:1-5`).
- Dev story page: a separate bundle (`deno task --cwd packages/web bundle:dev` → `dist/dev/`,
  `packages/web/deno.json:4`), served at `dev/widgets` only while `HERDR_RELAY_DEV` is `1` or `insecure-no-sandbox`;
  otherwise every `dev/` path is 404 (`bridge/server/shell.ts:8-9,16-25,52-57`). The release tarball leaves
  `dist/dev/` out (`tools/release/build.ts:74-75`).

## Phone and tablet polish (T18, `1b0745c`)
- Touch targets: on a coarse pointer an icon-only press target (`role="button"` without text) gets an invisible
  44×44 px hit area centred on it, above its neighbours; larger targets are unchanged; text buttons and rows keep the
  mod's own size so dense lists keep their taps (`packages/web/src/render/render.css:46-59`). The shell's own targets
  use `--hit: 44px` (`packages/web/src/app/app.css:3,31`).
- Fonts pipeline: `packages/web/public/fonts/fonts.manifest.json` + committed `OFL.txt` files; `deno task --cwd
  packages/web fonts` fetches and verifies them, `deno task bundle` generates the `@font-face` rules into
  `dist/app.css` and fails naming the task when a font is missing (`packages/web/deno.json:6`;
  `packages/web/tools/assets.ts:1-13,182-205`). Stacks: `packages/web/src/app/theme.ts:15-17`. DESIGN-v2 §3.1–§3.3 and
  the T18 row now name these paths (they named `packages/web/fonts.manifest.json` and `tools/fonts/fetch.ts`).
- `blankState()` is the store's initial state for boot and for renderers outside the app (tests, server rendering)
  (`packages/web/src/app/store.ts:79-101`).

## Renderer snapshot and a11y tests (T29, `1b0745c`)
- Every tree under `fixtures/trees/generic/**` is rendered with `renderToStaticMarkup` and compared with
  `packages/web/test/__snapshots__/<layout>/<copy>.json.html`; `deno task test:web:update` rewrites the snapshots
  (`HERDR_RELAY_UPDATE_TREES=1`) (`packages/web/test/render_test.tsx:7-41`; `deno.json:71`).
- Amended a11y rule (DESIGN-v2 T29 row): on the phone class every icon-only element with a `click` handler has a
  ≥ 44×44 px effective hit area — the test asserts the T18 `pointer: coarse` rule and fails on an icon-only target
  with an explicit size under 44 px that the rule does not expand; text controls and rows keep the mod's size and are
  only counted and printed (`packages/web/test/render_test.tsx:43-111`).
- Also: unknown kinds draw the red placeholder, error nodes show their reason, widget and terminal nodes render or
  show a labelled placeholder, and the font manifest declares the four OFL-1.1 families with matching licence digests
  (`packages/web/test/render_test.tsx:113-162`).

## Mod sounds (T09s, `1b0745c`) → PROTOCOL.md wave 4 item 9, POLICY.md §2.1
- `playSound(path)` is a view-manager emit: it plays only on the device whose event or command led to the call; no
  origin (init, render, timer) or a downgraded one → no device, logged once per folder
  (`bridge/views/manager.ts:23-28,254,974-975,1063-1084`).
- `HerdrSource.sound` checks it: at most `SOUND_RATE_PER_S = 4` per second per device session (the rest dropped,
  logged once per burst), and only a file the asset route serves as audio (`mods/**/*.mp3|wav|ogg`, same realpath
  rules); anything else — including Herdr's named sounds `"done"`/`"blocked"` — is refused and logged (method
  `playSound`, rule `read`). The answer is the mount-relative `assets/mods/…` URL
  (`bridge/herdr/source.ts:21-23,120,209,436-483`; `bridge/views/data.ts:5-9,117-122`). Until this commit `playSound`
  was "not supported remotely"; that list now has 12 names (`bridge/herdr/source.ts:25-29`).
- Asset route: `mods/**` also serves `.mp3` (`audio/mpeg`), `.wav` (`audio/wav`), `.ogg` (`audio/ogg`)
  (`bridge/policy/read.ts:224,237-242,244-263`; the `bridge/static.ts` header lists them too, a comment edit made
  after `1b0745c`).
- Protocol: bridge message `sound {t: "sound", src}`, `src` matching `SOUND_SRC_PATTERN`; never kept for a resume
  (`protocol/messages.ts:13-15,433-444,492`; samples `packages/protocol/samples/bridge/sound.json`,
  `invalid/bridge/sound.outside-mods.json`).
- Client: plays a sound only while the page is visible, never queues, drops what the browser refuses; the first press
  or key unlocks a pool of 4 audio elements (iOS); a per-device mute switch in the device panel, kept in
  `localStorage` `herdr-relay.sound.muted` (`web/sound.ts:1-86`; `web/client.ts:455-458`; `web/boot.tsx:65`;
  `web/ui/DevicePanel.tsx:195-216`).

## CI and release (T43, `1b0745c`)
- `.github/workflows/ci.yml`: `check` on macOS and ubuntu (`deno install --frozen`, `deno task check`,
  `deno task scrub:check`); `test` on macOS (`deno task test`, `test:modhost`, fonts from cache or
  `deno task --cwd packages/web fonts`, then `deno task release:dry`); `security` on macOS (`deno task test:security`,
  then the Seatbelt derivation check, whose failure is a warning plus a report artifact); `secrets` on ubuntu
  (gitleaks over the full history). Ubuntu runs only `check` and `secrets` (macOS is the only v1 platform, O2). Not
  run: `test:core`, device tests, bubblewrap rows, real Tailscale and Web Push. Actions are pinned by commit; Deno
  2.9.8; caches keyed on `deno.lock` and the font manifest (`.github/workflows/ci.yml:1-118`).
- `deno task check` now also type-checks `tools/release`, `tools/scrub`, `tools/fixtures` and `tools/contract`
  (`deno.json:59`).
- Release: on a `v*` tag, macOS: fonts, `deno task bundle:release --tag $GITHUB_REF_NAME`, then a GitHub release with
  the tarball, its `.sha256` and the version's CHANGELOG section as notes (`.github/workflows/release.yml:1-53`).
  `deno task release:dry` = `bundle:release --dry`: the same build without a tag, uploading nothing (`deno.json:72-73`).
- Tarball (`tools/release/build.ts:1-28`): `.tmp/release/herdr-relay-<version>.tar.gz` (one top folder),
  `.tar.gz.sha256`, `.notes.md`. Version = CHANGELOG.md's first `## [x.y.z]` heading (the tag must be `v<version>`;
  a root `deno.json` `version` must agree). Contents: the files git would publish under the shipped list — top-level
  docs and notices, `deno.json`, `deno.lock`, `docs/`, `fixtures/generic-home/` (Seatbelt derivation's app home),
  `mods/herdr-relay-mirror/`, the bridge's `bin/`, `profiles/`, `scripts/`, `src/`, `packages/modhost/`, the protocol
  package minus tests, the web shell files, `tools/launchd/` — plus the built `packages/web/dist/` (without `dist/dev/`)
  and `packages/web/public/`; required files are checked; never tests, other fixtures, `.tmp` or `node_modules`
  (`tools/release/build.ts:36-89`). Every member passes the scrub rules first; links are refused; the archive is
  reproducible (sorted, HEAD's commit time, owner 0:0, 0644/0755, gzip without name or time).

## Watchdog bound (S28)
- S28 now reads "watchdog SIGKILL at 6 s, exit observed ≤ 7 s (reap)" (DESIGN-v2 and SECURITY.md S28 rows): the host is
  killed when it has not answered a ping for `pingMs` (2000) × `missedPongs` (3) = 6 s since it was last alive, and the
  test allows 7 s from the hog's start to the observed exit (`2e1f01a`: `bridge/hosts/supervisor.ts:91-100,872-880`;
  `protocol/control.ts:56`; `packages/bridge/test/security/availability_test.ts:77-82`).

## Review fixes (independent review of `50f1629`)
An independent review of `50f1629` found four security gaps. The fixes, the net lanes the hub gate relies on, the
packaging, desktop-path and README work that landed beside them, and the follow-ups (a bridge-answered `open_url` waking
a waiting read, sync-config's remote apply, the one cross-site navigation the gate admits, two web UI fixes) are below.
Commits: `846f8c6` (parts 1–7), `fce82d7` (part 4 wake, part 6 remote apply and tarball), `bb9d83d` (parts 8, 9).
Every `path:line` in this section is the working tree at `bb9d83d`, except `<commit>:<path>:<line>` (`50f1629`,
`846f8c6`) for the code before a fix.

### 1. Cockpit hub write gate → POLICY.md §2.7, §2.8; SECURITY.md S16, S37; PROTOCOL.md wave 4 item 5
- Gap: `net.write` relayed whatever a mod wrote on an allowed hub connection, whatever the origin
  (`50f1629:packages/bridge/src/herdr/net.ts:87-94`). A `read` device's click, a downgraded origin or the mod's own
  task could make the cockpit hub fork, start or resume agents, move the Mac's focus, open pages on the Mac or run
  routines (D3, U3).
- Contract: profile field `net.writes`, `"act"` (default) or `"cockpit-hub"` (`protocol/profile.ts:58-67,128-135`;
  `packages/protocol/schema/policy-profile.schema.json:180-186`); `netWriteMode` gives a folder's mode, null when net
  is off (`bridge/policy/profiles.ts:77-85`). Built-ins `cockpit` and `lstack-herdr` set `cockpit-hub`
  (`packages/bridge/profiles/cockpit.json:4,23`; `packages/bridge/profiles/lstack-herdr.json:39`).
- Each write is decided for the call's resolved origin: `HubProxy.write` takes the origin as its fifth argument
  (`bridge/herdr/source.ts:400-406`; `bridge/herdr/net.ts:166-177`). Mode `act` sends the write as written only for a
  connected `act` device (`bridge/herdr/net.ts:212-238`). Mode `cockpit-hub` feeds a per-connection `HubStream`
  (`bridge/herdr/net.ts:130-135,150-162`): only complete, admitted request lines are sent; a partial line is held; a
  refused line sends nothing of its write and closes the connection (`bridge/policy/hub.ts:1-16,111-150,173-221`).
- Table (`bridge/policy/hub.table.ts:1-168`), from the cockpit client in the lstack fork: reads `subscribe`, `view`,
  `search`, `events`, `history` and seven "details on demand" `fetch` kinds for anyone, also with no origin; other
  `fetch` kinds and `act` for a connected `act` device; `go` and 14 `act` actions of `agents`, `home`, `inbox`,
  `palette`, `runbook` and `routines` refused for everyone ("<what> needs the Herdr window", toasted to the device that
  asked); `routines` limited to 9 literal actions; unknown ops refused.
- `open_url` (any app) is never sent: an http(s) URL becomes the E11 "Open link" toast on the device that asked and the
  connection's reads get the answer `hub.js:125` gives (`bridge/policy/hub.ts:152-171`;
  `bridge/policy/hub.table.ts:152-165`; `bridge/herdr/net.ts:239-255`). E11 and `open_url` share `openLinkToast`
  (`bridge/policy/hub.ts:69-72`; `bridge/herdr/source.ts:552-555`); `HerdrSource` passes the toast sink and
  `USER_DECISIONS` to the proxy (`bridge/herdr/source.ts:258-259`).
- Logged with rule `net` and the folder's profile: every `net.connect`, each refused request and each intercepted
  `open_url`, by op/app/action/kind (and the URL) only; never the hub token; admitted lines are not logged
  (`bridge/herdr/net.ts:114-147,219-234,248`; `bridge/policy/hub.ts:40-47`).
- Behaviour change: a profile that enables net without `net.writes` gets `act`, so its writes from `init`, timers,
  downgraded origins and `read` devices are refused. On the cockpit hub, a `read` device keeps every view and gets
  links, but its actions are refused with a "Read-only device" toast; forks, agent starts and resumes, runbook steps
  and routine runs need the Herdr window from every device.
- Tests: `packages/bridge/test/security/hub_gate_test.ts` (through `HerdrSource` and a fake loopback hub; the policy
  log never holds the hub token), `packages/bridge/test/unit/policy/hub_stream_test.ts` (partial lines, the 1 MiB
  boundary in UTF-8 bytes).

### 2. E4 git hardening → POLICY.md §2.3 E4; SECURITY.md S11; PROFILES.md §6
- Gap 1, abbreviations: the denied-option pattern matched full spellings only
  (`50f1629:packages/bridge/src/policy/exec.table.ts:242-243`), while git accepts any unambiguous prefix (`--out=x` for
  `--output`, `--no-ind` for `--no-index`). Now `gitDeniedArg` also refuses a long option whose name up to `=` has at
  least 3 characters and is a prefix of a denied one; exemptions (`rev-parse --git-dir`, the global `--git-dir` under
  `gitDirUnderRoots`, `config --file|--blob`) match the full spelling only (`bridge/policy/exec.table.ts:240-276,282-283`;
  `bridge/policy/exec.ts:389-406,415-417,486-487`). Side effect: `--text`, an option of git's own, is refused as a prefix
  of `--textconv`.
- Gap 2, `git branch`: names were checked only before `--` and `--color`/`--abbrev` took the next argument as their
  value (`50f1629:packages/bridge/src/policy/exec.ts:506-519`; `50f1629:packages/bridge/src/policy/exec.table.ts:300-301`),
  so `branch -- <name>` and `branch --color <name>` created a branch. Now the mode is decided over the whole argv:
  every option by its full spelling from the listing lists, a name (before or after `--`) only as a pattern of a
  listing-mode flag, `--color`/`--abbrev` values only as `--opt=value` (`bridge/policy/exec.table.ts:303-348`;
  `bridge/policy/exec.ts:418-422,512-542`).
- Gap 3, `git diff`: outside a work tree, or with an operand outside it, git switches to `--no-index` by itself and
  reads any two files around the read roots. Now `diff` refuses an absolute operand or one with a `..` segment
  (before or after `--`) and, unless `--git-dir` is given, requires `-C`/`cwd` to lie in a work tree git finds, on the
  same filesystem, owned by the owner of `$HOME` (gitfile targets too) (`bridge/policy/exec.ts:423-425,544-590`).
- The E4 form text names the new limits (`bridge/policy/exec.table.ts:49-64`). Test:
  `packages/bridge/test/unit/policy/git_security_test.ts`, with `packages/bridge/test/unit/policy/git_nonrepo_probe.ts`.

### 3. Origin tokens bound to the delivering socket; revocation purge → SECURITY.md S19, §4; PROTOCOL.md wave 4 items 1, 8
- Gap: a token stayed valid for its 30 s across a disconnect, a resume on a new socket and a device revocation; a
  detached session still resolved as connected with its scope (`50f1629:packages/bridge/src/views/manager.ts:601-602,620`);
  a revoked device's sessions waited the 120 s resume grace (`50f1629:packages/bridge/src/views/manager.ts:352`;
  `50f1629:packages/bridge/src/server/server.ts:233`).
- Tokens carry the socket they were delivered over (`bridge/views/origins.ts:1-15,22-32,45-56`;
  `bridge/views/manager.ts:640-643`). `#resolve` accepts a token only while that socket is the session's open one;
  otherwise "session not connected" or "token from before the session reconnected" (`bridge/views/manager.ts:645-682`).
  A detached session resolves as `read`, not connected (`bridge/views/manager.ts:633-638`). Downgrades are logged once
  per token and reason (`bridge/views/manager.ts:665-669`).
- Revocation: the server tracks tailnet devices that had a socket this run; its 2 s sweep revokes one that is no longer
  paired once, calls the session layer's `revokeDevice`, then closes its sockets 1008 "device revoked"
  (`bridge/server/server.ts:14-17,54-57,87-88,231,245-260`; the session layer exposes the `ViewManager`,
  `bridge/app.ts:51-53`). `revokeDevice` ends every session of the device at once and closes its socket with
  `REVOKED_CLOSE`; a socket closed with that code and reason also ends its session without grace; ending a session
  forgets its tokens (`bridge/views/manager.ts:98-104,352-387,491-497`; `bridge/views/origins.ts:63-66`;
  `REVOKED_CLOSE` is exported from `bridge/views/mod.ts:25`).
- Tests: `packages/bridge/test/security/origin_lifecycle_test.ts` with the probe mod
  `fixtures/probe-mods/origin-replay/main.js`; `packages/bridge/test/unit/server/revoke_sweep_test.ts`.

### 4. Net read and write lanes
- Before: one queue per connection, so a `net.write` waited behind a pending `net.read`
  (`50f1629:packages/bridge/src/herdr/net.ts:26-27,132-134`): a mod keeping a read open in the background could not
  write on the same socket when the person acted.
- `846f8c6`: reads and writes became separate lanes, each in call order; a failed read or write closes the connection,
  and both lanes end. Test: `packages/bridge/test/unit/herdr/net_duplex_test.ts`.
- `fce82d7`, wake: a read took the bridge's queued answers only when it started, else waited in `tcp.read`
  (`846f8c6:packages/bridge/src/herdr/net.ts:160-170`). An `open_url` answered while a read already waited therefore sat
  behind it, and the hub, which was sent nothing, never answered that read. Now reads take the connection's bytes from
  one inbox in the order they came — the bridge's own answers and the hub's — and a single `tcp.read` is in flight at a
  time, started while a read waits; an answer the bridge gives wakes a waiting read at once, and what the `tcp.read` in
  flight then brings joins the inbox for the next read (FIFO). After the hub ends the stream, reads answer `null` once
  the inbox is empty. Closing the connection rejects the waiting reads with "the connection is closed"; later calls get
  "no such connection"; queued writes reject with "the connection is closed"
  (`bridge/herdr/net.ts:18-23,53-80,179-192,244-254,258-301,303-318,325-335`).
- Test: `packages/bridge/test/unit/herdr/net_wake_test.ts`: a read waiting before an intercepted `open_url` gets the
  note, then the hub's bytes in order, split by `maxBytes`, then `null` at the end; two waiting reads get the note and
  the hub's line in order; close rejects the rest.

### 5. Homebrew formula (O4, O6)
- `packaging/homebrew/herdr-relay.rb`, prepared and **not published**; its header says how to publish it into the tap
  `Lapis0875/homebrew-herdr-relay` after a tagged release (`packaging/homebrew/herdr-relay.rb:1-7`). It depends on
  `deno` and macOS, installs the release folder into `libexec` and links `herdr-relay` with Homebrew's `deno` first on
  `PATH` (`:15-25`); its `brew services` block runs `herdr-relay start` under the launchd label
  `io.github.lapis0875.herdr-relay`, with `~/.local/bin` on `PATH`, restart after a non-zero exit at most every 30 s and
  the log in `var/log/herdr-relay.log` (`:27-38`); `brew test` runs `herdr-relay doctor` (`:40-48`). Its `sha256` is the
  local dry run's and changes with every commit (`:5-7,12`).
- Not in the release tarball: it names the tarball's digest, so it is copied to the tap instead
  (`tools/release/build.ts:18-21`).
- Documented in `docs/INSTALL.md:210-236` (§10); listed in `CHANGELOG.md:25-26`; `README.md:62` and
  `README.ko.md:60-61` point at `packaging/homebrew/`.

### 6. Desktop path: sync-config (T13) and the lstack `on:` patch (T14)
- `tools/sync-config/mod.ts` plans the Mac → PC copy for any app home: user layouts, the unshipped mods they reference
  (with the other folders of the built-in profile governing such a mod), the themes they name, and a section merge of
  `keys.json`; dry run by default (`tools/sync-config/mod.ts:1-23,29-30`).
- `--apply` to a local folder copies the files and merges `keys.json` in place (`tools/sync-config/mod.ts:461-485`).
- `--apply` to `[user@]host:path` is implemented (`fce82d7`): rsync is the only program it runs, over the remote shell
  `--rsh`, else `$RSYNC_RSH`, else `ssh` (rsync's own order). It pulls the PC's `keys.json` alone into a fresh local
  temporary folder (only when there are sections to merge; an absent file is neither merged nor created), merges it on
  the Mac (an invalid one stops before anything is sent), sends the planned files (`-rtm --omit-dir-times`, no
  `--delete`), then pushes the merged `keys.json` back only when the merge changed it; a failed rsync stops the rest and
  says what was sent; the temporary folder is removed. The dry run prints the same rsync lines with `<temp>`; `--rsh`
  with a local target is a usage error (`tools/sync-config/mod.ts:338-371,492-532,636-658`).
- Task `deno task sync-config` now has `--allow-env=…,RSYNC_RSH --allow-run=rsync --allow-write=$TMPDIR`; `check` and
  `test` cover `tools/sync-config`, `test` with `RSYNC_RSH` and `rsync` (`deno.json:59-60,74`). Tests:
  `tools/sync-config/test/sync_test.ts` (remote dry run and `--rsh` precedence `:108-172`, remote apply order, keys
  push only when changed, failures stopping later sends `:174-319`, an rsync integration through a stand-in remote
  shell `:321-392`), `tools/sync-config/test/fixture.ts`.
- The release tarball ships `tools/sync-config/mod.ts` (its tests stay in the repository), so `deno task sync-config`
  works from a release folder (`tools/release/build.ts:70-71`).
- docs/DESKTOP.md documents it ("sync-config", `docs/DESKTOP.md:51-173`, remote apply in "Remote targets" `:143-173`)
  and T14 ("The lstack `on:` patch (T14)", `docs/DESKTOP.md:175-186`): the patch lives under the gitignored
  `fixtures/private/lstack-remote-patch/` because it is derived from the private fork (O7; `docs/OSS-PLAN.md:246`), not
  under `tools/lstack-remote-patch/` as DESIGN-v2 T14 planned (`docs/DESIGN-v2.md:356`), and it is not applied (D9)
  (`docs/DESKTOP.md:3-7,12-16`).

### 7. README qualification
- The README no longer says herdr-relay never resizes a Mac terminal: viewing never resizes it, typing may briefly
  resize it because of the herdr-core attach limitation recorded in wave 3 (`README.md:23-25`; `README.ko.md:23-24`;
  `docs/AMENDMENTS-c1-wave3.md:17`).

### 8. Cross-site top-level navigation to the app shell (`bb9d83d`) → SECURITY.md §2, S33, §4
- Gap: the gate refused every `Sec-Fetch-Site: cross-site` request (`50f1629:packages/bridge/src/auth/gate.ts:13,59`),
  so Android could not open the app from an intent, another app's link or a notification.
- Now one exception: a top-level navigation that loads the shell's page — GET/HEAD, `Sec-Fetch-Mode: navigate`,
  `Sec-Fetch-Dest: document` or absent, no `Origin` (`isDocumentNavigation`) — with the new `navigate` access, which the
  server passes only for the shell's HTML routes (extensionless paths and `/index.html`); everything else stays
  same-site only: `/api/*`, `/ws`, extension routes, the bundle's other files, frames, `cors`/`no-cors`/`same-origin`
  modes, `OPTIONS`, POST, a navigation with an `Origin` (`bridge/auth/gate.ts:13-24,33-47,77-85`;
  `bridge/server/server.ts:11-12,201-208`). On the tailnet `navigate` is a read: owner, host and peer are checked, no
  `Origin` is needed (`bridge/auth/gate.ts:87-98`). The page is the static shell at the `shell` level: no cookie,
  ticket or session (`bridge/auth/auth.ts:75-99`).
- A `?token=` in such a URL grants nothing by itself: the bridge never reads it; the shell moves it into
  `sessionStorage` and sends it only as `Authorization: Bearer` on its same-origin `fetch`es (`web/env.ts:39-59`;
  `web/api.ts:44-46`).
- Tests: `packages/bridge/test/unit/auth/cross_site_nav_test.ts`, `packages/bridge/test/unit/server/cross_site_nav_test.ts`.

### 9. Web UI fixes (`bb9d83d`)
- Accessible capitalised labels: the shell no longer capitalises labels with CSS `text-transform: capitalize`
  (removed from `.segments__item`, `.peek__label` and `.list__row`, `packages/web/src/app/app.css:568,816,1070`).
  Segment and More titles are capitalised in the text itself by `titleOf`, so the visible label and the accessible name
  agree (WCAG 2.5.3) (`web/ui/Screen.tsx:161-163`; `web/nav.ts:129-133`).
- Inert background under modal sheets: while a drawer or side sheet (`aria-modal`) is open above it, the home layer
  and each push layer below stay drawn but are `inert` and `aria-hidden`, so they take no focus or input
  (`web/ui/Navigator.tsx:183-184,205,241-256,268-287,338`).
- The Playwright device suite closes an open Panel before its home screenshot and picks the More sheet's first list
  option (`tools/device-tests/screens.spec.js:52-62,80`); its README pins one `PLAYWRIGHT_BROWSERS_PATH` for install and
  runs (`tools/device-tests/README.md:12,22`).

### Docs
- POLICY.md: E2, E4, E5 rows, §2.7 `net.writes`, new §2.8 (hub request table; the read queue an `open_url` answer
  wakes), U1–U3 marked decided (DECISIONS.md rows U1–U3 supersede the former "Pending user decisions" table).
  SECURITY.md: §2 "Cross-site top-level navigation", S11, S16, S19, S33, new S37, §4 notes (S19, S37, the navigation
  residual). PROTOCOL.md: wave 4 items 1, 5, 8 and a pointer to the gate. PROFILES.md: §1, §2, §4 `net.*` rows, §6 E4,
  §8.2. The T41 section above now names `sessionStorage` for the loopback token. Comment-only: the `intercept` decision
  names the hub's `open_url` (`protocol/policy-log.ts:62-65`); the hub gate cites S37 (`bridge/policy/hub.ts:2`).

## iPad real-device fixes (`7bf41ef`, `e6aa387`, `8470d00`, `9e14b9d`, `8a6778f`)
Fixes from running the Home Screen app on an iPad with a hardware keyboard. Commits: `7bf41ef` (part 1), `e6aa387`
(part 2 and the first keyboard fix in part 3), `8470d00` (parts 3–5), `9e14b9d` (keyboard review fixes: the Hide
keyboard commit in part 3, the redacted, page-only diagnostics in part 4; the two-device test in part 2), `8a6778f`
("Nothing kept while the view cannot type" in part 3). Every `path:line` in this section is at `8a6778f`
(`bab8964` later moved `web/ui/DevicePanel.tsx` and `bridge/views/manager.ts`), except `<commit>:<path>:<line>` for
the code before a fix. Short paths as above, plus `render/X` = `packages/web/src/render/X` and `widgets/X` =
`packages/web/src/widgets/X`.

### 1. Opaque status bar (iPadOS 26.1+ blur) (`7bf41ef`)
- Gap: the app asked for `apple-mobile-web-app-status-bar-style` `black-translucent`, which draws the page under the
  status bar (`7bf41ef^:packages/web/index.html:13`). On iOS/iPadOS 26.1 and later the system lays a blur over the top
  of such Home Screen apps, and taps there do nothing (WebKit bug 317153).
- Now `default`: the system bar is opaque and the web view starts below it, so nothing is drawn under the bar and
  `--safe-top` is 0 in the Home Screen app; the safe-area insets still keep the frame clear of a phone's notch and home
  indicator (`packages/web/index.html:13-16`; `web/app.css:1-7,44,121`). The dev story page asks for the same
  (`widgets/dev/widgets.html:12`).
- The hover card's height limit is `100%` of the viewport it is fixed in, not `100vh`, which can include the iOS status
  bar (WebKit 316008) (`widgets/widgets.css:643-650`).
- iOS reads the tag only when the app is added to the Home Screen: an icon added before keeps the translucent bar and
  the blur until it is removed and the app is added again. The opaque bar follows the device's light or dark
  appearance, not the Herdr theme (`docs/INSTALL.md:138-141`).

### 2. Per-device focus view (`e6aa387`) → PROTOCOL.md §3, DESIGN-v2 §1.7; supersedes part of wave 3 "Lead session"
- Gap: hosts got the lead session's `layout()` and `focused()` only; `spaces()`, `panes()` and `agents()` kept the
  Mac's `active`, `focused` and `zoomed` flags, and a device's `snapshot` replaced only `focused`
  (`e6aa387^:packages/bridge/src/views/manager.ts:766-770,775-780`). A device's `tab.select` changed what it showed,
  but the `tabs` mod draws its highlight and close button from `spaces().find(p => p.active)` and each tab's `active`
  (`fixtures/generic-home/mods/tabs/main.js:50,59,72`), so the highlight stayed on the Mac's tab.
- `SessionFocus.view(world, zoom)` returns the Mac's lists with one device's own flags: the space it shows is `active`,
  in each space the tab shown there is `active`, only its focused pane is `focused` (none while a terminal block is)
  and so is that pane's agent, and tabs and panes are `zoomed` as zoomed on this device; `zoom: false` reports nothing
  zoomed (`bridge/session/focus.ts:19-28,91-119`). `Session.view()` passes `zoom: false` on a phone, matching
  `zoomed()` (`bridge/session/session.ts:173-187`); `SessionView` is exported from `bridge/session/mod.ts:4-11`.
- `changed.focus` compares `view()` before and after a command, so a selection, focus or zoom flag counts too (a
  `pane.zoom` now pushes state) (`bridge/session/session.ts:64-68,365-381`). It marks the device's state for a
  `patch.state` and, for the lead, tells the hosts (`bridge/views/manager.ts:649-651`).
- Host state is the Mac's `HostState` with the lead session's `view()` and `layout` on top; without a session, the
  Mac's own (`bridge/views/manager.ts:774-779`). Each device's snapshot takes its own `view()`, so its `patch.state`
  carries `/spaces/…/active` and `/panes/…/focused` for that device alone (`bridge/views/manager.ts:767-769,1267-1274`).
  `HerdrData` keeps returning the Mac's flags, which the view manager replaces (`bridge/views/data.ts:90-103`); the
  `HostStateSchema` comment says so (`protocol/control.ts:117-124`).
- Unchanged: focus commands stay in the session (`tab.select` passes nothing through to the Mac). The lead is still the
  device that acted last, so other devices see the lead's selection inside mod views, and their own in the ScreenGraph
  and their `snapshot` (`bridge/views/manager.ts:46-49,669-670`).
- Tests: `packages/bridge/test/unit/session/session_view_test.ts:57-100` (a device's tab selection and zoom leave the
  Mac world unchanged; an invalid selection changes nothing; a phone never exposes zoom),
  `packages/bridge/test/unit/views/tab_focus_test.ts:9-107` (host state and the device patch follow a device
  `tab.select`; nothing passed through), `packages/bridge/test/unit/views/two_device_focus_test.ts:49-175` (two
  desktops and a phone: host state follows whichever device acted, each device's snapshot keeps its own tab, the phone
  never shows zoom, nothing is passed through and the Mac's state is unchanged).

### 3. Hardware-keyboard input-language switching (`e6aa387`, `8470d00`, `9e14b9d`, `8a6778f`)
- First fix (`e6aa387`): keys the operating system keeps (`systemKey`: Caps Lock, Globe/fn, the input-language keys,
  modifiers on their own, Ctrl+Space on an iPad or iPhone) and keys an input method takes (`imeKey`) are neither sent
  nor cancelled: not as GPUI keys, not by xterm, not as an element's Enter/Space activation, a list row's or a split
  handle's key (`render/events.ts:38-78,186`; `widgets/terminal/ime.ts:108,120-125`; `render/interact.ts:356`;
  `widgets/VirtualList.tsx:158`; `web/ui/Screen.tsx:540`). WebKit's Korean input, which fires no composition events,
  is sent once per finished syllable (`widgets/terminal/ime.ts:1-20`), and an Enter the input method takes is not a
  submit (`widgets/text/TextInput.tsx:139-141`).
- Root cause of the language still not switching: xterm's textarea was read-only (`disableStdin`) until typing started
  (`e6aa387:packages/web/src/widgets/terminal/TerminalView.tsx:165,259`). iPadOS gives a field a keyboard session
  (input-language switching with Caps Lock, Globe or Ctrl+Space; IME composition) only if the field is editable when
  it gets the focus, and never revisits that (`widgets/terminal/TerminalView.tsx:11-13`). A terminal focused by a tap
  therefore had none, and a language key did not start typing
  (`e6aa387:packages/web/src/widgets/terminal/TerminalView.tsx:308-317`), so the field stayed read-only; the blur and
  refocus when typing started (`:288-306`) is removed. A page sees Ctrl+Space at all only when the focused field has
  no keyboard session (`render/events.ts:67-74`).
- Fix (`8470d00`): the textarea is never read-only. Until typing starts it has `inputmode="none"`, which takes effect
  at once, so a tap brings up no on-screen keyboard; starting to type removes it before the terminal is focused
  (`widgets/terminal/TerminalView.tsx:7-14,61-65,206,295-299,326-333,359`). Nothing typed reaches the Mac before
  then: the gate is in xterm's `onData` now, not `disableStdin` (`widgets/terminal/TerminalView.tsx:227-230`).
- `inputmode="none"` stops input-language switching too. So any key but a modifier on its own starts typing in a
  focused terminal, Caps Lock and Globe included (that first press is spent on starting, the next one switches), and
  marks the page as having a hardware keyboard, since none showed on screen. After that no terminal on the page asks
  for `inputmode="none"`, also one mounted earlier once it gets the focus
  (`widgets/terminal/TerminalView.tsx:54-59,335-347,396-397`). A modifier alone does not start typing: it may begin a
  ⌘ shortcut of the browser (`widgets/terminal/TerminalView.tsx:51-52,344`).
- Hide keyboard (`9e14b9d`): the touch keyboard button, turning typing off, first sends the Korean syllable WebKit
  still holds, through `onData` with the same checks, while typing is still on; the blur's own commit that follows
  would come when nothing is sent any more. `attachTerminalInput` returns a `TerminalInput` (`commit`, `setEnabled`,
  `dispose`) (`widgets/terminal/TerminalView.tsx:349-363`; `widgets/terminal/ime.ts:12-18,35-49,180-197`). Test:
  `packages/web/test/terminal_ime_test.tsx:206-235`.
- Nothing kept while the view cannot type (`8a6778f`): until then the input layer held a syllable, and took input,
  whatever the view's state (`9e14b9d:packages/web/src/widgets/terminal/ime.ts:87,115-157`), so what was typed or
  still open while the view could not type could go out with the next key once it could. Now the view tells the layer
  whether it can type, at mount and on every change (`widgets/terminal/TerminalView.tsx:208-210,291-293`). Turned off
  (offline, stale, read-only, refused), the open syllable is dropped unsent; input then is dropped, xterm's own
  `insertText` path included; a composition under way then, or begun meanwhile, is cleared from the textarea when it
  ends, before xterm's composition helper reads it
  (`widgets/terminal/ime.ts:21-25,42-46,68-71,135-139,166-179,184-189`). Tests:
  `packages/web/test/terminal_ime_test.tsx:237-262` (a syllable open when the stream goes offline is dropped; live
  again without a blur, Enter sends only `\r`), `:264-288` (typed while offline, never sent; typed once live, sent
  once), `:290-327` (compositions under way or begun while offline send nothing).
- Jamo keys: iPadOS's hardware-keyboard Korean input reports a keydown with the jamo as `key` and the key's real
  `keyCode` (`"ㄱ"`, 82), not 229, and composes it from the input events that follow. `imeKey` now also takes a jamo
  key without Ctrl/⌘, so it is neither a GPUI key nor xterm's; a Ctrl or ⌘ chord on a Korean layout stays a key
  (`cmd-r`) (`render/events.ts:80-92`; `packages/web/test/keys_test.ts:53-70`, the jamo case seen in the iOS 27
  simulator).
- Amends the T17 terminal bullet ("input stays off until a key is pressed in the focused terminal (fine pointers)",
  `1b0745c`): nothing typed is sent until then, but the field is editable from the start. A key from a hardware
  keyboard starts typing on a touch screen too; the code never checked the pointer
  (`1b0745c:packages/web/src/widgets/terminal/TerminalView.tsx:282-289`), only the text named fine pointers.

### 4. Keyboard diagnostics panel (`8470d00`; redaction and page-only switch `9e14b9d`)
- The device panel's "Diagnostics" section has a "Keyboard diagnostics" switch. It is this page's alone: nothing is
  stored, and a reload turns it off (`web/ui/DevicePanel.tsx:60,343-370`; `web/ui/KeyboardDiagnostics.tsx:1-12,30-53`).
  At `8470d00` it was kept in `localStorage` (`8470d00:packages/web/src/app/ui/KeyboardDiagnostics.tsx:13,40-61`).
- While it is on, a list over the app (mounted once in the app root, `web/ui/App.tsx:34`) shows the last 30 `keydown`,
  `keyup`, `beforeinput`, `input`, `compositionstart`/`update`/`end`, `focusin` and `focusout` events, newest first:
  ms since the switch, the event as `describeEvent` gives it, `PREVENTED` when a listener cancelled it, and the
  focused element — tag, first class, `ro` (read-only), `im=` (`inputmode`), `editable`
  (`web/ui/KeyboardDiagnostics.tsx:17-28,55-64,157-167,236-239`).
- Nothing typed is in a line (`describeEvent`, exported and pure; `web/ui/KeyboardDiagnostics.tsx:66-155`). The keys
  that type no character keep their `key` and `code` names: modifiers, locks, Globe/fn (`Unidentified`, `Fn`),
  input-method and language keys (`HangulMode`, `Process`, `Lang1`–`Lang5`, …), Enter, Tab, Escape, Backspace,
  arrows, F1–F24, and Space only in a Ctrl or ⌘ chord (iPadOS's language switch). Any other key is its kind (`char`,
  `jamo`, `hangul`, `mixed`) with `code=char`. `keyCode` shows only as `kc=229`, the input method's. An input's or
  composition's text is its length and kind (`data=1:hangul`), `data=0` when empty, `data=null` when absent; its
  `inputType` as it is. Also modifiers, `capslock-on`, `repeat`, `composing`.
- Passive: capture-phase passive listeners on the window that never cancel or stop an event, added only while the
  switch is on and removed, with the list, when it goes off; an event recorded just before is dropped
  (`web/ui/KeyboardDiagnostics.tsx:5-7,161-166,187-195`). The list takes no press; its Copy, Clear and Turn Off
  buttons keep the focus on the field being diagnosed (`web/ui/KeyboardDiagnostics.tsx:198-234`;
  `web/app.css:1670-1740`).
- Copy puts the time, user agent, touch points, Home Screen app or browser, `navigator.languages` and the focused
  element on the clipboard, then the lines oldest first (`web/ui/KeyboardDiagnostics.tsx:169-179,205-215`), through
  the toasts' `copyText`, now exported (`web/ui/Toasts.tsx:14-15`). Nothing goes to the bridge: the module imports only
  React and `copyText` (`web/ui/KeyboardDiagnostics.tsx:14-15`).
- Tests: `packages/web/test/keyboard_diagnostics_test.ts:44-101` (named keys; character keys and texts as kinds and
  lengths), `:162-206` (a typed secret, in WebKit's Korean input and a composition too, is neither shown nor copied;
  the switch stores nothing).

### 5. Program icons from Herdr's built-in program table (`8470d00`)
- Gap: the bridge built `program` from the app home's `programs.json` alone (the person's table, which Herdr lays over
  its compiled-in one), fixed shell and interpreter lists and the process name; a program only Herdr's built-in table
  lists got no icon or tile, and `tint` defaulted to false
  (`8470d00^:packages/bridge/src/herdr/model.ts:6-8,45-48,67,107`).
- The bridge now ships Herdr 0.1.14's `defaults/programs.json`, unmodified apart from a `$comment`
  (`bridge/herdr/programs.json:1-5`; `THIRD_PARTY_NOTICES:104-108`). `programTable` lays the app home's file over it
  as Herdr's `programs::load` does: shells and interpreters are added, a field the person sets wins, a non-empty
  `match`/`run` replaces the built-in one, and a file Herdr could not read leaves the built-in table
  (`bridge/herdr/model.ts:24,39-48,66-124`). It is rebuilt when the app home files reload
  (`bridge/herdr/source.ts:241,784`).
- Resolution follows Herdr's `programs::resolve` and `window.rs` `program_of`: the agent's report (`status.app`), else
  the foreground `argv`, else the started `argv`; the app's `<shell> -ic '"$@"…'` wrapper and Windows'
  `pwsh -NoExit -Command "& '…'"` are unwrapped; an interpreter shows the known program it runs (`node …/vite.js`,
  `npx vite`); a key equal to the name (case-insensitive) wins, else a `match` name, in key order; a shell is `shell`;
  anything else is `program` with a tile from an 8-colour palette picked by the FNV-1a hash of its name; `tint`
  defaults to true (`bridge/herdr/model.ts:126-237`).
- Icons are `icons/…` paths in the app home, served by the asset route (`bridge/policy/read.ts:246-258`); mods draw one
  with `svg()` when `tint`, else `image()` (e.g. `fixtures/generic-home/mods/tabs/main.js:56,68`).
- `knownAgents()` lists the table's startable agents (entries with `run`), most picked first (`claude`, `codex`, `pi`,
  …), then by key, each `installed` when its program is on `PATH` (`bridge/herdr/model.ts:239-252`;
  `bridge/herdr/source.ts:558-566`). `program` is no longer exported; `startable` is (`bridge/herdr/mod.ts:16-27`).
- Refresh per Herdr version: when `deno task contract:update` syncs another tag, copy a changed
  `fixtures/generic-home/programs.json` into `packages/bridge/src/herdr/programs.json`, keeping its `$comment`
  (`docs/COMPATIBILITY.md:136-139` in §5; `bridge/herdr/programs.json:4`).
  `packages/bridge/test/unit/herdr/programs_test.ts:31-34` fails while the two differ, `:36-41` checks that every
  built-in icon is an `icons/` file the asset route serves, and `:43-176` mirror Herdr's resolution, overlay and
  `startable` cases.

### Docs
- PROTOCOL.md §3 and DESIGN-v2 §1.7: host state carries the lead session's view. Wave 3 "Lead session" has a
  superseding note (part 2). Comment-only: `HostStateSchema` (`protocol/control.ts:117-124`). Also in the commits:
  INSTALL.md (part 1), COMPATIBILITY.md §5 and THIRD_PARTY_NOTICES §4 (part 5), CHANGELOG.md 0.1.0 "Added" (parts 2, 3
  and 5 in `e6aa387`/`8470d00`, parts 1 and 4 in `9e14b9d`).

## Push end to end (`bab8964`) → PROTOCOL.md "Push test"
What notifications need end to end: a VAPID subject Apple accepts, a test notification from the device panel, a log
line for every send, the payload limit push services must accept, and notification states that say what to do. Every
`path:line` in this section is at `bab8964`, except `bab8964^:<path>:<line>` for the code before it.
Short paths as above; the service worker is `packages/web/sw.js`.

### 1. VAPID subject
- Gap: without the Tailscale identity the token's `sub` was `https://localhost`
  (`bab8964^:packages/bridge/src/app.ts:45,142`). Apple's push service answers a token whose subject is not a
  `mailto:` address or an `https:` URL it accepts with `403 {"reason":"BadJwtToken"}`, and refuses `localhost`
  (`bridge/push/subject.ts:1-5`).
- Now, in order: `HERDR_RELAY_PUSH_SUBJECT` when valid, else `https://<MagicDNS name>` while the Tailscale identity is
  known, else `PUSH_SUBJECT_FALLBACK = "https://github.com/Lapis0875/herdr-relay"` (`bridge/push/subject.ts:9-11,60-64`;
  `bridge/app.ts:137,140`). The MagicDNS form is not run through the check below.
- Valid (`subjectProblem`): no spaces; `mailto:<address>` at a dotted public domain, without a query; or an `https:` URL
  without credentials whose host is a dotted DNS name, neither `localhost` nor an IP address
  (`bridge/push/subject.ts:13-39`).
- Read once at start, and only when the bridge's `--allow-env` grants it, so it never prompts. An invalid value is
  logged as `push: HERDR_RELAY_PUSH_SUBJECT <problem>; ignored`, a valid one as
  `push: VAPID subject from HERDR_RELAY_PUSH_SUBJECT: <value>` (`bridge/push/subject.ts:41-58,66-69`;
  `bridge/app.ts:137`). `deno task start` and `start:dev` grant it (`deno.json:65-66`), and `herdr-relay start` adds
  it to the variables it computes `--allow-env` from (`packages/bridge/bin/start.ts:31,49-58`).
- The token is otherwise unchanged: `aud` the endpoint's origin, `exp` now + 12 h (`bridge/push/webpush.ts:21,125-136`);
  one subject is read per batch of sends (`bridge/push/service.ts:280`).

### 2. Test notification (`push.test`)
- Client message `push.test {t, id}` (`protocol/messages.ts:282-288,335,347,359`;
  `packages/protocol/schema/client-message.schema.json:975`; samples `packages/protocol/samples/client/push.test.json`,
  `packages/protocol/samples/invalid/client/push.test.missing-id.json`). The session layer passes it to the
  `PushService` with `visible` and `push.sub` (`bridge/app.ts:14-16,158-161`; `bridge/views/manager.ts:141-143`).
- Own device only: it goes to the subscriptions the asking socket's paired device registered (the loopback identity
  is `local`), never another device's. `read` devices may send it (`bridge/push/service.ts:161-165,241-245`;
  `protocol/messages.ts:283-286`).
- Sent while a device is visible: `test` does not check `muted`, which keeps every alert unsent while any device has
  the app on screen (`bridge/push/service.ts:192-198,220-253`).
- At most one per `TEST_INTERVAL_MS = 5_000` ms per device, counted from each accepted request, even one that then
  finds no subscription; within it, `wait <n> s before another test notification`
  (`bridge/push/service.ts:31-32,224-232`).
- Message: title `herdr-relay`, body `Test notification from <name>` — the core's machine name, else the first label
  of the MagicDNS name, else `the Mac` — tag `herdr-relay:test` (a newer test replaces the earlier one), url `./`
  (`bridge/push/service.ts:33-36,246-251`; `bridge/app.ts:141`).
- Ack: `ok` when at least one push service answered 2xx, `{ok:true, message}`; otherwise
  `{ok:false, error:"refused", message}` (`bridge/push/service.ts:161-165`). The message joins every subscription's
  result with `; `: `sent to 1 subscription (201)` or `sent to 1 of 2 subscriptions (201)`,
  `push service answered <status>[: <reason>]` (with ` (subscription removed)` on 404/410),
  `push service unreachable: <error>`, `subscription dropped` (`bridge/push/service.ts:355-374`). Before sending: the
  wait above, `no subscription for this device`,
  `the Mac cannot read its push keys or subscriptions (see the bridge log)` (`bridge/push/service.ts:230,233-245`).
  A 2xx means the push service took the message, not that the device showed it.
- Device side: `BridgeClient.pushTest` (`web/client.ts:224-230`); `sendTestPush` shows the ack's message as it is, and
  its own text for `offline` and `timed out` (`web/push.ts:203-209`).

### 3. Delivery and log lines
- Alerts and the test share one delivery: per subscription, `aes128gcm` body, `TTL: 86400`, `Urgency: high`, 10 s
  deadline, no redirects (`bridge/push/service.ts:28-30,275-332`). A subscription outside the allowlist or of a device
  no longer paired is dropped unsent; a 404 or 410 removes it; every other answer keeps it (`:284-288,297,301-303`).
- One log line per answer, `herdr-relay: push: <service host> <status> [<reason or apns-id>]`, then what a refusal
  means: on 404/410 `— subscription removed`; on 403 `BadJwtToken`,
  `— Apple refused the VAPID token: check the subject <subject> (HERDR_RELAY_PUSH_SUBJECT overrides it) and the Mac's clock`;
  on any other 403, `— the VAPID token or key was refused` (`bridge/push/service.ts:133,298,343-353`). No answer:
  `<host> failed: <error>`, with URL paths cut from the error (`:292-295,417-420`). Never an endpoint path, key or
  token (`:9-13`).
- The reason: the first 2048 bytes of a refusal's body, then Apple's `reason`, Mozilla's `message` or FCM's `error`
  when the body is JSON, else the text without markup; one line of at most `REASON_MAX = 120` characters. An
  `apns-id` is kept up to 64 characters (`bridge/push/service.ts:37-40,322-330,376-415`).
- Also logged: `device <id> subscribed (<host>)`; an alert not sent because `a device is on screen` (each time) or
  because `no device has turned notifications on` (once, until a device subscribes); a test for a device without a
  subscription (`bridge/push/service.ts:187-188,193-211,243`).

### 4. Payload limit
- RFC 8291 §4: a push service need not accept a body over 4096 bytes; less the 86-byte `aes128gcm` header (salt 16,
  `rs` 4, `idlen` 1, sender key 65), the padding delimiter and the 16-byte tag, that leaves 3993 bytes of plaintext:
  `MAX_BODY_BYTES = 4096`, `MAX_PAYLOAD_BYTES` = 3993 (`bridge/push/webpush.ts:12-19`). Before, the limit filled the
  4096-byte record instead, `RECORD_SIZE - 1 - 16` = 4079 bytes (`bab8964^:packages/bridge/src/push/webpush.ts:13-15`),
  so a body could reach 4182 bytes (86 + 4096).
- An alert over the limit is logged and not sent; `encryptPayload` throws `RangeError` over it
  (`bridge/push/service.ts:212-216`; `bridge/push/webpush.ts:96-98`).

### 5. Device panel: notification states, test button, service worker facts
- States (`pushStatus`, `web/push.ts:14-20,98-122`) and their text (`web/ui/DevicePanel.tsx:208-226`):
  - `unsupported`: not HTTPS ("open the app through its Tailscale address"); no Web Push in the browser; a Home Screen
    app on iPhone or iPad without it ("Notifications need iOS or iPadOS 16.4 or later"); the service worker is not
    registered yet ("Reload the app once").
  - `needs-install`: Safari on iPhone or iPad: Share → Add to Home Screen, then turn it on in the Home Screen app.
  - `denied`: on iPhone and iPad, Settings → Notifications → herdr (its Home Screen name) → Allow Notifications; else
    the browser's site settings.
  - `off`, with a reason when the permission prompt closed without an answer; `on`; `error` with what failed.
- Enabling (`enablePush`, `web/push.ts:142-181`): `Notification.requestPermission()` runs before the first `await`, and
  the switch calls it in the tap itself, because iOS and iPadOS show the prompt only during a tap
  (`web/ui/DevicePanel.tsx:283-295`). It waits up to 10 s for a first service-worker install to activate
  (`web/push.ts:42-43,77-97`). A failure names its stage (`Asking for permission`, `Starting the service worker`,
  `Getting the Mac’s push key`, `Subscribing with the push service`, `Registering with the Mac`) and the browser's
  error name. A registration the Mac never answered (`offline`, `timed out`) keeps the subscription, which is sent again
  after the next `hello`; one the Mac refused is unsubscribed and its reason shown.
- The registration is looked up by the app's scope, not the page's URL (`web/push.ts:71-75`). The panel reads the
  state again when the page becomes visible (back from Settings), when a service worker takes over, and once it is
  ready; a read begun before a toggle cannot overwrite the toggle's outcome (`web/ui/DevicePanel.tsx:242-280`).
- "Send Test Notification" shows while the switch is on and not busy; the answer goes in a status line under it, in
  the error tone when not `ok` (`web/ui/DevicePanel.tsx:296-300,327-341`).
- Facts list: Service worker (`Not available here`, `Not registered`, `Installing…`, `Waiting to start`, `Active`, with
  `Not serving this page yet` while an active worker does not control the page), Scope, Permission (`Allowed`,
  `Blocked`, `Not asked yet`) and the push service's host (`web/push.ts:22-34,124-140`;
  `web/ui/DevicePanel.tsx:228-240,342-374`).

### 6. Service worker
- Every push shows a notification: a payload that is not JSON shows its text as the body (iOS and Chrome expect a
  notification for every push); the title defaults to `herdr-relay`; `renotify` only with a non-empty tag
  (`packages/web/sw.js:9-11,90-113`).
- A tap opens `url` only inside the scope, else `./`; it focuses an open page of the app (never a `dev/` page) and
  posts it `{type: "open", url, terminal}`; when focusing fails it opens a new window (`packages/web/sw.js:115-139`).

### Not covered by tests at `bab8964`
- No test exercises `push.test`, the subject order and validation, the log lines or the device panel's states; the
  push unit tests are unchanged and check the payload limit through `MAX_PAYLOAD_BYTES`
  (`packages/bridge/test/unit/push/push_test.ts:115`). The two new samples are validated with every other one, by
  the TypeScript validators and the JSON Schema (`packages/protocol/test/samples_test.ts:1-2,120-141`).

### Docs
- INSTALL.md: `HERDR_RELAY_PUSH_SUBJECT` in §4's settings, and §7 "Notifications" (troubleshooting). DESIGN.md §4
  "Push": the test button. CHANGELOG.md 0.1.0 "Added". PROTOCOL.md "Push test" carries §2 and §3 in spec form.

## Open
- No device banner for a profile's `requires.herdr` mismatch or a stale mirror: both are in the bridge log only
  (`bridge/policy/profiles.ts:156-169`; `bridge/mirror.ts:283`). An unknown or untested Herdr version and drift are
  bannered through `hello.compat` (T46 section).
- Herdr's named app sounds (`playSound("done")`, `"blocked"`) are refused: they are app sounds, not files the asset
  route serves (T09s section).
