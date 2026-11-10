# Security policy

## Supported versions

Security fixes go into the latest minor release only. Today that is **0.1.x**; once 0.2.0 is out, 0.1.x gets no more
fixes.

## Reporting a vulnerability

Report it privately through GitHub's private vulnerability reporting: on
[github.com/Lapis0875/herdr-relay](https://github.com/Lapis0875/herdr-relay), open **Security → Report a
vulnerability**. Please do not open a public issue, pull request or discussion for it.

Useful in a report:

- the herdr-relay version or commit, macOS version, `deno --version` and `herdr-app --version`;
- what an attacker needs (a paired device, a tailnet account, a mod you installed, a page open in a browser, …);
- steps or a proof of concept, and what happened against what you expected;
- the output of `herdr-relay doctor` if it relates to setup.

The report stays private while a fix is prepared. We publish an advisory with the fix, crediting you unless you ask
otherwise. Disclosure happens when the fix is released or **90 days** after the report, whichever comes first; if a
fix needs longer, we agree a date with you in the advisory thread.

## Threat model

herdr-relay runs on your Mac as you, next to Herdr, and shows Herdr's window on your own phones and tablets. The full
model, with the exact process flags, the sandbox profile and the security test matrix, is
[docs/SECURITY.md](docs/SECURITY.md); the exec and file rules are [docs/POLICY.md](docs/POLICY.md).

**Who gets in.** The bridge listens on `127.0.0.1` only and is published with `tailscale serve` inside your tailnet.
It refuses to serve while Tailscale Funnel is on. A request is accepted only when it comes through Tailscale from the
account that owns the Mac, names the Mac's own tailnet address, and carries a paired device's credentials. A device is
paired with a one-time 6-digit code that expires after 2 minutes, then holds an httpOnly cookie; it is the second
factor after the Tailscale login. Each device has a scope, `read` (view only) or `act` (typing and commands), and can
be revoked at any time.

**What devices can do.** Devices never receive mod code, only rendered element trees and terminal output. A `read`
device can look and navigate, but cannot type, and any command its clicks would run is refused. An `act` device can
type into terminals and trigger the same actions a click on the Mac would, except structural changes to Herdr
(worktrees, machines and the like), which stay on the Mac.

**Mods.** Herdr treats mods as trusted code, and herdr-relay keeps that trust: installing a mod means trusting it, on
the Mac as in Herdr. What herdr-relay adds is a boundary around what devices can make mods do:

- each mod folder runs in its own unprivileged Deno process under a macOS Seatbelt profile; it can read only its own
  folder and the mod-host code, connect only to the bridge's loopback control port, and holds none of the bridge's
  secrets;
- every `exec`, `hc`, file read, folder watch and network connection a mod requests goes to the bridge, which checks
  it against argument-level rules and the folder's policy profile ([docs/PROFILES.md](docs/PROFILES.md)); a folder
  without a profile can read its own files and the space folders, and run nothing;
- mods cannot write files through herdr-relay.

**Out of scope.** Someone who already controls your Mac account, your Tailscale account, or an unlocked paired device;
a mod you chose to install that is malicious on the Mac itself (Herdr runs it with your full rights either way);
vulnerabilities in Herdr, Tailscale, Deno or macOS themselves (report those upstream).
