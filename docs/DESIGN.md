# herdr-relay — architecture & feasibility design

Status: READY (design only; no project files written). Root: `<repo>` (to be created by implementers after approval).

Evidence legend: **[V]** personally read on this Mac (path given) · **[B]** stated in the brief, not re-run here · **[I]** inference. No shell was available to this role, so `hc --help`, `hc schema`, `herdr-app --help`, `xcrun simctl list` were **not executed**; tool availability below comes from filesystem inspection. Context7/Context8 MCP tools are **not mounted** in this session (only REA tools under `xd://`), so library versions below are the ones pinned on disk in Shepherdr's `package.json`, not upstream-verified docs.

---

## 0. One-paragraph verdict

Rendering this Mac's real layouts + mods on iPad/Android is feasible, but only with **server-side mod execution**: run the unmodified mod JavaScript on the Mac inside a Bun host that implements the `herdr` module and a serialising `gpui-kit`, stream a declarative element tree to thin clients (PWA first; native wrappers later), and relay terminals from herdr-core `terminal.attach` (observe mode) to xterm.js. Running the mods *in the browser* is blocked by `exec`/`hc`/`readTextFile`/`net`/`watchFolder`/`node lh-scan.mjs` semantics (all local-Mac side effects) and would require a TCP-over-WebSocket proxy to the cockpit hub; server-side execution removes every one of those blockers at the cost of one tailnet round-trip per interaction. Mobile recomposition is a pure function over the layout tree (fixed-width siblings in the root row → screens; stacks → tab/segment groups; floating → sheet), driven by intercepting `layout.*` commands per session. The desktop path (native Herdr on another PC + `hc machine add` + config sync) works for chrome/terminals/agents but degrades the cockpit and the lstack tree because those read Mac-local files/hub.

---

## 1. Feasibility per rendering path

### 1.1 Measured API surface (what the shim must cover)

Source files: `~/.config/herdr-app/gpui-kit.d.ts` (22,213 lines), `herdr.d.ts` (414 lines), `layouts/lstack-herdr.json`, `mods/{lstack-herdr-cockpit,lstack-herdr,workspace-chrome,tabs,files,changes}/*.js`. **[V]**

| Surface | Total declared | Used by the layout's mods | Notes |
|---|---|---|---|
| `NativeElement` methods (gpui-kit) | **3,308** = 3,146 generated no-arg style methods (the d.ts says so at line 1438) + 59 argument style methods (lines 1320–1436, counted) + 103 behavioural/slot methods (lines 606–1313, counted) | Behavioural methods observed: `child, children, when, id, map, on_click, on_mouse_down, on_mouse_up, on_mouse_move, on_hover, on_scroll_wheel, on_size_change, on_key_down, track_focus, hover, tooltip, transition, loop, spin, trigger, content, size_range, overflow_y_scrollbar, overflow_hidden, absolute/relative, cursor_*, truncate, whitespace_nowrap, font_family, shadow_*, opacity`; no `on_action/key_context/bind_keys/on_drop/dock_*` usage | The 3,146 no-arg names are Tailwind-style (`border_b_12`, `w_full`, `items_center` …): map them with a **name parser** (families × scale), not a 3,146-row table; unknown names must be logged and fail the coverage test, never silently ignored |
| `gpui-kit` module exports | `View, div, svg, image, list, uniform_list, PathBuilder, Background, FocusHandle, Window, Storage, Timer…` | **6** imported: `View, div, svg, image, PathBuilder, Background` + global `window.paint_path` (ui.js:966, plot.js, diagram.js) + global `localStorage` (agentsui.js:329) | `PathBuilder` methods used: `fill/stroke/move_to/line_to/arc_to/add_polygon/close/dash_array/build` → serialise to SVG path data |
| `gpui-base` exports (~70) | — | **15**: `h_flex, v_flex, InputState, Input, TextView, Editor, EditorState, h_resizable, resizable_panel, v_virtual_list, Scrollbar, VirtualListScrollHandle, HoverCard, TextareaState, Textarea` | `Editor` (code.js), `v_virtual_list` (diff.js, show.js, changes), `TextView.markdown/html` (reader.js, mail.js, meetings.js) need real client widgets |
| `Context` (`cx`) methods | 15 | **7**: `notify, spawn, timer.after, timer.every, stop_propagation, focus_handle, write_to_clipboard` | grep for `cx.new/bind_keys/sleep/open_url/read_from_clipboard/theme` → none |
| `herdr` module functions | **44** | **31**: `exec, hc, home, appHome, readTextFile, writeTextFile, knownAgents, run, spaces, agents, panes, setAgentOrder, terminals, focused, layout, layouts, commands, window, placement, theme, updates, settings, keys, openOverlay, closeOverlay, notify, props, shared, setShared, nextCommand, watchFolder` | unused: `machines, pickFolder, playSound, themes, fonts, presentUpdateNotes, telemetry, feedback*(6), sendFeedback` |
| Node-ish ambient modules | `buffer, path, url, crypto, zlib, console, process, os, fs/promises, net, websocket` | **2**: `net` + `buffer` (hub.js only) | `net.connect("127.0.0.1", port)` to the cockpit hub (hub.js:107) |

Layout inventory (`layouts/lstack-herdr.json`, 518 lines) **[V]**: 1 floating block (`queue`, right edge, peek 44) · root `row` → `sidebar` column (268 px, min 44, max 480, `chrome` bg; blocks `brand`/`cockpit-sidebar`/`sidebar-footer`) + `main-area` column (`topbar` row 42 px: `tabs` + `bell` 52 px; `center` **stack** of 9 children: `home` (row: `home-board` + hidden `home-agent` 600 px column with `agent-head` + `{agent:"focused"}`), `work` (row: `view` stack [`main` `{tab:"active"}` with pane header mod + `agent` column] + hidden `panel` row 420 px [stack `panel-body` of 6: show, review, runbook-panel, files, changes, tree + `activity` rail 44 px]), `inbox, runbook, todo, meetings, monitor, routines, mail`; `status` block 34 px). Mod copies: **20 `lstack-herdr-cockpit` blocks** (+1 pane-header copy per pane), 2 `workspace-chrome`, 1 `tabs`, 1 `files`, 1 `changes`; 3 terminal blocks (`main`, `agent-term`, `home-agent-term`). Keys: `keys.json["layout:lstack-herdr"]` has 26 chords → `lstack-herdr-cockpit.<command>` (e.g. `panel:tree`, `go:inbox`, `palette`). **[V]**

### 1.2 Host-side side effects the mods perform (the blockers for any client-side execution) **[V]**

| Call | Where | Semantics |
|---|---|---|
| `exec("node", [lh-scan.mjs, …])` | lh-tree-data.js:92/153/213/252, lh-transcript.js:80, lh-watch.js:167 (`sync.mjs`) | Reads `~/.omp` session transcripts and `~/.omp/agent/terminal-sessions/<tty>`, writes `~/.cache/lstack-herdr/scan-cache.json` (lh-scan.mjs header) |
| `net.connect` to cockpit hub | hub.js (reads `~/.config/herdr-app/cockpit.json` → `~/.cache/cockpit/hub.json` `{port, token}`; starts `cockpit hub start` when gone) | Hub on 127.0.0.1; one request per connection; token auth |
| `exec("env", [HOME=…, HERDR_APP_HOME=…, cockpit, …])` | hub.js:116 | cockpit CLI on the Mac |
| `exec("open"/"xdg-open"/"cmd")` | hub.js:19–21, editor.js:45 | opens URLs/apps on the Mac |
| `exec("env", [HERDR_APP_HOME=…, ~/.local/bin/herdr-app, "do", "pane.split", …])` | code.js:37 | needs the Mac window open |
| `exec("git", …)`, `readTextFile`, `writeTextFile`, `watchFolder` | code.js, files, changes, home.js:114, routines.js | Mac filesystem |
| `hc(["machine","ls","--json"])` | editor.js:22 | herdr-core CLI |
| `run("layout.select/show/hide")`, `run("agent.focus")`, `run("pane.split/close")`, `run("tab.new/settle")` | activity.js, agent-head.js, fleet.js, home.js, lh-home.js, lh-watch.js, lh-ui.js, palette.js | App commands; the `layout.*` ones must become **session-local** on a remote client |
| `openOverlay({kind:"window"|"dialog"|"popup"})`, `closeOverlay` | lh-tree-view.js, monitor.js, palette.js, reader.js, menu.js, kit.js | Overlays = more mod copies; `kind:"window"` can embed terminal blocks |

### 1.3 Paths

**(a-browser) PWA running the mods in the browser + Mac bridge for `herdr` data.** Verdict: **feasible only partially; not recommended.** Every row in §1.2 would need an RPC round-trip with a *different* latency/failure model than the mods assume, `net` needs a TCP-over-WS proxy to 127.0.0.1 (a lateral-movement primitive you must then lock to the hub port), `hub.js` starts processes (`cockpit hub start`), `watchFolder` becomes a long-poll, `localStorage` semantics diverge per device, and 850 KB × copies of mod JS ship to the phone. Nothing in it is impossible, but it reimplements the whole trust boundary twice.

**(a-server, RECOMMENDED) Server-driven UI: Bun mod host on the Mac + thin renderer clients.** The Mac runs `herdr-relay-bridge` which (1) loads the active layout and instantiates the mods' `View` classes exactly as Herdr does (one copy per block, `props()` per copy, overlays as copies), (2) provides the `herdr` module from herdr-core (`hc connect` JSON-RPC: `doc.get herdr-app`, `terminal.list`, `events.subscribe`), files (`layouts/*.json`, `layouts/.state/*.json`, `shared.json`, `settings.json`, `themes/*.json`, `programs.json`, `keys.json`) and `herdr-app do` for writes, (3) implements `gpui-kit`/`gpui-base` as **builders that record** a tree (`{tag, id, styles, handlers:[ids], children}`), (4) diffs trees per view and streams JSON patches over WebSocket, (5) receives events (`click`, `key`, `scroll`, `size`, `hover`, `input`) by handler id and runs the closure with a fresh `cx`. Terminals: separate binary channel per attach (observe mode), xterm.js on the client. Verdict: **feasible; all §1.2 blockers vanish** (they run where they always ran). Residual costs: RTT per event (Tailscale LAN/WiFi typically 5–40 ms **[I]**), `v_virtual_list` range callbacks need a round-trip (mitigate: send all rows when ≤ 400, window above that), `Input`/`Editor` need client widgets with local echo, hover styles must be sent as declarative `hover:{…}` style sets (they already are closures over a detached element—evaluate once at render), `hover(...)` on touch devices maps to `:active`.

Known gaps for (a-server), each with a mitigation:
1. **Theme palette of built-in presets** (`graphite/ink/moss/paper`) and the panel-colour derivation from `themes/*.json` live in the app binary, not in files (AGENTS.md "The look" section) **[V]**. Mitigation (preferred): an opt-in **mirror mod** `mods/herdr-relay-mirror/` that the user installs; it POSTs `theme(), settings(), themes(), fonts(), layout(), focused(), panes(), shared("…")` to `http://127.0.0.1:<bridge>/mirror` on each re-render (debounced via `cx.timer`). Fallback when the window is closed: last cached mirror snapshot. Secondary option: extract preset palettes from the Herdr binary with REA `search_strings` (read-only) — unverified whether palettes are string-encoded.
2. **`panes()` details** (title, branch, cwd, zoomed, focused): title/cwd from `terminal.get` (`CoreTerminal.cwd`, `status.title`) **[V shepherdr protocol.ts]**; branch via `git` exec like Shepherdr `model.ts:84`; zoom/focus are session-local.
3. **`run()` of structural commands** (`tab.new`, `pane.split`, `space.new`, `tab.settle`, `terminal.peek`) requires the Mac window (`herdr-app do`) — same limitation Shepherdr documents in `actions.ts`. Surface as a toast "needs the Herdr window open"; v2 may create terminals via core `terminal.run` with `herdr.space/herdr.tab` labels (AGENTS.md adoption rule) — but adoption is performed by the window, so still window-dependent **[V]**.
4. **`herdr-app do` acts on the Mac window** — `layout.*`, `agent.focus`, `pane.focus`, `space.select`, `tab.select` must be **intercepted** by the bridge and applied to the remote session's own state (Herdr's own rule: "connected screens share layout and live terminals, not their focus, zoom or attention" — AGENTS.md **[V]**). Everything else passes through.
5. **Fonts**: `settings.json` uses `"D2Coding ligature"` **[V]**; cockpit uses `"JetBrains Mono"` (ui.js:1102). Client ships JetBrains Mono (OFL) + system fallback; D2Coding is user-installed on the Mac — decision D7.
6. **Images/SVGs**: `svg("mods/<name>/icons/x.svg")` paths relative to `~/.config/herdr-app` → bridge serves a read-only allow-list (`mods/**`, `icons/**`, `my-icons/**`, `layouts/*.svg`).
7. **Native animation methods** (`spin`, `loop`, `transition`, `frames`) → CSS animations/transitions on the client; no server timers.
8. **Keyboard** — `track_focus` + `on_key_down` with GPUI keystroke strings (`"cmd-alt-b"`): client translates `KeyboardEvent` to GPUI `Keystroke::unparse` form; `keys.json` chords are dispatched by the bridge to `nextCommand()` of shown copies (mobile: a command palette surface instead of chords).
9. **Mod reloading**: Herdr reloads on file save; bridge watches `mods/**` and re-instantiates copies (Bun has real GC; the 17–25 MB/layout leak is Herdr's QuickJS **[B]**).
10. **Copy context**: `props()/nextCommand()/placement()` are copy-scoped while `globalThis` is shared across copies (hub.js:46 comment) → one realm per mod folder, copy resolved through `AsyncLocalStorage` set around `init/render/handler/task` entry points.

**(b) Native mobile apps (Flutter / React Native / SwiftUI+Kotlin) consuming the same bridge.** Verdict: **feasible later, not v1.** With (a-server) the client is a tree renderer + xterm; a Flutter/RN port is a second renderer for the same protocol (~the style parser + widgets). Native adds: APNs/FCM push (Apple Developer Program + Firebase accounts), store/sideload distribution, Keychain token storage. Nothing in the user goal needs it on day 1; iOS PWAs installed to the Home Screen support Web Push (iOS ≥ 16.4) **[I]**. Keep the protocol renderer-agnostic so (b) is additive.

**(c) Reuse/extend Shepherdr or ColliePWA.** Verdict: **borrow, don't extend.** Shepherdr 3.1.3 (`~/.local/share/shepherdr`) **[V]** is a Bun service + React/Vite/Tailwind/xterm PWA with proven pieces we should copy by design (not fork): `hc/client.ts` (JSON-RPC + framed channels; `hello {generation:1, framed:true}`, `rpc.discover`, 9-byte frame header `u32 channel | u8 kind | u32 len`, kinds data/credit/close/resize/focus/facts), `terminal.ts` (observe-only attach + 2-second typing attach at the terminal's own size, monotonic message ids + acks, no input replay), `auth.ts` (Tailscale identity header gate + loopback bearer token), `tailscale.ts` (`tailscale serve --bg --set-path <mount> <port>`, refuses Funnel), `push.ts` (Web Push VAPID/RFC 8291 with WebCrypto only), `live.ts` (named views, send only changed). Its UI model is chat/agent-centric and explicitly does not render layouts/mods **[B]**, and it is tied to its own layout (`mods/spaces-chat` check in spaces.ts:16). Extending it would entangle two products in one service. ColliePWA/Ovis/Roamgate: not installed, not verifiable here **[B]**; none advertises a gpui-kit renderer.

**(d) Other credible paths.** Screen streaming (`herdr-app shot`/VNC): `shot` returns the last rendered frame only, stale when occluded **[B]**; Screen Sharing is off; a pixel stream cannot recompose for phones → rejected. **Mirror mod** (above) is the one additional credible component and is folded into (a-server).

### 1.4 Verdict table

| Path | Feasible | Fidelity | Blockers | Recommendation |
|---|---|---|---|---|
| a-browser (mods in browser) | partial | high visual, broken behaviour for §1.2 | exec/hc/net/watchFolder/node scripts/fs, mod JS on device | no |
| **a-server (Bun mod host + thin renderer PWA)** | **yes** | high (same mod code), RTT per event | preset theme palette (mirror mod), window-dependent writes | **yes — v1** |
| b native apps | yes, later | same as a-server | push infra, distribution | v2 |
| c extend Shepherdr | yes technically | low (no layout model) | product entanglement | reuse patterns only |
| d screen streaming | no | pixel-exact | stale frames, no recomposition | no |

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

---

## 3. Mobile recomposition model (phone / tablet)

Pure function `recompose(layout, clickState, device) → ScreenGraph`, in a shared package used by the bridge (to decide which copies to instantiate) and the client (to navigate). Rules operate on node *structure*, never on ids.

**Device classes**: `phone` (shortest side < 600 dp), `tablet-portrait` (≥ 600 dp, width < 1024), `tablet-landscape` (width ≥ 1024), `desktop` (≥ 1280, pointer). iPad Air lands in tablet-*.

**Classification rules (applied top-down):**
1. `R1 bars` — a `block` or `row/column` child with fixed `size.px ≤ 72` along its parent's main axis is a **bar** (lstack: `brand` 46, `topbar` 42, `status` 34, `sidebar-footer` 69, `activity` 44, `agent-head` 34, `bell` 52). Bars stay in place on every class.
2. `R2 side panels` — in a `row`, a non-bar child with fixed `size.px` (or `min/max` resize bounds) is a **panel**; the weighted/unsized child is **main**. Leading panel = left, trailing = right. (lstack: `sidebar` 268, `panel` 420, `home-agent` 600.)
3. `R3 stacks` — a `stack` is a **screen group**; `active` (file, overridden by `layouts/.state/<name>.json`.`nodes[id].active`) is the shown child. Direct stack children are **destinations**.
4. `R4 floating` — a `floating` entry is a **sheet**; `peek` → collapsed handle.
5. `R5 hidden` — `hidden:true` (file or click state) → destination exists but is not mounted.
6. `R6 tab block` — `{tab:"active"}` is a **pane group**; its pane tree (core doc `tabs[].root`) is itself a split tree.
7. `R7 agent block` — `{agent:"focused"}` is a single terminal screen.

**Phone composition:**
- Root = `Navigator`. Home route = **main** of the root row with its bars; left panel → `drawer` route (edge-swipe from left or a leading-bar button); right panel → `push` route; nested panels inside main (e.g. `home-agent`, `panel`) → `push` routes too.
- Shell button (the drawer, or the device panel when there is no drawer) → the leading edge of the first row bar (lstack `topbar`); without one, the block bar the home screen starts with (Herdr `main`: `tabs`) is drawn as a row with the button in its own cell, which takes the mod's background and bottom line while the mod gives up as much of its leading padding as it can spare; otherwise it floats at the top-left. Bars across a column stay one line: mod text never wraps in them, and a line that does not fit is cut at its end — the last labelled item gives way first, labels ending in an ellipsis.
- Stack with ≤ 5 destinations → bottom segmented control; > 5 → the first 4 + "More" sheet (lstack `center` has 9 → `home, work, inbox, runbook` + More).
- Pane group → one pane at a time (horizontal pager), pane header mod kept as the pager's title row; zoom = no-op.
- Side-by-side `row` children that are both unsized (e.g. `home-board` + visible `home-agent`) → vertical column with the second collapsed into a push route.
- Sheets (`floating`) → bottom sheet; `peek` → a 44 px grab handle.
- **Command interception** (bridge, per session): `layout.show {id}` where id is a panel → `push(route(id))`; `layout.hide {id}` → `pop` if on top; `layout.toggle` → either; `layout.select {stack, child}` → if the stack is on the current route, switch destination; else `replace(route containing child)`; `layout.resize` → phone: no-op; tablet/desktop: the device's layout profile (below) when the node is one this device may resize and the size is of its kind, else a size click of this session only; `agent.focus/pane.focus/space.select/tab.select` → session focus state (+ navigate to the pane group route). Everything else → pass-through to `herdr-app do`.
- Mods keep working untouched because they only call `run("layout.*")`, read `layout()` (bridge returns the session's effective tree with `hidden/active` reflecting the navigator) and `shared(...)`.

**Tablet composition:** `tablet-landscape` = desktop tree, resizable like desktop (D12: a touch tablet drags dividers too; children of a `resizable: false` parent stay fixed), and `peek` floating kept. `tablet-portrait` = sidebar collapsed to its `min` (44 px rail; lstack sidebar mods already draw a compact rail under 160 px per AGENTS.md **[V]**) unless the device's profile expands it, right panel → overlay sheet from the right (not a split), stacks unchanged. iPad Split View widths change class live.

**Device layout profile (D12):** what a device resizes stays on that device, per layout and device class, and is never written to the Mac.
- Store: `<state>/layout-profiles/<device id>.json` (`local.json` for the loopback identity, shared by every loopback client) = `{"v":1,"layouts":{"<layout>":{"<class>":{"<node id>":{"px"?,"weight"?,"collapsed"?}}}}}`; compact JSON ≤ 64 KiB, directory 0700, file 0600, writes coalesced to one per second per device and atomic (a new random temp file created exclusively, then renamed); a profile left empty removes its file. An unreadable, oversized or malformed file is logged once and read as empty (the next write replaces it). Over the cap, whole layouts are dropped, least recently changed first, never the one being changed (a change that does not fit even alone is refused). Layout names and node ids are data (`__proto__` round-trips). The directory must be a real directory at `<real state dir>/layout-profiles` (else nothing is read or written there, logged); a symlinked profile file is never followed.
- Nodes: only `overridable(tree, class)` (protocol `recompose.ts`): split children of a row/column whose `resizable` is not `false`, with a size or bounds, not R1 bars, with a layout id, next to another non-bar child; none on a phone. The ScreenGraph marks them `resize: {kind, collapsible}` (with their bounds in `size.min`/`max` where the file has them), so the client takes eligibility from the latest graph, never from `hello.layout`. Unknown or ineligible ids are ignored when applied, never deleted; entries go only by a reset, the cap, or the device confirmed no longer paired.
- Order: Mac file → Mac `.state` clicks → session size clicks (mods' `layout.resize` on nodes outside the profile) → profile (`applyProfile`: `px` clamped to the file's `min`/`max`, `weight`, `collapsed` on R2 panels) → session-transient clicks (`hidden`/`active`). Neither the profile nor `hidden`/`active` changes eligibility, so what the bridge accepts is exactly what the graph marks `resize`. `layout()` (lead session), `hello.layout`, the ScreenGraph and its `overridden` (`profiledNodes()`: sorted ids of the `overridable()` nodes an entry actually resizes or collapses — a size of the node's kind, or `collapsed` on a collapsible one; a stale entry the profile ignores does not count) all reflect it.
- Sessions read the section of (device, layout name, class) when they start (a rotation re-hellos: a new session, its class's section), on `layout.switch`, and when another session of the same device changed it; the same layout name keeps its section across Mac edits (re-clamped). Every Mac layout edit or switch sends every session `patch.screens`.
- Changes: client `layout {action:"set", changes:[{node, size?:{px}|{weight}, collapsed?}, …]}` (1–8 changes, all or none: one ack, one rate unit, one write, one `patch.screens`; a weight pair is one message) / `layout {action:"reset", node?}` (also from `read` devices: the device's own view only) — the whole message is refused for a node not resizable here, a size of the other kind, `collapsed` on a non-panel, a node named twice, or a result over the cap; mods' `run("layout.resize", {id, px|weight})` writes the profile of its origin's device (no origin or a downgraded one: no device; phone: ok, no-op; mods cannot set `collapsed`). At most 20 such changes per second per session (`layout` messages, `layout.resize` commands and mod runs together); the rest are refused (`ack`; mod runs are dropped without a toast), logged once per burst. The session gets `patch.screens`.
- Lifecycle: a profile is deleted only after a successful read of the device list no longer names the device — at bridge start and after every 2 s device-list sweep (`local` stays). A revocation while the list is unreadable is fail closed for sessions and tokens but keeps every profile.
- Mod-internal splits (`h_resizable`/`v_resizable` inside one mod) are not layout nodes: they stay client-local. Mod copies are shared across devices, so a copy shown by two devices at different widths renders at the last reported width (accepted).

**Example transform of `lstack-herdr` on a phone** (click state from `layouts/.state/lstack-herdr.json` **[V]**: `center.active=work`, `panel.hidden=false`, `panel-body.active=files`, `sidebar.px=320`):

```
Navigator
├─ route "/"            (main-area)
│   ├─ bar  topbar      [tabs | bell]                       (R1)
│   ├─ group center     bottom segments: home · work · inbox · runbook · More(todo, meetings, monitor, routines, mail)   (R3)
│   │    active = work → pane group `view`: pager over panes of the active tab, header mod `app:"pane"` per pane; `agent` = alt destination of stack `view`   (R6, R3)
│   └─ bar  status                                          (R1)
├─ route "/drawer"      (sidebar, R2 leading) → brand bar · cockpit-sidebar · footer bar
├─ route "/panel"       (panel, R2 trailing) → segments show · review · runbook · files · changes · tree (stack panel-body) + activity rail becomes the segment row   (currently hidden:false → mounted as the top route on first open)
├─ route "/home-agent"  (R2 inside home) → agent-head bar + {agent:"focused"} terminal
└─ sheet  queue         (floating, peek 44 → handle)        (R4)
```

Golden-test fixture: `lstack-herdr.json` + the `.state` file above → the ScreenGraph JSON above (T04).

---

## 4. Security, push, offline/reconnect

**Network/identity (Tailscale-only).** Bridge binds `127.0.0.1:<port>` only; published with `tailscale serve --bg --set-path /herdr-relay <port>` on the Mac's existing MagicDNS name `<mac>.<tailnet>.ts.net` (Shepherdr already uses `/shepherdr`; both coexist by path) **[V tailscale.ts]**. Refuse to serve when Funnel is enabled on that port (Shepherdr rule). Gate (copy Shepherdr `auth.ts` semantics): `Tailscale-User-Login` must equal the machine owner's login from `tailscale status --json`, `Host` must equal the DNS name, connections must come from tailscaled (peer check), writes/WebSockets require `Origin === https://<dns>` and a custom header; cross-site requests rejected.

**Device pairing (second factor, per device).** First visit → `herdr-relay pair` on the Mac prints a 6-digit code (TTL 2 min); the device enters it → the bridge issues a device record `{id, name, scope, created}` in `~/.herdr/herdr-relay/devices.json` and sets an httpOnly, Secure, SameSite=Strict cookie; WebSocket upgrades carry a one-time ticket minted over HTTPS. Scope per device: `read` (view + terminals observe) or `act` (typing, `run`). Revoke via CLI. Local dev (simulators/emulators, no Tailscale headers): loopback bearer token in `~/.herdr/herdr-relay/token`, never accepted with an `Origin` header (Shepherdr rule).

**Trust boundary for mods.** Mods are trusted code already (AGENTS.md **[V]**); they run on the Mac as the user, exactly as in Herdr, limited to the mod folders referenced by the active layout. Clients never receive mod code — only trees. Write-capable `herdr` calls triggered by a `read`-scope device are refused at the bridge (`run`, `writeTextFile`, `setShared` persistence, typing).

**Push (agent done/blocked).** Web Push (VAPID ES256, RFC 8291 aes128gcm) with WebCrypto, modelled on Shepherdr `push.ts` **[V]**; subscriptions in `~/.herdr/herdr-relay/push.json`. Triggers from `events.subscribe`: `status.state` transitions `working→blocked` (title "Needs you") and `working→idle` (title "Finished") per terminal/turn, deduped by `(address, turn)`; muted while any device socket reports `visible:true`; tap opens the pane route. iPad: PWA must be installed to Home Screen; the Android PWA works in Chrome. No APNs/FCM in v1.

**Test notification.** The device panel's "Send Test Notification" (`push.test`) sends one notification to that device's own subscriptions, also while a device is visible, at most one per 5 s per device, and shows what the push service answered (AMENDMENTS-c1-wave4 "Push end to end").

**Offline/reconnect.** Client keeps the last ScreenGraph + trees + snapshot in IndexedDB and renders them greyed with a "stale since HH:MM" banner. WebSocket reconnect with backoff 1→2→5→10→30 s; `hello {since: seq}` resumes from the bridge's patch ring (last 512 patches, else full snapshot). Terminals re-attach observe-only; typed input never replayed; pending `run` acks time out at 15 s (core default) and surface as toasts. Bridge ↔ core: on `disconnected` from `hc connect`, re-negotiate and emit `reset` (Shepherdr `live.ts` pattern).

---

## 5. Project structure, module boundaries, protocol, stack

### 5.1 Repository layout (`<repo>`)

```
herdr-relay/
  package.json            bun workspaces; scripts: dev, build, test, typecheck
  bunfig.toml
  tsconfig.base.json
  packages/
    protocol/             shared TS types + JSON Schemas (bridge ⇄ client); recompose(); gpui style-name parser
    bridge/               Bun service (Mac): core client, herdr-module impl, mod host, tree differ, terminal relay, auth, tailscale, push, mirror endpoint
    web/                  React 19 + Vite PWA: tree renderer, widgets (xterm, markdown, code, input), navigator, sw.js, manifest
    herdr-mods/
      herdr-relay-mirror/  optional mod the user installs into ~/.config/herdr-app/mods (POSTs live app facts to the bridge)
  tools/
    sync-config/          Mac→PC rsync + keys.json section merge for the desktop path
    device-tests/         Playwright device-emulation runs; simctl/avd helper scripts
  docs/
    DESIGN.md (this), PROTOCOL.md, RECOMPOSE.md, SECURITY.md, DEVICES.md
```

Boundaries: `protocol` has no runtime deps and is the only shared contract; `bridge` never imports `web`; `web` never imports Bun APIs; the mirror mod imports only `herdr`/`gpui-kit` and `fetch`.

### 5.2 Bridge protocol contract (WebSocket `/herdr-relay/ws`, JSON text frames + binary terminal frames)

Client → bridge:
```
hello      {v:1, device:string, since?:number, class:"phone"|"tablet-portrait"|"tablet-landscape"|"desktop", viewport:{w,h,dpr}}
nav        {id, action:"push"|"pop"|"select"|"replace", route?:string, stack?:string, child?:string}
event      {id, view:string, handler:number, kind:"click"|"mousedown"|"mouseup"|"mousemove"|"hover"|"wheel"|"key"|"size"|"input"|"link", data:object}
command    {id, name:string, args?:object}                  // keys.json chord or palette entry → nextCommand()/run()
term.open  {id, terminal:string, mode:"observe"|"type"}     // binary follows on channel; resize never sent by remote
term.close {id, terminal}
visible    {visible:boolean}
push.sub   {subscription:PushSubscription}
```
Bridge → client:
```
hello      {v:1, seq, session, layout:{name, tree}, screens:ScreenGraph, theme, settings, fonts, scope:"read"|"act"}
snapshot   {seq, spaces, agents, terminals, panes, focused, shared}        // full
patch      {seq, views:[{view, ops:JSONPatch[]}], state?:JSONPatch[], screens?:ScreenGraph}
view.tree  {view, tree:ElementTree}                                         // first render of a copy
overlay    {id, kind:"dialog"|"popup"|"window", view, at?, width?, height?, frame?}
ack        {id, ok:boolean, error?:string}
toast      {title, body?, level?, action?}
term.size  {terminal, cols, rows}                                           // then binary frames [u32 channel][bytes]
reset      {}
```
`ElementTree` node: `{k:"el"|"text"|"svg"|"image"|"path"|"terminal"|"view", id?:string, tag?:string, style:Record<string,string|number>, states?:{hover?:Style, active?:Style, focus?:Style}, anim?:{spin?:ms, loop?:{prop,from,to,period}, transition?:[prop,policy][], frames?:[string[],ms]}, on?:{click?:number, mousedown?:{left?,right?,middle?}, …}, widget?:{type:"input"|"textarea"|"editor"|"markdown"|"html"|"vlist"|"hovercard"|"resizable"|"scrollbar", state:string, props:object}, children?:Node[]}`. Handler ids are per view and invalidated on each view re-render; stale ids are acked `ok:false` silently.

Invariants: `seq` strictly increases; a `patch` never references a view the client has not received `view.tree` for; terminal binary frames only after `term.size`; the bridge never sends mod source; `scope:"read"` sessions receive `ack {ok:false, error:"read-only device"}` for `event` kinds `key`/`input` and for `command`.

### 5.3 Stack choices (versions = pinned on this Mac in Shepherdr's package.json **[V]**; Context7 unavailable to confirm newer)

| Layer | Choice | Rationale | Alternative |
|---|---|---|---|
| Bridge runtime | **Bun 1.4.x** (`~/.bun/bin/bun` present **[V]**), TypeScript | `Bun.serve` HTTP+WS in one, `bun test`, no build step; Shepherdr precedent on this Mac | Node 22.23.2 (`~/.nvm`) + `ws`; needed if Bun's module-resolution plugin cannot alias bare specifiers at runtime (**verify in T01**: Node's `module.register` loader hooks are the fallback) |
| Mod host | Bun ES-module loading of `~/.config/herdr-app/mods/<name>/main.js` with a resolver mapping `gpui-kit, gpui-base, gpui, herdr, net, buffer, fs/promises, process, os, path, crypto, zlib, websocket, console` → `packages/bridge/src/shim/*`; `AsyncLocalStorage` for copy context | runs the real mod code unmodified | QuickJS via wasm (closer to Herdr, slower, more work) |
| Core access | `hc connect` child process (stdio) with JSON-RPC 2.0 + framed channels, generation 1 (`protocol.ts` **[V]**) | documented, used by Shepherdr; no Unix-socket path guessing | direct socket once `hc schema`/socket path is confirmed |
| Web client | **React 19.3 + Vite 8 + Tailwind 4 + TypeScript 5.9**, `@xterm/xterm 6.0` + `addon-unicode11`, `marked 18` + `dompurify 3`, `highlight.js 11` | same toolchain already proven for a Herdr PWA on this Mac; xterm is the only serious terminal in browsers | Preact (smaller) — not worth diverging from the precedent |
| Code widget | read-only `highlight.js` `<pre>` in v1 | `Editor` is used by one mod (`code.js`) and `files`; editing from a phone is out of v1 scope (D6) | CodeMirror 6 when editing is in scope |
| Virtual list | client windowing with server `range` callback; full render ≤ 400 rows | matches `v_virtual_list(id, count, sizes, key, render(range))` | — |
| Style mapping | `protocol/src/gpui-style.ts`: name parser → CSS (`w_4`→16px, `items_center`→align-items, `text_sm`…), generated-name list from gpui-kit.d.ts lines 1441–20269 used only in tests | avoids a 3,146-row table; test proves 100 % of names parse | — |
| Push | Web Push via WebCrypto (port of Shepherdr `push.ts` design) | zero external accounts | APNs/FCM for native (v2) |
| Native (v2) | Capacitor or Flutter renderer over the same protocol | protocol is renderer-agnostic | — |

### 5.4 Data sources used by the bridge's `herdr` implementation

| `herdr` fn | Source |
|---|---|
| `spaces(), panes()` structure | core `doc.get {name:"herdr-app"}` → `{spaces:[{id,name,folder,tabs:[{id,name,root}]}]}` (Shepherdr `core/spaces.js:42` **[V]**), refreshed on `event {type:"doc", data.name:"herdr-app"}` |
| `terminals(), agents()` | `terminal.list` + `events.subscribe` stream; `agents()` = terminals with `status` |
| `focused(), layout(), placement()` | session state (remote-local) seeded from `view.json` + `layouts/<name>.json` + `layouts/.state/<name>.json` |
| `theme(), settings(), fonts(), updates(), commands(), keys(), layouts()` | mirror mod snapshot (preferred) / `settings.json` + `themes/*.json` + `keys.json` + `herdr-app commands` + `layouts/*.json` |
| `shared(), setShared()` | `shared.json` (read + fs.watch) with a session-local overlay; persistence policy = D5 |
| `run()` | intercept table (§3) else `herdr-app do <name> <json>` |
| `exec, hc, readTextFile, writeTextFile, watchFolder, knownAgents, home, appHome, window` | real implementations on the Mac (child processes, fs, fs.watch); `window()` → `{platform:"macos", titlebar:"none", buttons:false}` |
| `openOverlay/closeOverlay/notify/nextCommand/props` | bridge view manager |

---

## 6. Workstreams (bounded tasks)

Owners: **BE** = backend-implementer, **UI** = ui-designer, **TW** = testcode-writer. Every task lists allowed paths; anything outside is forbidden for that task. No task writes to `~/.config/herdr-app` except the user-installed mirror mod (T09, by the user).

| ID | Goal | Owner | Allowed paths | Depends on | Acceptance | Verification |
|---|---|---|---|---|---|---|
| T00 | Repo scaffold: workspaces, tsconfig, bunfig, lint, `docs/` with this design split into PROTOCOL/RECOMPOSE/SECURITY/DEVICES | BE | repo root, `docs/` | — | `bun install` + `bun test` (empty) + `bun run typecheck` succeed | Main runs the three commands |
| T01 | **Spike (go/no-go, ≤ 1 day):** load `mods/lstack-herdr-cockpit/main.js` under Bun with bare-specifier aliasing and `AsyncLocalStorage` copy context; instantiate `app:"status"` and `app:"activity"` copies with a stub `herdr`; print the recorded tree | BE | `packages/bridge/src/host/**`, `packages/bridge/src/shim/**` | T00 | tree for both copies produced without editing mod files; if Bun cannot alias, document Node `module.register` path and switch runtime (D2) | TW adds `host.spike.test.ts` asserting non-empty trees and zero unknown style names |
| T02 | `protocol` package: TS types + JSON Schemas for §5.2, `ElementTree`, `ScreenGraph`; gpui style-name parser | BE | `packages/protocol/**` | T00 | schemas validate sample messages; parser maps every generated name | TW: T20 |
| T03 | Core client: `hc connect` negotiation (generation 1, framed), `events.subscribe`, `terminal.attach` observe/type, `doc.get`, `terminal.list/get`, reconnect + `reset` | BE | `packages/bridge/src/core/**` | T00 | live `terminal.list` and doc read against this Mac's core; disconnect → reconnect within 5 s | TW: T21 (fake core server) |
| T04 | `recompose()` in `protocol` + session command interception table | BE | `packages/protocol/src/recompose.ts`, `packages/bridge/src/session/**` | T02 | lstack fixture → ScreenGraph in §3 for phone/tablet-portrait/tablet-landscape; `layout.show {id:"panel"}` on phone → `push("/panel")` | TW: T22 golden tests |
| T05 | `herdr` module implementation (§5.4) incl. `shared.json` overlay, `herdr-app do` runner, file allow-list static route | BE | `packages/bridge/src/herdr/**`, `packages/bridge/src/static.ts` | T03 | all 31 used functions implemented; unused 13 throw `not supported remotely` with the function name | TW: T23 |
| T06 | View manager: copies per block/overlay/pane-header, `cx` object (7 methods + `timer`), render scheduling, tree diff → `patch`, handler registry, `nextCommand` routing, mod folder watch + reload | BE | `packages/bridge/src/views/**` | T01, T02, T05 | all 20 cockpit copies + 5 shipped-mod copies of lstack render; a click on `activity` tab changes `panel-body.active` in session state | TW: T24 headless harness |
| T07 | WebSocket server, auth gate, pairing CLI (`herdr-relay pair/devices/revoke`), tailscale serve helper, loopback dev token | BE | `packages/bridge/src/server/**`, `packages/bridge/src/auth/**`, `packages/bridge/bin/**` | T02 | gate matrix (tailnet owner / other user / wrong host / cross-site / loopback token / token with Origin) behaves as §4; serve refuses Funnel | TW: T25 |
| T08 | Terminal relay (observe attach per visible pane; type attach for `act` scope; `term.size`; backpressure 1 MiB) + Web Push service | BE | `packages/bridge/src/terminal/**`, `packages/bridge/src/push/**` | T03, T07 | remote typing never resizes the Mac terminal (cols/rows unchanged in `terminal.get` before/after); push fires once per `(address, turn)` transition | TW: T26 |
| T09 | Mirror mod `herdr-relay-mirror` (optional install): debounced POST of theme/settings/fonts/layout/focused/panes/shared to `127.0.0.1:<port>/mirror` with the loopback token; bridge endpoint + staleness | BE | `packages/herdr-mods/herdr-relay-mirror/**`, `packages/bridge/src/mirror.ts` | T05 | `herdr-app check packages/herdr-mods/herdr-relay-mirror` passes (run by Main/user); bridge theme equals mirrored theme within 1 s of a theme switch | TW: T23 covers fallback path |
| T10 | Desktop path tooling: `tools/sync-config` (rsync include list from §2, keys.json section merge, dry-run default) + `docs/DESKTOP.md` (Remote Login on Tailscale interface, `hc machine add`, cockpit install on PC) | BE | `tools/sync-config/**`, `docs/DESKTOP.md` | T00 | dry-run prints exactly the §2 "yes" set and nothing from the "no" set | TW: T27 |
| T11 | Patch proposal for `mods/lstack-herdr/components/lh-tree-data.js` etc.: `exec/readTextFile {on: space.machine}` for remote spaces; delivered as a diff under `tools/lstack-remote-patch/` — **not applied** to `~/.config/herdr-app` (user decision D9) | BE | `tools/lstack-remote-patch/**` | T10 | diff applies cleanly to a copy of `mods/lstack-herdr`; `sync.mjs` regenerates fork | Main/user applies and runs `herdr-app check` |
| T12 | Web shell: WS client with resume, IndexedDB cache, stale banner, Navigator (routes/segments/drawer/sheet from ScreenGraph), PWA manifest + sw.js + push subscription UI, pairing screen | UI | `packages/web/src/app/**`, `packages/web/public/**` | T02, T04 | installable on iPadOS Safari and Android Chrome; reconnect resumes with `since` | TW: T28 Playwright |
| T13 | Tree renderer: `ElementTree` → DOM/React with style map, `states` (hover/active/focus), animations, SVG `path`, images, handler event emission with GPUI keystroke encoding | UI | `packages/web/src/render/**` | T02 | renders the recorded trees from T24 fixtures pixel-plausibly; unknown node kinds render a visible red placeholder | TW: T29 snapshot tests |
| T14 | Widgets: xterm terminal (observe size, scale-to-fit vs scroll per D8), markdown/html (marked+DOMPurify), input/textarea with local echo, read-only code, virtual list windowing, hover card, resizable (touch dividers; sizes kept per device — amended by D12) | UI | `packages/web/src/widgets/**` | T13 | each widget has a story page; terminal shows this Mac's live `t1` | TW: T28 |
| T15 | Phone/tablet UX polish: bottom segments + More sheet, drawer edge-swipe, pane pager, safe-area insets, 44 px touch targets, dark/light from theme | UI | `packages/web/src/app/**`, `packages/web/src/styles/**` | T12–T14 | lstack phone ScreenGraph navigable end-to-end on an iPhone-size viewport and iPad portrait | TW: T28 device matrix |
| T20 | Style parser tests: extract the 3,146 generated names from `gpui-kit.d.ts` (fixture copy in repo) → every name parses; 59 arg methods map; negative: `p("auto")` rejected like the runtime | TW | `packages/protocol/test/**`, `fixtures/gpui-kit.d.ts` | T02 | — | `bun test` |
| T21 | Fake core: in-process JSON-RPC/framed server emitting hello/discover/list/attach/events; tests for negotiate, framing boundary splits, disconnect→reset, oversized frame rejection | TW | `packages/bridge/test/core/**` | T03 | — | `bun test` |
| T22 | Recompose golden tests (lstack, main, terminals, win98 fixtures) × 4 device classes; command interception table tests; negative: unknown node ids in `.state` ignored | TW | `packages/protocol/test/recompose/**`, `fixtures/layouts/**` | T04 | — | `bun test` |
| T23 | `herdr` impl tests: doc→spaces/panes mapping, shared overlay precedence, `run` interception vs pass-through (mock `herdr-app`), file allow-list (path traversal `../` rejected), mirror fallback | TW | `packages/bridge/test/herdr/**` | T05, T09 | — | `bun test` |
| T24 | Headless mod harness: load the real six mods from a **read-only fixture copy** of `~/.config/herdr-app/mods/*` (copied into `fixtures/herdr-home/` by Main, never the live folder), render every lstack block with stub data, assert zero unknown style names / unimplemented `herdr` calls; record trees as renderer fixtures | TW | `packages/bridge/test/views/**`, `fixtures/herdr-home/**` | T06 | — | `bun test` |
| T25 | Auth matrix tests (§4) + pairing code TTL/one-time + WebSocket ticket replay rejection | TW | `packages/bridge/test/auth/**` | T07 | — | `bun test` |
| T26 | Terminal relay tests (no resize on type; backpressure close; ack monotonicity) + push dedupe/mute tests with fake subscriptions | TW | `packages/bridge/test/terminal/**`, `packages/bridge/test/push/**` | T08 | — | `bun test` |
| T27 | sync-config dry-run tests against a fixture home | TW | `tools/sync-config/test/**` | T10 | — | `bun test` |
| T28 | Playwright device runs (iPhone 15/iPad Air/Pixel 8 emulation) against bridge + fake core; iOS Simulator and Android emulator smoke scripts (below) | TW | `tools/device-tests/**` | T12–T15 | — | Main runs scripts |
| T29 | Renderer snapshot tests from T24 trees; a11y check (touch target ≥ 44 px) | TW | `packages/web/test/**` | T13 | — | `bun test`/vitest |

**Integration order:** T00 → T01 (go/no-go) → {T02, T03} → {T04, T05, T07} → T06 → T08 → T09 → UI T12/T13 (parallel with T06 using T24 fixtures) → T14 → T15 → device verification. T10/T11 are independent of the client and can run any time after T00. Dependent tasks are never parallel; shared contracts (`protocol`, fixtures, lockfile) are owned by BE (T02) and TW (fixtures) respectively.

**Device verification facts (filesystem) [V]:**
- iOS: `/Applications/Xcode.app` present with `iPhoneSimulator.platform`; runtime volume `/Library/Developer/CoreSimulator/Volumes/iOS_24A434`; iPad device types present (`iPad Air (5th gen)`, `iPad mini (A17 Pro)`, `iPad (10th gen)`, …); **no simulator devices created** (`~/Library/Developer/CoreSimulator/Devices/` holds only `device_set.plist`) → `xcrun simctl create "iPad Air" "iPad Air (5th generation)" <runtime>` first. Simulator Safari reaches the bridge at `http://127.0.0.1:<port>` with the loopback token; Web Push cannot be tested in Simulator — needs the real iPad Air on the tailnet **[B]**.
- Android: `~/Library/Android/sdk` with `emulator/`, `platform-tools/adb`, `system-images/android-35/google_apis/arm64-v8a`, `platforms/android-36, android-37`, `build-tools/36,37`, `cmdline-tools/latest`; **no AVD** (`~/.android/avd` absent); Android Studio absent; Java via `/opt/homebrew/opt/openjdk`. Create an AVD with `avdmanager`, reach the Mac via `10.0.2.2:<port>` (loopback token). REA `xd://mcp__rea_list_adb_devices` / `capture_adb_screen` are available for screenshots.
- Real devices: iPad Air on the tailnet via `https://<mac>.<tailnet>.ts.net/herdr-relay/` once `tailscale serve` is set (user action, D4).

---

## 7. Decisions for the user (options → recommendation)

1. **Client form (클라이언트 형태)** — (a) PWA only; (b) PWA now + native wrappers later; (c) native first. **Recommend (b)**: PWA covers iPad/Android immediately with Web Push; protocol stays renderer-agnostic.
2. **Bridge runtime (브리지 런타임)** — Bun vs Node 22 (both installed). **Recommend Bun**, with T01 as the go/no-go on bare-specifier aliasing; fall back to Node `module.register` if it fails.
3. **Layout scope for v1 (지원 레이아웃 범위)** — (a) `lstack-herdr` only; (b) any personal layout + shipped mods `tabs/files/changes/workspace-chrome`; (c) every layout incl. `win98`. **Recommend (b)** — the renderer is generic; `win98` (one mod drawing a desktop) is a stretch goal validated by T22 fixtures only.
4. **Exposure (노출 방식)** — tailscale serve on the existing MagicDNS host (path `/herdr-relay`) vs a dedicated TCP port on the tailnet IP. **Recommend serve**: HTTPS cert + identity headers for free; required for Web Push and PWA install.
5. **`setShared` persistence from mobile (shared 상태 저장)** — (a) session-local only; (b) write back to `shared.json`. **Recommend (a)** for v1: the app owns `shared.json` and concurrent writes risk clobbering; revisit with the mirror mod as the writer.
6. **Write scope on mobile (모바일 쓰기 권한)** — (a) read-only; (b) view + typing + `run` for non-structural commands; (c) everything incl. `tab.new/pane.split/space.close`. **Recommend (b)** per device scope; (c) is window-dependent anyway and destructive on a small screen.
7. **Fonts (글꼴)** — bundle JetBrains Mono (OFL) and use system fallback vs also shipping D2Coding (OFL, Korean glyphs). **Recommend shipping both**; terminals on a phone benefit from the Korean monospace.
8. **Terminal sizing on phones (터미널 크기)** — (a) observe at the Mac's cols/rows, scale to fit width; (b) observe, horizontal scroll at 1:1; (c) full attach that resizes the agent's terminal for everyone. **Recommend (a)** with pinch-to-1:1; never (c) — it would reflow the Mac window.
9. **Desktop path & lstack remote patch (데스크톱 경로)** — (a) ship `sync-config` + patch proposal only (T10/T11); (b) also apply the `on:`-aware patch to `mods/lstack-herdr` now. **Recommend (a)**; apply (b) only when a second PC is actually set up (needs Remote Login + cockpit on the PC).
10. **Mirror mod install (미러 모드 설치)** — install `herdr-relay-mirror` into `~/.config/herdr-app/mods` (exact theme/settings/panes truth, requires the window) vs file-derived approximation only. **Recommend install**; it is read-only and tiny, and it is the only exact source for preset palettes.
11. **iPad composition (iPad 구성)** — desktop-like split in landscape with rail+sheet in portrait (as §3) vs phone-style navigation everywhere. **Recommend §3** (confirming the brief's assumption).
12. **Push transport (푸시)** — Web Push only (v1) vs APNs/FCM (needs Apple Developer Program + Firebase). **Recommend Web Push**; revisit with native wrappers.

---

## 8. Risks needing a parent decision

- **R1 Bun aliasing of bare specifiers at runtime** — unverified here; T01 resolves it in a day (fallback Node). 
- **R2 `hc connect` without a shell check** — protocol facts come from Shepherdr's client (generation 1, methods list) not from `hc schema` run here; Main should run `hc schema | head` and `hc connect` hello once to confirm generation/version (core 0.1.18 per brief).
- **R3 Preset theme palettes** — blocked without the mirror mod or binary extraction (D10).
- **R4 Window-dependent writes** — structural commands fail when the Mac window is closed; acceptable (same as Shepherdr) but must be stated in the UI.
- **R5 Event RTT on `Input`/virtual lists** — acceptable on tailnet LAN; degrade gracefully on cellular (local echo, larger windows).
- **R6 Mod behaviour that assumes one window** — e.g. `lstack-herdr-cockpit.go:<child>` keys and `shared("lstack-herdr-cockpit.view")` are shared across copies; two remote sessions + the Mac share `shared.json` reads but have separate overlays (D5), so the Mac and a phone may disagree on `lstack-herdr-cockpit.app` — intended, mirrors Herdr's "not their focus" rule.
