# herdr-relay — devices

Split by T00 on 2026-11-09; text copied verbatim from [DESIGN-v2.md](DESIGN-v2.md) §5.1–§5.2 and the device classes
from [DESIGN.md](DESIGN.md) §3. Device runs: **T28** (`tools/device-tests/**`); operations section (start/stop/logs/
pairing, launchd, doctor): **T33/T44** (`tools/launchd/**`, `packages/bridge/bin/**`, this file; installation:
[INSTALL.md](INSTALL.md)). Decisions in force: D1 (PWA now), D4 (never resize the Mac
terminal), D7 (`tailscale serve`, no Funnel), D11 (Web Push only). Pairing and the auth gate: [SECURITY.md](SECURITY.md)
§2. Evidence legend as in DESIGN-v2 (**[V]** read on this Mac · **[M]** measured · **[I]** inference · **[B]** brief).

---

## Device classes — DESIGN.md §3

**Device classes**: `phone` (shortest side < 600 dp), `tablet-portrait` (≥ 600 dp, width < 1024), `tablet-landscape` (width ≥ 1024), `desktop` (≥ 1280, pointer). iPad Air lands in tablet-*.

---

## Verification obligations — DESIGN-v2 §5.1–§5.2

### 5.1 Real `hc connect` (this Mac, read-only)

Facts confirmed by Main: herdr-core 0.1.19, generation 1, 32 methods incl. `hello, rpc.discover, doc.get, doc.set, terminal.attach, terminal.list, terminal.get, terminal.run, events.subscribe` (`docs/DECISIONS.md`). Tests (T31) and T03 acceptance use **only**: `hello {generation:1, framed:true}`, `rpc.discover`, `doc.get {name:"herdr-app"}`, `terminal.list`, `terminal.get`, `events.subscribe` (≤ 3 s), `terminal.attach` observe (≤ 1 s, no input, no resize). Forbidden everywhere in tests: `doc.set`, `terminal.run`, any typing, `terminal.attach` type mode. Gate: `HERDR_RELAY_LIVE_CORE=1` and `--allow-run=hc`; the test skips (not fails) when unset. Main runs `deno task test:core` and reports the first failing assertion.

### 5.2 Device checks (`tools/device-tests/`)

Facts **[V DESIGN §6]**: Xcode present with iPad device types, no simulator devices created; Android SDK at `~/Library/Android/sdk` with `system-images;android-35;google_apis;arm64-v8a`, `cmdline-tools/latest`, no AVD; Java via Homebrew openjdk.

1. **iPad Simulator** (`ios-sim.sh`): `RUNTIME=$(xcrun simctl list runtimes -j | <jq-free deno one-liner> pick latest iOS)`; `xcrun simctl create "herdr-relay iPad Air" "iPad Air (5th generation)" "$RUNTIME"`; `xcrun simctl boot <udid>`; `xcrun simctl openurl booted "http://127.0.0.1:<port>/herdr-relay/?token=<loopback token>"`; `xcrun simctl io booted screenshot .tmp/devices/ipad-{portrait,landscape}.png` (rotate via `xcrun simctl … orientation`? not available → use the Simulator menu or Playwright viewport for landscape; document). Acceptance: both orientations show the recomposed lstack (rail + sheet in portrait; split in landscape). Web Push cannot be tested in Simulator **[B]**.
2. **Android AVD** (`android-avd.sh`): `avdmanager create avd -n herdr-relay -k "system-images;android-35;google_apis;arm64-v8a" -d pixel_tablet` (fallback `-d pixel_7`); `emulator -avd herdr-relay -no-snapshot -no-boot-anim &`; `adb wait-for-device`; `adb shell am start -a android.intent.action.VIEW -d "http://10.0.2.2:<port>/herdr-relay/?token=<token>"`; screenshot via REA `xd://mcp__rea_capture_adb_screen` or `adb exec-out screencap -p`. Acceptance: installable PWA prompt in Chrome; phone class navigation works on `pixel_7`.
3. **Real iPad Air over tailnet** (user action): `herdr-relay serve` (tailscale serve set-path), open `https://<mac>.<tailnet>.ts.net/herdr-relay/`, `herdr-relay pair` → code → device paired as `act`; Add to Home Screen; enable notifications; on the Mac, let an agent finish → push "Finished" arrives; type one character into an observe→type terminal and confirm with `hc terminal get` that cols/rows did not change.
4. **Playwright** emulation (T28) runs headless in CI-style against `start:dev` + fake core for regressions; it is the only Node-run tool and lives in `tools/device-tests/package.json`.

---

## Operations (T33, T44)

Everything runs through the launcher `packages/bridge/bin/herdr-relay` (on `PATH` as `~/.local/bin/herdr-relay`, or
`deno task herdr-relay` in the repository); setup steps are in [INSTALL.md](INSTALL.md).

### Start, stop, logs

| | In a terminal | As the launchd agent `io.github.lapis0875.herdr-relay` |
|---|---|---|
| start | `herdr-relay start` (foreground) | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.lapis0875.herdr-relay.plist` (also at every login) |
| restart | Ctrl-C, then `herdr-relay start` | `launchctl kickstart -k gui/$(id -u)/io.github.lapis0875.herdr-relay` |
| stop | Ctrl-C (or SIGTERM to the launcher: it passes it on) | `launchctl bootout gui/$(id -u)/io.github.lapis0875.herdr-relay` |
| logs | the terminal (stderr, `herdr-relay: …` lines) | `~/Library/Logs/herdr-relay.log` |
| state | `launchctl print gui/$(id -u)/io.github.lapis0875.herdr-relay` | same |

- `herdr-relay start` computes the bridge's `deno run` flags for this Mac and runs it with the repository as working
  directory; `herdr-relay start --print-flags` prints that line. On a default setup it is byte-identical to `deno task
  start` (which now also carries `--allow-import=jsr.io:443` and `HERDR_RELAY_TAILSCALE_BIN` in `--allow-env`). Computed
  where a fixed line cannot know the machine: the Tailscale CLI in `--allow-run` (`HERDR_RELAY_TAILSCALE_BIN`, the
  app bundle in `/Applications` or `~/Applications`, `tailscale` on `PATH`), `<appHome>/data/herdr-relay` of
  `HERDR_APP_HOME` in `--allow-write` (and an app home outside `$HOME`/`/tmp` in `--allow-read`), `/tmp` for an unset
  `TMPDIR`.
- Exit codes: 0 stopped, 1 failure (port in use, session layer), 2 configuration, 3 no working sandbox. The launchd
  agent restarts on a non-zero exit, at most every 30 s.
- `tools/launchd/io.github.lapis0875.herdr-relay.plist` is a template (`__REPO__`, `__HOME__`; `plutil -lint` OK):
  `/bin/sh <repo>/packages/bridge/bin/herdr-relay start`, `RunAtLoad`, `KeepAlive` on failure, its own `PATH`
  (`~/.local/bin`, `~/.deno/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, system), both streams to the log above.

### Pairing

1. The bridge runs and is published: `herdr-relay serve` (`--dry-run` shows the plan; refused while Funnel is on).
2. `herdr-relay pair --scope read|act [--name NAME]` prints a 6-digit code (one use, 2 min) and the URL.
3. On the device: open the URL, enter the code, Add to Home Screen, allow notifications.
4. `herdr-relay devices` lists paired devices; `herdr-relay revoke <id|name>` unpairs one, closing its sessions within
   2 s.

### Checks and state

- `herdr-relay doctor`: deno (≥ 2.9), platform against the last start, sandbox, access mode, Tailscale login and
  `tailscale serve`, Herdr compatibility, lock cache, paired devices, mirror mod and the running bridge. Read-only;
  exit 1 when a check fails.
- `<state>` = `~/.herdr/herdr-relay/` (0700): `token`, `devices.json` (`v: 1`), `environment.json` (`v: 1`: macOS
  version, `deno` path and version at the last start), `mirror-endpoint.json` (while the bridge runs), `vapid.json`,
  `push.json`, `storage/`, `log/`, `profiles/`. A `devices.json` or `environment.json` with a higher `v` comes from a
  newer herdr-relay: refused with that message and never rewritten (the bridge then pairs no device).
- After a macOS or Deno change, `start` prints what changed and the Seatbelt re-derivation command
  ([INSTALL.md](INSTALL.md) §8); `doctor` reports it until the next start.
- Mirror mod: `herdr-relay install-mod` copies `mods/herdr-relay-mirror` into `<appHome>/mods/` (never over a newer
  or hand-edited copy; never edits layouts — it prints the `floating` entry to add). The bridge logs, and toasts
  connected devices, once per reported `relayMod` older than the bundled `mod.json` version.
