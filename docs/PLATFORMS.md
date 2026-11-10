# Platforms

herdr-relay v1 runs on **macOS** only ([DECISIONS.md](DECISIONS.md) O2). Linux is described in code but has no mod-host
sandbox yet, so the bridge refuses to start there (planned: bubblewrap, OSS-PLAN T39). Windows is refused. Everything
that differs between operating systems goes through one seam, `packages/bridge/src/platform.ts` (OSS-PLAN §3, T38).

Path shorthand: `bridge/` = `packages/bridge/src/`. Line numbers refer to the tree this document was written against.

## 1. Matrix

| | macOS | Linux | Windows |
|---|---|---|---|
| Status | **v1** | planned (T39); refused today | unsupported |
| Bridge start | runs | exit 2: `no mod-host sandbox for Linux yet, so mod hosts cannot be confined; refusing to start. …` (`bridge/config.ts:102-107`) | exit 2: `Windows is not supported yet` (`bridge/platform.ts:150-154`) |
| Mod-host sandbox | Seatbelt: `sandbox-exec -f <run>/seatbelt/<folder>.sb <deno> run …` (`bridge/hosts/seatbelt.ts:187-226`, `bridge/hosts/seatbelt.template.sb:1-14`) | none (`sandbox: null`, `bridge/platform.ts:144`); planned bubblewrap (§4) | — |
| Sandbox probe | `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` exits 0 (`seatbelt.ts:192-205`) | — | — |
| Opener a mod's `open <url>` uses (E11: opened on the device) | `open` | `xdg-open` | — |
| Other platforms' openers (E12: refused) | `xdg-open`, `cmd`, `cmd.exe`, `powershell`, `powershell.exe`, `pwsh`, `start` | `open`, `cmd`, `cmd.exe`, `powershell`, `powershell.exe`, `pwsh`, `start` | — |
| Bridge `--deny-read` under `$HOME` | `.ssh`, `.gnupg`, `.aws`, `.config/gh`, `Library/Keychains`, `Library/Cookies` | `.ssh`, `.gnupg`, `.aws`, `.config/gh`, `.local/share/keyrings`, `.mozilla`, `.config/google-chrome`, `.password-store`, `.docker/config.json` | — |
| Tailnet peer check | `netstat-lsof`: `/usr/sbin/netstat`, `/bin/ps`, `/usr/sbin/lsof` spawned (`bridge/auth/peer.ts:8-15`) | `proc-net-tcp`: `/proc/net/tcp{,6}` read, nothing spawned (`peer.ts:17-20`) | — |
| Tailscale CLI default | the app bundle (§3) | `tailscale` on `PATH` | — |
| `trueBin`, default `TMPDIR` | `/usr/bin/true`, `/tmp` | `/bin/true`, `/tmp` | — |
| `window().platform` mods see | `macos` (the Mac's, not the device's) | `linux` | — |

Sources: `bridge/platform.ts:110-147` for the macOS and Linux rows; `bridge/herdr/source.ts:173-177,623-624` for
`window().platform` (the mirror mod's value wins once it reports). The E11/E12 split comes from the platform's openers
(`bridge/policy/exec.table.ts:472-473`). On Linux, `xdg-open <url>` opens on the device and `open` is refused.

Every `$HOME` entry of the deny list is applied twice:

- to the bridge itself: `--deny-read` in `deno task start` (`deno.json:64`, the macOS list) or computed per platform
  by the launcher's `start` (`packages/bridge/bin/start.ts:14`);
- to the `lh-scan` script runner (`bridge/policy/scripts.ts:51-53,100-109`).

`$HOME` stays the outer read bound.

## 2. Startup and exit codes

`bridge/main.ts` (run by `deno task start` / `start:dev`, and by the launcher's `herdr-relay start`):

| Exit | When | Where |
|---|---|---|
| 0 | stopped by SIGINT/SIGTERM | `bridge/main.ts:151-162` |
| 1 | the session layer cannot start, or `127.0.0.1:<port>` is in use | `main.ts:124-131,143-148` |
| 2 | configuration error (`ConfigError`), see the list below | `main.ts:57-65,74-76` |
| 3 | the platform has a sandbox and it does not work here (macOS: the Seatbelt probe fails or `sandbox-exec` is missing): `sandbox-exec is not available, so mod hosts cannot be confined by Seatbelt; refusing to start. …` | `main.ts:84-90`, `seatbelt.ts:191` |

Exit 2 covers:

- an operating system other than macOS or Linux (`platform.ts:150-154`);
- a platform without a sandbox provider, i.e. Linux today, unless `HERDR_RELAY_DEV=insecure-no-sandbox`
  (`config.ts:102-107`);
- `HOME` unset or relative (`config.ts:86`);
- `HERDR_APP_HOME` or `TMPDIR` relative (`config.ts:97-99`);
- `HERDR_RELAY_PORT` not a port 1–65535 (`config.ts:68-74`);
- `HERDR_RELAY_DEV` other than unset, `1` or `insecure-no-sandbox` (`config.ts:76-81`);
- `HERDR_RELAY_TAILSCALE_BIN` relative (`platform.ts:96-98`).

`--self-test` also exits 2 on a configuration error (`main.ts:67-71`).

Linux therefore exits **2**, not 3. Exit 3 needs a platform with a provider whose probe fails; on macOS that is the
security-matrix row S35 ([DESIGN-v2.md](DESIGN-v2.md) §5.3).

**`HERDR_RELAY_DEV=insecure-no-sandbox`** is for local development only. Mod hosts start unconfined, and the bridge
prints `WARNING: HERDR_RELAY_DEV=insecure-no-sandbox — mod hosts run without <sandbox>; pairing and tailnet access are
disabled (loopback token only)` (`main.ts:79-83`). Pairing is off and every tailnet request is refused
(`config.ts:116`, `main.ts:104-105`). It is the only way the bridge starts on Linux today. Deno permissions still
apply, but the kernel layer is gone: the security-matrix rows that rely on layer S (S03 symlink to a secret, S07
process spawn, S36 escaping link at runtime) lose that layer.

## 3. Tailscale CLI resolution (`HERDR_RELAY_TAILSCALE_BIN`)

`resolveTailscaleBin` (`bridge/platform.ts:88-108`) takes the first match:

1. `HERDR_RELAY_TAILSCALE_BIN`, if set. It must be absolute (else exit 2). It is used as given, without a file check.
2. macOS only: `/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
3. macOS only: `~/Applications/Tailscale.app/Contents/MacOS/Tailscale`.
4. `tailscale` in each absolute `PATH` directory, in order (Linux, the Homebrew formula).
5. The bare name `tailscale`.

Steps 2–4 accept a candidate that is a file. When the bridge may not look at a path (outside its `--allow-read`), it
accepts the candidate whose exact path is in its `--allow-run` instead (`platform.ts:63-77,107`). The launcher resolves
with read access and grants only the path it found, so the bridge arrives at the same one
(`packages/bridge/bin/start.ts:11-13`).

Every call runs with `TAILSCALE_BE_CLI=1`: the macOS app binary acts as its CLI only with it
(`bridge/auth/tailscale.ts:7-9,17-33`).

Permissions decide what is reachable:

- The bridge reads `HERDR_RELAY_TAILSCALE_BIN` only when its `--allow-env` lists it (`platform.ts:64-67,79-80`).
  `deno task start` does not (`deno.json:64`), so under it resolution starts at step 2. The launcher's `start` adds it
  (`packages/bridge/bin/start.ts:7-8,49-57`).
- Deno runs only what `--allow-run` names. `deno task start` names only
  `/Applications/Tailscale.app/Contents/MacOS/Tailscale`; any other location needs the launcher.

## 4. Linux (planned, T39)

What already exists is the description in `platform.ts:128-147`: openers, deny list, peer check, Tailscale default,
`/bin/true`. Not built yet (OSS-PLAN §3 and T39):

- **Sandbox provider `bwrap`** behind the `Sandbox` interface (`bridge/hosts/sandbox.ts:38-49`). Planned arguments:
  `--ro-bind` of the deno prefix, modhost and mod folder; `--bind` of the host's `DENO_DIR`; `--dev /dev`;
  `--proc /proc`; `--tmpfs /tmp`; `--unshare-user --unshare-pid --unshare-ipc --unshare-uts`; host network namespace
  kept (the control port is on loopback; Deno's `--allow-net=127.0.0.1:<ctl>` bounds it); `--cap-drop ALL`;
  `--die-with-parent`; `--new-session`.
- An availability probe, so a missing or blocked `bwrap` gives exit 3 like Seatbelt.
- `scripts/bwrap-derive.ts`: confined vs unconfined comparison, like the Seatbelt derivation.
- A `deno-only` opt-in, flagged in `hello.hosts[].sandbox`.
- A systemd user unit `tools/systemd/herdr-relay.service`.

**[I]** unprivileged user namespaces are required; Ubuntu 24.04 restricts them behind AppArmor unless a `bwrap`
profile is installed (OSS-PLAN §3). Linux security rows are T51.

## 5. Windows

Unsupported: `resolvePlatform` throws `ConfigError("Windows is not supported yet")` and the bridge exits 2
(`platform.ts:149-154`). Deferred past Linux ([DECISIONS.md](DECISIONS.md) O2, OSS-PLAN §3). The device protocol and
the PWA are platform-neutral. Windows lacks `sh`, `sandbox-exec` and `bwrap`, and Herdr's mods use `powershell` paths
there.

## 6. After an OS or Deno upgrade (macOS)

The Seatbelt template was derived on macOS 27.0 (26A428) with Deno 2.9.8 (`seatbelt.template.sb:5-10`). After a macOS
or Deno upgrade, re-run `packages/bridge/scripts/seatbelt-derive.ts`; benign hosts must show zero denials, and S03/S36
must stay blocked ([DESIGN-v2.md](DESIGN-v2.md) §5.3, regression rule). Then run `deno task test:security`.
