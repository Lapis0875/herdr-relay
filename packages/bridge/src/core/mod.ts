/**
 * herdr-core client (T03): `hc connect` child, JSON-RPC 2.0 with generation-1 frames, the read-only method set plus
 * `terminal.attach` observe/type, a mirrored terminal list from `events.subscribe`, and reconnect + `reset`.
 *
 * Use {@link CoreClient}. The frame codec and {@link CoreTransport} are exported for in-process fake cores (T21).
 */

export {
  type AttachOptions,
  CoreClient,
  type CoreClientEvent,
  type CoreClientListener,
  type CoreClientOptions,
  type CoreClientState,
  type CoreResetReason,
  type CoreSession,
  DEFAULT_BACKOFF_MS,
} from "./client.ts";
export {
  type AttachMode,
  type CoreStreamEnd,
  DEFAULT_CALL_TIMEOUT_MS,
  MAX_INPUT_BYTES,
  MAX_PENDING_CALLS,
  MAX_QUEUED_BYTES,
  type TerminalStream,
} from "./connection.ts";
export { type CoreClientErrorKind, CoreError } from "./errors.ts";
export {
  CONTROL_CHANNEL,
  decodeResize,
  encodeCredit,
  encodeFrame,
  FRAME,
  FRAME_HEADER_BYTES,
  type FrameHandler,
  type FrameKind,
  FrameReader,
  LineReader,
  MAX_FRAME,
  MAX_LINE,
} from "./frames.ts";
export {
  type CoreTransport,
  type CoreTransportFactory,
  HC_CONNECT_ENV_KEYS,
  hcConnectEnv,
  type HcConnectOptions,
  spawnHcConnect,
} from "./transport.ts";
export * from "./types.ts";
