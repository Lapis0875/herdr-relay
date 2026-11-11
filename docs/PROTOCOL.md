# herdr-relay — protocols

Split by T00 on 2026-11-09; text copied verbatim from [DESIGN-v2.md](DESIGN-v2.md) §3.4, §1.5, §1.7 and from
[DESIGN.md](DESIGN.md) §5.2 (v1, carried forward by DESIGN-v2 §3.4 with the amendments listed there). Owner of the
contract: **T02** (`packages/protocol/**`: TS types + JSON Schemas). Evidence legend as in DESIGN-v2 (**[V]** read on
this Mac · **[M]** measured by a spike · **[I]** inference).

Two protocols:

1. **Client ⇄ bridge** — WebSocket `/herdr-relay/ws` (DESIGN.md §5.2, amended by DESIGN-v2 §3.4).
2. **Bridge ⇄ mod host** — token-authenticated NDJSON over TCP (DESIGN-v2 §1.5).

---

## Protocol package (`packages/protocol`) — DESIGN-v2 §3.4

Runtime-dependency-free TS; the only shared contract; owned by BE (T02). Contents:
- `messages.ts` — client⇄bridge WebSocket messages (DESIGN §5.2, carried forward unchanged except: `hello` from bridge adds `fonts:{ui,mono,terminal}`, `hosts:[{folder,state,reason?,profile?}]` (`profile`: the folder's policy profile id, wave 4) and `compat?` (wave 4 item 7); new `toast.action.open?:string` (E11); `ack.error` codes enumerated: `read-only-device`, `structural`, `refused`, `stale-handler`, `host-down`).
- `tree.ts` — `RecordedTree` (host) → `ElementTree` (client) conversion; `ElementTree` node as DESIGN §5.2 plus `k:"error"`.
- `gpui-style.ts` — name parser (3,146 generated + 59 arg + 103 behavioural names **[V]**).
- `screens.ts`, `recompose.ts` — device classes and rules R1–R7 (DESIGN §3; resize bounds on tablet-landscape and the device layout profile: [Device layout profile](#device-layout-profile-be-1-2026-11-10)).
- `control.ts` — §1.5 types + JSON Schema (used by bridge and by modhost tests).
- `policy-log.ts` — decision record type (`{ts, folder, method, argv, decision, rule:"E4"…, reason?, session?, profile?}`) so SECURITY tests and docs share rule ids.
- `schema/*.json` — generated from the TS by a `deno task` and committed; tests validate samples both ways.

---

## 1. Client ⇄ bridge — DESIGN.md §5.2 (v1 text; v2 amendments above apply)

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

---

## 2. Bridge ⇄ mod host — DESIGN-v2 §1.5

### 1.5 Control channel (bridge ⇄ mod host)

Token-authenticated NDJSON over TCP `127.0.0.1:<ctlPort>` (one listener for all hosts), as the spike ran **[M]**. Why not stdio: with a Worker-free host stdio *could* carry protocol, but any mod code can `Deno.stdout.write` without a permission **[M]** and forge frames; with TCP the mod would need the token, which the entry reads from stdin **before** any mod code runs and keeps in a closure. A mod can `Deno.connect` to `<ctlPort>` (it is inside its `--allow-net`), so the bridge drops any connection that does not send a valid `hello` within 1 s, allows one connection per token, and rate-limits unauthenticated connects (≥ 20/min from a host → that host is killed and restarted).

Framing: one JSON object per line, `\n`-terminated, UTF-8. Max line 4 MiB (a `tree` over that kills the sending host — protects the bridge). The bridge writes with `writeAll` (partial `Conn.write` corrupted NDJSON in the spike **[M]**) and a per-connection write queue.

Messages (type field `t` host-level, `type` copy-level; defined in `packages/protocol/src/control.ts` as TS types + JSON Schema; the mod host is plain JS and does not import it):

bridge → host:
```
boot        {t, state:HostState, harden:true, mainUrl:"file://<appHome real>/mods/<folder>/main.js"}
create      {t, copy:"<folder>:<blockId>|overlay:<id>|pane:<id>", props:object, placement:Placement|null}
state       {t, state:HostState}                      // full snapshot, debounced 16 ms, ~20 KB measured [M]
shared      {t, key, value}                           // one key; faster than a full state push
render      {t, copy}
event       {t, copy, handler:number, args:unknown[], origin:{session:string}}
command     {t, copy, command:string, origin:{session}}
rpc-result  {t, id:number, ok:boolean, value?:unknown, error?:string}
close       {t, copy}
ping        {t, n}
exit        {t}
```
host → bridge:
```
hello       {t, token, pid, folder}                    // first line; else the connection is dropped
loaded      {t, ms, exports?:string[], error?:string}
created     {t, copy, ms}
tree        {t, copy, n:number, ms, tree:RecordedTree}  // whole tree per render; the bridge diffs
emit        {t, copy, method:"run"|"notify"|"openOverlay"|"closeOverlay"|"setShared"|"setAgentOrder"|"playSound"|"write_to_clipboard"|"net.close"|"focus", args, origin?}
rpc         {t, id, copy, method:"readTextFile"|"writeTextFile"|"exec"|"hc"|"knownAgents"|"watchFolder"|"net.connect"|"net.write"|"net.read"|"storage.set", args, origin?}
event-result{t, copy, handler, ok, error?}
error       {t, copy|null, where, error}               // paths stripped before any device sees it [M bun: Error().stack leaks paths]
pong        {t, n, copies:string[], heap:number}
```
`RecordedTree` = `{tag, id?, style:[[method, ...args]], handlers:[{event, id, args?}], children:[...], states?, slots?, props?}` (spike shape **[M]**, kept; `packages/protocol/src/tree.ts` converts it to the client `ElementTree` with the style parser).

Trust rule: the bridge **attributes every message to the folder of the connection it arrived on**, never to the `copy`/`origin` the message claims. A `copy` not prefixed `<folder>:` is logged `forged-*-ignored` and dropped (as the spike did **[M]**). `origin.session` is used only to pick the device that receives a toast/`open <url>` and to look up that session's **scope in the bridge's own table**; a forged or stale session id yields `scope:"read"` (most restrictive), so forging can only reduce privileges.

---

## 3. How trees and events flow — DESIGN-v2 §1.7

```
device ──WS event {view, handler, kind, data}──▶ bridge.session ──▶ view manager (scope check, handler id → copy)
   ──ctl event {copy, handler, args, origin}──▶ mod host (ALS {copy, origin}) ──▶ mod's on_click(...)
   ◀──ctl emit run/setShared/notify/openOverlay ─── (bridge applies: session-local layout ops, overlay copies, toasts)
   ◀──ctl rpc exec/readTextFile/net ─── bridge policy (§2) ──▶ fs / scoped deno run / hub TCP ──ctl rpc-result──▶
   ◀──ctl tree {copy, tree} (render after markDirty, ≤ 1 per 16 ms per copy) ─── bridge diffs vs last tree
device ◀──WS patch {seq, views:[{view, ops}]} / view.tree (first render) ─── bridge
```
State the mods read synchronously (`spaces()`, `panes()`, `theme()`, `layout()`, `shared()`…) is pushed to hosts as `state`/`shared`. One host serves every connected device, as one Herdr window serves every screen, so the per-folder snapshot is the Mac's data with the **lead session's view** on top — the lead is the device session that acted last: its `layout()` and `focused()`, and its own selection, focus and zoom flags in `spaces()`/`panes()`/`agents()` (the `active` space and each space's `active` tab, the `focused` pane and that pane's agent, `zoomed` tabs and panes; nothing zoomed on a phone). Without a session hosts read the Mac's own. Each device's `snapshot`/`patch.state` carries that device's view the same way, so a device selecting a tab moves its tab-bar highlight and never the Mac's focus; other devices see the lead's view inside mod views and their own in the ScreenGraph and their `snapshot` (AMENDMENTS-c1-wave4 "iPad real-device fixes" §2). `props()/placement()/nextCommand()` are copy-scoped via `AsyncLocalStorage`, measured across exec RPC replies, timers, shared promises and `Promise.all` **[M]**.

---

## Decisions on open items (Main, 2026-11-09)

- **Envelope field.** Every client ⇄ bridge WebSocket text message is a JSON object with a string discriminator **`t`** (same as the control channel), e.g. `{"t":"hello","v":1,…}`. Binary terminal frames are unchanged. T02 defines the discriminated unions on `t`.
- **Sample messages.** T02 owns them: one JSON file per message kind under `packages/protocol/samples/<direction>/<t>.json` (directions `client`, `bridge`, `control`), plus at least one invalid sample per kind under `samples/invalid/`. T02's acceptance is "every valid sample validates and every invalid sample fails". This document links that folder instead of embedding samples.
- **Shapes without a field list** (`HostState`, `Placement`, `Style`, `JSONPatch` = RFC 6902, `PushSubscription` = W3C Push API, `ScreenGraph` per DESIGN.md §3 golden) — T02 defines all of them in `packages/protocol`, each with at least one sample.

## Contract additions from T02 (Main, 2026-11-09) — `@herdr-relay/protocol` is authoritative

The package (`packages/protocol`, schemas in `schema/*.json`, samples in `samples/`) is the source of truth; where it differs from §1–§3 above, the package wins.

1. `term.size` carries a required `channel`; binary terminal frames are `[u32 big-endian channel][bytes]` (`encodeTerminalFrame`/`decodeTerminalFrame`).
2. `push.sub` carries a required `id`; an unsupported push service is acked `ack {id, ok:false, error:"refused", message}` (the five `ACK_ERRORS` stay fixed).
3. New bridge → client message `overlay.close {id}` (implements `closeOverlay`); optional `overlay.modal`, optional `ack.message`.
4. `event.data` is typed per `kind` (GPUI payload shapes); `click`/`mousedown` take an optional `key` for list-row handlers; `size` also accepts `{sizes}`.
5. `input` events carry `{value, event?, secondary?, shift?}`.
6. `ElementNode` has per-kind fields (`text`, `src`, `path`+`paint`, `terminal`, `view`, `reason`+`folder`) plus `attrs`, `slots`, `anim.spring`; `states` covers all 7 GPUI refinements.
7. RecordedTree (mod host → bridge) rules: refinements in `states` (not `style`), integer handler ids, factory data under `props`, no `{unknown}` children — the spike shape is rejected.
8. Style conventions: numbers are px except unitless ones (e.g. `lineHeight` multiplier); longhand properties only; custom properties `--herdr-text-bg`, `--herdr-ellipsis`; the converter adds `borderStyle:"solid"` wherever a border width is set, and a renderer draws only the sides that have a width (unset sides are 0, as in GPUI, not CSS's `medium`).
9. Control `emit`/`rpc` require a non-null `copy`; only `error.copy` may be null. Copy-id trust rule: `copyBelongsTo`.

## Contract additions, wave 4 (Main, 2026-11-10)

The package stays authoritative. Evidence with `file:line`: [AMENDMENTS-c1-wave4.md](AMENDMENTS-c1-wave4.md). Items 1, 5
and 8 were amended by the review fixes (independent review of `50f1629`; their citations are the working tree at
`bb9d83d`, [AMENDMENTS-c1-wave4.md](AMENDMENTS-c1-wave4.md#review-fixes-independent-review-of-50f1629)). The HTTP and
WebSocket gate, including its one cross-site exception (a top-level navigation to the app shell's page), is in
SECURITY.md §2.

1. **Resume (`hello.since`, T08b).** Client `hello` may carry `session` (the bridge `hello.session` it holds data for) with `since` (the highest `seq` it holds); together they ask to resume that session, either alone starts a fresh one. Bridge `hello` always carries `session` and `hosts`, and `resumed: true` when the session continues: `seq` repeats `since`, the kept messages after it follow, and the client keeps its views, overlays and live state. Absent or false: the client drops them; a `snapshot` and the `view.tree`s follow. The bridge keeps, per session, the last 512 messages that change what a device holds (`snapshot`, `patch`, `view.tree`, `overlay`, `overlay.close`; never `ack`, `toast`, `look`, `clipboard`, `sound`) and keeps a session whose socket is gone for 120 s; a revoked device's sessions end at once, without that grace (item 8). A resume needs the same paired device, scope and device class; a `since` the ring no longer reaches gets `hello` + `snapshot` + overlays + every `view.tree` in the same session.
2. **`look` and `clipboard` (T08b).** Bridge → client `look {theme, settings, fonts}`: the Mac's look changed after `hello` (same fields). `clipboard {text}`: a mod's `write_to_clipboard(text)`, sent to the device of its origin (else the lead session's); browsers write the clipboard only during a user gesture, so the client offers it (a toast with a Copy action).
3. **Control `event.n` (T08b).** `event` carries optional `n`, the render of the copy (`tree.n`) the bridge took the handler id from. When `n` is not the copy's latest render, or the handler is not one of its ids, the host runs nothing and answers `event-result {ok:false, stale:true}`.
4. **`hello.hosts[]` (T34)** is `HostStatus {folder, state, reason?, profile?}`. `profile` is the id of the policy profile applied to the folder (`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`; `default` for a folder no profile names; POLICY.md §2.7); the bridge always sets it. `reason` is path-stripped before it is sent.
5. **`PolicyLogRecord` (T34)**, one line per decision in `<state>/log/policy.ndjson`: `{ts, folder (null without a folder), method, argv, decision: "allow"|"refuse"|"intercept", rule, reason?, session?, profile?}`; `profile` is set on every exec, hc, net, read, write, symlink and storage record of a mod folder (not on `origin` records). Rule ids are `E1`–`E16`, `read`, `symlink`, `run.*`, `write`, `storage`, `net`, `rpc.unknown`, `push` and (T08d) `origin`: a host call whose origin token named no device (item 8), logged `{folder, method, argv: [copy], decision: "refuse", rule: "origin", reason: "origin downgraded: <why>"}` once per token and reason. **`net` records (review fixes, POLICY.md §2.8):** `net.connect` → `allow` or `refuse` with `argv: [host, port]`; `net.write` → one record per refused request (`refuse`) and per `open_url` the bridge answered itself (`intercept`), whose `argv` names the request only — `[op]`, `["fetch", kind]`, `["act", app, action]`, `["act", app, "open_url", url]` (`url` empty when the request names none), or `[]` for a line that is not a request, a line over 1 MiB, a write on a connection already refused, and a `net.writes: act` refusal — plus `reason`, `session` (the call's resolved origin: a device session id, or the presented origin token when downgraded) and `profile`. The hub's `token` and the other request fields are never logged, and admitted requests are not logged (`packages/bridge/src/herdr/net.ts:114-147,212-256`; `packages/bridge/src/policy/hub.ts:40-47,115-171,174-221`).
6. **Policy profile documents (T34):** `PolicyProfile` / `schema/policy-profile.schema.json` (a file holds one profile or a list); fields in POLICY.md §2.7.
7. **`hello.compat` (T46, OSS-PLAN §2.3).** Bridge `hello` carries optional `compat {herdrVersion: string|null, tested: boolean, drift: [{surface: "herdr.d.ts"|"gpui-kit.d.ts"|"installed.json"|"commands", detail}], banner?: string}`: the running Herdr against the contract pins of its version, else of the newest pinned version. `herdrVersion` is null while unknown; `tested` = herdr-relay pins that version; `drift` (at most 8) lists the surfaces that differ, `detail` (≤ 500 chars) names files and commands, never paths; `banner` (≤ 300 chars) is present when the version is unknown or untested or anything drifted, and the client shows it once live until dismissed (a different banner shows again). `compat` is absent only while the bridge has not run its start-time check. Only the WebSocket `hello` carries it; `GET api/hello` does not.
8. **Control `origin` is an opaque token (T08d, S19; review fixes).** The `origin.session` the bridge puts on a control `event` or `command` is a fresh token `o-<uuid>`, minted for that one delivery and bound to the device session, the socket it was delivered over (`SessionConnection.id`), the mod folder and the host generation it was delivered to; it is valid for 30 s. The host passes it back unchanged on the `emit`/`rpc` its handling leads to (copy-scoped, as before); raw session ids never reach a host. On `emit`/`rpc` the bridge resolves the token: from the same folder's current host within its lifetime, while the session's open socket is still the one it was delivered over, it names that device's session (and scope, from the bridge's own table). Anything else — an unknown token (forged, a raw session id, a revoked device's), an expired one, another folder's, an earlier host generation's, one whose session has ended, is not connected ("session not connected") or has reconnected since ("token from before the session reconnected") — is downgraded: `read` scope, no device (`connected: false`), logged once per token and reason as `origin downgraded: <copy> <t> <method> (<why>); counted as read from no device`, and recorded with policy rule `origin`. A token whose delivery failed is revoked at once; an ended session's tokens are forgotten. A revoked device's sessions end at once: the server's 2 s revocation sweep calls the view manager's `revokeDevice` for a tailnet device that had a socket this run and is no longer paired, and a socket closed with 1008 "device revoked" also ends its session without resume grace (`packages/bridge/src/views/origins.ts:1-15,22-29,45-56,63-76`; `packages/bridge/src/views/manager.ts:98-104,352-387,491-497,633-682`; `packages/bridge/src/server/server.ts:14-17,54-57,87-88,231,245-260`). Residual and behaviour change: SECURITY.md §4.
9. **`sound` (T09s).** Bridge → client `sound {t: "sound", src}`: a mod's `playSound(path)`. `src` matches `SOUND_SRC_PATTERN` (`packages/protocol/src/messages.ts`): `assets/mods/<folder>/…/<file>`, mount-relative like image URLs, URL-encoded segments, no `.`/`..` segment and no `?`, `#` or `\`; the bridge sends only files its asset route serves as audio (`mods/**/*.mp3|wav|ogg`, POLICY.md §2.1). Delivered only to the device whose event or command led to the call: a call without an origin (init, render, a timer) or with a downgraded one (item 8) plays on no device. At most 4 per second per device session; the rest are dropped (logged once per burst). Never kept for a resume. The client plays it only while the page is visible, never queues it, drops a play the browser refuses, unlocks audio on the first press or key, and has a per-device mute switch (the device panel, `localStorage` `herdr-relay.sound.muted`).

## Device layout profile (BE-1/BE-2, 2026-11-10)

The package stays authoritative: `LayoutMessageSchema`/`LayoutChangeSchema` (`messages.ts`), `overridable()`,
`applyProfile()`, `profiledNodes()`, `LayoutProfileSectionSchema` (`recompose.ts`), `ScreenResizeSchema`,
`ScreenGraph.overridden` (`screens.ts`). A device's layout profile is bridge state (one section per device, layout
name and device class); it is never written to the Mac.

1. **Client `layout`.** `{t:"layout", id, action:"set", changes:[{node, size?: {px} | {weight}, collapsed?: boolean}, …]}` (1–8 changes, `LAYOUT_CHANGES_MAX`) changes the entries of this device's section for the current layout and class **all or none**: one ack, one rate-limit unit (item 7), one profile write and one `patch.screens`. A divider drag between two weighted siblings sends both weights in one message. `{t:"layout", id, action:"reset", node?}` drops that node's entry, or without `node` the whole section. `px`/`weight` are numbers ≥ 0 and exactly one of them; `node` is non-empty; a change keeps the entry's other fields. The bridge answers with `ack`; the whole message is `ok:false, error:"refused"` with a `message` when any change names a node that is not overridable here (no `resize` in the graph), gives a size of the other kind (`px` for a `weight` node and the reverse), sets `collapsed` on a node that cannot collapse, names a node already named in the message, or has neither `size` nor `collapsed`, or when the result would not fit the profile cap; nothing changes then. `scope:"read"` devices may send it: it changes only that device's own view, as `nav` does.
2. **Overridable nodes** (`overridable(tree, device) → Map<id, {axis, kind: "px"|"weight", min?, max?, collapsible}>`) are derived from structure, never from ids: a child of a row/column whose `resizable` is not `false`; with `size.px`, `size.weight`, `min` or `max`; not an R1 bar and not inside one; with a layout `id` (a synthetic `#path` id is positional and would retarget after a file edit); next to at least one other non-bar child of the split on this class (on tablet-portrait trailing panels are sheet routes, not split children). Of nodes sharing an id, the first in document order. Phone: none.
   - **Weighted siblings are overridable** (`kind: "weight"`): one drag sets the weights of the pair (main.json `spaces`/`agents`, weight 1, `min` 90, in the column `sidebar-lists`, which does not set `resizable`).
   - **`hidden` does not count**: hidden is session-transient and applied after the profile, so a panel's width survives closing and reopening it (main.json `panel` is `hidden: true` in the file and overridable).
   - `collapsible`: an R2 panel (row child); its rail is `min`, else 44 px.
   - Shipped layouts on tablet-landscape and desktop: `main` → sidebar, spaces, agents, panel; `lstack-herdr` → sidebar, home-agent, panel; `terminals`, `win98` → none. Tablet-portrait: `main` → sidebar, spaces, agents; `lstack-herdr` → sidebar.
3. **Apply order** (`applyProfile(tree, section, device)`, a copy): Mac file → Mac `.state` clicks → the session's size clicks (mods' `layout.resize` outside the profile, item 8) → profile → session-transient clicks (`hidden`, stack `active`). Neither the profile nor `hidden`/`active` changes what `overridable()` names, so the nodes the bridge accepts changes for are exactly the graph's `resize` nodes. `px` applies to `px` nodes, clamped to the node's current `min`/`max` as recompose clamps `size.px` (`px: 10` on main.json `panel` → 280); an unbounded node other than a stack stays above 72 px, so a profile never turns a panel into an R1 bar. `weight` applies to `weight` nodes. Unknown, ineligible and mismatched entries are ignored, not deleted (the Mac may rename the node back). `collapsed` (collapsible nodes only) is kept on the tree node, a relay field Herdr files do not carry: `true` draws the panel as its rail (the screen node's `collapsed`, item 4) on any tablet/desktop class; tablet-portrait leading panels are rails unless the profile says `collapsed: false`. The tree keeps the panel's `px`, so it reopens at its last width. A `set` change with a size and no `collapsed` leaves the entry's `collapsed` as it is: a collapsed panel stays collapsed (its saved `px` changes); the client sends `collapsed: false` with the size to open it.
4. **Resize metadata** (amends DESIGN.md §3 "tablet-landscape = resizable disabled"). On every class but phone, exactly the split children `overridable()` names carry `resize: {kind: "px"|"weight", collapsible: boolean}` (`ScreenResize`; on `split`, `block`, `group`, `panes` and `terminal` nodes) — what a `layout set` accepts for them — and their bounds in `size.min`/`max` where the layout file has them (a rail keeps its bounds; other nodes carry no bounds). A node with `resize` and no bounds is still resizable; the client picks its own drag limits. **Rail state** (`ScreenSlot.collapsed`, on the same five node kinds): `collapsed: true` on every R2 panel drawn as its rail (`size.px` is then its `min`, else 44 px), `collapsed: false` on every collapsible panel (`resize.collapsible`) that is expanded — always present on collapsible panels, so a panel expanded at its `min` is told apart from its rail; absent on other nodes and on phone. A rail that is not overridable (tablet-portrait default of a panel the device may not resize) carries `collapsed: true` without `resize`. The graph's `layout` is the layout shown now (`hello.layout` is only the one the connection started with); every Mac layout edit or switch sends every session `patch.screens`, so a client takes eligibility, rail state and the layout name from the latest graph.
5. **`ScreenGraph.overridden?: string[]`** (in `hello.screens` and `patch.screens`): the sorted ids of the nodes the profile actually changes here, `profiledNodes(tree, section, device)` — `overridable()` nodes whose entry has a size of the node's kind (`px` on a `px` node, `weight` on a `weight` node) or a boolean `collapsed` on a collapsible node. An entry of the wrong size kind, `collapsed` alone on a node that cannot collapse, or an id that is unknown or not overridable here does not count. Absent when none.
6. **Profile section** (`LayoutProfileSectionSchema`): `{[node id]: {px?, weight?, collapsed?}}`, numbers ≥ 0.
7. **Storage and limits (BE-2, `packages/bridge/src/session/profiles.ts`).** `<state>/layout-profiles/<deviceId>.json` (0600, directory 0700, ≤ 64 KiB, atomic: a new random temp file created exclusively, then renamed; writes coalesced 1 s; over the cap the least recently changed layout section is evicted, never the one being written). The directory must be a real directory whose real path is `<real state dir>/layout-profiles`, else nothing is read or written there (logged); a profile file that is a symlink is never followed (it reads as empty and the next write replaces the link). Loopback clients share `local.json`. A profile is deleted only when a successful read of the device list no longer names the device — at start and after each 2 s device sweep; `local` is kept. A revocation decided while the list is unreadable (fail closed: sessions end, tokens die) keeps the profile. At most 20 layout changes per second per session — `layout` messages (one per message, however many changes), `layout.resize` commands and mod `layout.resize` runs together: an excess `layout` message or command gets `ack {ok:false, error:"refused", message:"over 20 layout changes per second"}`, an excess mod run is dropped without a toast (logged once per burst).
8. **Mods' `run("layout.resize", {id, px|weight})`** writes the profile of the device whose event led to the call (origin token, item 8 of wave 4); origin-less or downgraded → no device; phone → `ok` and nothing changes. A target that is not overridable here (or the wrong size kind) changes only that session's size click (item 3) and is not saved (the shipped win98 kit resizes its bars this way). Mods cannot set `collapsed`.
9. **Mod-internal splits** (`h_resizable`/`v_resizable` inside a mod) are not part of the profile: the client draws touch dividers and keeps sizes in the browser's `localStorage` per device (`herdr-relay:split:<layout>:<view>#<group>`, ≤ 200 entries), re-clamped to the mod's bounds; the mod receives `on_resize` as on desktop.

## Push test (2026-11-11)

The package stays authoritative: `PushTestSchema` (`messages.ts`); the bridge side is
`packages/bridge/src/push/service.ts` (`PushService.test`).

1. **Client `push.test {t:"push.test", id}`** sends one test notification (title `herdr-relay`, body
   `Test notification from <Mac name>`, tag `herdr-relay:test`, url `./`) to the push subscriptions **this device**
   registered with `push.sub` (the socket's paired device id; loopback-token clients are `local`) — never to another
   device's — at once, even while a device is visible (alerts stay muted then). Allowed on `scope:"read"` devices.
2. **Ack** `{t:"ack", id, ok, message}`: `ok` is true when at least one push service accepted the message (2xx). The
   `message` sums up every subscription's result, joined by `; `: `sent to 1 subscription (201)`,
   `sent to 1 of 2 subscriptions (201)`, `push service answered 403: BadJwtToken` (the service's own `reason`/`message`
   or body text, redacted, one line, at most 120 characters), `push service answered 410: Unregistered (subscription
   removed)`, `push service unreachable: <error>` (redacted, at most 240 characters). Refusals are `ok:false,
   error:"refused"` with `no subscription for this device` or `wait <n> s before another test notification` (at most
   one `push.test` per device per 5 s).
3. **Same delivery as alerts**: VAPID (RFC 8292; `aud` = the endpoint's origin, `exp` = now + 12 h, `sub` =
   `HERDR_RELAY_PUSH_SUBJECT` when it is a valid `mailto:` address or `https:` URL, else `https://<MagicDNS name>`, else
   the project page), `aes128gcm` (RFC 8291, body ≤ 4096 bytes), `TTL: 86400`, `Urgency: high`. 404/410 drop the
   subscription; every other answer keeps it. Every send is logged on the Mac as
   `herdr-relay: push: <service host> <status> [<reason or apns-id>]`; the `apns-id` only when it is a UUID.
4. **Redaction** (`packages/bridge/src/push/redact.ts`). A push service's answer is untrusted and may echo the request:
   before truncation, and before it reaches the log or an ack, the reason and any delivery error lose the
   subscription's endpoint (whole → its host; its path, path segments and their base64url pieces of 8+ characters →
   `[path]`; also percent- or JSON-escaped), its `p256dh`/`auth` keys (base64url or base64, padded or not → `[key]`),
   every other URL (`[url]`) and every run of 16+ base64url or hex characters (`[redacted]`) except plain identifiers
   such as `TooManyProviderTokenUpdates` or `INVALID_ARGUMENT` (letters only, each `_`/`-` part lowercase, uppercase or
   CamelCase, not all hex).

## Scroll requests (Herdr 0.1.15, 2026-11-11)

The package stays authoritative: `ScrollRequestSchema` and `ElementNode.scrollTo` (`tree.ts`). The host side is
`ScrollHandle` and `VirtualListScrollHandle` in `packages/modhost/src/shims/gpui-base.js`, the device side
`packages/web/src/render/scroll.ts` (plain elements) and `packages/web/src/widgets/VirtualList.tsx` (virtual lists).

1. **Host.** gpui-base `ScrollHandle.new()` and `VirtualListScrollHandle.new()` (gpui-kit.d.ts 0.1.15) are retained
   handles with ids `ScrollHandle:<n>` / `VirtualListScrollHandle:<n>`. Each keeps one request: `scroll_to_item(index)`
   → `{seq, index}`; `VirtualListScrollHandle.scroll_to_item(index, "center")` → `{seq, index, strategy: "center"}`
   (`"top"`, the default, records no strategy; another strategy is reported as unknown and taken as `"top"`);
   `VirtualListScrollHandle.scroll_to_bottom()` → `{seq, bottom: true}`. `seq` numbers the requests of the mod host
   process from 1 (both kinds share it; a restarted host starts again at 1), a later request replaces the earlier one,
   and an index that names no item (negative, not a number) drops it. The copy that owns the handle re-renders, unless
   it is rendering now (the tree it is building carries the request). `release()` returns `true`; afterwards every
   method, `release()` included, and `track_scroll(handle)` throw.
2. **RecordedTree.** `track_scroll(handle)` records `["track_scroll", "<handle id>"]` (no request yet) or
   `["track_scroll", {handle, scroll_to: <request>}]`, read when the render's tree is serialised, so a request made
   later in the same render is in that tree. Every tree keeps the latest request: the bridge sends only the newest
   tree of a flush, so a request carried by one tree could be lost.
3. **ElementTree.** The converter keeps the handle id in `attrs.track_scroll` and puts the request in `scrollTo`
   (`ScrollRequest`: `{seq, index, strategy?: "top"|"center", gen?}` or `{seq, bottom: true, gen?}`; integers, `seq` ≥
   1, `index` ≥ 0); any other object, including one carrying `gen`, is a diagnostic. `gen` is the bridge's name for
   the host process that recorded the tree (`toElementTree(tree, {scrollGen})`): the view manager sets
   `<run>.<host generation>`, `<run>` 8 random hex digits per bridge run, so a restarted host or a restarted bridge
   never repeats an identity a mounted view has already carried out. An unchanged request diffs to nothing.
4. **Device.** Each request (`gen` + `seq`; no `gen` counts as `""`) is carried out once, in the layout phase of the
   commit that brings it; a device that mounts the element later (a reload, a re-shown view) carries out the latest
   request once. Nothing but the tracked element scrolls (not the page, not an outer scroller).
   - **Plain element** (not a widget, not `frames`): reveals its direct child `index` (in the node's `children`; slots
     drawn before them are skipped; `bottom`: the last child) on each axis it scrolls (`overflowX`/`overflowY` `auto`
     or `scroll`): by the CSS `nearest` amount, so a child already in view stays put, or with `center` centred. An
     index past the children, a child without a box or an element that does not scroll does nothing.
   - **Virtual list** (`widget.type: "vlist"`): from the row offsets of `props.sizes`, so the row need not be mounted:
     `index` comes in by the `nearest` amount (`"top"`: the near edge) or centred (`"center"`); `bottom` scrolls to
     the end. The rows in view are mounted before the frame is drawn. An `index` the host did not record (past the
     rows, below `props.count`) scrolls to the end, where the list notes how many rows are not shown; an `index` at or
     past `count` does nothing.

## 4. Mirror endpoint (loopback HTTP, T12) — `packages/bridge/src/mirror.ts`

The `herdr-relay-mirror` mod (repo-root `mods/herdr-relay-mirror/`, [RECIPE.md](../RECIPE.md)) reports what the Herdr window shows.

- **Discovery.** While the bridge runs it keeps `<state>/mirror-endpoint.json` = `{v:1, port, pid}` (0600) and removes it on stop; the mod reads it and the loopback token `<state>/token`. Either missing → the mod sends nothing.
- **`POST <mount>/mirror`** (`http://127.0.0.1:<port>/herdr-relay/mirror`), `Authorization: Bearer <token>`, `Content-Type: application/json`, body ≤ 1 MiB: `{relayMod, theme?, settings?, fonts?, layout?, focused?, panes?, updates?, window?, commands?, keys?, shared?}` — each the value of the same-named `herdr` function, `shared` holding every key, `relayMod` the mod's version (`x.y.z[-pre]`, required). Every field is validated against the protocol schemas (Herdr 0.1.14 shapes); one invalid field rejects the whole body. Unknown keys are ignored. Answers: `200 {ok:true, changed, staleAfterMs, bundledMod, outdated}`; `400 {error:"invalid mirror snapshot", errors:[{path, message}]}` (JSON Pointers, at most 20); `401` without the right token; `403` with an `Origin` header (the loopback token is never accepted from a browser page) and for any request that did not arrive over loopback, even from a paired device; `405` for other methods.
- **`GET`/`HEAD <mount>/mirror`** (token): `{state: "none"|"fresh"|"stale", receivedAt: string|null, relayMod: string|null, bundledMod: string, outdated: boolean, staleAfterMs}`. `bundledMod` is the version of the mirror mod this bridge ships (`mods/herdr-relay-mirror/mod.json`); `outdated` = `relayMod` is older than it.
- **Version handshake (T44).** A changed snapshot whose `relayMod` is older than `bundledMod` is logged on the Mac and sent to every connected device as a warning `toast` ("… run herdr-relay install-mod on the Mac"), once per distinct reported version.
- **Freshness.** A POST makes the mirror `fresh`; a body equal to the last one only refreshes it. After 30 s without one it is `stale`: the bridge keeps `theme`, `settings`, `fonts`, `commands`, `keys`, `updates` and drops `focused`, `panes`, `shared`, `window`, which fall back to the core document and `shared.json`. The mod POSTs 250 ms after a burst of changes (only when the body changed) and re-sends an unchanged body every 10 s once it is older than 5 s.
- **Cache.** Each accepted change is written to `<appHome>/data/herdr-relay/mirror.json` (`{v:1, receivedAt, snapshot}`, 0600) and read at the next start as `stale`. `layout` is validated and cached but not used for the device layout.
- Devices do not see the mirror state (no `hello` field); the marker is this `GET` and the bridge log.
