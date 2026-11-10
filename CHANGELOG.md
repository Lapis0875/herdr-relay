# Changelog

All notable changes to herdr-relay are listed here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

The first public version.

### Added

- The bridge: a Deno 2.9 process on the Mac that connects to the Herdr core, renders Herdr's layouts and unmodified
  mods, and serves them on `127.0.0.1`, published to the tailnet with `herdr-relay serve` (`tailscale serve`; Funnel
  refused).
- One unprivileged mod-host process per mod folder under a macOS Seatbelt profile; every `exec`, `hc`, file read,
  folder watch and network request is decided by the bridge with argument-level rules.
- Policy profiles: built-in profiles for Herdr's 21 shipped mods and for the cockpit and lstack-herdr mods; a folder
  without a profile reads its own files and runs nothing ([docs/PROFILES.md](docs/PROFILES.md)).
- The device app (PWA) for phones and tablets: layouts recomposed per device class, terminals at the Mac's size, a
  stale view while offline, and Web Push when an agent finishes or needs you.
- Device layout profiles: on tablets and desktops, drag the sidebar and panel edges (or use the keyboard) to resize them for that device only; the Mac's Herdr layout never changes. Kept per paired device, layout and device class, with "Reset layout for this device". Mods' `layout.resize` calls apply to the device that triggered them, and splits inside mods are draggable on touch screens.
- Pairing with one-time codes, per-device `read` / `act` scope, and revocation.
- The `herdr-relay` launcher (`start`, `serve`, `pair`, `devices`, `revoke`, `install-mod`, `doctor`) and a launchd
  agent template ([docs/INSTALL.md](docs/INSTALL.md)).
- A Homebrew formula with a `brew services` block, prepared in `packaging/homebrew/` and not published
  ([docs/INSTALL.md](docs/INSTALL.md) §10).
- Per-device focus reaches the mods: selecting a tab or pane on a device updates what the mods draw for that device
  (e.g. the tab bar's highlight) without moving the Mac's focus.
- Hardware keyboards on iPad: Ctrl+Space, Caps Lock and the Globe key switch the input language instead of reaching
  the terminal or mods; Korean input from Safari/WebKit is sent once per finished syllable.
- iPad Home Screen app: an opaque status bar, so iPadOS 26.1+ no longer blurs and blocks the top of the app (re-add
  the app to the Home Screen once).
- A "Keyboard diagnostics" switch in the device panel that lists key and input events (typed characters redacted) for
  bug reports.
- Terminals show the name, icon and tile Herdr shows (Deno, npm, Shell, …): the bridge resolves programs as Herdr
  does, from Herdr's built-in program table with the app home's `programs.json` on top.
- The `herdr-relay-mirror` mod, which reports the Mac window's exact theme, fonts and focus ([RECIPE.md](RECIPE.md)).
- Herdr compatibility: contract pins for Herdr 0.1.14, drift detection and device banners for other versions
  ([docs/COMPATIBILITY.md](docs/COMPATIBILITY.md)).
- Publishing files: Apache-2.0 [LICENSE](LICENSE), [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES),
  [SECURITY.md](SECURITY.md) with private vulnerability reporting, [CONTRIBUTING.md](CONTRIBUTING.md), README in
  English and Korean, and `deno task scrub:check`, which fails when a file about to be published holds a personal
  path, host name or secret.

### Removed

- The Deno and Bun runtime spikes (`spikes/`). Their measured results, the evidence behind choosing Deno (decision D6),
  are kept as [docs/spikes/deno.md](docs/spikes/deno.md) and [docs/spikes/bun.md](docs/spikes/bun.md).

[0.1.0]: https://github.com/Lapis0875/herdr-relay/releases/tag/v0.1.0
