# Contributing to herdr-relay

Thanks for helping. Bug reports, profiles for other people's mods, fixes and documentation are all welcome. For a
security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## Toolchain

- macOS (the mod sandbox and the security tests need `sandbox-exec`).
- [Deno](https://deno.com) **2.9 or newer**. It is the only toolchain: no Node, no npm scripts. Dependencies are pinned
  in `deno.json` and locked in `deno.lock`, which is frozen.
- Herdr 0.1.14 and `hc` on `PATH`, only for the live tests and for running the bridge against your own window.

```sh
deno install --frozen     # fetch the locked dependencies; never rewrites deno.lock
```

A change that needs a new or upgraded dependency should say so in the pull request. It adds the dependency with
`deno add --save-exact --frozen-lockfile=false` in that change only, and gives it a line in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

## Checks

Run these before opening a pull request:

| Command | What it does |
|---|---|
| `deno task check` | `deno fmt --check`, `deno lint`, `deno check` of the packages |
| `deno task test` | unit and integration tests (protocol, bridge, web) |
| `deno task check:modhost` | type-checks the mod host against its own config (its behaviour is tested through the bridge's render and security suites) |
| `deno task test:security` | the security matrix against real sandboxed mod hosts (macOS) |
| `deno task scrub:check` | no personal paths, host names or secrets in anything you are about to publish |

Opt-in: `deno task test:core` talks to the Herdr core on your Mac (read-only methods only).

`deno fmt` formats code with a line width of 120; Markdown is not formatted by it, so keep docs wrapped at 120 by hand.

## Fixtures

- `fixtures/generic-home/` is an unmodified copy of Herdr 0.1.14's shipped mods and defaults. Do not edit it; check it
  with `deno run --allow-read=fixtures tools/fixtures/sync.ts --check`. Pinning another Herdr version goes through
  `deno task contract:update` ([docs/COMPATIBILITY.md](docs/COMPATIBILITY.md) §5).
- `fixtures/trees/` holds recorded render trees; regenerate them with `deno task test:views:update` and review the
  diff.
- **Never commit your own Herdr app home** (`~/.config/herdr-app`) or anything from it: your settings, keys, layouts'
  state and personal mods. Personal copies go under `fixtures/private/`, which is gitignored; tests that need them skip
  when it is absent. `deno task scrub:check` fails on a tracked `fixtures/private/` file.

## Profiles for your own mods

A mod folder that no profile names can render, read its own files and the space folders, and run nothing. To let a
mod run commands or read more, write a policy profile: [docs/PROFILES.md](docs/PROFILES.md) covers the fields, what a
profile cannot do, and how to test one. A profile for a published mod is a welcome contribution; include a link to the
mod and the test from PROFILES.md §9.

## Pull requests

- Keep one change per pull request, with tests for behaviour changes.
- Add a line to the top section of [CHANGELOG.md](CHANGELOG.md), the one marked `Unreleased`, for anything users
  would notice.
- Docs are in English. The Korean README ([README.ko.md](README.ko.md)) mirrors [README.md](README.md) section for
  section; if you change one, change the other or say so in the pull request.
- Commit messages follow the existing style: `feat: …`, `fix: …`, `docs: …`, `test: …`, `refactor: …`.

There is no CLA and no sign-off requirement. Contributions are accepted under the [Apache License 2.0](LICENSE), as its
section 5 describes.
