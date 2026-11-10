// herdr-relay-mirror: tells the herdr-relay bridge on this Mac what this Herdr window shows, so phones and
// tablets look and behave like it. It draws nothing: place it as a floating block (see RECIPE.md).
//
// What it sends: the values of theme(), settings(), fonts(), layout(), focused(), panes(), updates(),
// window(), commands(), keys() and every shared() key, plus `relayMod` (this build's version), as one JSON
// POST to http://127.0.0.1:<port>/herdr-relay/mirror with `Authorization: Bearer <token>`.
// - <port>: `~/.herdr/herdr-relay/mirror-endpoint.json` `{ port }`, written by the bridge while it runs.
//   No file: the bridge is not running, nothing is sent.
// - <token>: `~/.herdr/herdr-relay/token`, the bridge's loopback token. No file: nothing is sent.
// - shared keys: the ones in `shared.json` (and `layout`), each read live with shared(key).
// When: Herdr re-renders this copy on every live change; a burst becomes one POST 250 ms later, and only
// when the snapshot changed. Every 10 s it re-sends an unchanged snapshot older than 5 s, so the bridge
// knows the window is still there (it marks the mirror stale after 30 s without one).

import { div, View } from "gpui-kit";
import {
  appHome,
  commands,
  focused,
  fonts,
  home,
  keys,
  layout,
  panes,
  readTextFile,
  settings,
  shared,
  theme,
  updates,
  window,
} from "herdr";

/** This build; keep equal to mod.json's "version". */
const RELAY_MOD = "0.1.0";
const DEBOUNCE_MS = 250;
const HEARTBEAT_MS = 10_000;
/** A POST the bridge has not answered by then is abandoned (fetch has no timeout of its own). */
const POST_TIMEOUT_MS = 5_000;

export default class HerdrRelayMirror extends View {
  init(_props, cx) {
    this.soon = null; // the debounce timer, while one is pending
    this.busy = false; // a POST is in flight
    this.again = false; // something changed while it was
    this.sent = ""; // the body the bridge last accepted
    this.sentAt = 0;
    this.sharedKeys = ["layout"];
    cx.timer.every(HEARTBEAT_MS, (cx) => this.flush(cx, true));
    this.flush(cx, false);
  }

  render(cx) {
    if (!this.soon) {
      this.soon = cx.timer.after(DEBOUNCE_MS, (cx) => {
        this.soon = null;
        this.flush(cx, false);
      });
    }
    return div();
  }

  flush(cx, beat) {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.post(cx, beat);
      } catch (_) {
        // The bridge is down, slow or refused it: the next change or heartbeat tries again.
      } finally {
        this.busy = false;
        if (this.again) {
          this.again = false;
          this.flush(cx, false);
        }
      }
    });
  }

  async post(cx, beat) {
    const state = `${home()}/.herdr/herdr-relay`;
    const port = endpointPort(await readText(`${state}/mirror-endpoint.json`));
    const token = (await readText(`${state}/token`))?.trim();
    if (!port || !token) return;
    this.sharedKeys = sharedKeys(await readText(`${appHome()}/shared.json`), this.sharedKeys);
    const body = JSON.stringify(snapshot(this.sharedKeys));
    if (body === this.sent && !(beat && Date.now() - this.sentAt >= HEARTBEAT_MS / 2)) return;
    const res = await Promise.race([
      fetch(`http://127.0.0.1:${port}/herdr-relay/mirror`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      }),
      cx.sleep(POST_TIMEOUT_MS).then(() => null),
    ]);
    if (res?.ok) {
      this.sent = body;
      this.sentAt = Date.now();
    }
  }
}

/** The snapshot: each value as Herdr returns it; one that throws or is null (no window yet) is left out. */
function snapshot(sharedKeys) {
  const out = { relayMod: RELAY_MOD };
  const take = (name, read) => {
    try {
      const value = read();
      if (value !== null && value !== undefined) out[name] = value;
    } catch (_) {
      // Not available in this Herdr: left out.
    }
  };
  take("theme", theme);
  take("settings", settings);
  take("fonts", fonts);
  take("layout", layout);
  take("panes", panes);
  take("updates", updates);
  take("window", window);
  take("commands", commands);
  take("keys", keys);
  try {
    out.focused = focused() ?? null;
  } catch (_) {
    // Left out.
  }
  const all = {};
  for (const key of sharedKeys) {
    try {
      const value = shared(key);
      if (value !== undefined) all[key] = value;
    } catch (_) {
      // Left out.
    }
  }
  out.shared = all;
  return out;
}

/** The keys `shared.json` holds, plus `layout`; the previous list when the file can't be read. */
function sharedKeys(text, previous) {
  if (text === null) return previous;
  try {
    const map = JSON.parse(text);
    if (map === null || typeof map !== "object" || Array.isArray(map)) return previous;
    return [...new Set(["layout", ...Object.keys(map)])];
  } catch (_) {
    return previous;
  }
}

/** The bridge's port from `mirror-endpoint.json`, or null. */
function endpointPort(text) {
  if (text === null) return null;
  try {
    const port = JSON.parse(text)?.port;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch (_) {
    return null;
  }
}

/** A file's text, or null when it is missing or unreadable. */
async function readText(path) {
  try {
    return await readTextFile(path);
  } catch (_) {
    return null;
  }
}
