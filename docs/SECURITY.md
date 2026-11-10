# herdr-relay — security model

Split by T00 on 2026-11-09; text copied verbatim from [DESIGN-v2.md](DESIGN-v2.md) §0, §1.1–§1.4, §1.6, §5.3, §9 and
from [DESIGN.md](DESIGN.md) §4 (v1; in force except as amended by DESIGN-v2). Implemented by **T05** (policy, Seatbelt),
**T06** (mod host hardening), **T07** (supervisor), **T10** (server + auth), **T11** (push); tested by **T23**, **T25**,
**T26**, **T30**. Exec/file policy rules live in [POLICY.md](POLICY.md); the control-channel trust rule lives in
[PROTOCOL.md](PROTOCOL.md). Evidence legend as in DESIGN-v2 (**[V]** read on this Mac · **[M]** measured by a spike ·
**[I]** inference · **[B]** stated in the brief).

Reporting a vulnerability, supported versions and the threat-model summary: [SECURITY.md](../SECURITY.md) at the
repository root. The spikes' measurements behind this model: [spikes/deno.md](spikes/deno.md),
[spikes/bun.md](spikes/bun.md).

The review fixes (independent review of `50f1629`; commits `846f8c6`, `fce82d7`, `bb9d83d`) amended rows S11, S16,
S19 and S33, added row S37, the "Cross-site top-level navigation" paragraph of §2 and the matching §4 notes;
`file:line` citations there are the working tree at `bb9d83d`. Evidence:
[AMENDMENTS-c1-wave4.md](AMENDMENTS-c1-wave4.md#review-fixes-independent-review-of-50f1629).

---

## Trust zones — DESIGN-v2 §0

Two trust zones on the Mac. The **bridge** (one `deno run`, privileged: secrets, auth, HTTP/WS, `hc connect`, policy, push, tailscale) never loads mod code. **Mod hosts** (one `deno run` process **per mod folder**, under macOS Seatbelt, with `--allow-read=<that folder>` and `--allow-net=127.0.0.1:<ctl>` only) load the unmodified mod through a computed `import()` inside a bridge-authored entry, record element trees, and talk to the bridge over a token-authenticated NDJSON/TCP control channel. Every `exec`/`hc`/`readTextFile`/`net` the mods perform is an RPC the bridge decides with an **argument-level** allowlist; `node <script>` becomes a **scoped `deno run`**; the two `sh -c` literals shipped mods use are pinned by hash and replaced by native/scoped implementations. The web client is a PWA built with `deno bundle` (no Vite, no npm build tooling) and served by the bridge; fonts per D10 are vendored with licenses and a checksum manifest.

---

## 1. Process model — DESIGN-v2 §1.1–§1.4, §1.6

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

Wave 4 (2026-11-10): `--allow-import=jsr.io:443` limits module loading to the locked JSR packages (without it Deno 2.9
grants import from every host and only `--cached-only` stops a remote import; `--deny-import` breaks the `jsr:@std`
imports, measured); `main.ts --self-test` (S32) shows a remote import refused by the import permission.
`HERDR_RELAY_TAILSCALE_BIN` lets the bridge honour the launcher's Tailscale CLI override. `herdr-relay start` computes
this line for the machine ([AMENDMENTS-c1-wave4.md](AMENDMENTS-c1-wave4.md), T44).

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

**T00 notes (2026-11-09, measured, see [PROBES-T00.md](PROBES-T00.md)):**
- The bridge flags above are the root `deno.json` tasks `start` / `start:dev`. `deno task`'s shell expands `$HOME` and
  `$TMPDIR` but not `${VAR:-default}` (measured), so `<appHome>` is fixed to `$HOME/.config/herdr-app` and `<run>` to
  the `$TMPDIR/herdr-relay` parent there; a `HERDR_APP_HOME` override is not reflected in `--allow-write` (T10 owns
  the launcher).
- `packages/modhost/deno.json` carries `"workspace": []`, making it its own workspace root. Measured on Deno 2.9.8: with
  `--config` pointing at it, the six specifiers resolve to `packages/modhost/src/shims/*.js` for a file under `/tmp`;
  root import-map entries (`@std/assert`, `react`, `@herdr-relay/protocol`) do **not** resolve; and the per-spawn
  stderr warning "config file … is not a member of the workspace … Ignoring the parent workspace config" is gone.

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

### 1.6 Lifecycle, crash/OOM restart, watchdog

Supervisor (`packages/bridge/src/hosts/supervisor.ts`) per folder:

1. `start`: realpath the folder, run the symlink audit (§2.2) — a folder with an escaping link is **not started** and renders an error block; write the Seatbelt profile; mint a token; spawn; wait for `hello` (≤ 5 s) then send `boot`; wait for `loaded` (≤ 10 s; cockpit graph import measured 37 ms **[M]**); then `create` every copy the view manager owns for that folder and push `state`.
2. Running: `ping` every 2 s; 3 missed `pong` → `SIGKILL` → restart. `pong.heap` > 200 MB → log + restart at the next idle moment (V8 cap is 256 MB; the process aborting on OOM is also handled by 3).
3. Exit for any reason (clean, crash, OOM exit 133 **[M]**, `Deno.kill(Deno.pid)` **[M]**, watchdog): backoff 0 s, 1 s, 5 s, 30 s; > 5 exits within 10 min → `failed`, blocks of that folder render `{k:"error", folder, reason}` on clients, retry every 5 min. Other folders are unaffected (separate processes). Clients receive fresh `view.tree` for the folder's copies after a restart; handler ids are reissued.
4. Mod folder change (`Deno.watchFs(<appHome>/mods/<folder>)`, debounced 500 ms, as Herdr reloads on save): graceful `exit` + restart with the same copies. Layout change (`layouts/<name>.json` or `.state`): the view manager recomputes copies; folders no longer referenced are stopped after 30 s.
5. Bridge exit: `exit` to every host, `SIGKILL` after 2 s, remove `<run>`.

---

## 2. Network, identity, pairing, push, offline — DESIGN.md §4 (v1)

In force except where DESIGN-v2 amends it: the "Trust boundary for mods" paragraph below is superseded by the process
model above (D6: mods run in unprivileged, Seatbelt-confined mod hosts, not as the user inside the bridge); its last two
sentences (clients never receive mod code; `read`-scope write refusals) still hold.

**Network/identity (Tailscale-only).** Bridge binds `127.0.0.1:<port>` only; published with `tailscale serve --bg --set-path /herdr-relay <port>` on the Mac's existing MagicDNS name `<mac>.<tailnet>.ts.net` (Shepherdr already uses `/shepherdr`; both coexist by path) **[V tailscale.ts]**. Refuse to serve when Funnel is enabled on that port (Shepherdr rule). Gate (copy Shepherdr `auth.ts` semantics): `Tailscale-User-Login` must equal the machine owner's login from `tailscale status --json`, `Host` must equal the DNS name, connections must come from tailscaled (peer check), writes/WebSockets require `Origin === https://<dns>` and a custom header; cross-site requests rejected, except the one top-level navigation below.

**Cross-site top-level navigation (review fix, `bb9d83d`).** The gate refuses `OPTIONS` and every `Sec-Fetch-Site: cross-site` request with one exception: a top-level navigation that loads the app shell's page — GET or HEAD, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document` or no `Sec-Fetch-Dest`, and no `Origin` (`isDocumentNavigation`, `packages/bridge/src/auth/gate.ts:13-24,33-47,77-85`). The server asks for this `navigate` access only for GET/HEAD of the shell's HTML routes, extensionless paths and `/index.html` (`packages/bridge/src/server/server.ts:11-12,201-208`); `/api/*`, `/ws`, extension routes (`/mirror`, `/push/key`, `assets/…`) and the bundle's other files (`app.js`, `sw.js`, `manifest.webmanifest`, …) stay same-site only, and so do frames (`Sec-Fetch-Dest: iframe`/`frame`; also `X-Frame-Options: DENY`, `packages/bridge/src/server/http.ts:8`), the `cors`/`no-cors`/`same-origin` modes, a navigation with an `Origin`, POST and WebSockets. It is how Android opens the app from an intent, another app's link or a notification. Such a request still passes every other transport check — on the tailnet the owner's login, the MagicDNS `Host` and the tailscaled peer (no `Origin` is required: it is a read); on loopback a loopback `Host` — and gets only the static shell, at the `shell` level: no cookie, ticket or session is issued (`packages/bridge/src/auth/gate.ts:87-110`; `packages/bridge/src/auth/auth.ts:75-99`). A loopback `?token=` in its URL grants nothing by itself: the bridge never reads it; the shell's own script moves it into `sessionStorage` (this tab only) and strips it from the address bar (`packages/web/src/app/env.ts:39-59`), then presents it only as `Authorization: Bearer` on its own same-origin `fetch`es, without `Origin` (`packages/web/src/app/api.ts:44-46`), which the gate checks as usual — so a cross-site navigation can load the page but never authenticates. Tests: `packages/bridge/test/unit/auth/cross_site_nav_test.ts` (the fetch-metadata predicate; `navigate` access is `read` plus the exception, GET/HEAD only), `packages/bridge/test/unit/server/cross_site_nav_test.ts` (shell pages served on loopback and tailnet without a cookie; API, resource, frame, `OPTIONS`, POST and WebSocket requests refused; owner, host and peer still checked; a token in the navigation does not authenticate a later cross-site request).

**Device pairing (second factor, per device).** First visit → `herdr-relay pair` on the Mac prints a 6-digit code (TTL 2 min); the device enters it → the bridge issues a device record `{id, name, scope, created}` in `~/.herdr/herdr-relay/devices.json` and sets an httpOnly, Secure, SameSite=Strict cookie; WebSocket upgrades carry a one-time ticket minted over HTTPS. Scope per device: `read` (view + terminals observe) or `act` (typing, `run`). Revoke via CLI. Local dev (simulators/emulators, no Tailscale headers): loopback bearer token in `~/.herdr/herdr-relay/token`, never accepted with an `Origin` header (Shepherdr rule).

**Trust boundary for mods.** Mods are trusted code already (AGENTS.md **[V]**); they run on the Mac as the user, exactly as in Herdr, limited to the mod folders referenced by the active layout. Clients never receive mod code — only trees. Write-capable `herdr` calls triggered by a `read`-scope device are refused at the bridge (`run`, `writeTextFile`, `setShared` persistence, typing).

**Push (agent done/blocked).** Web Push (VAPID ES256, RFC 8291 aes128gcm) with WebCrypto, modelled on Shepherdr `push.ts` **[V]**; subscriptions in `~/.herdr/herdr-relay/push.json`. Triggers from `events.subscribe`: `status.state` transitions `working→blocked` (title "Needs you") and `working→idle` (title "Finished") per terminal/turn, deduped by `(address, turn)`; muted while any device socket reports `visible:true`; tap opens the pane route. iPad: PWA must be installed to Home Screen; the Android PWA works in Chrome. No APNs/FCM in v1.

**Offline/reconnect.** Client keeps the last ScreenGraph + trees + snapshot in IndexedDB and renders them greyed with a "stale since HH:MM" banner. WebSocket reconnect with backoff 1→2→5→10→30 s; `hello {since: seq}` resumes from the bridge's patch ring (last 512 patches, else full snapshot). Terminals re-attach observe-only; typed input never replayed; pending `run` acks time out at 15 s (core default) and surface as toasts. Bridge ↔ core: on `disconnected` from `hc connect`, re-negotiate and emit `reset` (Shepherdr `live.ts` pattern).

---

## 3. Security test matrix — DESIGN-v2 §5.3

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
| S11 | `exec('git', ['-c','alias.x=!echo PWNED','x'])`, `git --exec-path=…`, `git diff --ext-diff`, `git push`; abbreviated denied options (`git log --out=/tmp/x`, `git --git-d <dir> log`, `git diff --no-ind a b`); `git branch -- <name>`, `git branch --set-up <b>`; `git diff /etc/passwd x`, `git diff -- ../../x`, `git diff` outside a repository (git's implicit `--no-index`) | P (E4, POLICY.md §2.3) | T23 (`packages/bridge/test/unit/policy/git_security_test.ts`) |
| S12 | `exec('git', ['-c','core.fsmonitor=false','status',…])` (shipped `files`) | **allowed** (control) | T23 |
| S13 | `hc(['kill',…])`, `hc(['terminal','run',…])`, `hc(['doc','set',…])` | P (E7) | T23 |
| S14 | `sh -c <modified literal>`; `sh -c <L1> files /etc` | P (E14 hash / roots) | T23 |
| S15 | `sh -c <L2 remote> … file:///etc/passwd`; destination outside `data/cockpit/show` | P (E15) | T23 |
| S16 | `net.connect('127.0.0.1', 22)`, `('example.com', 80)`, `(hub port)` from a folder whose profile does not enable net; `net.write`/`net.read` on another folder's socket id | P (`net.connect` only to 127.0.0.1/localhost at the port `hub.json` names, only under a profile with `net.hubPortFrom`, ≤ 16 per folder; a socket id belongs to the folder that opened it; what may be written on it: S37) | T23 |
| S17 | `Deno.connect`/`fetch`/`WebSocket` to the hub port or the bridge port directly | D (`--allow-net=127.0.0.1:<ctl>` only) | T30 |
| S18 | mod connects to `<ctlPort>` itself and sends `hello` without the token / floods | P (drop ≤ 1 s; rate limit → restart) | T30 |
| S19 | forged `rpc` with another folder's copy id; forged `tree` for another folder; forged `origin.session` of an `act` device from a `read` event; a token replayed after its socket closed, after a resume on a new socket, or after the device was revoked | P (attribution by connection; hosts get only opaque origin tokens bound to session + the socket they were delivered over + folder + host generation for 30 s; any other origin — also a token whose session is detached, resumed on another socket, ended or revoked — ⇒ `read` from no device, policy rule `origin`; a revoked device's sessions end at once: the server's 2 s sweep calls `revokeDevice`, which forgets their tokens and closes their sockets 1008 "device revoked", without resume grace). Residual: same-folder replay ≤ 30 s on the same open socket (§4) | T30 + T23 (`packages/bridge/test/security/origin_lifecycle_test.ts`, `packages/bridge/test/unit/server/revoke_sweep_test.ts`) |
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
| S33 | tailnet: other user login / wrong Host / cross-site Origin / token with Origin / WS ticket replay / expired pairing code / `read` device typing; cross-site requests other than a top-level document navigation to a shell page (frames, `fetch`/`cors`/`no-cors`, `/api/*`, assets, extension routes, `OPTIONS`, POST, WebSockets), a navigation with an `Origin`, and a `?token=` carried by a cross-site navigation (§2 "Cross-site top-level navigation") | A | T25 (`packages/bridge/test/unit/auth/cross_site_nav_test.ts`, `packages/bridge/test/unit/server/cross_site_nav_test.ts`) |
| S34 | `push.sub` with endpoint host not in the 3-host allowlist | P | T26 |
| S35 | Seatbelt absent (`sandbox-exec` missing) without dev flag | bridge exits 3; with `insecure-no-sandbox` pairing is disabled | T25/T30 |
| S36 | mod folder with escaping symlink appears **after** start | S at runtime; audit on restart refuses | T30 |
| S37 | hub requests on an allowed hub connection (POLICY.md §2.8): `act agents fork`, `act home resume`, `act routines run`, `go` from any device; `act inbox merge` or a `fetch` of a non-read kind from a `read` device, a downgraded origin or no origin; a refused request split across two writes or batched after an allowed one; an unknown op, a non-JSON line, a line over 1 MiB; `open_url file:///…`, `open_url` with no device or after another request on the connection; under `net.writes: act`, any write without a connected `act` device | P (`net.writes`): nothing of the write reaches the hub, the connection closes, the device that asked is toasted when there is one, the refusal is logged with rule `net` naming the request only (never the hub token); an http(s) `open_url` becomes a link on the device that asked (U3) and its answer reaches the connection's reads, a waiting one at once | T30 (`packages/bridge/test/security/hub_gate_test.ts`, `packages/bridge/test/unit/policy/hub_stream_test.ts`, `packages/bridge/test/unit/herdr/net_wake_test.ts`) |

Regression rule: any Deno upgrade re-runs `deno task test:security`; any macOS upgrade re-runs the Seatbelt derivation check (zero denials for benign, S03/S36 still blocked).

---

## 4. Risks — DESIGN-v2 §9 (security-relevant)

- **R1 Seatbelt derivation effort** (T05): the exact mach-lookup/sysctl set Deno needs under deny-default is unmeasured; budget 0.5 day; fallback is a narrower `(allow default)` profile with explicit `deny file-read*` on `$HOME` minus the folder, which still closes the symlink class **[M]**.
- **R3 Per-process memory** (6 Deno processes) — budget set; if idle RSS > 120 MB/host, T07 may group *shipped* mods (`tabs`, `files`, `changes`, `workspace-chrome`) into one host as they share Herdr's trust level — a parent decision only if the budget is missed.
- **R4 `--allow-read=$HOME` for the bridge** is wide by design (space folders); the policy layer is the real bound and is fully tested (T23). Spaces outside `$HOME`/`/tmp` are unreadable remotely.
- **S19 residual: origin-token replay within a folder** (wave 4, T08d; narrowed by the review fixes): one host serves
  every device, so a mod can reuse, for the rest of its 30 s lifetime, an origin token its own folder legitimately
  received with an `act` device's event or command — e.g. act on that device's behalf while handling a `read` device's
  click in that window — while that device's session stays connected over the same socket. Not possible across folders
  (a token is bound to its folder), across a host restart (bound to the host generation), after 30 s, once the socket
  it was delivered over has closed (a detached session counts as `read`, and the token stays `read` after a resume on a
  new socket), or once the device is revoked (the next 2 s sweep ends its sessions and forgets their tokens)
  (`packages/bridge/src/views/origins.ts:1-15,22-29,45-56,63-76`;
  `packages/bridge/src/views/manager.ts:98-104,352-387,491-497,633-682`;
  `packages/bridge/src/server/server.ts:14-17,54-57,87-88,231,245-260`). Closing it would need one host per device.
  Accepted.
- **Behaviour change (T08d):** a handler, timer or task still running more than 30 s after the event or command that started it no longer names its device: its `emit`/`rpc` counts as `read` from no device (no toast, no `open <url>`, no `act`-only row such as E5), logged `origin downgraded …` and recorded with policy rule `origin`.
- **Behaviour change (review fix, S19):** the same holds once the device's socket closes, also across a resume — a
  handler still running when its device reconnects no longer names it (downgrade reasons "session not connected",
  "token from before the session reconnected"). A revoked device's sessions end at once instead of waiting 120 s for a
  resume.
- **Hub write authorisation (S37, review fix).** Before it, `net.write` relayed whatever a mod wrote on an allowed hub
  connection whatever the origin: a `read` device's click, a downgraded origin or the mod's own task could make the
  cockpit hub fork, start or resume agents, move the Mac's focus, open pages on the Mac or run routines. Each write is
  now decided for the call's origin under the folder's `net.writes` (POLICY.md §2.8;
  `packages/bridge/src/herdr/net.ts:9-16,212-256`; `packages/bridge/src/policy/hub.ts:1-16,111-221`;
  `packages/bridge/src/policy/hub.table.ts:1-168`). Residual: the table is derived from the cockpit client, because
  the hub binary is not in this repository; an `act` action outside the Herdr-window list and outside `routines` is sent
  for a connected `act` device, so a hub action whose Herdr-window effect the client code does not show passes for
  `act` devices. Under `net.writes: act` a write is opaque: an `act` device's interaction may send anything on the
  connection. Behaviour change: a profile that enables net without naming `net.writes` gets `act`, so its writes from
  `init`, timers, downgraded origins and `read` devices are refused.
- **Cross-site navigation residual (review fix, `bb9d83d`; §2).** Any page, app, intent or notification can open the
  shell as a top-level page. On a paired device the shell then connects with that device's own cookie as if the user
  had opened it **[I]** (its later `fetch`es are same-origin), and a `?terminal=` in the link focuses that terminal in
  this device's session only: `pane.focus` is a session command, so the Mac's focus never moves
  (`packages/web/src/app/env.ts:39-55`; `packages/web/src/app/client.ts:97-102,197-199,500-504`;
  `packages/bridge/src/policy/commands.json:19`). Nothing else in the URL is acted on, and the linking page gets no
  answer or cookie from the bridge. Accepted.

Seatbelt availability on this Mac (M3): see [EVIDENCE-M1-M3.md](EVIDENCE-M1-M3.md).
