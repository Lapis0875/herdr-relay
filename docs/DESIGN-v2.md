# herdr-relay — architecture & task plan v2 (Deno 2.9)

Status: READY (design only). Supersedes `docs/DESIGN.md` §5–§6 where they differ; §1–§4 of DESIGN.md (feasibility, desktop path, recompose rules, security model) stay in force except as amended in §3/§6 below. Decisions D1–D11 (`docs/DECISIONS.md`) are binding; D6 = Deno 2.9.

Evidence legend: **[V]** read on this Mac (path given) · **[M]** measured by a spike ([spikes/deno.md](spikes/deno.md), [spikes/bun.md](spikes/bun.md); the spikes' raw `out/*.json` were not kept) · **[I]** inference, unverified here. Context7/Context8 are not mounted in this session; Deno-documentation claims below are **[I]** and every one has a named verification step in T00.

---

## 0. Summary

Two trust zones on the Mac. The **bridge** (one `deno run`, privileged: secrets, auth, HTTP/WS, `hc connect`, policy, push, tailscale) never loads mod code. **Mod hosts** (one `deno run` process **per mod folder**, under macOS Seatbelt, with `--allow-read=<that folder>` and `--allow-net=127.0.0.1:<ctl>` only) load the unmodified mod through a computed `import()` inside a bridge-authored entry, record element trees, and talk to the bridge over a token-authenticated NDJSON/TCP control channel. Every `exec`/`hc`/`readTextFile`/`net` the mods perform is an RPC the bridge decides with an **argument-level** allowlist; `node <script>` becomes a **scoped `deno run`**; the two `sh -c` literals shipped mods use are pinned by hash and replaced by native/scoped implementations. The web client is a PWA built with `deno bundle` (no Vite, no npm build tooling) and served by the bridge; fonts per D10 are vendored with licenses and a checksum manifest.

Thirty-six tasks, one owner each, Deno verification commands throughout; T01 (spike) is done. Three new user decisions (§8).

---

## 1. Process model

### 1.1 Processes

| Process | Count | Trust | Loads mod code | Holds |
|---|---|---|---|---|
| `bridge` (`packages/bridge/src/main.ts`) | 1 | privileged | **never** | device records, loopback token, VAPID keys, `hc connect` child, hub connection, policy, sessions, view manager, static files |
| `modhost` (`packages/modhost/src/main.js`) | **one per mod folder** referenced by the active layout + overlays (lstack-herdr: 6 — `lstack-herdr-cockpit`, `lstack-herdr`, `workspace-chrome`, `tabs`, `files`, `changes`) | unprivileged | yes, via computed `import()` | the folder's realm, its copies, the recorder, the shims; **no** secrets, no env, no fs beyond its folder |
| scoped script runner (`deno run …`) | per `exec` call, short-lived | narrow, per-script profile (§2.5) | runs `lh-scan.mjs` / bridge-authored replacements | nothing persistent |
| `hc connect` | 1 (child of bridge) | user | — | core JSON-RPC stdio |

**Why one process per folder (not one process with Workers as the spike ran):** per-Worker permissions need `--unstable-worker-options` **[M]**; a Worker that exceeds its heap aborts the **whole** mod host (exit 133, `Fatal JavaScript out of memory`) **[M]**; `BroadcastChannel`/`caches` cross Workers inside a process and can only be hidden best-effort **[M]**. One process per folder uses only stable flags, gives the kernel (Seatbelt) a per-folder boundary, and makes OOM/crash restart a per-folder event. Cost: ~6 Deno processes for lstack (spike: 232 MB RSS for 15 Workers in one process **[M]**; per-process baseline is the only addition **[I]**, measured in T07 acceptance; budget ≤ 120 MB RSS per host at idle).

No Worker inside the mod host. Deno's main thread cannot be interrupted, so a CPU-bound mod is handled by the supervisor watchdog (§1.6) killing the process, not `Worker.terminate()`. The spike's 13 ms Worker terminate **[M]** becomes a ≤ 6 s detect-and-restart; acceptable because a mod folder stuck in `for(;;)` is a bug, not a steady state.

### 1.2 Exact `deno run` flags

Paths in `<…>` are **real paths** (`Deno.realPathSync`) computed by the bridge at startup; `<repo>` is the repo root; `<appHome>` = `~/.config/herdr-app` or `HERDR_APP_HOME`; `<run>` = `$TMPDIR/herdr-relay/<run-id>/` (0700, created by the bridge, deleted on exit); `<state>` = `~/.herdr/herdr-relay/`.

**Bridge** (`deno task start`, flags live in `deno.json` so they are versioned; never `-A`):

```
deno run --no-prompt --cached-only --no-npm --lock=deno.lock --allow-import=jsr.io:443 \
  --allow-read=$HOME,/tmp,/private/tmp,$TMPDIR/herdr-relay,<repo>/packages,<repo>/deno.json \
  --deny-read=$HOME/.ssh,$HOME/.gnupg,$HOME/.aws,$HOME/.config/gh,$HOME/Library/Keychains,$HOME/Library/Cookies,$HOME/.herdr/herdr-relay/devices.json.bak \
  --allow-write=<state>,<run>,<appHome>/data/herdr-relay \
  --allow-net=127.0.0.1,web.push.apple.com:443,fcm.googleapis.com:443,updates.push.services.mozilla.com:443 \
  --allow-env=HOME,TMPDIR,HERDR_APP_HOME,HERDR_RELAY_PORT,HERDR_RELAY_DEV,PATH,HERDR_RELAY_TAILSCALE_BIN \
  --allow-run=hc,herdr-app,git,deno,sandbox-exec,/Applications/Tailscale.app/Contents/MacOS/Tailscale,cockpit,/usr/sbin/netstat,/bin/ps,/usr/sbin/lsof \
  packages/bridge/src/main.ts
```

- **Amendment (Main, 2026-11-09, from T00):** the bridge uses `--cached-only` instead of `--no-remote` so locked `jsr:` deps already in the cache (e.g. `@std/path`) still resolve while nothing is downloaded at run time (T00 verified both). Mod hosts and scoped runners keep `--no-remote`. `deno bundle` downloads esbuild once into the Deno cache on first use (not recorded in `deno.lock`); this is accepted for the dev/build step only — the running bridge never bundles. `HERDR_APP_HOME` is read at run time by the bridge via `Deno.env` (it is in `--allow-env`), not interpolated by `deno task`; T10/T33 resolve `<appHome>` that way.
- **Amendment (Main, 2026-11-10, wave 4):** `--allow-import=jsr.io:443` limits module loading to the locked JSR packages. Without it Deno 2.9 grants import from every host and only `--cached-only` stops a remote import; `--deny-import` instead breaks the `jsr:@std` imports (measured). `main.ts --self-test` (S32) shows a remote import refused by the import permission. `HERDR_RELAY_TAILSCALE_BIN` in `--allow-env` lets the bridge honour the launcher's Tailscale CLI override (T38). The line above is `deno task start`; `herdr-relay start` computes the same line for the machine (T44, AMENDMENTS-c1-wave4).
Notes:
- `--allow-read=$HOME` (not `<appHome>` only) because the shipped `files`/`changes` mods and the cockpit `code` pane read files under **space folders** (`readTextFile(`${root}/${path}`)`, `fixtures/herdr-home/mods/files/main.js:136`, `changes/main.js:118` **[V]**) and `watchFolder` needs `Deno.watchFs` on them. The bridge policy (§2.1) narrows reads to appHome ∪ space folders ∪ cockpit config/cache at the application level; the Deno flag is the coarse outer bound; `--deny-read` removes the obvious credential stores. Spaces outside `$HOME`/`/tmp` are unreadable remotely and the mod shows its own "cannot list" text — documented limitation.
- `--allow-net=127.0.0.1` covers: the bridge's own listener (bind), the control listener, outbound to mod hosts? (none — hosts connect in), the cockpit hub (`hub.json` port), and mod-host ctl. Push endpoints are the three known Web Push services; a `push.sub` whose endpoint host is not one of them is refused (`ack {ok:false,error:"unsupported push service"}`).
- `--allow-run` by **name**; Deno resolves names to absolute paths at startup, so `/usr/bin/git` is refused while `git` is allowed **[M]**. `Deno.execPath()` (`/opt/homebrew/Cellar/deno/2.9.8/bin/deno`) does **not** match `--allow-run=deno` (`/opt/homebrew/bin/deno`) **[M]** → spawn children by the name `deno`. `tailscale` is `~/.local/bin/tailscale`, a `#!/bin/sh` wrapper **[M bun]** → allowlist the app binary path instead. `node` is **not** on the list: every former `node <script>` runs under `deno` (§2.5). `open`, `code`, `sh`, `env`, `ps`, `sips`, `curl` are **not** on the list — they are either refused remotely or run inside scoped children.
- Child processes inherit the bridge's env (Deno's `--allow-env` governs reading, not passing **[I]**, verified in T05). `hc`/`herdr-app` need the user's `HOME`/`PATH`; mod hosts and scoped runners are spawned with `clearEnv: true` and an explicit env.

**Mod host** (one per folder; spawned by the bridge supervisor):

```
sandbox-exec -f <run>/seatbelt/<folder>.sb \
  deno run --no-prompt --no-remote --no-npm --no-lock \
    --config=<repo>/packages/modhost/deno.json \
    --allow-read=<appHome>/mods/<folder>,<repo>/packages/modhost \
    --allow-net=127.0.0.1:<ctlPort> \
    --v8-flags=--max-old-space-size=256 \
    <repo>/packages/modhost/src/main.js <ctlPort> <folder>
env (clearEnv): DENO_DIR=<run>/deno-dir/<folder>  NO_COLOR=1  TZ=<bridge TZ>
stdin: one line `<token>\n`, then closed.   stdout/stderr: piped to the bridge log, never parsed as protocol.
```

No `--allow-write`, `--allow-env`, `--allow-run`, `--allow-sys`, `--allow-ffi`, `--allow-import`. Measured consequences **[M]**: `Deno.readTextFile` of appHome `settings.json` → `NotCapable`; another mod's `ui.js` → `NotCapable`; `Deno.Command`, `node:child_process`, `Deno.connect` elsewhere, `Deno.listen`, `Deno.env`, `Deno.dlopen`, `import('https://…')`, `npm:`, `jsr:` → blocked; `Deno.permissions.request` → `"denied"` with no prompt. What Deno flags alone do **not** block: a symlink inside the folder (Deno path permissions do not resolve links) **[M]** → Seatbelt + load-time audit (§1.3, §2.2); `Deno.kill(Deno.pid)` → that host dies, supervisor restarts it (§1.6); `caches.open()` writes into `DENO_DIR` **[M]** → throwaway `DENO_DIR` per host per run + bootstrap deletes `caches`; `Deno.stdout.write` → stdout is never protocol **[M]**.

`--config` points at `packages/modhost/deno.json`, whose `imports` alias the mods' six bare specifiers (`gpui-kit`, `gpui`, `gpui-base`, `herdr`, `net`, `buffer`) to the shims; the spike measured this resolving for mods under `fixtures/` (outside the config's folder) **[M]**. `packages/modhost` is deliberately **not** a workspace member (§3.1) so the root import map cannot leak into the mod realm.

### 1.3 Seatbelt profile scope (mod hosts)

Generated per folder into `<run>/seatbelt/<folder>.sb` by `packages/bridge/src/hosts/seatbelt.ts` from a template. Deny-by-default; the spike measured only the symlink rule (`(deny file-read* (subpath …))` under `(allow default)`) **[M deno]**; the Bun spike ran a complete deny-default profile for `bun` **[M bun]**. The Deno-specific allow set is derived empirically in **T05** (procedure below) and committed as `packages/bridge/src/hosts/seatbelt.template.sb`. Skeleton:

```scheme
(version 1)
(deny default)
(import "system.sb")                                   ; if present on this macOS; else the explicit sysctl/mach rules below
(allow process-exec (literal "<deno real path>"))        ; /opt/homebrew/Cellar/deno/<v>/bin/deno
(allow file-read* (subpath "<deno Cellar dir>"))
(allow file-read* (subpath "<repo>/packages/modhost"))
(allow file-read* (subpath "<appHome real>/mods/<folder>"))   ; the ONLY mod-visible tree
(allow file-read* file-write* (subpath "<run>/deno-dir/<folder>"))
(allow file-read-metadata (literal "/") (literal "/Users") (literal "<HOME>") (literal "<appHome real>") (literal "<appHome real>/mods"))
(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))
(allow file-write* (literal "/dev/null"))
(allow network-outbound (remote tcp "localhost:<ctlPort>"))  ; "localhost" also matches 127.0.0.1 [M bun]
(allow sysctl-read)
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.SecurityServer"))  ; trimmed in T05
(allow signal (target self))
```

Rules: no `network-inbound`; no `process-fork` (so even an escaped `Deno.Command` cannot spawn **[M bun]**); no write except `DENO_DIR` and `/dev/null`; the symlink class is closed because the kernel checks the **resolved** path (measured: `PermissionDenied` on `evil/data/link.json → secret` **[M]**). Metadata-only read of ancestor directories is what `realpath`/`stat` of the folder itself needs; **nothing** under `<HOME>` other than the listed subpaths is readable.

Derivation procedure (T05): start from the skeleton with `(trace "<run>/seatbelt/<folder>.trace")`, run the mod host through load + render of every copy + the security probes, read the trace, add only the operations observed, remove `trace`, re-run, assert zero `Sandbox` denials in `log show --last 2m --predicate 'sender == "Sandbox"'` for benign runs and non-zero for the probes. `sandbox-exec` is deprecated but present on this Mac **[M]**; the bridge **refuses to start a mod host without it** (`herdr-relay` prints the reason and exits 3) unless `HERDR_RELAY_DEV=insecure-no-sandbox` is set, which also disables pairing (loopback token only) so the degraded mode can never face the tailnet. Note **[M bun]**: Seatbelt cannot restrict `bind` to loopback — irrelevant for mod hosts (no `network-inbound`), and the bridge binds `127.0.0.1` in code.

### 1.4 DENO_DIR and filesystem footprint

- Bridge: `DENO_DIR` unset (default `~/Library/Caches/deno`); the bridge has `--no-remote --no-npm` and a lockfile, so the cache is only the TS emit cache.
- Mod hosts: `DENO_DIR=<run>/deno-dir/<folder>` (fresh, 0700). With `--no-remote --no-npm` and `.js` mods there is nothing to cache; the directory exists so `caches`/`location_data` cannot land in a shared place **[M]**. Deleted with `<run>` on bridge exit.
- Scoped runners: `DENO_DIR=<run>/deno-dir/scripts` (shared across runs of the same bridge; scripts are user-authored `.mjs`, no transpile).
- Bridge state `<state>` = `~/.herdr/herdr-relay/`: `devices.json`, `token`, `vapid.json`, `push.json`, `storage/<folder>.json` (mod `localStorage`, ≤ 1 MiB each), `log/`. Mode 0700, files 0600.

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

### 1.6 Lifecycle, crash/OOM restart, watchdog

Supervisor (`packages/bridge/src/hosts/supervisor.ts`) per folder:

1. `start`: realpath the folder, run the symlink audit (§2.2) — a folder with an escaping link is **not started** and renders an error block; write the Seatbelt profile; mint a token; spawn; wait for `hello` (≤ 5 s) then send `boot`; wait for `loaded` (≤ 10 s; cockpit graph import measured 37 ms **[M]**); then `create` every copy the view manager owns for that folder and push `state`.
2. Running: `ping` every 2 s; 3 missed `pong` → `SIGKILL` → restart. `pong.heap` > 200 MB → log + restart at the next idle moment (V8 cap is 256 MB; the process aborting on OOM is also handled by 3).
3. Exit for any reason (clean, crash, OOM exit 133 **[M]**, `Deno.kill(Deno.pid)` **[M]**, watchdog): backoff 0 s, 1 s, 5 s, 30 s; > 5 exits within 10 min → `failed`, blocks of that folder render `{k:"error", folder, reason}` on clients, retry every 5 min. Other folders are unaffected (separate processes). Clients receive fresh `view.tree` for the folder's copies after a restart; handler ids are reissued.
4. Mod folder change (`Deno.watchFs(<appHome>/mods/<folder>)`, debounced 500 ms, as Herdr reloads on save): graceful `exit` + restart with the same copies. Layout change (`layouts/<name>.json` or `.state`): the view manager recomputes copies; folders no longer referenced are stopped after 30 s.
5. Bridge exit: `exit` to every host, `SIGKILL` after 2 s, remove `<run>`.

### 1.7 How trees and events flow

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

## 2. Exec / file policy (bridge-side, `packages/bridge/src/policy/`)

Deny by default. Every decision is logged `{folder, method, argv, decision}` to `<state>/log/policy.ndjson` (ring, 10 MB).

### 2.1 Read policy (`readTextFile`, `watchFolder`, `svg()/image()` static route)

Roots (all realpath'ed at startup/refresh):
- `<appHome>` (settings, themes, layouts, mods, `cockpit.json`, `data/**`, icons);
- every `spaces[].folder` from the core `herdr-app` document (refreshed on `doc` events) — for `files`, `changes`, `code`, `reader`, `routines`;
- `~/.config/cockpit/config.json` and the cockpit `cache` dir from `cockpit.json` (`hub.json`, `config.json`) — read by `hub.js`, `editor.js`, `home.js`, `sidebar.js` **[V]**;
- `~/.cache/lstack-herdr/` (scan cache, read by `lh-watch.js:119` **[V]**).

Algorithm (spike `policyRead` **[M]**, kept): lexical check `resolve(appHome, p)` under a root → `realPath` → real path under a **real** root → read ≤ 1 MiB (else refused "over 1 MiB"). Missing file → `null` (Herdr semantics). Never follow a path whose realpath leaves the roots (`appHome/../../x`, symlinks) **[M]**.

Static route `/herdr-relay/assets/*` (icons for `svg("mods/x/icons/y.svg")`): allowlist `mods/**/*.svg|png|jpg|webp`, `icons/**`, `my-icons/**`, `layouts/*.svg`, `data/cockpit/show/**`; same realpath rule; `Content-Type` by extension only; `Cache-Control: private, max-age=300`.

### 2.2 Symlink and realpath rules

- **Load-time audit** (`symlinkAudit`, spike **[M]**): walk the mod folder; any symlink whose realpath is outside the folder's realpath (or dangling) → the folder does **not** start; the block shows "mod folder contains a link outside itself: <relative path>". Re-run on every folder change before restart.
- **Runtime**: Seatbelt denies the read in the kernel even if a link appears after the audit **[M]**.
- **Bridge**: every path argument from a mod (read, `-C`, `cwd`, script path, picture destination) is realpath'ed and checked against the relevant roots **after** a lexical check; never trust the lexical form alone.
- appHome itself may be a symlink (e.g. dotfiles repo): all roots are realpaths; the `--allow-read` flags use realpaths.

### 2.3 Exec allowlist (argument level)

`exec(command, argv, {cwd, on, timeout})` and `hc(argv)` arrive as RPC. `on` ≠ null → refused ("remote machines are out of scope"; the desktop path T14 proposes the patch). `cwd` must realpath under a read root. Timeout: min(mod `timeout`, 60 s); output capped 4 MiB per stream. The allowlist is a data table `packages/bridge/src/policy/exec.table.ts` + tests; the rows below are the complete set derived from every `exec`/`hc` call site in the fixture mods **[V]** (grep of `fixtures/herdr-home/mods`):

| # | Caller(s) [V] | Argv form | Decision | Executed as |
|---|---|---|---|---|
| E1 | `lh-tree-data.js:92/153/213/252`, `lh-transcript.js:80` (both `lstack-herdr-cockpit` and `lstack-herdr/components`) | `node <appHome>/mods/<F>/lh-scan.mjs tree\|detail\|run\|call\|transcript <args…>` | **allow** if the script realpath ∈ **known scripts** (§2.5) and ≤ 3 more args, none starting with `-` | scoped `deno run` profile `lh-scan` |
| E2 | `lh-watch.js:167`, `lstack-herdr/main.js:32` | `node <appHome>/mods/lstack-herdr/sync.mjs [--json]` | **refuse by default** (rewrites `mods/lstack-herdr-cockpit/**`, `layouts/lstack-herdr.*`, `keys.json` and needs a Herdr restart per its own toast **[V]**) — toast "Run Sync on the Mac"; **U2** may allow for `act` scope | scoped `deno run` profile `sync` (only if U2 = allow) |
| E3 | any `node` with a flag (`-e`, `--eval`, `-r`, `--import`, `--loader`…) or an unknown/foreign script | `node -e …` | **refuse** **[M]** | — |
| E4 | `changes/main.js:71/74/126`, `files/main.js:92/96`, `sidebar.js:128`, `code.js:153` | `git [-C <dir>] [--no-optional-locks] [-c core.fsmonitor=false] [-c diff.autoRefreshIndex=false] <RO> …` where `RO ∈ {rev-parse, status, diff, log, show, branch, ls-files, --version}` | **allow**; `-c` only with exactly those two `key=value`s; `-C`/`cwd` under read roots; refuse any arg matching `^(-c(?!$)|--config-env|--exec-path|--upload-pack|--receive-pack|--ext-diff|--output|-u|--git-dir|--work-tree|--namespace)` and any `diff --ext-diff`/`--textconv` without `--no-…` | `git` (bridge `--allow-run=git`), `env: {HOME, PATH, GIT_TERMINAL_PROMPT=0, GIT_CONFIG_NOSYSTEM?no}`, `GIT_OPTIONAL_LOCKS=0` |
| E5 | `changes/main.js:157–158` | `git add -A`, `git commit -m <message>` (cwd = repo root) | **U1**: default **allow only when `origin.session` is a connected `act`-scope device**; refused otherwise; `commit` must have exactly `-m <msg>` | `git` with `GIT_AUTHOR_*` left to the user's config |
| E6 | `editor.js:22` | `hc machine ls --json` | **allow** | `hc` |
| E7 | — (future-proofing) | `hc ls --json`, `hc terminal list --json`, `hc terminal get <id> --json`, `hc schema`, `hc --version` | **allow** (read-only forms only; everything else, incl. `hc connect`, `kill`, `terminal run`, `doc set`, refused) | `hc` |
| E8 | `code.js:37` | `env HERDR_APP_HOME=… <home>/.local/bin/herdr-app do pane.split <json>` | **refuse** (structural, D3); the mod's fallback `run("pane.split")` is refused too → one toast "needs the Herdr window" | — |
| E9 | bridge `run()` pass-through (not an exec call by mods) | `herdr-app do <name> <json>` | allowed only for names in `commands.json → passthrough` (§2.4) and `act` scope | `herdr-app`, env `HERDR_APP_HOME` |
| E10 | `hub.js:116` via `cockpit()` | `env HOME=<install.home> HERDR_APP_HOME=<appHome> COCKPIT_FRONTEND=app [K=V…] <install.bin> hub start` | **allow** `hub start` only; env keys ∈ {HOME, HERDR_APP_HOME, COCKPIT_FRONTEND} ∪ keys of `cockpit.json`.`env` (the bridge reads `cockpit.json` itself and requires exact value match); `bin` must equal `cockpit.json`.`bin` realpath and be the `cockpit` on `PATH` (bridge `--allow-run=cockpit`); `DYLD_*`/`LD_*`/`NODE_OPTIONS`/`PATH` keys refused **[M]** | `cockpit` |
| E11 | `hub.js:19` | `open <http(s) url>` | **intercept**: not executed on the Mac; `toast {action:{open:url}}` to the originating session's device (U3 confirms); any other `open` form (`-a`, file paths, non-http schemes) **refused** | — |
| E12 | `hub.js:20–21`, `files/main.js:22` | `xdg-open`, `cmd /c start`, `powershell …` | **refuse** (not macOS) | — |
| E13 | `editor.js:38/41/45`, `code.js:208` | `<editor> <folder>`, `code -g <file:line>`, `code --folder-uri …`, `open -a <App> <folder>` | **refuse** ("opens an app on the Mac; not available remotely") | — |
| E14 | `files/main.js:28–30` | `sh -c <L1> files <path>` where `sha256(L1)` = pinned constant of the literal at `files/main.js:28` **[V]** | **allow** by hash; `<path>` under read roots | **native** `Deno.readDir` reimplementation producing the same `kind\0name\0` stream (≤ 501 entries, skips `.git`, follows the script's semantics incl. `test -d`) — no shell |
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
| mirror mod (D5, inside Herdr) | nothing; reads `<state>/token`, `<state>/mirror-endpoint.json` and `<appHome>/shared.json`, POSTs to the bridge | — |

---

## 3. Repository structure (Deno)

### 3.1 Layout

```
herdr-relay/
  deno.json                 workspace root: members, tasks, fmt/lint, compilerOptions (jsx react-jsx), imports (@herdr-relay/*, npm: pins), lock
  deno.lock                 single lockfile — owned by BE (T00); UI/TW never edit it
  .gitattributes            `fixtures/** -text`, `*.woff2 binary`; keeps the evil probe symlink as a symlink
  docs/                     DESIGN.md (v1, kept), DESIGN-v2.md (this), DECISIONS.md, PROTOCOL.md, POLICY.md, SECURITY.md, DEVICES.md, DESKTOP.md, spikes/{deno,bun}.md
  fixtures/                 herdr-home/ (Main-provided, read-only), herdr-app-commands.json (M1), layouts/, trees/ (recorded trees), probe-mods/ (evil, iso-a, iso-b, hog, ctx-probe — migrated from spikes/deno)
  packages/
    protocol/               deno.json {name:"@herdr-relay/protocol", exports:"./mod.ts"}; src/{messages.ts, tree.ts, screens.ts, recompose.ts, gpui-style.ts, control.ts, policy-log.ts}; schema/*.json; test/
    bridge/                 deno.json; src/{main.ts, config.ts, core/, hosts/{supervisor,control,seatbelt}.ts, policy/{read,exec,exec.table,scripts,symlink}.ts + commands.json, views/, session/, herdr/, server/, auth/, terminal/, push/, mirror.ts, static.ts, log.ts}; scripts/fetch-picture.ts; bin/herdr-relay.ts; test/{unit,fakes,security}
    modhost/                deno.json (standalone, NOT a workspace member: imports gpui-kit/gpui/gpui-base/herdr/net/buffer → ./src/shims/*.js, lock:false); src/{main.js, runtime.js, shims/{gpui-kit,gpui-base,herdr,net,buffer}.js}; test/ (run with --config packages/modhost/deno.json)
    web/                    deno.json (tasks bundle/bundle:dev/watch/fonts); index.html, manifest.webmanifest, sw.js, src/{main.tsx, app/, render/, widgets/}, tools/assets.ts (fonts fetch + `dist/app.css`), public/fonts/fonts.manifest.json + public/fonts/<family>/OFL.txt (committed), public/fonts/<family>/{*.woff2|*.ttf} (fetched, gitignored); dist/ (gitignored, served by the bridge); test/
  mods/herdr-relay-mirror/  plain JS mod at the repository root (main.js, mod.json, jsconfig.json as Herdr writes it; RECIPE.md at the root); checked by `herdr-app check mods/herdr-relay-mirror`
  tools/
    sync-config/            deno.json member; Mac→PC rsync include list + keys.json section merge (D9)
    lstack-remote-patch/    diff proposal (D9), not applied
    device-tests/           Node 26 + Playwright, own package.json + package-lock.json (the ONLY non-Deno dev tool; never imported by packages/); simctl/avd/adb scripts (.sh)
    (fonts)                 no separate tool: `packages/web/tools/assets.ts fonts` downloads the pinned fonts, verifies sha256, converts to woff2 when `woff2_compress` exists (§3.3)
  (spikes/)                 deleted by T32; the measured results are docs/spikes/{deno,bun}.md
```

Root `deno.json` (shape; exact versions pinned at T00 with `deno add`):

```jsonc
{
  "workspace": ["./packages/protocol", "./packages/bridge", "./packages/web", "./tools/sync-config"],
  "nodeModulesDir": "auto",                       // npm packages for web (xterm css asset copy needs a real dir) [I]
  "compilerOptions": { "jsx": "react-jsx", "jsxImportSource": "react", "lib": ["deno.window", "dom", "dom.iterable"] },
  "imports": {
    "@herdr-relay/protocol": "./packages/protocol/mod.ts",
    "react": "npm:react@19", "react-dom": "npm:react-dom@19", "react-dom/client": "npm:react-dom@19/client", "react-dom/server": "npm:react-dom@19/server",
    "@xterm/xterm": "npm:@xterm/xterm@6", "@xterm/addon-unicode11": "npm:@xterm/addon-unicode11@0",
    "marked": "npm:marked@18", "dompurify": "npm:dompurify@3", "highlight.js": "npm:highlight.js@11",
    "@std/assert": "jsr:@std/assert@1", "@std/path": "jsr:@std/path@1", "@std/testing": "jsr:@std/testing@1", "@std/async": "jsr:@std/async@1"
  },
  "fmt": { "lineWidth": 120 }, "lint": { "rules": { "tags": ["recommended"] } },
  "exclude": ["spikes", "fixtures", "packages/web/dist", "node_modules"],
  "tasks": {
    "check":      "deno fmt --check && deno lint && deno check packages/protocol/mod.ts packages/bridge/src/main.ts packages/web/src/main.tsx tools/sync-config/mod.ts",
    "test":       "deno test --allow-read=. --allow-write=./.tmp --allow-net=127.0.0.1 --allow-env=HOME,TMPDIR,HERDR_RELAY_LIVE_CORE --allow-run=deno,sandbox-exec,git packages tools/sync-config",
    "test:modhost": "deno test --config packages/modhost/deno.json --allow-read=packages/modhost,fixtures --allow-net=127.0.0.1 packages/modhost",
    "test:security": "deno test --allow-read=. --allow-write=./.tmp --allow-net=127.0.0.1 --allow-env=HOME,TMPDIR --allow-run=deno,sandbox-exec packages/bridge/test/security",
    "test:core":  "HERDR_RELAY_LIVE_CORE=1 deno test --allow-read=. --allow-env=HOME,HERDR_RELAY_LIVE_CORE --allow-run=hc packages/bridge/test/live",
    "bundle":     "deno task --cwd packages/web bundle",
    "start":      "deno run <bridge flags from §1.2> packages/bridge/src/main.ts",
    "start:dev":  "HERDR_RELAY_DEV=1 deno run <same flags> packages/bridge/src/main.ts"
  }
}
```
Dependency budget: runtime (bridge/modhost/protocol) **zero** third-party deps (`node:` builtins + `@std/*` from JSR for tests/path). Web: react, react-dom, @xterm/xterm, @xterm/addon-unicode11, marked, dompurify, highlight.js (7). Dev: @std/*, optionally `npm:happy-dom` for widget event tests (TW may add; BE pins). Device tests: playwright (Node-only, isolated).

### 3.2 Web client build: `deno bundle`, not Vite

Choice: **`deno bundle --platform browser`** (esbuild-backed, built into Deno 2.x **[I]**; T00 verifies on 2.9.8) producing `packages/web/dist/app.js` (+ `app.css` concatenated by a 20-line task script, xterm's CSS copied from `node_modules/@xterm/xterm/css/xterm.css`). Justification: zero build dependencies (no Vite, no plugin-react, no esbuild npm download) → the same trust root as the runtime, one lockfile, offline builds; the client is a tree renderer tested with fixtures, so HMR buys little (`deno bundle --watch` + reload is enough); the bridge serves `dist/` anyway. Trade-off: no code splitting (one ~600 KB gzip'd bundle incl. xterm/highlight.js **[I]**; fine on a tailnet) and no Vite plugin ecosystem (unneeded). **Fallback** (decided now, no new decision): if T00's `deno bundle` check fails on React JSX or `npm:` resolution, use Vite **under Deno** (`deno run -A --node-modules-dir npm:vite build` with `@vitejs/plugin-react`) — still one toolchain/lockfile; npm/Node for the build is not used. PWA pieces (`index.html`, `manifest.webmanifest`, `sw.js`) are plain files, not generated.

`packages/web/deno.json` tasks: `bundle` (`deno bundle --platform browser --minify -o dist/app.js src/main.tsx && deno run --allow-read=.,../../node_modules --allow-write=dist tools/assets.ts build`), `bundle:dev` (the widget story bundle into `dist/dev/`), `watch` (`deno bundle … --watch`), `fonts` (`deno run --allow-net=cdn.jsdelivr.net,github.com,release-assets.githubusercontent.com,objects.githubusercontent.com --allow-read=. --allow-write=public/fonts --allow-run=woff2_compress tools/assets.ts fonts`). Run them as `deno task --cwd packages/web <task>`; the root `deno task bundle` forwards to `bundle`.

### 3.3 Fonts (D10)

`packages/web/public/fonts/fonts.manifest.json` (committed, `v: 1`): per family `{family, role: ui|mono|terminal, version, source_url, license: "OFL-1.1", license_file, license_sha256, archive?, files:[{path, sha256, url | member, format, weight, style}]}` for **Geist** (Vercel, OFL 1.1), **Pretendard** (orioncactus, OFL 1.1; `PretendardVariable.woff2`), **JetBrains Mono** (OFL 1.1), **D2Coding** (Naver, OFL 1.1; TTF, plus a `.woff2` when `woff2_compress` is present). Font binaries are gitignored and fetched by `deno task --cwd packages/web fonts` (`packages/web/tools/assets.ts fonts`) with checksum verification, from a file URL or a member of a release ZIP; the committed `OFL.txt` files are checked against their pinned hashes too. `deno task bundle` runs `tools/assets.ts build`, which fails with what to run when a manifest file is missing and writes `dist/app.css`: the generated `@font-face` rules, xterm's CSS, then every `*.css` under `src/app`, `src/render`, `src/widgets`. A test asserts the four families, `OFL-1.1` and each licence file's digest (`packages/web/test/render_test.tsx`). Stacks (`packages/web/src/app/theme.ts`; the bridge puts the Mac's own font first, `packages/bridge/src/herdr/look.ts`): UI `Geist, Pretendard, system-ui, sans-serif`; mono `'JetBrains Mono', Pretendard, ui-monospace, monospace`; terminal `D2Coding, 'JetBrains Mono', ui-monospace, monospace` (settings.json uses "D2Coding ligature" **[V]**; the ligature variant is not needed on devices).

### 3.4 Protocol package (`packages/protocol`)

Runtime-dependency-free TS; the only shared contract; owned by BE (T02). Contents:
- `messages.ts` — client⇄bridge WebSocket messages (DESIGN §5.2, carried forward unchanged except: `hello` from bridge adds `fonts:{ui,mono,terminal}` and `hosts:[{folder,state}]`; new `toast.action.open?:string` (E11); `ack.error` codes enumerated: `read-only-device`, `structural`, `refused`, `stale-handler`, `host-down`).
- `tree.ts` — `RecordedTree` (host) → `ElementTree` (client) conversion; `ElementTree` node as DESIGN §5.2 plus `k:"error"`.
- `gpui-style.ts` — name parser (3,146 generated + 59 arg + 103 behavioural names **[V]**).
- `screens.ts`, `recompose.ts` — device classes and rules R1–R7 (DESIGN §3, unchanged).
- `control.ts` — §1.5 types + JSON Schema (used by bridge and by modhost tests).
- `policy-log.ts` — decision record type (`{ts, folder, method, argv, decision, rule:"E4"…}`) so SECURITY tests and docs share rule ids.
- `schema/*.json` — generated from the TS by a `deno task` and committed; tests validate samples both ways.

---

## 4. Bounded task list

Owners: **BE** backend-implementer · **UI** ui-designer · **TW** testcode-writer. Allowed paths are exclusive per task; anything else is forbidden for that task. Shared contracts: `packages/protocol/**` → BE (T02); `deno.lock` + root `deno.json` → BE (T00; later edits only by BE via T00-owner hand-off); `fixtures/**` → TW (except `fixtures/herdr-home` = Main, read-only); `packages/modhost/deno.json` → BE (T06). Nobody writes `~/.config/herdr-app`; live-core tests use read-only methods only.

"Verification" = commands **Main** runs after the task lands (implementers do not run them).

| ID | Goal | Owner | Allowed paths | Depends | Acceptance | Verification (Main) |
|---|---|---|---|---|---|---|
| T00 | Repo scaffold for Deno: root `deno.json` (workspace, tasks, imports, pins), `deno.lock`, `.gitattributes`, `.gitignore`, `docs/` split (PROTOCOL/POLICY/SECURITY/DEVICES/DESKTOP stubs with the relevant sections of this doc), empty members. **Go/no-go probes**: (a) `deno bundle --platform browser` of a 5-line React component; (b) a standalone `packages/modhost/deno.json` with `--config` resolving `gpui-kit` for a file outside the repo; (c) a workspace member test run | BE | repo root files, `docs/**`, `packages/*/deno.json`, `packages/web/src/main.tsx` (probe), `packages/modhost/deno.json` | — | (a)(b)(c) succeed on Deno 2.9.8 or the documented fallback (§3.2) is switched on in `deno.json`; `deno task check` and `deno task test` succeed on the empty tree | `deno --version`, `deno task check`, `deno task test`, `deno task bundle` |
| **T01** | Spike (go/no-go) — **DONE** (`spikes/deno`, `spikes/bun`, deleted by T32; results in [docs/spikes/deno.md](spikes/deno.md), [docs/spikes/bun.md](spikes/bun.md)) | BE | — | — | done | — |
| T02 | `protocol` package: §3.4 contents, JSON Schemas, style parser, `control.ts` | BE | `packages/protocol/**` | T00 | schemas validate the sample messages in `docs/PROTOCOL.md`; parser covers every generated name (T20 proves) | `deno task test` (protocol), `deno task check` |
| T03 | Core client: `hc connect` (generation 1, framed channels), `hello`, `rpc.discover`, `doc.get herdr-app`, `terminal.list/get`, `events.subscribe`, `terminal.attach` observe/type, reconnect + `reset` | BE | `packages/bridge/src/core/**` | T02 | live `terminal.list` + `doc.get` against this Mac's core (read-only); kill the child → reconnected ≤ 5 s | `deno task test:core` (read-only methods only) |
| T04 | `recompose()` + command classification tables (§2.4) + session interception | BE | `packages/protocol/src/recompose.ts`, `packages/bridge/src/session/**`, `packages/bridge/src/policy/commands.json` | T02, fixture M1 | lstack fixture → ScreenGraph of DESIGN §3 for 3 device classes; every name in `fixtures/herdr-app-commands.json` classified; `layout.show {id:"panel"}` on phone → `push("/panel")` | `deno task test` (T22) |
| T05 | **Policy engine**: read roots + realpath (§2.1), symlink audit (§2.2), exec table E1–E16 (§2.3), known-script profiles (§2.5) incl. `fetch-picture.ts`, native E14 listing, Seatbelt template + generator + **derivation run** (§1.3), scoped-runner spawner. Migrate `policyRead/policyExec/symlinkAudit/within` from `spikes/deno/bridge.ts:205–262` | BE | `packages/bridge/src/policy/**`, `packages/bridge/src/hosts/seatbelt*.ts`, `packages/bridge/scripts/**` | T02 | every row of §2.3 has a unit test (T23); `lh-scan.mjs` from the fixture runs under profile `lh-scan` against a scratch HOME (exit 0); `sync.mjs --check` runs under profile `sync` against a scratch appHome copy; the committed Seatbelt template yields zero `Sandbox` denials for a benign host and denies the symlink probe | `deno task test`, `deno task test:security` |
| T06 | **Mod host package** (migration of `spikes/deno/modhost/{host,worker}.js` + `shim/*.js` → `packages/modhost/src/`): Worker-free `main.js` (token from stdin, ctl connect, `boot/create/state/shared/render/event/command/rpc-result/close/ping/exit`, hardening deletes `caches`/`BroadcastChannel`/`Deno[Deno.internal]`), `runtime.js` (ALS store `{copy, origin}`; `rpc`/`emit` carry `origin`; `storage.set` RPC for `localStorage`; drop spike `probe` handler; keep `unknown` counters as diagnostics), shims unchanged in API; `TextareaState.set_auto_grow` implemented (the one unknown API hit **[M]**) | BE | `packages/modhost/**` | T02 | loads all 6 fixture folders with `--allow-read=<folder>` only; records trees for the 3 T01 copies + 22 coverage copies with 0 unknown style names, 0 unsupported `herdr` calls, 0 errors (T24) | `deno task test:modhost` |
| T07 | **Host supervisor** in the bridge: §1.2 flags, §1.4 DENO_DIR, §1.5 ctl listener (token, 1 s hello deadline, writeAll, 4 MiB cap, forged-copy drop), §1.6 lifecycle (backoff, watchdog, folder watch, failed state), state push debounce, tree intake | BE | `packages/bridge/src/hosts/**` (except seatbelt from T05) | T05, T06 | 6 hosts start under Seatbelt ≤ 500 ms total; `kill -9` one → restarted and its copies re-rendered ≤ 2 s; the `hog` probe (CPU) → SIGKILL at 6 s (ping 2 s × 3 missed), exit observed ≤ 7 s; the OOM probe → exit 133 → restart, other folders unaffected; idle RSS per host ≤ 120 MB | `deno task test:security` (T30 availability rows) |
| T08 | **View manager**: copies per block/overlay/pane-header, `cx` (7 used methods + `timer`), render scheduling, tree diff → `patch`, handler registry (ids per view, invalidated per render), `nextCommand` routing, overlays (`openOverlay/closeOverlay`), `origin` plumbing | BE | `packages/bridge/src/views/**` | T04, T07 | all lstack copies render; click on `activity` tab → `panel-body.active` changes in session state and a `patch` is produced (spike click round-trip **[M]** reproduced) | `deno task test` (T24 harness) |
| T09 | **`herdr` implementation** (DESIGN §5.4 sources): `spaces/panes/terminals/agents/focused/layout/layouts/theme/settings/fonts/keys/commands/window/updates/knownAgents`, `shared` overlay (D8), `run()` → §2.4 classes, `exec/hc/readTextFile/watchFolder/net.*` → T05 policy, `watchFolder` via `Deno.watchFs` (≤ 16 watchers per folder, 100 ms debounce), `storage.set`, `writeTextFile` refusal, cockpit hub proxy (`net.connect` to `hub.json` port only **[M]**) | BE | `packages/bridge/src/herdr/**`, `packages/bridge/src/static.ts` | T03, T05, T08 | all 31 used functions implemented; 13 unused reject with `not supported remotely: <name>`; static route allowlist + traversal refusal | `deno task test` (T23) |
| T10 | **Server + auth**: `Deno.serve` on `127.0.0.1:<port>` (HTTP + WS upgrade), Tailscale identity gate (header/Host/peer), device pairing CLI (`herdr-relay pair/devices/revoke`, 6-digit code TTL 2 min), httpOnly cookie + one-time WS ticket, loopback dev token (never with `Origin`), `tailscale serve --bg --set-path /herdr-relay <port>` helper (refuse Funnel), read/act scope enforcement, `HERDR_RELAY_DEV=insecure-no-sandbox` ⇒ pairing disabled | BE | `packages/bridge/src/server/**`, `packages/bridge/src/auth/**`, `packages/bridge/bin/**`, `packages/bridge/src/main.ts`, `packages/bridge/src/config.ts` | T02 | gate matrix (T25) passes; serve helper refuses when Funnel is on; bridge exits 3 without `sandbox-exec` unless dev flag | `deno task test`; `deno task start:dev` then `curl -H 'Authorization: Bearer <token>' http://127.0.0.1:<port>/herdr-relay/api/hello` |
| T11 | **Terminal relay + Web Push**: observe attach per visible pane, type attach for `act` (never resize **D4**), `term.size`, binary frames, 1 MiB backpressure; VAPID keygen into `<state>/vapid.json`, RFC 8291 aes128gcm with WebCrypto, `events.subscribe` → `working→blocked` ("Needs you") / `working→idle` ("Finished") deduped by `(address, turn)`, muted while a device is `visible`, endpoints limited to the 3 hosts in §1.2 | BE | `packages/bridge/src/terminal/**`, `packages/bridge/src/push/**` | T03, T10 | `terminal.get` cols/rows unchanged before/after remote typing; push fires once per transition (T26) | `deno task test` |
| T12 | **Mirror mod** `herdr-relay-mirror` (D5): debounced POST of `theme/settings/fonts/layout/focused/panes/themes/shared("*")` to `http://127.0.0.1:<port>/herdr-relay/mirror` with the loopback token; bridge endpoint + staleness marker + snapshot cache in `<appHome>/data/herdr-relay/mirror.json` | BE | `mods/herdr-relay-mirror/**`, `RECIPE.md`, `packages/bridge/src/mirror.ts` | T09 | `herdr-app check mods/herdr-relay-mirror` passes; theme equals mirrored theme ≤ 1 s after a switch on the Mac | Main/user: `herdr-app check …`; install is the user's step |
| T13 | Desktop path tooling (D9): `tools/sync-config` (rsync include list from DESIGN §2, `keys.json` section merge, dry-run default) + `docs/DESKTOP.md` | BE | `tools/sync-config/**`, `docs/DESKTOP.md` | T00 | dry-run prints exactly the "yes" set | `deno task test` (T27) |
| T14 | lstack `on:`-aware patch proposal (`exec/readTextFile {on: space.machine}` in `mods/lstack-herdr/components/*` + `hooks.mjs`) under `tools/lstack-remote-patch/`, **not applied** (D9) | BE | `tools/lstack-remote-patch/**` | T13 | `git apply --check` against a scratch copy of `fixtures/herdr-home/mods/lstack-herdr` succeeds | Main: `git apply --check` |
| T15 | **Web shell**: bundle pipeline (§3.2, `tools/assets.ts`), WS client with `since` resume, IndexedDB cache + stale banner, Navigator (routes/segments/drawer/sheet from ScreenGraph), PWA manifest + `sw.js` + push subscription UI, pairing screen, `toast.action.open` handling (E11) | UI | `packages/web/src/app/**`, `packages/web/index.html`, `packages/web/manifest.webmanifest`, `packages/web/sw.js`, `packages/web/tools/**`, `packages/web/deno.json` tasks | T02, T04 | installable on iPadOS Safari and Android Chrome; reconnect resumes with `since`; `deno task bundle` produces `dist/` | `deno task bundle`; T28 |
| T16 | **Tree renderer**: `ElementTree` → React DOM with style map, `states` (hover/active/focus), CSS animations for `spin/loop/transition/frames`, SVG `path`, images via the static route, handler emission with GPUI keystroke encoding, `k:"error"` block, unknown kinds → red placeholder | UI | `packages/web/src/render/**` | T02 | renders every tree in `fixtures/trees/**` (from T24) with no console errors | T29 snapshots |
| T17 | **Widgets**: xterm (observe size, scale-to-fit, pinch 1:1 per D4), markdown/html (marked + DOMPurify), input/textarea with local echo + `set_auto_grow`, read-only code (highlight.js), virtual list windowing, hover card, resizable (touch dividers with 44 px hit zones; sizes kept per device in localStorage — amended by D12) | UI | `packages/web/src/widgets/**` | T16 | each widget has a story page under `/herdr-relay/dev/widgets` (dev flag only); terminal shows a live Mac terminal in observe mode | T28 |
| T18 | **Phone/tablet polish + fonts**: bottom segments + More sheet, drawer edge-swipe, pane pager, safe areas, 44 px targets (icon-only press targets get a 44×44 px hit area on touch screens), dark/light from theme, `fonts.manifest.json` + `OFL.txt` files + `@font-face` CSS (§3.3) | UI | `packages/web/src/app/**`, `packages/web/src/render/render.css`, `packages/web/public/fonts/fonts.manifest.json`, `packages/web/public/fonts/*/OFL.txt`, `packages/web/tools/assets.ts` | T15–T17 | lstack phone ScreenGraph navigable end-to-end at 390×844 and iPad portrait; `deno task --cwd packages/web fonts` fetches 4 families with matching sha256; manifest test passes | `deno task --cwd packages/web fonts`, `deno task bundle`, T28 |
| T20 | Style parser tests: extract the generated names from `fixtures/herdr-home/mods/tabs/gpui-kit.d.ts` → every name parses; 59 arg methods map; negative `p("auto")` rejected | TW | `packages/protocol/test/**` | T02 | — | `deno task test` |
| T21 | Fake core (in-process JSON-RPC + framed server): negotiate, frame boundary splits, disconnect→`reset`, oversized frame rejection, observe-attach never sends `resize` | TW | `packages/bridge/test/fakes/core.ts`, `packages/bridge/test/unit/core/**` | T03 | — | `deno task test` |
| T22 | Recompose goldens (lstack + `fixtures/layouts/*`) × 4 device classes; interception table; command classification completeness vs `fixtures/herdr-app-commands.json`; negative: unknown ids in `.state` ignored | TW | `packages/protocol/test/recompose/**`, `packages/bridge/test/unit/session/**`, `fixtures/layouts/**` | T04 | — | `deno task test` |
| T23 | **Policy tests** (unit, no processes): one test per row E1–E16 (allow + at least one refusal variant each), read policy (lexical escape, symlink to secret, > 1 MiB, missing → null), env-key allowlist incl. `DYLD_INSERT_LIBRARIES`, git option denylist incl. `-c alias.x=!…`, hc write forms, scripts outside loaded folders, static route traversal, `writeTextFile` refusal, `run()` classes incl. `read`-scope refusal, `origin` forgery ⇒ `read` | TW | `packages/bridge/test/unit/policy/**`, `packages/bridge/test/unit/herdr/**` | T05, T09 | — | `deno task test` |
| T24 | **Headless mod harness**: real `packages/modhost` process per fixture folder (under Seatbelt when available), stub state from `spikes/deno/stub-data.ts` migrated to `packages/bridge/test/fixtures/state.ts`, render every lstack block + the 22 coverage copies + overlays; assert 0 unknown style names, 0 unsupported `herdr` calls, 0 errors; **record trees into `fixtures/trees/`** (replaces `spikes/deno/out/*.json`) | TW | `packages/bridge/test/views/**`, `packages/bridge/test/fixtures/**`, `fixtures/trees/**` | T06, T07, T08 | — | `deno task test` |
| T25 | Auth matrix: tailnet owner / other tailnet user / wrong Host / cross-site Origin / loopback token / token + Origin / pairing code TTL + one-time / WS ticket replay / `read` device sends `key`,`input`,`command` → `ack read-only-device` / dev-insecure mode disables pairing | TW | `packages/bridge/test/unit/auth/**`, `packages/bridge/test/unit/server/**` | T10 | — | `deno task test` |
| T26 | Terminal relay + push tests: no resize on type; backpressure close at 1 MiB; ack monotonicity; push dedupe `(address, turn)`; mute while visible; endpoint host not in the allowlist refused; aes128gcm vector test | TW | `packages/bridge/test/unit/terminal/**`, `packages/bridge/test/unit/push/**` | T11 | — | `deno task test` |
| T27 | sync-config dry-run tests against a fixture home | TW | `tools/sync-config/test/**` | T13 | — | `deno task test` |
| T28 | Device runs: Playwright (iPhone 15 / iPad Air / Pixel 8 emulation) against `start:dev` + fake core; `tools/device-tests/{ios-sim.sh, android-avd.sh}` (§5.2); screenshot capture into `.tmp/devices/` | TW | `tools/device-tests/**` | T15–T18 | — | Main runs the scripts (§5.2) |
| T29 | Renderer snapshot tests: `renderToStaticMarkup` of every `fixtures/trees/**` (no DOM needed); a11y (amended): on the phone class every icon-only element with a `click` handler has a ≥ 44×44 px effective hit area (T18 `pointer: coarse` expansion); text controls and rows keep the mod's own size (expanding them would overlap neighbours) and are reported as counts; fonts manifest/license test | TW | `packages/web/test/**` | T16, T18 | — | `deno task test` |
| T30 | **Security matrix** (integration; §5.3): migrate `spikes/deno/probe-mods/*` + `probes/*` to `fixtures/probe-mods/` and `packages/bridge/test/security/`; each row of §5.3 is one test naming the layer expected to block; availability rows (hog, OOM, self-kill, `Deno.exit`) | TW | `packages/bridge/test/security/**`, `fixtures/probe-mods/**` | T07, T09 | — | `deno task test:security` |
| T31 | Live-core tests (opt-in): `hello`, `rpc.discover`, `doc.get herdr-app`, `terminal.list`, `terminal.get <first>`, `events.subscribe` for 3 s, `terminal.attach` observe for 1 s then close — **no** `doc.set`/`terminal.run`/typing | TW | `packages/bridge/test/live/**` | T03 | — | `deno task test:core` |
| T32 | Cleanup: delete `spikes/` after T24 fixtures and T30 probes are regenerated from `packages/`; move both READMEs to `docs/spikes/`; update `docs/DECISIONS.md` D6 evidence links; CHANGELOG entry | BE | `spikes/**` (delete), `docs/spikes/**`, `docs/DECISIONS.md`, `CHANGELOG.md` | T24, T30 | `deno task check && deno task test` green with `spikes/` gone | `deno task check`, `deno task test` |
| T33 | launchd template `tools/launchd/io.github.lapis0875.herdr-relay.plist` + `docs/DEVICES.md` operations section (start/stop/logs/pairing) | BE | `tools/launchd/**`, `docs/DEVICES.md` | T10 | plist passes `plutil -lint`; documents exact flags from `deno.json` | `plutil -lint tools/launchd/*.plist` |

**Spike code folded in as explicit migrations** (not copy-paste): T05 (`bridge.ts` policy + symlink audit + MODHOST_ARGS/seatbelt probe), T06 (`modhost/host.js` + `worker.js` → `main.js`; `shim/*` → `shims/*`), T07 (ctl listener/writeAll/forged-copy drop from `bridge.ts:318–420`), T24 (`stub-data.ts`, `out/*.json` → `fixtures/trees`), T30 (`probe-mods/*`, `probes/*`), T32 (delete `spikes/`). `outline.ts` → `packages/bridge/tools/outline.ts` in T07 (dev aid).

**Integration order:** T00 → {T02} → {T03, T04, T05, T06} (independent: core, recompose, policy, modhost) → T07 → T08 → T09 → T10 → T11 → T12 → UI T15/T16 (start after T02/T04 using `fixtures/trees` from T24; T24 needs T08) → T17 → T18 → T28 device verification → T32. T13/T14/T33 any time after their deps. Tests T20–T27, T29–T31 follow their implementation task; T30 after T09. No dependent pair runs in parallel.

---

## 5. Verification obligations

### 5.1 Real `hc connect` (this Mac, read-only)

Facts confirmed by Main: herdr-core 0.1.19, generation 1, 32 methods incl. `hello, rpc.discover, doc.get, doc.set, terminal.attach, terminal.list, terminal.get, terminal.run, events.subscribe` (`docs/DECISIONS.md`). Tests (T31) and T03 acceptance use **only**: `hello {generation:1, framed:true}`, `rpc.discover`, `doc.get {name:"herdr-app"}`, `terminal.list`, `terminal.get`, `events.subscribe` (≤ 3 s), `terminal.attach` observe (≤ 1 s, no input, no resize). Forbidden everywhere in tests: `doc.set`, `terminal.run`, any typing, `terminal.attach` type mode. Gate: `HERDR_RELAY_LIVE_CORE=1` and `--allow-run=hc`; the test skips (not fails) when unset. Main runs `deno task test:core` and reports the first failing assertion.

### 5.2 Device checks (`tools/device-tests/`)

Facts **[V DESIGN §6]**: Xcode present with iPad device types, no simulator devices created; Android SDK at `~/Library/Android/sdk` with `system-images;android-35;google_apis;arm64-v8a`, `cmdline-tools/latest`, no AVD; Java via Homebrew openjdk.

1. **iPad Simulator** (`ios-sim.sh`): `RUNTIME=$(xcrun simctl list runtimes -j | <jq-free deno one-liner> pick latest iOS)`; `xcrun simctl create "herdr-relay iPad Air" "iPad Air (5th generation)" "$RUNTIME"`; `xcrun simctl boot <udid>`; `xcrun simctl openurl booted "http://127.0.0.1:<port>/herdr-relay/?token=<loopback token>"`; `xcrun simctl io booted screenshot .tmp/devices/ipad-{portrait,landscape}.png` (rotate via `xcrun simctl … orientation`? not available → use the Simulator menu or Playwright viewport for landscape; document). Acceptance: both orientations show the recomposed lstack (rail + sheet in portrait; split in landscape). Web Push cannot be tested in Simulator **[B]**.
2. **Android AVD** (`android-avd.sh`): `avdmanager create avd -n herdr-relay -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_tablet` (fallback `-d pixel_7`); `emulator -avd herdr-relay -no-snapshot -no-boot-anim &`; `adb wait-for-device`; `adb shell am start -a android.intent.action.VIEW -d "http://10.0.2.2:<port>/herdr-relay/?token=<token>"`; screenshot via REA `xd://mcp__rea_capture_adb_screen` or `adb exec-out screencap -p`. Acceptance: installable PWA prompt in Chrome; phone class navigation works on `pixel_7`.
3. **Real iPad Air over tailnet** (user action): `herdr-relay serve` (tailscale serve set-path), open `https://<mac>.<tailnet>.ts.net/herdr-relay/`, `herdr-relay pair` → code → device paired as `act`; Add to Home Screen; enable notifications; on the Mac, let an agent finish → push "Finished" arrives; type one character into an observe→type terminal and confirm with `hc terminal get` that cols/rows did not change.
4. **Playwright** emulation (T28) runs headless in CI-style against `start:dev` + fake core for regressions; it is the only Node-run tool and lives in `tools/device-tests/package.json`.

### 5.3 Security test matrix (from both spikes' attack tables)

Layers: **D** Deno flags · **S** Seatbelt · **P** bridge policy · **X** process separation · **A** auth gate · **R** modhost runtime hardening. Each row = one test in T30 (integration, real mod host + `fixtures/probe-mods/evil`) or T23/T25 (unit). "Expected" names the layer that must block; a second letter = defense in depth also asserted.

| # | Attack (from spike) | Expected | Test |
|---|---|---|---|
| S01 | `Deno.readTextFile(<state>/devices.json)` from a mod | D | T30 |
| S02 | `import()` of a module that statically imports the secret; `import('../../secret/'+name)`; `fetch('file://…')` | D | T30 |
| S03 | **symlink inside the mod folder → secret**, read via `Deno.readTextFile`/`import()` | **S** (D does not) + load-time audit refuses the folder | T30 (audit) + T30 (Seatbelt, folder started with audit bypassed in test) |
| S04 | same via `herdr.readTextFile` | P (realpath) | T23 |
| S05 | read appHome `settings.json` / another mod's `ui.js` directly | D | T30 |
| S06 | `readTextFile("<appHome>/../../x")`, `~/.ssh/id_ed25519`, `> 1 MiB` | P | T23 |
| S07 | `new Deno.Command('/bin/sh')`, `node:child_process` | D (+S no process-fork) | T30 |
| S08 | `exec('cat'/'sh'/'env /bin/sh'/'curl')` | P (E16) | T23 |
| S09 | `exec('node', ['-e', …])`, `node <other folder's script>`, `node <unknown script>` | P (E3) | T23 |
| S10 | `exec('env', ['DYLD_INSERT_LIBRARIES=…', 'git'])`; `env PATH=… cockpit hub start` | P (E10) — and D blocks `DYLD_*` even for the bridge **[M]** | T23 + T30 |
| S11 | `exec('git', ['-c','alias.x=!echo PWNED','x'])`, `git --exec-path=…`, `git diff --ext-diff`, `git push` | P (E4) | T23 |
| S12 | `exec('git', ['-c','core.fsmonitor=false','status',…])` (shipped `files`) | **allowed** (control) | T23 |
| S13 | `hc(['kill',…])`, `hc(['terminal','run',…])`, `hc(['doc','set',…])` | P (E7) | T23 |
| S14 | `sh -c <modified literal>`; `sh -c <L1> files /etc` | P (E14 hash / roots) | T23 |
| S15 | `sh -c <L2 remote> … file:///etc/passwd`; destination outside `data/cockpit/show` | P (E15) | T23 |
| S16 | `net.connect('127.0.0.1', 22)`, `('example.com', 80)`, `(hub port)` from a folder that did not open it (`net.write` on another folder's socket id) | P | T23 |
| S17 | `Deno.connect`/`fetch`/`WebSocket` to the hub port or the bridge port directly | D (`--allow-net=127.0.0.1:<ctl>` only) | T30 |
| S18 | mod connects to `<ctlPort>` itself and sends `hello` without the token / floods | P (drop ≤ 1 s; rate limit → restart) | T30 |
| S19 | forged `rpc` with another folder's copy id; forged `tree` for another folder; forged `origin.session` of an `act` device from a `read` event | P (attribution by connection; stale/forged origin ⇒ `read`) | T30 + T23 |
| S20 | `Deno.env`, `process.env`, `Deno.hostname`, `Deno.dlopen`, `Deno.listen` | D | T30 |
| S21 | `import('https://…')`, `npm:`, `jsr:` | D (`--no-remote --no-npm`, import permission) | T30 |
| S22 | `Deno.permissions.request({name:'read',path:'/'})` | D → `"denied"`, no prompt | T30 |
| S23 | `caches.open().put()`; `BroadcastChannel` | R (deleted) + per-host `DENO_DIR` + X (separate processes) | T30 |
| S24 | `Deno[Deno.internal]` reachable | R (deleted) | T30 |
| S25 | `Deno.stdout.write("<forged protocol line>")` | X (stdout never parsed) — assert layout unchanged | T30 |
| S26 | `Deno.kill(Deno.ppid)` (bridge) | D | T30 |
| S27 | `Deno.kill(Deno.pid)`, `Deno.exit(7)` | supervisor restart; other folders unaffected | T30 (availability) |
| S28 | `for(;;);` (hog) | watchdog SIGKILL at 6 s, exit observed ≤ 7 s (reap); others keep rendering | T30 |
| S29 | heap exhaustion | exit 133 → restart; bridge up; others unaffected | T30 |
| S30 | `Error().stack` path leak to devices | bridge strips absolute paths from `error` before `toast`/`ack` | T23 |
| S31 | `writeTextFile(anything)`; `watchFolder('/')` | P (refused / roots) | T23 |
| S32 | bridge self: read `/etc/hosts`, `~/.ssh`; write into appHome; spawn `ls`, `/bin/sh`, an unlisted binary (`/usr/bin/curl`; amended from `/usr/bin/git`, which `--allow-run=git` resolves to on some Macs); connect `1.1.1.1:80`; listen `0.0.0.0`; import `https://` | D (bridge flags) — asserted by spawning the bridge with its production flags and a `--self-test` switch | T30 |
| S33 | tailnet: other user login / wrong Host / cross-site Origin / token with Origin / WS ticket replay / expired pairing code / `read` device typing | A | T25 |
| S34 | `push.sub` with endpoint host not in the 3-host allowlist | P | T26 |
| S35 | Seatbelt absent (`sandbox-exec` missing) without dev flag | bridge exits 3; with `insecure-no-sandbox` pairing is disabled | T25/T30 |
| S36 | mod folder with escaping symlink appears **after** start | S at runtime; audit on restart refuses | T30 |

Regression rule: any Deno upgrade re-runs `deno task test:security`; any macOS upgrade re-runs the Seatbelt derivation check (zero denials for benign, S03/S36 still blocked).

---

## 6. Amendments to DESIGN.md v1 (what changed and why)

| v1 | v2 | Reason |
|---|---|---|
| Bun bridge + in-process mod host with realms | Deno bridge + one Seatbelt'd `deno run` per mod folder | D6; OOM/Worker-permission findings **[M]** |
| `node` on the bridge's run list | `node` removed; scripts run under scoped `deno run` | measured **[M]**; removes a trampoline |
| `git -c` fully refused (spike) | `-c` allowed only for the two shipped `files`/`changes` keys | shipped mods would break otherwise **[V files/main.js:96, changes/main.js:14]** |
| `sh` refused outright | two pinned literals (files listing, show picture) re-implemented natively/scoped | shipped `files` mod needs it **[V]** |
| React + Vite + Tailwind | React, `deno bundle`, plain CSS with theme variables, no Tailwind | zero build deps; style mapping is generated anyway |
| JetBrains Mono + D2Coding | Geist + Pretendard + JetBrains Mono + D2Coding, manifest + licenses | D10 |
| T-numbering | renumbered (T05 policy, T06 modhost, T07 supervisor…); T01 kept as done | new tasks |

---

## 7. Main-side evidence requested (not blockers for starting T00)

- **M1** `herdr-app commands` output → `fixtures/herdr-app-commands.json` (seed for §2.4; T04 depends on it).
- **M2** Confirm `deno bundle --platform browser` exists on Deno 2.9.8 (`deno bundle --help`) — T00 probe (a) covers it; an early answer lets UI start on `deno bundle` vs the Vite fallback.
- **M3** `sandbox-exec -p '(version 1)(deny default)' /bin/true; echo $?` and `ls /System/Library/Sandbox/Profiles/system.sb` — tells T05 whether `(import "system.sb")` is available on this macOS.

---

## 8. New user decisions (3)

| # | Question | Options | Recommendation |
|---|---|---|---|
| **U1** | `changes` mod commits from a device (`git add -A && git commit -m <msg>`, `changes/main.js:157` **[V]**) — a repository mutation that D3 did not name | (a) refuse remotely; (b) allow for `act`-scope devices only | **(b)** — it is the mod's own UI, non-structural for Herdr, and scoped to `act`; refusal would leave a dead "Commit" button |
| **U2** | Regenerating the lstack fork from a device (`sync.mjs`, rewrites `mods/lstack-herdr-cockpit/**`, `layouts/lstack-herdr.*`, `keys.json`; needs a Herdr restart **[V]**) | (a) refuse, toast "run Sync on the Mac"; (b) allow for `act` under profile `sync` | **(a)** for v1 |
| **U3** | `open <url>` from mods (`hub.js:19` **[V]**) | (a) refuse; (b) open on the **device** that triggered it (toast with a link; never on the Mac) | **(b)** |

---

## 9. Risks for the parent

- **R1 Seatbelt derivation effort** (T05): the exact mach-lookup/sysctl set Deno needs under deny-default is unmeasured; budget 0.5 day; fallback is a narrower `(allow default)` profile with explicit `deny file-read*` on `$HOME` minus the folder, which still closes the symlink class **[M]**.
- **R2 `deno bundle` maturity** on 2.9.8 **[I]** — fallback decided (§3.2), checked in T00 (a).
- **R3 Per-process memory** (6 Deno processes) — budget set; if idle RSS > 120 MB/host, T07 may group *shipped* mods (`tabs`, `files`, `changes`, `workspace-chrome`) into one host as they share Herdr's trust level — a parent decision only if the budget is missed.
- **R4 `--allow-read=$HOME` for the bridge** is wide by design (space folders); the policy layer is the real bound and is fully tested (T23). Spaces outside `$HOME`/`/tmp` are unreadable remotely.
- **R5 `herdr-app commands` classification** (§2.4) needs M1; until then `passthrough` is empty and every non-session, non-mod command is refused — safe default.
