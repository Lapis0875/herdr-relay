# herdr-relay — user decisions (2026-11-09)

Source design: `docs/DESIGN.md` (architect, Claude Fable 5.1 / high). These decisions override the design where they differ.

| # | Decision | Choice |
|---|---|---|
| D1 | Client form | PWA now; native wrappers later. The bridge protocol stays renderer-agnostic. |
| D2 | v1 layout scope | *Superseded by D2′ (below).* Any personal layout + Herdr's shipped mods (`tabs`, `files`, `changes`, `workspace-chrome`). `win98` is a stretch goal (fixtures only). |
| D3 | Device write scope | View + terminal typing + non-structural `run`, per-device scope (`read` / `act`). Structural commands are refused on devices. |
| D4 | Phone terminal sizing | Observe at the Mac's cols/rows and scale to fit the width; pinch to 1:1. Never resize the Mac terminal. |
| D5 | Mirror mod | Install `herdr-relay-mirror` into `~/.config/herdr-app/mods` (read-only, exact theme/settings/panes truth). |
| D6 | Bridge runtime | **Deno 2.9** (user, 2026-11-09: chosen for its permission system). Evidence: [docs/spikes/deno.md](spikes/deno.md) (GO; Deno blocked 30/36 direct hostile-mod attempts, bridge policy 14/16) vs [docs/spikes/bun.md](spikes/bun.md) (GO only with a hand-written linker + Seatbelt; Bun enforces nothing itself). Required hardening carried from the spike: privileged bridge process + separate unprivileged mod-host process(es) (process per mod folder, no `--unstable-worker-options`); mods loaded only via computed `import()` in a process that cannot read secrets; macOS Seatbelt around the mod host (symlink escape); bridge realpath checks + load-time symlink scan; argument-level allowlists for every exec (`git -c`, `node -e`, `env DYLD_*` refused); delete `caches`/`BroadcastChannel` reachability per Worker where possible; throwaway `DENO_DIR`; crash/OOM of a mod host restarts that host only. |
| D7 | Exposure | `tailscale serve --set-path /herdr-relay` on the existing MagicDNS host; refuse Funnel. |
| D8 | `setShared` from devices | Session-local overlay only; never writes `shared.json`. |
| D9 | Desktop path | Ship `tools/sync-config` + the lstack `on:` patch proposal; do not apply to `~/.config/herdr-app` until a PC is set up. |
| D10 | Fonts | Bundle **Geist** (UI, Latin), **Pretendard** (UI, Hangul + consistent across devices), **JetBrains Mono** (mono UI), **D2Coding** (terminal). All OFL. |
| D11 | Push | Web Push (VAPID) only in v1. |
| U1 | `git commit` from devices (changes mod, E5) | Allowed for `act`-scope devices only (user, 2026-11-09). |
| U2 | `sync.mjs` from devices (lstack-herdr's regeneration from upstream cockpit) | Refused (user, 2026-11-09). |
| U3 | `open <url>` from mods (E11) | Opens on the device that triggered it, never on the Mac (user, 2026-11-09). |
| N1 | Project name / repository | **herdr-relay** (user, 2026-11-09). Local git repository; nothing is pushed without explicit authorization. |
| N2 | Audience | **Open source** for anyone using herdr-core + herdr-app: must work with the user's current setup (lstack-herdr / cockpit) **and** generic setups (Herdr's shipped layouts and mods, other personal layouts). Personal-setup specifics become optional profiles, not hard requirements. |
| O1 | License | **Apache-2.0** (user, 2026-11-09). |
| O2 | Platforms | **macOS only in v1**; then Linux (bubblewrap sandbox), then Windows. Keep the platform/sandbox seam (T38) so later platforms are additive; T39 (Linux) and Windows are post-v1. |
| O3 | Network access | **Tailscale only in v1.** Reverse-proxy mode (OSS-PLAN T40) is deferred until after v1. |
| O4 | Distribution | **git clone + release tarball** with the `herdr-relay` launcher (T44) in v1; **prepare** a Homebrew formula/tap (T47) without publishing it. |
| O5 | README | English `README.md` (main) + full Korean `README.ko.md`. |
| O6 | Publish target | `github.com/Lapis0875/herdr-relay`, public, fresh scrubbed history; mirror mod tagged `herdr-mod`; launchd id `io.github.lapis0875.herdr-relay`. Creating the GitHub repo and every push require the user's explicit approval at that time. |
| O7 | lstack-herdr fork | Stays **private**: fork mod code only under gitignored `fixtures/private/`; only the layout JSON (+ `.state`) may be published for recompose goldens. |
| D2′ | v1 layout scope (supersedes D2 via N2) | Herdr's 21 shipped mods × 3 shipped layouts (`main`, `terminals`, `win98`) + personal layouts/mods via profiles. |
| D12 | Device-local layout profile | What a device resizes (shell dividers, collapse, mods' `layout.resize`) is kept by the bridge per device, layout name and device class in `<state>/layout-profiles/<device id>.json`, applied after the Mac's file and `.state` clicks and before session-transient clicks; never written to the Mac; allowed for `read` devices (their own view only); removed on revoke and when the device is no longer paired. **Tablet-landscape is resizable** like desktop (amends DESIGN.md §3). **Shared mod copies accepted:** a copy shown on two devices at different widths renders at the last reported width. **Mod-internal splits** (`h_resizable`/`v_resizable`) stay client-local, not in the profile (user, 2026-11-10). DESIGN.md §3 "Device layout profile". |

Facts confirmed by Main: `hc schema` → herdr-core 0.1.19, protocol generation 1; methods `hello`, `rpc.discover`, `doc.get`, `doc.set`, `terminal.attach`, `terminal.list`, `terminal.get`, `terminal.run`, `events.subscribe` exist (32 methods total). Runtimes installed: Bun 1.4.4, Deno 2.9.8, Node 26.13 (+22.23 via nvm).

Fixtures: `fixtures/generic-home/` is Herdr 0.1.14's shipped set (unmodified Apache-2.0 copies, `NOTICE.md`); personal app-home copies live only in the gitignored `fixtures/private/` (O7). Never read or write the live `~/.config/herdr-app` from tests.
