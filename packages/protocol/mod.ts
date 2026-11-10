/**
 * @herdr-relay/protocol — the shared contract of herdr-relay (DESIGN-v2 §3.4): client ⇄ bridge WebSocket messages,
 * the bridge ⇄ mod host control channel, element trees, the GPUI style parser, ScreenGraph and device classes, Herdr
 * data shapes, policy log records, their JSON Schemas and runtime validators. Runtime-dependency-free; imports only
 * its own files, so the mod host's tests can import it by relative path.
 */

export {
  assertValid,
  decode,
  definition,
  type DefinitionResolver,
  is,
  type JsonObject,
  jsonPointer,
  type JsonValue,
  ProtocolError,
  type Schema,
  type Static,
  validate,
  validateJson,
  type Validation,
  type ValidationError,
} from "./src/schema.ts";
export * from "./src/gpui-style.ts";
export * from "./src/tree.ts";
export * from "./src/screens.ts";
export * from "./src/recompose.ts";
export * from "./src/herdr.ts";
export * from "./src/json-patch.ts";
export * from "./src/messages.ts";
export * from "./src/control.ts";
export * from "./src/policy-log.ts";
export * from "./src/profile.ts";
export * from "./src/documents.ts";
