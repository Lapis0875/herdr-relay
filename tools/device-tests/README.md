# Device checks

These are local development checks, not production device setup. Use Node 26, Deno 2.9+, an already-running `deno task start:dev`, and a **scratch** Herdr home and fake core. The bridge must serve the lstack layout with a terminal pane in the active tab, Work selected initially for the iPad, and a working observe attachment that sends a size/paint. The fake core in `packages/bridge/test/fakes/core.ts` is an in-process test helper, not a standalone server; supplying a running bridge backed by a suitable fake core is a prerequisite, not something these scripts start. Do not use a real terminal for this check. Build the web bundle and fonts before starting the bridge (`deno task bundle` and `deno task --cwd packages/web fonts`).

## Playwright

From the repository root, after the scratch bridge is listening on `127.0.0.1:7781`:

```sh
npm ci --prefix tools/device-tests
cd tools/device-tests
export PLAYWRIGHT_BROWSERS_PATH=/private/tmp/herdr-relay-pw-browsers
npx playwright install chromium webkit
export BASE_URL=http://127.0.0.1:7781
export TOKEN="$(cat /absolute/path/to/scratch/token)"
npm test
cd ../..
```

Replace the token path and port for the scratch bridge. `BASE_URL` must be loopback HTTP; the token is added as a query parameter. The tests run iPhone 15, iPad Air-sized iPad, and Pixel 8-sized Pixel emulations. Playwright does not ship Air or Pixel 8 descriptors in this pinned version, so the latter two use iPad and Pixel 7 browser profiles with the stated viewport sizes (and Pixel 8 user agent). The phones exercise segments, More, drawer and panel push; the portrait tablet exercises its panel sheet. Each checks a live terminal's observe-mode wire request, status, and browser errors. Screenshots are in `.tmp/devices/playwright/`. This is emulation, not proof of physical-device or PWA behavior.

Use the same `PLAYWRIGHT_BROWSERS_PATH` for installation and every run. It must contain both the Chromium and WebKit builds required by the pinned Playwright version; a partial cache is insufficient.

## Simulator and emulator

Install an iOS runtime and Xcode command-line tools first. From the repository root, while the scratch bridge is running:

```sh
PORT=7781 TOKEN_FILE=/absolute/path/to/scratch/token tools/device-tests/ios-sim.sh
```

The script reuses a uniquely named simulator on the latest installed iOS runtime or creates one; it does not delete devices. Set portrait in Simulator and press Enter when prompted. Rotate to landscape using Simulator's menu and press Enter again. Inspect `.tmp/devices/ipad-portrait.png` and `ipad-landscape.png`: portrait should show the rail/sheet, landscape the split. Web Push is not testable in Simulator.

Install Android SDK command-line tools, platform-tools, emulator, Java, and `system-images;android-35;google_apis;arm64-v8a` first. Then:

```sh
PORT=7781 TOKEN_FILE=/absolute/path/to/scratch/token tools/device-tests/android-avd.sh
```

It reuses the named AVD or creates it with `pixel_tablet`, falling back to `pixel_7` if that profile is unavailable. It targets that emulator only, sets `adb reverse tcp:<port> tcp:<port>`, and opens `http://127.0.0.1:<port>/herdr-relay/` on the emulator. It leaves the emulator running. Wait for the page and press Enter to save `.tmp/devices/android.png`. Inspect Chrome's install prompt and phone navigation when using a phone profile. Set `ANDROID_SDK_ROOT` (or `ANDROID_HOME`) if the SDK is not at `~/Library/Android/sdk`. Both scripts default `TOKEN_FILE` to `$HOME/.herdr/herdr-relay/token`; explicitly set it to a scratch token for this project.

## Syntax checks

Run these from the repository root after installation:

```sh
bash -n tools/device-tests/ios-sim.sh tools/device-tests/android-avd.sh
node --check tools/device-tests/playwright.config.js
node --check tools/device-tests/screens.spec.js
```
