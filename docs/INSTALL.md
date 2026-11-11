# herdr-relay — install and run

How to put herdr-relay on a Mac, reach it from phones and tablets over Tailscale, and keep it running. Decisions in
force: O2 (macOS only in v1), O3 (Tailscale only in v1), O4 (git clone or release tarball, with the `herdr-relay`
launcher; a Homebrew formula is prepared but not published). Device operations: [DEVICES.md](DEVICES.md)
§Operations. Security model: [SECURITY.md](SECURITY.md).

## 1. Requirements

| Needed | Version | How to get it |
|---|---|---|
| macOS | the Seatbelt profile was derived on 27.0; on any other version run its check (§8) | — |
| Deno | **2.9 or newer** | `brew install deno` or the official installer (`~/.deno/bin`) |
| Herdr app | 0.1.13 or newer (tested: 0.1.14 and 0.1.15), with `herdr-app` and `hc` on `PATH` | herdr.dev |
| herdr-core | 0.1.19 or newer (comes with Herdr) | — |
| Tailscale | the macOS app, logged in, MagicDNS and HTTPS certificates on for the tailnet | tailscale.com |
| `sandbox-exec` | built into macOS | — |
| git | only for the clone path | Xcode command line tools or Homebrew |

`herdr-relay doctor` (§7) checks all of them.

## 2. Get herdr-relay

Pick one. Both give a folder (called `<repo>` below) that herdr-relay runs from; running, it writes nothing inside it.

### 2a. git clone (follows the main branch)

```sh
git clone https://github.com/Lapis0875/herdr-relay.git
cd herdr-relay
deno install --frozen                 # the locked dependencies (web build included); deno.lock stays as it is
deno task bundle                      # the device app → packages/web/dist
deno task --cwd packages/web fonts    # the bundled fonts → packages/web/public/fonts (woff2_compress optional)
```

### 2b. Release tarball (a tagged version)

Each GitHub release (from the first tagged version on) has `herdr-relay-<version>.tar.gz` and
`herdr-relay-<version>.tar.gz.sha256`, with the device app and fonts already built:

```sh
shasum -a 256 -c herdr-relay-<version>.tar.gz.sha256
tar -xzf herdr-relay-<version>.tar.gz
cd herdr-relay-<version>
```

No build step. The launcher fetches the locked modules on its first run (§3).

## 3. The `herdr-relay` command

`<repo>/packages/bridge/bin/herdr-relay` is the launcher: a small shell script that runs the CLI with its own Deno
permissions. Put it on your `PATH` as a link (it finds `<repo>` through the link):

```sh
mkdir -p ~/.local/bin
ln -s "$PWD/packages/bridge/bin/herdr-relay" ~/.local/bin/herdr-relay   # run in <repo>; ~/.local/bin must be on PATH
herdr-relay doctor
```

Inside `<repo>`, `deno task herdr-relay <command>` runs the same script.

Before every command the launcher checks that each module `deno.lock` pins for the launcher and the bridge is in the
Deno cache (both run with `--cached-only`, so nothing is ever downloaded while they run). When some are missing — the
first run, or after an upgrade changed the lock — it fetches exactly those once:
`deno install --entrypoint --frozen --no-npm --no-check --lock=deno.lock …`. The lock file is never rewritten.

Commands:

| Command | What it does |
|---|---|
| `herdr-relay start [--print-flags]` | runs the bridge in the foreground (§4); `--print-flags` prints its `deno run` line instead |
| `herdr-relay serve [--dry-run] [--port N]` | publishes the bridge on the tailnet (§5) |
| `herdr-relay pair [--scope read\|act] [--name NAME]` | a one-time pairing code (§6) |
| `herdr-relay devices` / `revoke <id\|name>` | paired devices / unpair one |
| `herdr-relay install-mod [--app-home DIR]` | installs the mirror mod into Herdr (§6) |
| `herdr-relay doctor [--port N]` | checks the installation (§7) |

Exit codes: 0 success, 1 failure or refusal, 2 usage or configuration error; `start` exits with the bridge's code
(3: no working sandbox).

The launcher's own permissions (in the script): read `$HOME`, `<repo>`, the app home and the Tailscale app binary
(`~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gh`, `~/Library/Keychains`, `~/Library/Cookies` denied); write
`~/.herdr/herdr-relay`, `<appHome>/mods` and `<appHome>/data/herdr-relay`; network `127.0.0.1` only; run `deno`,
`herdr-app`, `sandbox-exec`, `/usr/bin/sw_vers` and the Tailscale CLI; JSR imports only.

## 4. Start the bridge

```sh
herdr-relay start
```

It listens on `http://127.0.0.1:7781/herdr-relay/` (loopback only) and stops cleanly on Ctrl-C or SIGTERM. The
`deno run` flags are computed for this machine (`herdr-relay start --print-flags` shows them): on a default macOS
setup they are byte-identical to `deno task start` in the repository. They differ where the fixed task line cannot know
the machine:

- `--allow-run` names the Tailscale CLI the launcher finds: `HERDR_RELAY_TAILSCALE_BIN`, else
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, else the same under `~/Applications`, else `tailscale` on
  `PATH`. The variable is in the bridge's `--allow-env` too, so both resolve the same CLI.
- `--allow-write` names `<appHome>/data/herdr-relay` of the app home in use (`HERDR_APP_HOME` when set).
- An app home outside `$HOME` and `/tmp` is added to `--allow-read`.
- Without `TMPDIR` (launchd may not set it), the run directory is `/tmp/herdr-relay/<run>`.

Settings, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `HERDR_RELAY_PORT` | `7781` | loopback port |
| `HERDR_APP_HOME` | `~/.config/herdr-app` | Herdr's app home |
| `HERDR_RELAY_TAILSCALE_BIN` | found as above | absolute path of the Tailscale CLI |
| `HERDR_RELAY_PUSH_SUBJECT` | unset | contact the Web Push token names (VAPID `sub`): `mailto:you@example.com` or an `https:` URL of a public host; read at start, an invalid value is logged and ignored (§7 "Notifications") |
| `HERDR_RELAY_DEV` | unset | `1`: also answer the Android emulator's `10.0.2.2`; `insecure-no-sandbox`: mod hosts unconfined, pairing and tailnet off (development only) |

Each start compares this Mac with the last one (`~/.herdr/herdr-relay/environment.json`: macOS version, `deno` path and
version) and prints a prompt when either changed (§8).

## 5. Publish it on your tailnet

```sh
herdr-relay serve --dry-run    # shows the plan
herdr-relay serve              # tailscale serve --bg --set-path /herdr-relay 7781
```

Devices then open `https://<mac>.<tailnet>.ts.net/herdr-relay/`. herdr-relay is tailnet-only: `serve` refuses while
Tailscale Funnel is on anywhere on this Mac, and undoes its own share if Funnel shows up for it. Only the tailnet
account that owns this Mac is let in, and only on paired devices (§6).

## 6. Pair devices and install the mirror mod

Pair each phone or tablet once:

```sh
herdr-relay pair --scope act --name "iPad"    # --scope read: view only (default)
```

On the device, open the printed URL, enter the 6-digit code within 2 minutes, then Add to Home Screen. `herdr-relay
devices` lists paired devices, `herdr-relay revoke <id|name>` unpairs one (its open sessions close within 2 s).

iPhone and iPad read the app's status-bar setting only when it is added to the Home Screen. An icon added before
herdr-relay switched to the opaque system status bar keeps the old one: on iOS/iPadOS 26.1 and later a blur covers the
top of the app and taps there do nothing. Remove that icon from the Home Screen and add the app again. The opaque bar
takes the device's light or dark appearance, not the Herdr theme.

The mirror mod makes devices show this Herdr window's exact theme, fonts, focus and `shared` values
([RECIPE.md](../RECIPE.md)):

```sh
herdr-relay install-mod
```

It copies `<repo>/mods/herdr-relay-mirror` into `<appHome>/mods/herdr-relay-mirror` (a copy, never a link). It
refuses, writing nothing, when the installed copy is newer, or the same version with edited files. It never edits a
layout: add the entry it prints to the root node's `floating` list of each layout you show (Herdr's shipped layouts
are read-only: clone one first with `layout.clone`), then check it with `herdr-app check
<appHome>/mods/herdr-relay-mirror`. After an upgrade, a mirror older than the bundled copy is named in the bridge log
and as a toast on connected devices; run `herdr-relay install-mod` again.

## 7. Check the installation

```sh
herdr-relay doctor
```

One line per check, `ok`, `info`, `warn` or `FAIL`, then a count; exit 1 when anything failed. It only reads: `deno`
(2.9 or newer), the platform against the last start, the sandbox (`sandbox-exec` works), the access mode (Tailscale),
Tailscale login and `tailscale serve status`, Herdr compatibility (`herdr-app --version`, `herdr-app commands`, the app
home's contract files), the lock cache, the paired devices file, the mirror mod (installed against bundled version) and
the running bridge with its mirror status.

### Notifications

- **iPhone and iPad:** notifications work only in the Home Screen app (iOS or iPadOS 16.4 or later), not in a Safari
  tab. Open herdr from the Home Screen, then the device panel → Notifications, and turn the switch on there: iOS asks
  for permission only from that tap.
- **Blocked:** on iPhone and iPad, Settings → Notifications → herdr (the app's Home Screen name) → Allow Notifications,
  then go back to the app; elsewhere, the browser's site settings. The panel reads the state again when the app comes
  back into view, and lists the service worker, the permission and the push service it uses.
- **Send Test Notification** (under the switch while it is on) sends one notification to this device only, also while
  the app is open (alerts are never sent while any device has the app on screen); at most one every 5 s. The line
  under the button is what the push service answered: `sent to 1 subscription (201)` means it took the message;
  `no subscription for this device` or `410`: turn the switch off and on again.
- **The Mac's log** has one line per send, `herdr-relay: push: <service host> <status> [<apns-id or reason>]`, in the
  terminal running `herdr-relay start` or in `~/Library/Logs/herdr-relay.log` under launchd (§9).
- **`403: BadJwtToken`** (from `web.push.apple.com`): Apple refused the token the Mac signs each notification with.
  Its contact field must be a `mailto:` address or an `https:` URL Apple accepts, and the Mac's clock must be right.
  herdr-relay uses `HERDR_RELAY_PUSH_SUBJECT` when it is valid, else `https://<mac>.<tailnet>.ts.net` once the bridge
  knows its Tailscale name, else the project page. Set `HERDR_RELAY_PUSH_SUBJECT=mailto:you@example.com` where
  `herdr-relay start` runs (for the launchd agent, in the `EnvironmentVariables` of its copied plist), restart the
  bridge and send a test again. The start log says `VAPID subject from HERDR_RELAY_PUSH_SUBJECT: …`, or why the value
  was ignored.

## 8. Upgrade

1. Clone: `git pull`, then `deno task bundle` and `deno task --cwd packages/web fonts`. Tarball: unpack the new one
   (and point the `~/.local/bin/herdr-relay` link and the launchd agent at it).
2. Run `herdr-relay doctor`. The launcher fetches the modules a changed `deno.lock` pins on this first run.
3. A `mirror` warning: `herdr-relay install-mod`.
4. Restart the bridge (`launchctl kickstart -k gui/$(id -u)/io.github.lapis0875.herdr-relay` under launchd).

After a macOS or Deno upgrade, `start` and `doctor` say what changed. The mod-host Seatbelt profile was derived for one
macOS and one Deno; re-run its check in `<repo>`:

```sh
deno run --allow-read --allow-write --allow-net=127.0.0.1 --allow-env --allow-run=deno,sandbox-exec \
  packages/bridge/scripts/seatbelt-derive.ts
```

Exit 0 means the profile still holds. Otherwise report it (the JSON report names the failing check).

State files keep a schema version `v`. A file written by a newer herdr-relay (`devices.json` or `environment.json`
with a higher `v`) is refused with a message saying so and left unchanged; for `devices.json` the bridge then treats
no device as paired until herdr-relay is upgraded again.

## 9. Start at login (launchd)

`tools/launchd/io.github.lapis0875.herdr-relay.plist` is a per-user agent template running `herdr-relay start`. In
`<repo>`:

```sh
sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" tools/launchd/io.github.lapis0875.herdr-relay.plist \
  > ~/Library/LaunchAgents/io.github.lapis0875.herdr-relay.plist
plutil -lint ~/Library/LaunchAgents/io.github.lapis0875.herdr-relay.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.github.lapis0875.herdr-relay.plist
```

| To | Run |
|---|---|
| see its state | `launchctl print gui/$(id -u)/io.github.lapis0875.herdr-relay` |
| restart it | `launchctl kickstart -k gui/$(id -u)/io.github.lapis0875.herdr-relay` |
| stop it until the next login | `launchctl bootout gui/$(id -u)/io.github.lapis0875.herdr-relay` |
| read its log | `tail -f ~/Library/Logs/herdr-relay.log` |

The agent starts at login and is restarted after a non-zero exit, at most every 30 s. Its `PATH` is
`~/.local/bin:~/.deno/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`: edit the copy if `deno`,
`hc`, `herdr-app` or `cockpit` live elsewhere. A configuration error (exit 2) or a missing sandbox (exit 3) repeats in
the log every 30 s until fixed; `herdr-relay doctor` names the cause.

## 10. Homebrew

The formula is prepared in the repository as `packaging/homebrew/herdr-relay.rb` (not in the release tarball) and
**not published**: the tap `Lapis0875/homebrew-herdr-relay` does not exist yet, so `brew install` cannot find it.
Publishing copies the file into that tap after a tagged release, with the release's `.sha256` (the file's header says
how).

Once published:

```sh
brew install Lapis0875/herdr-relay/herdr-relay   # also installs deno
herdr-relay doctor
brew services start herdr-relay                  # instead of the §9 agent
```

- The release tarball (§2b) goes to `$(brew --prefix)/opt/herdr-relay/libexec`, which is `<repo>` in this guide. The
  `herdr-relay` command Homebrew links runs the launcher (§3) with Homebrew's `deno` first on `PATH`.
- The service has the §9 agent's label and plist path (`io.github.lapis0875.herdr-relay`), so the `launchctl`
  commands of §8 and §9 work for it. Run `launchctl bootout gui/$(id -u)/io.github.lapis0875.herdr-relay` first if
  you loaded the §9 agent. Like that agent it restarts after a non-zero exit, at most every 30 s. Its `PATH` is
  `~/.local/bin` plus Homebrew's `bin` and `sbin` and the system folders; its log is
  `$(brew --prefix)/var/log/herdr-relay.log`. Other `PATH` entries go in Homebrew's per-service override file
  `$HOMEBREW_USER_CONFIG_HOME/services/herdr-relay.env` (`PATH=…`), then `brew services restart herdr-relay`.
- Upgrade: `brew upgrade herdr-relay`, then steps 2 to 4 of §8 (restart: `brew services restart herdr-relay`).
- Uninstall: `brew services stop herdr-relay` and `brew uninstall herdr-relay`, then the last three commands of §11.
- `brew test herdr-relay` runs `herdr-relay doctor` in an empty home: it passes when the launcher, Homebrew's `deno`
  and a complete report work, whatever Herdr and Tailscale checks fail there.

## 11. Uninstall

```sh
launchctl bootout gui/$(id -u)/io.github.lapis0875.herdr-relay
rm ~/Library/LaunchAgents/io.github.lapis0875.herdr-relay.plist ~/.local/bin/herdr-relay
tailscale serve --https=443 --set-path /herdr-relay off
rm -rf ~/.herdr/herdr-relay                                  # paired devices, token, push keys, environment.json
rm -rf ~/.config/herdr-app/mods/herdr-relay-mirror ~/.config/herdr-app/data/herdr-relay
```

Then remove the mirror's entry from your layouts, and `<repo>`.
