# Main-side evidence for DESIGN-v2 (2026-11-09)

- **M1** `herdr-app commands` → `fixtures/herdr-app-commands.json` (71 commands, captured from Herdr app 0.1.13).
- **M2** `deno bundle --help` on Deno 2.9.8: subcommand exists; options include `-o/--output`, `--outdir`, `--format`, `--packages bundle|external`, `--platform browser|deno`, `--sourcemap linked|inline|external`, `--external`.
- **M3** Seatbelt on this Mac: `sandbox-exec -p '(version 1)(allow default)' /usr/bin/true` → exit 0; `(deny default)(allow process-exec)(allow file-read*)` → exit 0; `(deny default)` → `execvp ... Operation not permitted` (exit 71, as expected). `/System/Library/Sandbox/Profiles/system.sb` and `bsd.sb` exist. Note: `/bin/true` does not exist on macOS; use `/usr/bin/true`.
- herdr-core: `hc schema` → version 0.1.19, protocol generation 1, 32 methods.
