/**
 * Errors of the herdr-core client. `kind` is either one of the client's own kinds below or the stable `data.kind`
 * herdr-core puts on its JSON-RPC errors (`not_found`, `finished`, `needs_framed`, `machine_unknown`, …; `hc schema`).
 */

/** Kinds the client itself raises. */
export type CoreClientErrorKind =
  /** `hc connect` could not be started, or no connection came up within the call's timeout. */
  | "unavailable"
  /** The connection ended (child exited, stream closed, write failed); in-flight calls are never retried. */
  | "disconnected"
  /** The core speaks another generation, is older than the minimum, or lacks a required method or framing. */
  | "incompatible"
  /** The core sent something the generation-1 protocol does not allow (bad frame, oversized frame, bad JSON). */
  | "protocol"
  /** A call got no answer in time; its effect (if any) is unknown. */
  | "timeout"
  /** Too many calls in flight on one connection. */
  | "busy"
  /** The core does not read fast enough; the write queue overflowed and the connection was dropped. */
  | "slow"
  /** The client was closed by its owner. */
  | "closed"
  /** The bridge itself refuses the request (method outside the read-only allowlist, typing on an observe stream). */
  | "refused";

export class CoreError extends Error {
  override readonly name = "CoreError";
  /** A {@link CoreClientErrorKind} or a herdr-core `data.kind`. */
  readonly kind: CoreClientErrorKind | (string & Record<never, never>);
  /** JSON-RPC error code, when the core answered with an error. */
  readonly code?: number;
  /** herdr-core's `data.hint`, when it gave one. */
  readonly hint?: string;

  constructor(
    kind: CoreClientErrorKind | (string & Record<never, never>),
    message: string,
    options: { code?: number; hint?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    if (options.code !== undefined) this.code = options.code;
    if (options.hint !== undefined) this.hint = options.hint;
  }
}

/** The message of any thrown value. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
