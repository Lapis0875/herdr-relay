/** The bridge's HTTP + WebSocket server (DESIGN-v2 T10). Authentication lives in `../auth`. */

export {
  type ConnectionOptions,
  HELLO_TIMEOUT_MS,
  MAX_TEXT_FRAME,
  type RequestMessage,
  type SessionConnection,
  type SessionHandler,
  WsConnection,
} from "./connection.ts";
export { BodyError, json, readJsonObject, routePath, secured, SECURITY_HEADERS, text } from "./http.ts";
export { type BridgeServer, type Route, type RouteContext, type ServerOptions, startServer } from "./server.ts";
export { serveShell } from "./shell.ts";
