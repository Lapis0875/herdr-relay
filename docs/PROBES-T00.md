# T00 go/no-go probes (2026-11-09, candidate herdr-relay-c1)

All three probes **pass on Deno 2.9.8**. The §3.2 Vite fallback is **not** switched on.

| Probe | Question | Result |
|---|---|---|
| (a) | `deno bundle --platform browser` bundles a React 19 JSX component with `npm:` imports | **GO** — 11 modules, 223,677 B (69,250 B gzip); renders `<h1>herdr-relay</h1>` in headless Chrome |
| (b) | standalone `packages/modhost/deno.json` via `--config` resolves `gpui-kit` for a file outside the repo | **GO** — all 6 specifiers → `packages/modhost/src/shims/*.js`; root import map does not leak |
| (c) | a workspace member's test runs under the root `deno task test` | **GO** — 1 passed (scratch copy of the workspace config; see why below) |

Probe inputs that cannot live in the repo (T00 may not write test files, shims or `dist/`) were created under
`/tmp/herdr-relay-t00/`; their full contents are quoted below so the probes can be re-created.

Environment:

```
$ deno --version
deno 2.9.8 (stable, release, aarch64-apple-darwin)
v8 15.0.245.2-rusty
typescript 6.0.3
$ which deno
/opt/homebrew/bin/deno
```

Pinned dependencies (`deno add --save-exact --frozen-lockfile=false …`, root `deno.json` `imports`; `deno.lock`
sha256 `23b67b8adaffc872dcac21d5ce7e4edb22f17bbcc07e64448ffbb30271ddcb9e`):

```
Add npm:react@19.3.1            Add npm:@xterm/xterm@6.0.0            Add jsr:@std/assert@1.0.19
Add npm:react-dom@19.3.1        Add npm:@xterm/addon-unicode11@0.9.0  Add jsr:@std/path@1.1.6
Add npm:marked@18.1.3           Add npm:dompurify@3.4.17              Add jsr:@std/testing@1.0.21
Add npm:highlight.js@11.12.0    Add npm:@types/react@19.3.0           Add jsr:@std/async@1.5.1
Add npm:@types/react-dom@19.3.0
```

---

## (a) `deno bundle --platform browser` of a 5-line React component

Input: `packages/web/src/main.tsx` (committed probe; T15 replaces it):

```tsx
import { createRoot } from "react-dom/client";

function App() {
  return <h1>herdr-relay</h1>;
}

createRoot(document.getElementById("root")!).render(<App />);
```

Command — the `packages/web` `bundle` task with the output redirected to `/tmp` (T00 may not write `packages/web/dist`):

```
$ cd packages/web && deno bundle --platform browser --minify -o /tmp/herdr-relay-t00/probe-a/app.js src/main.tsx
⚠️  deno bundle is experimental and subject to changes
Download https://registry.npmjs.org/@esbuild%2fdarwin-arm64
Download https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.25.5.tgz
Bundled 11 modules in 56ms
  ../../../../../../tmp/herdr-relay-t00/probe-a/app.js 218.43KB

exit=0
```

Second and later runs (final config):

```
$ cd packages/web && deno bundle --platform browser --minify -o /tmp/herdr-relay-t00/probe-a/app.js src/main.tsx
⚠️  deno bundle is experimental and subject to changes
Bundled 11 modules in 51ms
  ../../../../../../tmp/herdr-relay-t00/probe-a/app.js 218.43KB

exit=0
$ wc -c /tmp/herdr-relay-t00/probe-a/app.js && gzip -c /tmp/herdr-relay-t00/probe-a/app.js | wc -c
223677 /tmp/herdr-relay-t00/probe-a/app.js
69250
```

Bundle content (self-contained, JSX transformed with the automatic runtime, no Node globals left):

```
$ grep -o -E 'getElementById\("root"\)|"herdr-relay"|createRoot|react\.transitional\.element|import\(|from"' /tmp/herdr-relay-t00/probe-a/app.js | sort | uniq -c
      2 createRoot
      1 getElementById("root")
      1 "herdr-relay"
      3 react.transitional.element
# second search, pattern `process\.env|require\(|^import |Deno\.` over app.js → "No matches found"
```

Runtime check in a browser engine (`/tmp/herdr-relay-t00/probe-a/index.html` =
`<!doctype html><html><body><div id="root"></div><script type="module" src="./app.js"></script></body></html>`):

```
$ "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --no-first-run \
    --user-data-dir=/tmp/herdr-relay-t00/chrome-profile --allow-file-access-from-files --virtual-time-budget=3000 \
    --dump-dom file:///tmp/herdr-relay-t00/probe-a/index.html 2>/dev/null
<!DOCTYPE html>
<html><head></head><body><div id="root"><h1>herdr-relay</h1></div><script type="module" src="./app.js"></script>
</body></html>
```

Type-check of the same file. Without React type packages it fails; with `@types/react` + `@types/react-dom` in the
root `imports` (Deno picks them up for the untyped `npm:react*` packages) it passes:

```
$ deno check packages          # before adding @types/*
Check packages/web/src/main.tsx
TS7026 [ERROR]: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
  return <h1>herdr-relay</h1>;
         ~~~~
    at file://<repo>/packages/web/src/main.tsx:4:10

TS2875 [ERROR]: This JSX tag requires the module path 'react/jsx-runtime' to exist, but none could be found. Make sure you have types for the appropriate package installed.
  return <h1>herdr-relay</h1>;
         ~~~~~~~~~~~~~~~~~~~~~
    at file://<repo>/packages/web/src/main.tsx:4:10

TS7026 [ERROR]: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
  return <h1>herdr-relay</h1>;
                         ~~~~~
    at file://<repo>/packages/web/src/main.tsx:4:26

Found 3 errors.

error: Type checking failed.
exit=1
$ deno check packages          # after `deno add --save-exact npm:@types/react@19 npm:@types/react-dom@19`
Check packages/web/src/main.tsx
exit=0
```

Findings:
- `react-dom/client` and `react/jsx-runtime` resolve from the plain `"react"` / `"react-dom"` entries (Deno maps
  subpaths of `npm:` import-map entries); the explicit `react-dom/client` / `react-dom/server` entries of the
  DESIGN-v2 §3.1 shape are not needed and were not added.
- **Not fully offline on first use:** `deno bundle` downloads the esbuild binary itself
  (`@esbuild/darwin-arm64@0.25.5` → `~/Library/Caches/deno/dl/esbuild-0.25.5-1/esbuild-darwin-arm64`). It is not
  recorded in `deno.lock`. Later runs reuse the cache. This contradicts the "no esbuild npm download … offline builds"
  wording of DESIGN-v2 §3.2; the fallback condition (failure on React JSX or `npm:` resolution) is not met.
- `deno bundle` prints "experimental" on every run (R2 in DESIGN-v2 §9 stands).
- The frozen lockfile is untouched by bundling: `cmp deno.lock <copy taken before>` → identical.

---

## (b) Standalone `packages/modhost/deno.json` resolving `gpui-kit` for a file outside the repo

Committed config (`packages/modhost/deno.json`):

```json
{
  "workspace": [],
  "imports": {
    "gpui-kit": "./src/shims/gpui-kit.js",
    "gpui": "./src/shims/gpui-kit.js",
    "gpui-base": "./src/shims/gpui-base.js",
    "herdr": "./src/shims/herdr.js",
    "net": "./src/shims/net.js",
    "buffer": "./src/shims/buffer.js"
  },
  "lock": false
}
```

### b.1 Resolution through the real repo config, file under `/tmp`, mod-host flag set

`/tmp/herdr-relay-t00/probe-b/mod/main.js`:

```js
for (const s of ["gpui-kit", "gpui", "gpui-base", "herdr", "net", "buffer"]) {
  console.log(`${s} -> ${import.meta.resolve(s)}`);
}
```

```
$ cd <repo> && deno run --no-prompt --no-remote --no-npm --no-lock \
    --config=<repo>/packages/modhost/deno.json \
    --allow-read=/tmp/herdr-relay-t00/probe-b/mod,<repo>/packages/modhost \
    /tmp/herdr-relay-t00/probe-b/mod/main.js
gpui-kit -> file://<repo>/packages/modhost/src/shims/gpui-kit.js
gpui -> file://<repo>/packages/modhost/src/shims/gpui-kit.js
gpui-base -> file://<repo>/packages/modhost/src/shims/gpui-base.js
herdr -> file://<repo>/packages/modhost/src/shims/herdr.js
net -> file://<repo>/packages/modhost/src/shims/net.js
buffer -> file://<repo>/packages/modhost/src/shims/buffer.js
exit=0
```

Same six lines with cwd `/tmp/herdr-relay-t00/probe-b` (re-run with the final config). Static imports
(`/tmp/herdr-relay-t00/probe-b/mod/static.js`:
`import { div } from "gpui-kit"; import { exec } from "herdr"; export { div, exec };`):

```
$ deno info --no-remote --no-npm --no-lock --config=<repo>/packages/modhost/deno.json \
    /tmp/herdr-relay-t00/probe-b/mod/static.js
local: /tmp/herdr-relay-t00/probe-b/mod/static.js
type: JavaScript
dependencies: 0 unique
size: 84B

file:///tmp/herdr-relay-t00/probe-b/mod/static.js (84B)
├── file://<repo>/packages/modhost/src/shims/gpui-kit.js (missing)
└── file://<repo>/packages/modhost/src/shims/herdr.js (missing)
exit=0
```

(`missing` = the shims arrive with T06.)

Root import map does not leak into the mod realm (`/tmp/herdr-relay-t00/probe-b/outside/leak.js` tries
`import.meta.resolve` on three root entries):

```
$ deno run --no-prompt --no-remote --no-npm --no-lock --config=<repo>/packages/modhost/deno.json \
    --allow-read=/tmp/herdr-relay-t00/probe-b/outside,<repo>/packages/modhost /tmp/herdr-relay-t00/probe-b/outside/leak.js
@std/assert -> not resolvable: Import "@std/assert" not a dependency and not in import map from "file:///tmp/herdr-relay-t00/probe-b/outside/leak.js"
react -> not resolvable: Import "react" not a dependency and not in import map from "file:///tmp/herdr-relay-t00/probe-b/outside/leak.js"
@herdr-relay/protocol -> not resolvable: Import "@herdr-relay/protocol" not a dependency and not in import map from "file:///tmp/herdr-relay-t00/probe-b/outside/leak.js"
exit=0
```

### b.2 Full load with real shims (scratch copy of the workspace)

T00 may not write `packages/modhost/src/**`, so the load was run in `/tmp/herdr-relay-t00/scratch/`: byte-identical
copies of `deno.json`, `deno.lock`, `packages/{protocol,bridge,web,modhost}/deno.json`, plus probe-only shims
(`export const div = () => "shim:gpui-kit";` etc.) and an entry `packages/modhost/src/main.js` that does a **computed**
`import(Deno.args[0])` as T06's entry will. The mod `/tmp/herdr-relay-t00/probe-b/outside/main.js` statically imports
all six specifiers:

```js
import { div } from "gpui-kit";
import { div as gdiv } from "gpui";
import { base } from "gpui-base";
import { herdr } from "herdr";
import { net } from "net";
import { Buffer } from "buffer";

export const report = { gpuiKit: div(), gpui: gdiv(), base, herdr, net, buffer: Buffer, url: import.meta.url };
```

```
$ cd /tmp/herdr-relay-t00/scratch && deno run --no-prompt --no-remote --no-npm --no-lock \
    --config=/tmp/herdr-relay-t00/scratch/packages/modhost/deno.json \
    --allow-read=/tmp/herdr-relay-t00/probe-b/outside,/tmp/herdr-relay-t00/scratch/packages/modhost \
    --allow-net=127.0.0.1:9 \
    /tmp/herdr-relay-t00/scratch/packages/modhost/src/main.js file:///tmp/herdr-relay-t00/probe-b/outside/main.js
{"gpuiKit":"shim:gpui-kit","gpui":"shim:gpui-kit","base":"shim:gpui-base","herdr":"shim:herdr","net":"shim:net","buffer":"shim:buffer","url":"file:///tmp/herdr-relay-t00/probe-b/outside/main.js"}
exit=0
```

### b.3 Why `"workspace": []`

Without it (config exactly as the DESIGN-v2 §3.1 shape), every run printed on stderr:

```
Warning: config file file://<repo>/packages/modhost/deno.json is not a member of the workspace at file://<repo>/. Ignoring the parent workspace config.
```

Resolution and the no-leak result were identical with and without it (both measured). `"workspace": []` makes the
config its own workspace root, removes the warning (it would be logged by the bridge for every mod-host spawn), and
leaves root `deno fmt` / `deno lint` coverage of `packages/modhost` unchanged (measured in the scratch copy).

---

## (c) Workspace member test run

T00 may not write test files (TW-owned) or `packages/protocol/mod.ts` (T02), so the member test was run in the same
scratch copy (byte-identical configs, verified with `cmp`), with two probe-only files:

```ts
// packages/protocol/mod.ts
export const PROTOCOL_VERSION = 1;

// packages/protocol/test/probe_test.ts
import { assertEquals } from "@std/assert";
import { PROTOCOL_VERSION } from "@herdr-relay/protocol";

Deno.test("workspace member resolves root imports and its own package name", () => {
  assertEquals(PROTOCOL_VERSION, 1);
});
```

plus `packages/modhost/test/resolve_test.js` (imports `div` from `"gpui-kit"`, asserts `"shim:gpui-kit"`):

```
$ cd /tmp/herdr-relay-t00/scratch && deno task test
Task test deno test --permit-no-files --allow-read=. --allow-write=./.tmp --allow-net=127.0.0.1 --allow-env=HOME,TMPDIR,HERDR_RELAY_LIVE_CORE --allow-run=deno,sandbox-exec,git packages/protocol packages/bridge packages/web
running 1 test from ./packages/protocol/test/probe_test.ts
workspace member resolves root imports and its own package name ... ok (761µs)

ok | 1 passed | 0 failed (4ms)

test exit=0
$ deno task check
Task check deno fmt --check && deno lint && deno check packages/protocol packages/bridge packages/web
Checked 15 files
Checked 10 files
check exit=0
$ deno task test:modhost
Task test:modhost deno test --config packages/modhost/deno.json --allow-read=packages/modhost,fixtures --allow-net=127.0.0.1 packages/modhost
running 1 test from ./packages/modhost/test/resolve_test.js
modhost config maps gpui-kit to the shim ... ok (156µs)

ok | 1 passed | 0 failed (2ms)

test:modhost exit=0
```

Why the gates list member directories instead of `packages` or the DESIGN-v2 entry points:

```
$ cd /tmp/herdr-relay-t00/scratch && deno check packages     # directory form picks up the non-member modhost
Check packages/bridge/src/main.ts
Check packages/modhost/src/main.js
Check packages/modhost/src/shims/buffer.js
Check packages/modhost/src/shims/gpui-base.js
Check packages/modhost/src/shims/gpui-kit.js
Check packages/modhost/src/shims/herdr.js
Check packages/modhost/src/shims/net.js
Check packages/modhost/test/resolve_test.js
Check packages/protocol/mod.ts
Check packages/protocol/test/probe_test.ts
Check packages/web/src/main.tsx
TS2307 [ERROR]: Import "gpui-kit" not a dependency and not in import map from "file:///private/tmp/herdr-relay-t00/scratch/packages/modhost/test/resolve_test.js"
  hint: If you want to use the npm package, try running `deno add npm:gpui-kit`
    at file:///private/tmp/herdr-relay-t00/scratch/packages/modhost/test/resolve_test.js:1:21

error: Type checking failed.
check exit=1
$ cd <repo> && deno check packages/protocol packages/bridge   # empty members on the empty tree
Warning No matching files found.
empty-dirs exit=0
```

`deno test packages` skipped `packages/modhost/test/**` in both modhost variants (measured), but the explicit member
list keeps `check` and `test` symmetric and independent of that behaviour.

---

## Repository gates on the empty tree (this repo, final files)

```
$ deno task check
Task check deno fmt --check && deno lint && deno check packages/protocol packages/bridge packages/web
Checked 6 files
Checked 1 file
check exit=0
$ deno task test
Task test deno test --permit-no-files --allow-read=. --allow-write=./.tmp --allow-net=127.0.0.1 --allow-env=HOME,TMPDIR,HERDR_RELAY_LIVE_CORE --allow-run=deno,sandbox-exec,git packages/protocol packages/bridge packages/web

ok | 0 passed | 0 failed (0ms)

test exit=0
```

(`deno check` prints `Check packages/web/src/main.tsx` only when the result is not cached; the uncached run is shown
under (a).)

`deno fmt --check` without a Markdown exclude fails on the Main-owned design docs (`docs/DESIGN.md`,
`docs/DESIGN-v2.md`, `docs/DECISIONS.md`, `docs/EVIDENCE-M1-M3.md`: "error: Found 4 not formatted files in 10 files" —
table alignment and prose re-wrapping), hence `"fmt": { "exclude": ["**/*.md"] }`.

---

## Other measured facts for later tasks

- **`deno task` shell has no `${VAR:-default}`** (affects `start` / `start:dev` and T33's launchd plist):

  ```
  $ deno task a   # "a": "echo ${HERDR_APP_HOME:-$HOME/.config/herdr-app} $TMPDIR"
  ${HERDR_APP_HOME:-<HOME>/.config/herdr-app} /var/folders/<…>/T/
  ```

- **`start` flags are accepted by Deno 2.9.8**; it stops only at the missing entry (T10):

  ```
  $ deno task start
  error: Module not found "file://<repo>/packages/bridge/src/main.ts".
  exit=1
  ```

- **`--no-remote` blocks `jsr:` imports even when cached.** Scratch `packages/bridge/src/main.ts` importing
  `@std/path` under the exact `start` task:

  ```
  error: JSR package manifest for '@std/path' failed to load. A remote specifier was requested: "https://jsr.io/@std/path/meta.json", but --no-remote is specified.
  exit=1
  $ deno run --no-prompt --cached-only --no-npm --lock=deno.lock --allow-read=./packages packages/bridge/src/main.ts
  bridge probe: a/b protocol=1
  cached-only exit=0
  ```

  Under the DESIGN-v2 §1.2 flags, bridge runtime code must use `node:path` (not `@std/path`); `@std/*` stays usable in
  tests. Switching `--no-remote` → `--cached-only` would also work but changes §1.2 (not done).

---

## Deviations from DESIGN-v2 (all within T00's allowed paths)

1. `tools/sync-config` is **not** a workspace member and is absent from `check`/`test`: its `deno.json` belongs to T13
   (`tools/sync-config/**`), and a workspace entry without that file fails every Deno command. T13 adds
   `"./tools/sync-config"` to `workspace` and to both task paths (root `deno.json` hand-off).
2. `check` runs `deno check packages/protocol packages/bridge packages/web` instead of the four named entry points (they
   do not exist yet; the directory form also checks tests and scripts and needs no edit when entry points land).
3. `test` adds `--permit-no-files` (empty tree) and lists member directories instead of `packages`.
4. `fmt` excludes `**/*.md` (Main-owned docs are not `deno fmt` clean).
5. `lock` is `{ "path": "./deno.lock", "frozen": true }` — enforces "UI/TW never edit it"; BE adds dependencies with
   `deno add --save-exact --frozen-lockfile=false`.
6. Exact pins (`--save-exact`) and `@types/react` + `@types/react-dom` added (required by `deno check` of JSX); no
   explicit `react-dom/client` / `react-dom/server` entries (subpaths resolve automatically).
7. `packages/modhost/deno.json` adds `"workspace": []` (b.3).
8. `packages/web` `bundle` / `watch` tasks omit the `tools/assets.ts` step (T15 owns `packages/web/tools/**` and the
   `packages/web/deno.json` tasks); `fonts` is present as designed and runs once T18 adds `tools/fonts/fetch.ts`.
9. `start` / `start:dev` fix `<appHome>` to `$HOME/.config/herdr-app` and `<run>` to `$TMPDIR/herdr-relay` (no
   `${VAR:-default}` in `deno task`).
