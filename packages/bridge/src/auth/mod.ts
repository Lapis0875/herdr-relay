/**
 * Authentication (DESIGN.md §4, DESIGN-v2 T10): the Tailscale identity gate with tailscaled peer check, the loopback
 * token, device pairing (codes, devices.json, cookies), one-time WebSocket tickets, `read`/`act` scope enforcement,
 * and the `tailscale serve` helper.
 */

export { Auth, type AuthLevel, type AuthOptions, type AuthResult, type Identity } from "./auth.ts";
export { DEVICE_COOKIE, deviceCookie, readCookie } from "./cookie.ts";
export {
  cleanDeviceName,
  type DeviceIdentity,
  type DeviceRecord,
  DEVICES_FILE,
  DeviceStore,
  DeviceStoreError,
  deviceView,
  LOCAL_DEVICE,
} from "./devices.ts";
export { type Access, CUSTOM_HEADER, gate, type GateConfig, type GatePass, type GateRequest } from "./gate.ts";
export { newPairingCode, PAIRING_MAX_FAILURES, PAIRING_TTL_MS, PairingCodes, type PairingGrant } from "./pairing.ts";
export {
  type CommandRun,
  darwinPids,
  LSOF,
  lsofOwners,
  NETSTAT,
  PeerCheck,
  PROC_NET_TCP,
  procOwners,
  type ProcSocket,
  procSockets,
  PS,
  readText,
  runCommand,
  type TextRead,
} from "./peer.ts";
export { scopeRefusal } from "./scope.ts";
export { sameSecret, sha256Hex } from "./secret.ts";
export {
  parseServeStatus,
  parseStatus,
  planServe,
  proxyFor,
  serve,
  type ServeOutcome,
  type ServePlan,
  type ServeState,
  type TailnetIdentity,
  type TailscaleRun,
  tailscaleRunner,
  whoami,
} from "./tailscale.ts";
export { TICKET_TTL_MS, TicketBook, type TicketGrant, type Via } from "./tickets.ts";
export { ensureStateDir, ensureToken, readToken, TOKEN_FILE } from "./token.ts";
