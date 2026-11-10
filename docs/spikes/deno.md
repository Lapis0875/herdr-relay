# T01 spike — Deno 2.9.8 runs the unmodified mods

**Verdict: GO.** It holds only with a two-process layout. The privileged bridge has no mod code. The unprivileged mod host runs one Worker per mod folder. Deno's own permission checks blocked every direct escape a hostile mod tried except three:

- a symlink inside the mod's own folder,
- `Deno.kill` on its own process,
- running out of memory.

The bridge's realpath policy, macOS Seatbelt and process separation cover those three. Everything below was measured on the author's Mac (Deno 2.9.8, V8 15.0, aarch64-apple-darwin) unless marked **[INFERENCE]**.

## Provenance

This is the record of the throwaway spike behind decision D6 ([DECISIONS.md](../DECISIONS.md)). The spike's code (`spikes/deno/`) was deleted once its parts had been rebuilt under `packages/` (T32); its run outputs (`out/*.json`, cited below by name) held absolute paths of the machine they ran on and were never published. The measurements stand as recorded; the current tests that cover the same ground are listed under [Where the spike went](#where-the-spike-went).

The spike ran as `deno task spike` (about 5 s) and `deno task import-graph` (about 1 s) in its own folder:

```sh
deno run --no-prompt --no-remote --no-npm \
  --allow-read=../../fixtures/herdr-home,. --allow-write=./out,./tmp --allow-net=127.0.0.1 --allow-env=HOME \
  --allow-run=hc,herdr-app,node,git,cockpit,tailscale,deno,sandbox-exec bridge.ts
```

It ran the bridge's self-tests and the sandboxed `lh-scan.mjs` run. It started the mod host and loaded 15 Worker folders. It created the 3 T01 copies, the `lstack-herdr` source copy, 22 coverage copies and the probes. Then it clicked, sent commands and ran the availability probes. Nothing was written outside the spike folder. `tmp/` was recreated by each run and held a stand-in HOME plus the child processes' DENO_DIRs.

## Go/no-go per requirement

| Requirement | Result | Evidence |
|---|---|---|
| Bare-specifier aliasing at runtime | **GO** | `deno.json` `imports` maps `gpui-kit`, `gpui`, `gpui-base`, `herdr`, `net` and `buffer` to `shim/*`. The mod host is started with `--config`. These are the only bare imports the graph uses. `lh-scan.mjs`/`sync.mjs` use `node:*`, but they are `exec`'d, not imported. |
| Unmodified load | **GO** | `fixtures/` is untouched. `lstack-herdr-cockpit/main.js` and the modules it imports (41 `.js` files, ~19.5k lines in the folder) import in **37 ms**. `lstack-herdr`, `workspace-chrome`, `tabs`, `files` and `changes` also load. 0 load errors. |
| Tree recorded | **GO** | `out/status.json`, `activity.json`, `activity.after-click.json` and `tree.json` (the fork's `LhTree`, via VIEWS `tree`). Also `lstack-herdr-source.json` and 22 more copies in `out/coverage/`. Shape: `{tag, id, style: [[method, ...args]], handlers: [{event, id, args}], children}`. Refinements (`hover`) are nested; slots (`trigger`/`content`) are kept. 0 render errors, 0 mod errors. |
| Per-mod-folder global isolation | **GO** (with one side channel) | `out/isolation.json`: iso-b sees none of iso-a's `globalThis` markers or `Array.prototype` pollution. Copies of one folder *do* share `globalThis`, as in Herdr (`ctx-probe` count 1→2→3). Side channel: `BroadcastChannel` crosses Workers. Deleting the global is bypassed via `node:worker_threads` (20/20 messages arrived in both modes). |
| Per-copy context | **GO** | `out/ctx-probe.json`: 3 copies × 5 continuations all saw their own `props()`. The continuations covered an exec RPC, `cx.timer.after`, one promise shared by all copies, and `Promise.all`. `nextCommand()` loops got only their copy's command. `run()` emits from continuations were attributed to the right copy. The cockpit's own `nextCommand` loop turned `panel:review` into `layout.hide` from `…:status`. |
| exec/readTextFile only via the stub | **GO** | Workers run with `read: [own folder]` and nothing else. Every `exec`, `readTextFile` and `net` call arrives at the bridge tagged with the folder by the mod host, and the bridge decides. A forged `postMessage` RPC gets the same policy. A forged copy id is attributed to the real folder. |

The click round trip works: the bridge took the `act-review` `on_click` handler id from the recorded tree and dispatched it. The handler's `run("layout.select")` changed the session layout, and the re-rendered tree shows Review active.

## Architecture as run

```
bridge.ts (privileged: secret, policy, herdr data, fake cockpit hub on 127.0.0.1)
  │ token-authenticated NDJSON over TCP 127.0.0.1:<ctl> (NOT stdio: Workers share stdio)
  ▼
modhost/host.js — separate `deno run` process:
    --allow-read=<appHome>/mods,probe-mods,shim,modhost  --deny-read=secret/  --allow-net=127.0.0.1:<ctl>
    --no-remote --no-npm --no-prompt --unstable-worker-options --v8-flags=--max-old-space-size=256, clearEnv
  ├─ Worker "lstack-herdr-cockpit"  permissions {read:[folder], write/net/env/run/ffi/sys/import: false}
  ├─ Worker "lstack-herdr" … one per mod folder
  │   entry = modhost/worker.js (shims only), then `import(<folder>/main.js)` with a COMPUTED specifier
  │   copies share the folder's realm; AsyncLocalStorage carries the copy; herdr getters read a pushed snapshot
```

The shipped design keeps the two processes but drops the Workers: one mod-host process per mod folder, so no unstable API is needed (DESIGN-v2 §1).

## Security: what a hostile mod tried (`out/security.json`, 52 attempts)

The hostile mod is `probe-mods/evil`. It ran twice: hardened, where the bootstrap deletes `BroadcastChannel`, `caches` and `Deno[Deno.internal]`, and raw.

**Got through (fix before shipping):**

| Attempt | Result | Why / mitigation (measured) |
|---|---|---|
| `Deno.readTextFile` / `import()` of a **symlink in its own folder → secret** | **secret read** | Deno path permissions do not resolve symlinks. `--deny-read=secret/` is bypassed too. Mitigations: the bridge's realpath check blocked the same read via `herdr.readTextFile`. Seatbelt blocked it in the kernel (`sandbox-exec … (deny file-read* (subpath secret/))` → `PermissionDenied`). `symlinkAudit` flags `evil/data/link.json` at load. |
| `Deno.kill(Deno.pid, …)` | allowed | Signalling yourself needs no `--allow-run`. `Deno.kill(Deno.ppid)` (the bridge) was blocked. A mod can kill the whole mod host. |
| `caches.open().put()` (raw Worker) | allowed | Wrote `DENO_DIR/location_data/web_cache/…` without `--allow-write`: a persistent channel shared across mods and runs. Blocked once the bootstrap deletes `caches`. Also use a throwaway DENO_DIR. |
| `Deno[Deno.internal]` (raw Worker) | reachable | Exposes `core` and 22 ops. Deleted by the bootstrap. Permission checks live in the ops, so this is not an escape **[INFERENCE]**. |
| `Deno.ppid`, `Deno.stdout.write` | allowed | Info leak, plus a forged protocol line on the mod host's stdout. The bridge never parses that stdout: the layout's `center` stayed `work`. |

**Blocked by Deno's permissions** (Worker scope, before any shim code):

| Group | Attempts (all BLOCKED, `NotCapable` unless noted) |
|---|---|
| Secret file | `Deno.readTextFile`, `node:fs`, `fetch(file://)`, computed `import()` as JSON, `import()` of a module that statically imports it, `import('../../secret/' + name)` |
| Other files | appHome `settings.json`, another mod's `ui.js` (read and import, even though its Worker had loaded it), write to own folder |
| Processes | `new Deno.Command('/bin/sh')`, `node:child_process.execFileSync('/usr/bin/id')`, `Deno.kill(bridge pid)` |
| Network | `Deno.connect`/`fetch`/`WebSocket` to the hub port, `Deno.listen` |
| Env / sys / ffi | `Deno.env`, `process.env`, `Deno.hostname`, `Deno.dlopen` |
| Remote code | `import('https://…')` (import permission), `npm:` (`--no-npm`), `jsr:` (import permission) |
| Escalation | `Deno.permissions.request` → `"denied"` without a prompt. Nested Worker `{read:true}` → `Can't escalate parent thread permissions`. Nested Worker `"inherit"` cannot read the secret. `Deno.stdin.read` gets nothing. |

**Blocked by the bridge's policy** (the shim path; the mod could also forge these RPCs with `postMessage`):

| Attempt | Policy |
|---|---|
| `readTextFile(secret)`, `appHome/../../…/secret`, symlink → secret | lexical root check, then realpath check |
| `exec('cat'/'sh')`, `exec('node', ['-e', …])`, `exec('node', [other mod's script])` | binary allowlist; `node` only as `node <script inside the caller's folder>` |
| `exec('env', ['DYLD_INSERT_LIBRARIES=…', 'git'])`, `exec('git', ['-c', …])`, `hc(['kill', …])` | env-var allowlist, git option denylist + read-only subcommands, hc read-only forms |
| `net.connect` to `:22` or `example.com` | loopback only, and only the hub port from `hub.json` |
| forged `postMessage` RPC (`readTextFile(secret)`, unknown method) | same policy; unknown methods rejected |

Allowed on purpose: `readTextFile(appHome/settings.json)`, and `net.connect(127.0.0.1:hub)`, which goes through the bridge.

### Import-graph rule (`out/import-graph.json`, single process, Worker `read:[probes/ig]`)

| Case | Result |
|---|---|
| Computed `import()` inside the Worker of a module that statically imports the secret | BLOCKED |
| Computed `import()` of the secret, before or after the parent loaded it | BLOCKED |
| Worker **entry** module statically imports the secret | **secret read** |
| Worker entry has a **literal** `import('./mod-static.js')` | **secret read** |

A Worker's entry graph is loaded with the parent's permissions. That covers its static imports and statically analyzable dynamic imports, transitively. So the mod host loads mods only through a computed `import()` inside a bridge-authored entry. Even so, it is a separate process that cannot read secrets at all.

### The bridge's own allowlist (`bridgeSelfTests`)

| Attempt | Result |
|---|---|
| read `secret/`, read fixtures | allowed |
| read `/etc/hosts`, `~/.ssh`; write into fixtures; read env `PATH` | BLOCKED |
| spawn `git --version` | allowed |
| spawn `node -e …` | **allowed**: `--allow-run` is per binary, never per argv, so argv policy is the bridge's job |
| spawn `ls`, `/bin/sh`, `env` | BLOCKED |
| spawn `/usr/bin/git` (allowlisted name, other path) | BLOCKED: names resolve to absolute paths at startup |
| spawn allowlisted `git` with `DYLD_INSERT_LIBRARIES` | BLOCKED by Deno itself |
| connect `1.1.1.1:80`, listen `0.0.0.0` | BLOCKED (`--allow-net=127.0.0.1`) |
| import `https://…` | BLOCKED (`--no-remote` / import permission) |

Gotcha: `Deno.execPath()` returns `/opt/homebrew/Cellar/deno/2.9.8/bin/deno`, which `--allow-run=deno` (resolved as `/opt/homebrew/bin/deno`) does not match. Spawn by name.

`node` scripts can be sandboxed too. The cockpit's `lh-scan.mjs` ran **unmodified** under `deno run --allow-read=<stand-in HOME>,<script> --allow-write=<HOME>/.cache --allow-env=HOME --allow-sys=homedir --allow-run=/bin/ps`. It exited 0 in 46–64 ms across runs and wrote its cache. A probe script under the same flags could not read the secret. With `node` the script runs with the user's full privileges.

## Availability (`security.json` → `availability`)

| Event | Measured |
|---|---|
| `Deno.exit(7)` in a Worker | only that Worker ends; the mod host and other Workers keep rendering |
| CPU-bound Worker (`for(;;);`) | other Workers re-render in 13 ms; the bridge terminates it via the mod host in 13 ms |
| Worker exceeds heap | **the whole mod host aborts** (`Fatal JavaScript out of memory`, exit 133 SIGTRAP) after ~173 ms at the per-isolate 256 MB cap. The bridge stays up. |

Consequence: the mod host must be restartable, and probably one process per mod folder. Deno exposes no per-Worker heap limit; I found none and did not test further **[INFERENCE]**.

## Timings (`out/summary.json`)

| What | ms |
|---|---|
| mod host process ready (spawn → authenticated hello) | 28 |
| 15 Workers spawned + all module graphs imported | 87 total; cockpit graph import 37 |
| all T01 + probe copies: `create` → first tree | 42 |
| status bar tree with hub data (TCP via bridge) | 22 after `create` |
| tree view with lh-scan data (exec via bridge) | 18 after `create` |
| render, status / activity / tree | first 1.4 / 0.5 / 1.2; median 0.4 / 0.2 / 0.4 |
| render, heaviest coverage copy (`home`, 304 nodes) | ≤ 5.4 |
| cockpit Worker heap | 10.8 MB used / 15.9 MB total. Mod host process RSS: 232 MB with 15 Workers. |

## Unknown or unsupported APIs the mods hit

- **T01 copies** (status, activity, tree) and the `lstack-herdr` source: **none**.
- **All other lstack-herdr layout copies** (17 cockpit + workspace-chrome ×2, tabs, files, changes): one, **`TextareaState.set_auto_grow`**.
- Not exercised: handlers beyond one click and two commands, keyboard, overlays, timers over 1 s. APIs reached only from those paths are still unknown.
- Stubbed as unsupported (throw and are counted if called):
  - `herdr`: `pickFolder`, `writeTextFile`, `watchFolder`, `feedback*`
  - `cx`: `bind_keys`, `phase`, `theme`, `open_url`, `read_from_clipboard`, `new`
  - `gpui-base`: `CalendarState`, `SliderState`, `OtpState`, `DockArea`, `dock_area`, `pagination_items`, `set_theme`
  - `window.*` except `paint_path` and `is_window_active`

## Supply chain

Zero third-party dependencies. `deno info` shows only local files and `node:` built-ins (`path`, `url`, `buffer`, `async_hooks`). `--no-remote --no-npm` is set on every process. Trust root: the Homebrew `deno` 2.9.8 binary.

## Recommendation notes for D6

1. Deno enforced least privilege for mod code apart from bridge code with no code of ours in the loop:
   - 30 of 36 direct runtime attempts were blocked by the runtime (28 without the bootstrap hardening).
   - Of the 6 that got through, 1 was the intended own-folder read and 2 were the symlink escape. The other 3 were self-kill, `ppid` and a stdout write.
   - Through the shim, the bridge's policy blocked 14 of 16. The 2 allowed calls were the legitimate ones.
2. Adopt it as measured here:
   - privileged bridge;
   - separate mod host process with path-scoped flags and no secrets;
   - one Worker per folder, mod loaded by computed `import()`;
   - bridge-side realpath and argv policy;
   - Seatbelt profile on the mod host (blocks the symlink class);
   - throwaway DENO_DIR;
   - restart on crash, or one process per folder.
3. Costs:
   - Per-Worker permissions need `--unstable-worker-options` (an unstable API in 2.9.8). Process-level flags are stable, so one-process-per-folder avoids the unstable API entirely.
   - In-process side channels (`BroadcastChannel`, `caches`) cannot be fully hidden.
4. Bonus: `exec("node", script)` can become a scoped `deno run`. Measured with `lh-scan.mjs`.
5. Bun's numbers are in [bun.md](bun.md); nothing here measures Bun.

## Where the spike went

| Spike part | Now |
|---|---|
| `bridge.ts`: `policyRead`, `policyExec`, `within`, `symlinkAudit` | `packages/bridge/src/policy/{read,exec,paths,symlink}.ts` |
| `bridge.ts`: ctl listener, `writeAll`, forged-copy drop | `packages/bridge/src/hosts/control.ts` |
| `modhost/host.js`, `modhost/worker.js` | `packages/modhost/src/main.js`, `runtime.js` (one process per folder, no Workers) |
| `shim/*.js` | `packages/modhost/src/shims/*.js` |
| `stub-data.ts` | `packages/bridge/test/fixtures/state.ts` |
| `probe-mods/evil`, `probes/*` | `fixtures/probe-mods/evil`, `packages/bridge/test/security/*_test.ts` (`deno task test:security`) |
| `out/*.json`, `out/coverage/*.json` | `fixtures/trees/` (recorded by `deno task test:views:update`) |
