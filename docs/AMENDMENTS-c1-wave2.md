# Implementation amendments — candidate herdr-relay-c1, wave 2 (T02b, T03b, T05b/c, T06b, T07, T10, T22, T23)

Main-owned. Where these differ from DESIGN-v2 / AMENDMENTS-c1, these and the code win.

## Protocol (T02b)
- Control `create` has optional `storage: StorageMap` (string→string) — the supervisor sends the persisted copy map; the mod host seeds `localStorage` from it (T06b).
- `HANDLER_KEYS.on_link_click → "link"`; TextView `on_link_click` becomes `on.link`, pairs with client `event {kind:"link", data:{href}}`.
- `ClickState` is in `SCHEMA_FILES` (`click-state.schema.json`) with valid/invalid samples.

## Environment hygiene (T03b, T05b/c)
- Every child process the bridge spawns starts with `clearEnv` and an explicit env: `hc connect` {HOME, PATH}; E4 git reads {HOME, PATH, TMPDIR, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0}; E5 git add/commit {HOME, PATH, TMPDIR, GIT_TERMINAL_PROMPT=0}; E6/E7 hc {HOME, PATH}; E9 herdr-app {HOME, PATH, HERDR_APP_HOME}; E10 cockpit = checked assignments + PATH; scoped runners already cleared. No `HC_*` reaches any child.
- Consequence: `SSH_AUTH_SOCK`/`GPG_TTY` do not reach git → device commits fail for users who sign commits via ssh/gpg agents (documented limitation).
- `test:core` task now allows env `PATH`.

## Host supervisor (T07)
- Watchdog: kill when no pong for 6 s since the last answered ping (meets the ≤ 6 s target; "3 missed pings" would allow 6–8 s).
- `failed` on the 6th exit within 10 min; a load error goes straight to `failed` (retry every 5 min); a heap restart counts as a crash; editing the mod folder clears the crash count.
- A folder's host starts on its first `create` and stops after 30 s with no copies.
- `storage.set` is handled by the supervisor: `<state>/storage/<folder>.json`, 1 MiB cap, ≤ 1 write/s.
- `Deno.watchFs` on macOS does not report newly created symlinks (measured); Seatbelt still blocks the read and the symlink audit refuses the folder on the next restart.
- Host `error` text contains absolute paths → T08/T09 must strip them before devices see it (S30). After a restart use `HostRef.generation` to send a fresh `view.tree`; old handler ids are void.
- Measured: 6 hosts up in 92–220 ms; kill -9 → re-render 50–155 ms; CPU hog killed 4.1–5.9 s; OOM exit 133 → restart, others unaffected; idle RSS 34–52 MB/host.

## Server + auth (T10)
- Default port 7781 (`HERDR_RELAY_PORT`); `HERDR_RELAY_DEV` ∈ {`1`, `insecure-no-sandbox`} (other values exit 2). Exit codes: 3 no `sandbox-exec` (unless insecure), 2 bad config, 1 port in use.
- Peer check: on macOS 27 `netstat -anv -p tcp` prints nothing when spawned from Deno; the check uses netstat + ps, falls back to `lsof` (user processes only — covers `IPNExtension` uid 501). Bridge `--allow-run` adds `/usr/sbin/netstat,/bin/ps,/usr/sbin/lsof` (applied in `deno.json`).
- The Tailscale app binary needs `TAILSCALE_BE_CLI=1` to act as the CLI.
- `GET /api/ticket` requires `X-Herdr-Relay: 1`. The loopback app shell is served without the token (Host + same-origin checks); `/api/*` still needs it.
- Insecure mode refuses every tailnet request (not only pairing). Dev mode `1` also accepts the Android emulator host `10.0.2.2:<port>`.
- Cookie `__Secure-herdr-relay-device` (`HttpOnly; Secure; SameSite=Strict; Path=/herdr-relay`); `devices.json` stores only SHA-256 of cookie secrets; state dir 0700, files 0600.
- Static shell layout for T15: `index.html`, `manifest.webmanifest`, `sw.js` from `packages/web/`; other files from `dist/` then `public/`; extensionless paths → `index.html`.
- New task `deno task herdr-relay` (CLI: pair / devices / revoke / serve [--dry-run]).
- `/ws` answers 503 after authentication until T08/T09/T11 handlers are wired into `runBridge`. The per-run `<run>` dir is created by the supervisor/bridge wiring (T08/Main).

## Security decision (Main, during T22)
- Read-scope devices MAY run session-class (device-local) commands (navigation/focus only affect the device's own view). Read scope refuses passthrough, mod-routed write effects, structural commands, typing/input. The `command`-message refusal for read devices is enforced in the server layer (T10).

## Incident (T05c verification, 2026-11-09 ~14:3x)
- A first verification run executed the real `herdr-app do theme.next {}` and real read-only `hc machine ls --json` / `hc ls --json`. `theme.next` is not a Herdr command (only `app.theme` exists) → rejected; Herdr status afterwards: layout `lstack-herdr`, no errors; `layouts/.state` has no theme key. Re-runs use fakes first on PATH + scoped `--allow-run` with a guard.

## Integration evidence (Main)
- `deno task test`: 73 passed / 0 failed. `deno check --config packages/modhost/deno.json packages/modhost/src/main.js`: ok.
- `deno task check`: lint `require-await` in `packages/bridge/test/unit/policy/policy_test.ts:188` → routed to T23 (fixing).
