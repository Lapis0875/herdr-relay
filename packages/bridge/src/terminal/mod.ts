/**
 * Terminal relay (DESIGN-v2 T11): `term.open`/`term.close` and typed binary frames from device sockets, relayed to
 * herdr-core `terminal.attach` streams — observe for display, short-lived `type` attaches for `act` devices, never a
 * resize (D4). Use {@link TerminalRelay}.
 */

export {
  ATTACH_TIMEOUT_MS,
  DRAIN_POLL_MS,
  MAX_BUFFERED_BYTES,
  MAX_PENDING_PER_SOCKET,
  MAX_TERMINALS_PER_SOCKET,
  type RelayCore,
  RESUME_BUFFERED_BYTES,
  TerminalRelay,
  type TerminalRelayOptions,
  TYPE_IDLE_MS,
} from "./relay.ts";
