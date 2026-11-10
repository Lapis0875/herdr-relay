# Spike T01 — Bun 1.4.4

**Verdict: GO, with conditions.** The unmodified cockpit mods load, run and record trees under Bun. But Bun itself enforces no least privilege. Every protection measured here comes from one of three places:

1. A `vm.SourceTextModule` linker plus a strings-only membrane, written for this spike.
2. A macOS Seatbelt (`sandbox-exec`) profile around a separate mod-host process.
3. The bridge's own allowlist policy.

`Bun.plugin` cannot do the aliasing: it refuses `net` and `buffer`.

Decision D6 ([DECISIONS.md](../DECISIONS.md)) chose Deno over Bun on these results and [deno.md](deno.md).

## Provenance

This is the record of a throwaway spike. Its code (`spikes/bun/`) was deleted in T32 and nothing from it ships; its run outputs (`out/*.json`, `out/*.sb`, cited below by name) held absolute paths of the machine they ran on and were never published. It ran from its own folder with Bun 1.4.4 (`~/.bun/bin/bun`) and zero dependencies:

```sh
bun --no-install run.js                                   # mods under Seatbelt (default) → out/tree-*.json, summary.json, security.json
bun --no-install run.js --no-sandbox                      # same, no OS sandbox → *.no-sandbox.json
bun --no-install run.js --keep-shadowrealm                # re-opens the ShadowRealm hole, sandbox on
bun --no-install run.js --no-sandbox --keep-shadowrealm   # the hole with nothing underneath
bun --no-install security/bridge-allowlist.js             # bridge exec/read/write/net allowlist → out/bridge-allowlist.json
bun --no-install probes/plugin-limits.js                  # why not Bun.plugin (prints JSON)
```

Each `run.js` took about 1.3 s of wall time. Most of that was fixed settle sleeps.

## Results per requirement

| Requirement | Result | Evidence |
|---|---|---|
| Bare-specifier aliasing at runtime | **GO**, via a `vm.SourceTextModule` linker. **NO-GO** via `Bun.plugin`. | `probes/plugin-limits.js`: `build.module()` works for `gpui-kit`/`herdr`, but for `net`, `buffer`, `node:fs`, `child_process` and `bun:ffi` it throws `module() cannot be used to override builtin module`. `onResolve` was never called for bare or builtin specifiers; it fires only for relative paths. So hub.js's `import net from "net"` would get Node's `net`, whose `connect(port, host)` is incompatible. |
| Bare imports the graph actually uses | `gpui-kit`, `gpui-base`, `herdr`, `net`, `buffer` | grep of all 41 files. There are no dynamic imports. The ambient globals used are `window.paint_path`, `window.is_window_active`, `localStorage`, and a `globalThis` shared across copies (hub.js). |
| Unmodified load | **GO** | `lstack-herdr-cockpit/main.js` plus 40 modules, and `lstack-herdr/main.js`, are read byte-for-byte from `fixtures/`. No source transform. |
| Tree recorded | **GO** | `out/tree-status.json` (52 nodes; hub data arrives through the `net` shim), `tree-activity.json` (25), `tree-tree.json` (153, the lstack call tree reached through the fork's `VIEWS.tree`), `tree-lstack-herdr-source.json` (12). Each node is `{tag,id,style:[[name,...args]],handlers:{on_click:"h5"},children,states?,slots?,props?}`. **0 unknown style names**, checked against 3,315 element methods parsed from `gpui-kit.d.ts`. |
| Interactions | **GO** | `nextCommand()` "panel:files" went to the status copy and ran `layout.select files` and `layout.show panel`. A recorded `on_click` (h5 on `act-changes`) ran `layout.select changes`; the re-rendered activity tree shows the new active tab (`after_click`). |
| Per-mod-folder global isolation | **GO** | One Bun Worker plus a fresh `vm.createContext()` per folder. `probe-iso` sees `probeCtxSecret`, `probeCtxCopies` and `cockpitHubStart` as `undefined`. Within one folder, copies share `globalThis` as Herdr does: probe-B saw 1 earlier copy. |
| Per-copy context (`props()`) | **GO** | `AsyncLocalStorage` set around every call into the realm. Two interleaved copies each passed 8 of 8 checkpoints (`summary.json → perCopyContext`): init, spawn body, `await null`, a host I/O reply delivered from a message handler with no store, `cx.timer.after`, inside a timer callback, `cx.sleep`, and `nextCommand()`. |
| exec/readTextFile only through the stub | **GO** | The mod realm has no `fs`, `process`, `require`, `Bun` or `fetch`. Every host op is a string call through `host(op, json)`, and the bridge policy decides. |

## Security: measured attempts

### A. Mod code inside its realm (57 attempts, `out/security.json → modRealm`)

| Attempt (count) | Result | Mechanism |
|---|---|---|
| Static `import … from "node:fs"`; static import of the host capability (2) | blocked | Linker refuses, so the folder fails to link and no mod code runs |
| `Bun`, `Deno`, `require`, `module`, `WebSocket`, `Worker`, `setTimeout`, `XMLHttpRequest`, `navigator`, `TextDecoder`, `process.env`, `Function("return this")()` (12) | blocked | Fresh vm context. Bun puts only ECMAScript intrinsics, `console` and `ShadowRealm` in it. |
| `new ShadowRealm()` running `Bun.spawnSync(id)` and `process.getBuiltinModule("fs")` (1) | blocked **only because `worker.js` deletes it** | With `--keep-shadowrealm` it is **ALLOWED**: the realm gets Bun's globals. Under Seatbelt the result was `spawn EPERM; read EPERM`. Without Seatbelt: `spawned id -> <user>; read 369 bytes`. |
| Constructor walks to `Function("return globalThis")` from every shim export, cx, element, promise, rejected host error (15) | blocked | Membrane: shims run inside the realm, and only strings cross |
| Dynamic `import()` of `node:fs`, `bun`, `bun:ffi`, shim internals, `file://`, a sibling mod (9) | blocked | `ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING` |
| `Error.prepareStackTrace` CallSite `getThis`/`getFunction` from a host-invoked timer (1) | blocked | Bun returns CallSites, but these are `undefined` for strict (ESM) host frames |
| `Error().stack` (1) | **ALLOWED** (information leak only) | Names `spikes/bun/host/worker.js`. Strip paths before showing errors on devices. |
| `readTextFile` of the secret, a `../` traversal, and `~/.ssh/id_ed25519`; `writeTextFile`; `watchFolder("/")` (5) | blocked | Bridge policy: reads only under `appHome()`, writes denied |
| `exec` of `cat`, `/bin/sh`, `env`, `env /bin/sh`, `node -e`, `git -c core.pager=…`, `open file:///`; `hc terminal run` (8) | blocked | Bridge policy: argv-level allowlist (`node` only for the mods' own scripts, `env` only in front of cockpit's binary, read-only `git`) |
| `net.connect` to `127.0.0.1:22` and to `example.com:80` (2) | blocked | Bridge policy: only the cockpit hub port from hub.json |
| CONTROL: `exec("node", [lh-scan.mjs, …])` (1) | allowed, by design | Bridge policy |

### B. "Assume the realm is escaped": code with the Worker's own Bun privileges (`escapeSimulation`)

| Attempt | Seatbelt (default) | `--no-sandbox` |
|---|---|---|
| Read `secret/devices.json` | EPERM | read 369 bytes |
| `stat` the secret (existence/size) | EPERM (metadata narrowed too) | ok |
| Read `docs/DESIGN.md` (not allowlisted) | EPERM | read |
| Spawn `/bin/sh`, `curl`, or Bun itself | EPERM (`posix_spawn`, no `process-fork`) | ran (`id` → the user's name; child read secret) |
| Connect or `fetch` to the bridge's `127.0.0.1` listener | refused / EPERM | connected / 200 |
| Write `out/escape-write-probe.txt` | EPERM | wrote (cleaned up) |
| `process.env` secret from the bridge's env | absent | absent |

The env secret is absent in both columns because of the bridge's spawn env, not Bun: the mod host is started with `PATH` only.

**Bun alone enforces nothing.** It has no `--allow-*` flags and no per-Worker permissions; the second column shows this. The kernel sandbox makes the ShadowRealm-class hole harmless.

### C. The bridge's own allowlist (`security/bridge-allowlist.js`, all rows as expected)

The bridge first starts the sandboxed mod host, then sandboxes itself with `sandbox_init` through `bun:ffi` (profile in `out/bridge.sb`).

| Allowed | Blocked |
|---|---|
| `git --version`, `node --version` (allowlisted by real path) | `/bin/sh`, `curl`, `cat` (EPERM) |
| Reading the secret (the bridge may), reading the fixture home | `git -c alias.x='!echo PWNED'`, `node -e` spawning sh (children inherit the profile) |
| Writing under `out/` | Reading `docs/DESIGN.md`, writing outside `out/` |
| Listening and fetching on `127.0.0.1`; talking to the pre-started mod host | Connecting to `192.0.2.1:9` off-host; nested `sandbox-exec` (`sandbox_apply: Operation not permitted`) |
| **Listening on `0.0.0.0` (limitation)** | — |

Allowlist caveats measured here:

- Seatbelt cannot confine `bind` to loopback. The `localhost` filter also matches `0.0.0.0` with the ip, ip4 and tcp variants. Loopback-only listening must stay in code.
- `~/.local/bin/tailscale` is a `#!/bin/sh` wrapper, so it is blocked. Allowlist the real `Tailscale.app` binary.
- Allowlisting `node` lets it run any JS, but still inside the bridge profile.
- `hc` inside the profile answered `cannot start core: Operation not permitted`: it needs its core socket and state-dir rules. That row was removed from the script so the probe never tries to start core again. Unmeasured beyond "denied by default".

### Supply chain

- **0 npm dependencies**: no `package.json`, lockfile or `node_modules`.
- What the spike trusts: the Bun binary, `/usr/bin/sandbox-exec`, `/usr/lib/libsandbox.1.dylib`.
- **Bun's default auto-install fetched from npm for an unresolved bare import.** Observed: `note: GET https://registry.npmjs.org/gpui-kit - 404`. `bunfig.toml` (`install.auto = "disable"`) and `--no-install` are mandatory. The vm linker never hands mod specifiers to Bun's resolver.
- `sandbox-exec` and `sandbox_init` are deprecated (but shipping) macOS APIs. They are macOS-only.

## Unknown or unsupported APIs hit by the mods

**None in the rendered copies** (status, activity, tree, lstack-herdr source):

- 0 unknown style names
- 0 calls to unsupported `herdr` functions
- 0 mod errors

Shim coverage against the d.ts value exports: `gpui-kit` 8/8, `gpui-base` 66/66, `herdr` 44/44.

The realm deliberately has no `setTimeout`, `TextEncoder`/`TextDecoder` or `URL`, as in Herdr's runtime. `buffer` is a pure-JS UTF-8/base64 shim. Not exercised by these copies: `Editor`, `TextView`, `v_virtual_list` and overlays. They are shimmed as recorded elements but have no renderer yet.

## Timings (ranges over every run: 4 Seatbelt, 2 `--no-sandbox`)

| Step | Time |
|---|---|
| Mod-host spawn → 7 folders loaded | 34–45 ms |
| Cockpit load: 41 modules, link + evaluate | 14–25 ms (shims about 1.5 ms per folder) |
| `init` | status about 1 ms; activity 0.05 ms; tree 0.5 ms |
| `render` | status 3.5–6.3 ms; activity 0.8–1.4 ms; tree 2.1–2.6 ms |

The Seatbelt and `--no-sandbox` runs are within noise.

## Notes for D6

- Bun's mod-host shape that worked: the bridge (Bun) spawns `sandbox-exec -p <deny-default profile> bun host/modhost.js`, then calls `sandbox_init` on itself. The mod host runs one Worker per mod folder, each with a vm context, a linker, a strings-only membrane and an `AsyncLocalStorage` copy context. This was measured in two halves: `run.js` runs the full mod host under Seatbelt with an unsandboxed bridge, and `security/bridge-allowlist.js` self-sandboxes a bridge after starting a minimal sandboxed host. Joining them would have been T06 work.
- In-realm isolation is defense in depth, not a boundary. In 57 attempts, one Bun-specific hole was found (ShadowRealm in vm contexts). Bun upgrades must re-run `--keep-shadowrealm`-style probes.
- The policy that matters lives in the bridge, outside the sandbox. `env`, `node` and `git` are trampolines, so allowlists must be argv-level, not command-level.
- Compared with Deno: Bun matches the measured outcomes only through macOS Seatbelt (`host/sandbox.js`, about 75 lines, plus a `bun:ffi` `sandbox_init` call), on deprecated APIs, with no runtime-native permission model. If the Deno spike shows equivalent fidelity with native `--allow-read/--allow-run` lists and per-Worker permissions, Deno has the stronger security story. If Bun is chosen, keep all three layers above; none is optional.

## What the spike was made of

- `run.js`: scenario and reports.
- `bridge/`: `state.js` (herdr data from the fixture), `policy.js` (allowlists, virtual cockpit hub, canned answers), `dts.js` (d.ts facts).
- `host/`: `modhost.js`, `worker.js`, `sandbox.js` (Seatbelt profiles).
- `shim/`: `rt.js` (inner runtime, recorder, cx, timers), `gpui-kit.js`, `gpui-base.js`, `gpui.js`, `herdr.js`, `net.js`, `buffer.js`, `ambient.js`.
- `mods/`: `probe-ctx`, `probe-iso`, `evil`, `evil-static-fs`, `evil-static-rt` (spike-only mod folders).
- `security/bridge-allowlist.js`, `probes/plugin-limits.js`, `secret/devices.json` (fake), `bunfig.toml`.
- `out/`: `tree-*.json`, `summary*.json`, `security*.json`, `bridge-allowlist.json`, `modhost.sb`, `bridge.sb`.

The stub boundary: no process is ever started for a mod. Allowed `exec`/`hc` calls return canned output, and `net` talks to an in-memory hub.
