# Implementation amendments — candidate herdr-relay-c1, wave 3 (T08, T11, T11b, T21, T25)

Main-owned. Where these differ from DESIGN-v2 and earlier amendments, these and the code win.

## View manager (T08, `packages/bridge/src/views/`)
- **Lead session:** mod hosts render with the `layout()`/`focused()` of the device session that acted last (one host serves every device). Other devices keep their own navigation but see the lead's layout inside mod views. Accepted for v1.
  - *Superseded in part (wave 4, "iPad real-device fixes" §2, `e6aa387`):* hosts also read the lead's own selection, focus and zoom flags in `spaces()`/`panes()`/`agents()` (`active` space and tabs, `focused` pane and agent, `zoomed`), where they read the Mac's before, and each device's `snapshot` carries its own view. Other devices therefore see the lead's selection, not only its layout, inside mod views. The text above is kept as decided in wave 3.
- Copies start the first time any session shows them and live while the Mac layout keeps the block (Herdr semantics); hosts keep running after devices disconnect (supervisor stops a folder's host 30 s after its last copy closes).
- A device only receives trees/patches for views on its own screen; a view shown again after falling behind gets a fresh `view.tree`.
- `run()` with no origin may only change the lead session (session commands only); stale/forged origins are ignored.
- Overlay ids are `overlay-<own folder>-<n>`; any mod may close one by id. Windows that hold a `layout` are refused with a toast; `mod.open` opens a plain dialog without `mod.json` sizes.
- `HerdrData` (views/data.ts) is the frozen seam implemented by T09.
- Measured: 26/26 lstack copies (24 blocks + 2 pane headers) render in 684–816 ms; activity click → ack 3 ms, `patch.screens` 24 ms, view patch 44 ms; host restart → fresh `view.tree` ≈ 150 ms, old handler ids → `ack stale-handler`.
- Follow-ups in progress (T08b): control `event.n` render number, `look`/`clipboard` bridge messages, `hello.since` patch ring.

## Terminal relay + push (T11, T11b)
- VAPID key route is `GET /herdr-relay/push/key` (the server owns every `/api/*` path).
- Typing uses a short-lived type attach (opened on the first key, closed after 2 s idle or any size change). Residual risk: a race attach sent at a stale size may already resize the Mac terminal before the relay closes it; the T03 API reads the size then attaches.
- Backpressure detaches a slow terminal at 1 MiB queued (2 MiB hard cap) and re-attaches after drain; the byte stream is never cut mid-frame. A RESIZE at the same size is not re-announced.
- Push alerts: `working→blocked` "Needs you", `working→done` / `working→idle` "Finished", `working→error` "Failed" (status message in body), once per `(address, turn)`; `done→idle` never re-alerts; muted while any device is visible; missed transitions after reconnect fire once; 410 removes the subscription; endpoints limited to the three push hosts. RFC 8291 Appendix A vector verified; `vapid.json`/`push.json` mode 0600.

## Tests (T21, T25)
- Core tests use a committed test-only executable `packages/bridge/test/unit/core/fake-hc` (no write permission needed, cannot launch the real `hc`). Workspace `test` task now allows env `PATH,HC_SOCKET` and `--allow-run=./packages/bridge/test/unit/core/fake-hc`.
- Server tests use `node:http` for tailnet cases because Deno `fetch` rewrites an explicit `Host` header to the URL authority.

## Integration evidence (Main)
- `deno check packages/protocol packages/bridge`: ok. Tests (protocol + bridge): 91 passed / 0 failed. Main ran `deno fmt` on four TW test files (mechanical).
