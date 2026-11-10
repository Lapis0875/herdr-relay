/**
 * Mod overlays (AGENTS.md "Overlays"): `openOverlay({mod, props, kind, width, height, at, frame, key})` from a host, or
 * `mod.open {name}` from a session, becomes one overlay copy `<mod>:overlay:<id>` whose `props()` carry `overlay: id`,
 * and an `overlay` message to the devices that show it. The id is the one the mod's `openOverlay()` returned
 * (`overlay-<folder>-<n>`): a host may only open overlays under its own folder's prefix (trust rule), and anyone may
 * close one by id (`closeOverlay`, as in Herdr).
 *
 * Not available remotely, refused with a toast: windows that hold a `layout` (terminals inside an overlay), and mods
 * whose policy profile says `overlay: "host-only"` (OSS-PLAN §1: their purpose is a change only the Herdr window
 * makes, e.g. `machine-add`); no copy of those is created, so nothing of theirs runs.
 */

import {
  FOLDER_PATTERN,
  is,
  type JsonObject,
  type JsonValue,
  type Overlay,
  OverlaySchema,
  type PROFILE_OVERLAYS,
} from "@herdr-relay/protocol";

export type OverlayKind = Overlay["kind"];

/** Where a mod's overlays may open (its policy profile's `overlay`): on devices, or only in the Herdr window. */
export type OverlayPlacement = (typeof PROFILE_OVERLAYS)[number];

/** A parsed `openOverlay` spec. */
export interface OverlaySpec {
  mod: string;
  props: JsonObject;
  kind: OverlayKind;
  /** `key: "name"` of a window: opening that key again replaces it. */
  key?: string;
  /** The `overlay` message fields other than `t`, `id`, `kind` and `view`. */
  place: Pick<Overlay, "at" | "width" | "height" | "frame" | "modal">;
}

const FOLDER = new RegExp(FOLDER_PATTERN, "u");
const KINDS: Record<string, OverlayKind> = { dialog: "dialog", popup: "popup", window: "window" };

const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);

/** The id a host's `openOverlay()` mints (`overlay-<folder>-<n>`, modhost `localId`); anything else is refused. */
export function hostOverlayIdOk(id: string, folder: string): boolean {
  const prefix = `overlay-${folder}-`;
  return id.startsWith(prefix) && /^[0-9]+$/.test(id.slice(prefix.length));
}

/**
 * Parses an `openOverlay` spec; a string is the reason it is refused (shown as a toast). `placement` gives a mod
 * folder's {@link OverlayPlacement} (absent: every mod opens on devices).
 */
export function parseOverlaySpec(
  spec: JsonValue,
  placement?: (mod: string) => OverlayPlacement,
): OverlaySpec | string {
  if (!isObject(spec)) return "openOverlay needs an object";
  if (spec.layout !== undefined) return "windows that hold a layout are not available remotely";
  if (typeof spec.mod !== "string" || !FOLDER.test(spec.mod)) return "openOverlay needs a mod folder name";
  if (placement?.(spec.mod) === "host-only") return `${spec.mod} opens only in the Herdr window`;
  const kind = spec.kind === undefined ? "dialog" : (typeof spec.kind === "string" ? KINDS[spec.kind] : undefined);
  if (kind === undefined) return `unknown overlay kind ${JSON.stringify(spec.kind)}`;
  const place: OverlaySpec["place"] = {};
  if (spec.at === "pointer") place.at = "pointer";
  else if (isObject(spec.at) && typeof spec.at.x === "number" && typeof spec.at.y === "number") {
    place.at = { x: spec.at.x, y: spec.at.y };
  }
  if (typeof spec.width === "number" && spec.width > 0) place.width = spec.width;
  if (typeof spec.height === "number" && spec.height > 0) place.height = spec.height;
  if (spec.frame === "none") place.frame = "none";
  if (typeof spec.modal === "boolean") place.modal = spec.modal;
  const out: OverlaySpec = { mod: spec.mod, props: isObject(spec.props) ? spec.props : {}, kind, place };
  if (typeof spec.key === "string" && spec.key !== "") out.key = spec.key;
  return out;
}

/** The `overlay` message for one overlay (validated, so a bad size or position never reaches a device). */
export function overlayMessage(id: string, view: string, spec: OverlaySpec): Overlay | null {
  const msg: Overlay = { t: "overlay", id, kind: spec.kind, view, ...spec.place };
  return is(OverlaySchema, msg) ? msg : null;
}
