/**
 * Device scope enforcement (D3, PROTOCOL.md invariants): a `read` device views, navigates and observes terminals; it
 * may not type or act. The WebSocket layer refuses, before anything else sees them, `event` kinds `key`/`input`,
 * `term.open` in `type` mode, and every `command` whose name is not `session`-class in `policy/commands.json`, with
 * `ack {ok:false, error:"read-only-device"}`; binary (typed) frames from a `read` device are dropped.
 *
 * `session` commands (navigation, focus, peek, device-local overlays) only change the device's own session and never
 * reach the Mac, so a `read` device may send them (a notification tap sends `pane.focus`/`agent.focus`). A keys.json
 * shorthand `<name>:<value>` counts by its `<name>`; `Session.run` resolves it with Herdr's live command list and still
 * refuses anything that does not end up `session`-class for a `read` session. Calls a mod makes for a `read` session
 * (`run`, git commits…) are refused downstream by the session/policy layers using the same scope.
 */

import type { Ack, ClientMessage, Scope } from "@herdr-relay/protocol";
import { classifyCommand } from "../session/commands.ts";

/** The refusal for `msg` from a device with `scope`, or `null` when the scope allows it. */
export function scopeRefusal(scope: Scope, msg: ClientMessage): Ack | null {
  if (scope === "act") return null;
  let id: number;
  switch (msg.t) {
    case "event":
      if (msg.kind !== "key" && msg.kind !== "input") return null;
      id = msg.id;
      break;
    case "command": {
      // `session` class never depends on loaded mod folders: Herdr's own table wins over mod prefixes.
      const colon = msg.name.indexOf(":");
      const head = colon > 0 ? msg.name.slice(0, colon) : msg.name;
      if (classifyCommand(msg.name).class === "session" || classifyCommand(head).class === "session") return null;
      id = msg.id;
      break;
    }
    case "term.open":
      if (msg.mode !== "type") return null;
      id = msg.id;
      break;
    default:
      return null;
  }
  return { t: "ack", id, ok: false, error: "read-only-device", message: "read-only device" };
}
