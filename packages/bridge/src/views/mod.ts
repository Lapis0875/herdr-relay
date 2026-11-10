/**
 * The view manager (DESIGN-v2 §4 T08): device sessions, mod copies per block/overlay/pane header, trees → `view.tree`
 * and `patch`, handler ids, `run()`/`nextCommand` routing, overlays, origins. `HerdrData` is the contract the `herdr`
 * implementation (T09) fulfils.
 */

export {
  type CopySpec,
  floatingPlacement,
  layoutBlocks,
  paneCopy,
  paneHeaderFolders,
  type Shown,
  shownCopies,
} from "./copies.ts";
export type { ClientLook, HerdrChange, HerdrData, MacLayout, ResolvedOrigin, SnapshotState } from "./data.ts";
export { diffJson, jsonEqual } from "./diff.ts";
export { bindHandlers, type EventArgs, eventArgs, type HandlerEntry } from "./handlers.ts";
export {
  FLUSH_MS,
  type HostPort,
  type HostWiring,
  RESUME_GRACE_MS,
  RESUME_RING,
  REVOKED_CLOSE,
  ViewManager,
  type ViewManagerOptions,
} from "./manager.ts";
export { ORIGIN_TTL_MS, type OriginCheck, OriginTokens } from "./origins.ts";
export { hostOverlayIdOk, type OverlayKind, overlayMessage, type OverlaySpec, parseOverlaySpec } from "./overlays.ts";
export { type PathRoot, PathStripper, STRIPPED_MAX } from "./strip.ts";
