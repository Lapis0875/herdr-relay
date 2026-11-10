# Implementation amendments — candidate herdr-relay-c1, wave 1 (T02–T06)

Main-owned record of measured deviations from DESIGN-v2 / POLICY.md / SECURITY.md. Where these differ from the design docs, this file and the code win.

## T03 core client (`packages/bridge/src/core/`)
- Read-only by construction: only `hello`, `rpc.discover`, `doc.get`, `terminal.list`, `terminal.get`, `events.subscribe`, `terminal.attach` can be called; others are refused before reaching the core. Type mode exists but is never exercised against the real core in development.
- Minimum core version 0.1.19 (`CORE_MINIMUM_VERSION`); older generation-1 cores are refused with an `hc update` hint.
- `terminal.list.machines` is optional (live core omits it).
- Open: the `hc connect` child inherits the bridge environment incl. `HC_*` (Shepherdr strips `HC_SOCKET`, `HC_TERMINAL_ID`, `HC_CORE_ID`) → follow-up T03b spawns with `clearEnv` + explicit `HOME`/`PATH`.
- Open: possible size change between `terminal.get` and a type attach → handled in T11.

## T04 recompose + command classes (`packages/protocol/src/recompose.ts`, `packages/bridge/src/session/`, `packages/bridge/src/policy/commands.json`)
- Classification of the 71 commands: 20 session, 7 passthrough, 44 refused (structural per D3, plus Mac-window/app/clipboard commands such as `app.help/palette/settings/zoom_*/hide*`, `terminal.copy/paste/search`, `app.update*`, `app.quit`, `window.*`, each with its own toast text). This supersedes the §2.4 table in DESIGN-v2 / POLICY.md.
- Session-scoped (device-local, never sent to the Mac): additionally `space.next/prev`, `tab.next/prev`, `agent.next/prev`, `pane.go`, `mod.open`, `overlay.close`.
- Passthrough fills the device focus: `terminal.scroll`/`terminal.right_click` get the device's focused terminal, `terminal.show` its focused pane.
- R1 bars are fixed-size only (a node with `min`/`max` is never a bar); sizes are clamped to `min`/`max` (the `.state` saves `panel` at 24 px with `min` 280) [inferred Herdr behaviour].
- Phone/tablet-portrait: a panel's push/sheet route is on the stack exactly when that panel is not hidden in the session layout (keeps mods' `layout.toggle` correct).
- Drawer route path is `/drawer` (not `/<node id>`). `GroupScreen` has no field for a stack `header` mod yet (lstack does not use one).

## T05 policy + Seatbelt (`packages/bridge/src/policy/`, `packages/bridge/src/hosts/seatbelt*`, `packages/bridge/scripts/`)
- Seatbelt verification: macOS 27 records no sandbox denials in `log show` and `(trace)` writes nothing, so "zero denials" cannot be checked; `scripts/seatbelt-derive.ts` compares confined vs unconfined behaviour instead (re-run after any macOS or Deno upgrade). The template also allows the Homebrew dylibs `deno` loads (little-cms2, sqlite); the host's cwd must be the mod folder.
- Hosts are started as `sandbox-exec -f <profile> <absolute deno path> run …` with cwd = mod folder; scoped runners also spawn `deno` by absolute path.
- lh-scan profile: real script path `mods/lstack-herdr/components/lh-scan.mjs`; needs unscoped `--allow-env` with a cleared environment plus `PATH=/bin` (for `ps`). Deno/macOS add `DENO_NODE_SHIM_ACTIVE`, `__CF_USER_TEXT_ENCODING`.
- E4 (git) stricter than designed: refuses `--no-index`, `--textconv`; adds `--no-ext-diff --no-textconv`; `git branch` listing only; requires cwd or `-C`. Programs given as paths are refused (E16) except cockpit.json's `bin`.
- U2 note: a real (non `--check`) `sync.mjs` needs write access to `<appHome>/layouts` and `<appHome>` (temp files) — only relevant if U2 becomes "allow".
- U1–U3 defaults live only in `policy/user-decisions.ts` (pending user confirmation).

## T06 mod host (`packages/modhost/`)
- `localStorage` is per copy (AGENTS.md semantics); `storage.set` sends the copy's full map. Persisted per folder file holding one map per copy.
- Input widgets get a host `on_change`; bridge event args `[InputData]` or `[value]`; a submit with a changed value fires `change` first. `emit focus` args `[{focus_handle:n}]` / `["InputState:n"]`.
- Unknown APIs → `error {where:"unknown-api"}` once per name; render failures → `error {where:"render"}` with no tree.
- `presentUpdateNotes` throws "not supported remotely".
- Contract gaps → follow-up T02b: (1) restoring `localStorage` (e.g. `create.storage`), (2) a `HANDLER_KEYS` entry for TextView `on_link_click`, (3) `ClickState` in `SCHEMA_FILES`/samples. `test:modhost` needs `--permit-no-files` until T24.

## Integration evidence (Main, 2026-11-09)
- `deno task check` exit 0 (fmt + lint + check of protocol, bridge, web); `deno check --config packages/modhost/deno.json packages/modhost/src/main.js` exit 0; `deno task test` 41 passed / 0 failed.
- T04 acceptance re-run: 67/67. T06 harness re-run: 26 copies, 26 valid RecordedTrees, 0 with errors.
