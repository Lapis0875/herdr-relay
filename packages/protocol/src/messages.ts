/**
 * Client ⇄ bridge WebSocket protocol (`/herdr-relay/ws`): JSON text frames discriminated on `t`, plus binary
 * terminal frames `[u32 channel (big-endian)][bytes]` sent only after a `term.size` for that channel.
 *
 * DESIGN.md §5.2 carried forward by DESIGN-v2 §3.4, with:
 * - the `t` discriminator on every text message (PROTOCOL.md, decisions on open items);
 * - bridge `hello` adds `fonts {ui, mono, terminal}` and `hosts [{folder, state, profile?}]` (`profile`: the id of the
 *   policy profile applied to the folder, OSS-PLAN §1);
 * - `toast.action.open` (E11) and the enumerated `ack.error` codes;
 * - additions needed to implement the listed behaviour: `push.sub.id` (the push-service refusal is acked),
 *   `term.size.channel` (maps binary frames to a terminal), `overlay.close` (mods close overlays),
 *   `overlay.modal`, `ack.message` (human-readable detail), typed `event.data` per `kind`;
 * - resume: client `hello.session` (with `since`) names the session to continue, bridge `hello.resumed` says whether
 *   it did; `look` (theme/settings/fonts changed after `hello`), `clipboard` (a mod's `write_to_clipboard`) and `sound`
 *   (a mod's `playSound`, played on the device its call came from);
 * - bridge `hello.compat` (OSS-PLAN §2.3, T46): the running Herdr against the contract herdr-relay pins per version;
 * - client `layout` (set/reset this device's layout profile) and `ScreenGraph.overridden` (the nodes it resizes);
 * - client `push.test` (one test notification to this device's own push subscriptions, acked with what the push
 *   services answered).
 *
 * Invariants (checked by the bridge, not expressible in a schema): `seq` strictly increases across `hello`,
 * `snapshot` and `patch` (a resumed `hello` repeats the client's `since`); a `patch` only names views the client has
 * received `view.tree` for; terminal binary frames only after `term.size`; the bridge never sends mod source; a
 * `scope:"read"` session gets `ack {ok:false, error:"read-only-device"}` for `event` kinds `key`/`input` and for
 * `command`.
 */

import {
  AgentInfoSchema,
  FocusedSchema,
  LayoutNodeSchema,
  PaneInfoSchema,
  SharedSchema,
  SpaceInfoSchema,
  TerminalInfoSchema,
} from "./herdr.ts";
import { JsonPatchSchema } from "./json-patch.ts";
import {
  array,
  boolean,
  decode,
  define,
  enumOf,
  integer,
  jsonObjectRef,
  literal,
  nullable,
  nullValue,
  number,
  object,
  record,
  type Same,
  type Static,
  string,
  tagged,
  union,
  validate,
  type Validation,
} from "./schema.ts";
import { PROFILE_ID_PATTERN } from "./profile.ts";
import { DeviceClassSchema, ScreenGraphSchema, ViewportSchema } from "./screens.ts";
import { ElementNodeSchema } from "./tree.ts";

/** Protocol version carried in both `hello`s. */
export const PROTOCOL_VERSION = 1;

const requestId = () => integer({ minimum: 0, description: "client-chosen; echoed by ack" });
const seq = () => integer({ minimum: 0 });
const nonEmpty = () => string({ minLength: 1 });

// ---------------------------------------------------------------------------------------------------------------------
// Shared shapes.

/** W3C Push API `PushSubscription.toJSON()`; the bridge accepts only the three Web Push services of DESIGN-v2 §1.2. */
export const PushSubscriptionSchema = define("PushSubscription", () =>
  object({
    endpoint: string({ pattern: "^https://" }),
    keys: object({
      p256dh: string({ pattern: "^[A-Za-z0-9_-]+=*$", description: "base64url P-256 public key" }),
      auth: string({ pattern: "^[A-Za-z0-9_-]+=*$", description: "base64url auth secret" }),
    }),
  }, { expirationTime: nullable(number()) }));
export type PushSubscription = Static<typeof PushSubscriptionSchema>;

/** A device's privileges (D3). */
export const ScopeSchema = define("Scope", () => enumOf(["read", "act"]));
export type Scope = Static<typeof ScopeSchema>;

/** Mod host lifecycle (DESIGN-v2 §1.6); `profile` is the policy profile applied to the folder (OSS-PLAN §1). */
export const HOST_STATES = ["starting", "running", "restarting", "failed", "stopped"] as const;
export const HostStatusSchema = define(
  "HostStatus",
  () =>
    object({ folder: nonEmpty(), state: enumOf(HOST_STATES) }, {
      reason: string(),
      profile: string({ pattern: PROFILE_ID_PATTERN }),
    }),
);
export type HostStatus = Static<typeof HostStatusSchema>;

/** `ack.error` codes. */
export const ACK_ERRORS = ["read-only-device", "structural", "refused", "stale-handler", "host-down"] as const;
export type AckError = (typeof ACK_ERRORS)[number];

/** The contract surfaces the bridge compares at start against the pins for the running Herdr (OSS-PLAN §2.3). */
export const COMPAT_SURFACES = ["herdr.d.ts", "gpui-kit.d.ts", "installed.json", "commands"] as const;
export type CompatSurface = (typeof COMPAT_SURFACES)[number];

/** One way the running Herdr differs from the pinned contract; `detail` names files and commands, never paths. */
export const CompatDriftSchema = define(
  "CompatDrift",
  () => object({ surface: enumOf(COMPAT_SURFACES), detail: string({ minLength: 1, maxLength: 500 }) }),
);
export type CompatDrift = Static<typeof CompatDriftSchema>;

/**
 * The running Herdr against the versions herdr-relay was tested with (OSS-PLAN §2.3): `herdrVersion` (null: not
 * known yet), `tested` (a version herdr-relay pins contract files for), `drift` (surfaces that differ from the pins
 * of that version, else of the newest one), `banner` (what the device shows; present when untested or drifted).
 */
export const HelloCompatSchema = define("HelloCompat", () =>
  object({
    herdrVersion: nullable(nonEmpty()),
    tested: boolean(),
    drift: array(CompatDriftSchema, { maxItems: 8 }),
  }, { banner: string({ minLength: 1, maxLength: 300 }) }));
export type HelloCompat = Static<typeof HelloCompatSchema>;

// ---------------------------------------------------------------------------------------------------------------------
// Event payloads (`event.data`), by `kind`. They mirror what the gpui-kit handler receives.

export const ModifiersSchema = define(
  "Modifiers",
  () => object({ shift: boolean(), control: boolean(), alt: boolean(), platform: boolean(), function: boolean() }),
);
export type Modifiers = Static<typeof ModifiersSchema>;

export const PointSchema = define("Point", () => object({ x: number(), y: number() }));
export const BoundsSchema = define(
  "Bounds",
  () => object({ x: number(), y: number(), width: number(), height: number() }),
);

const button = () => enumOf(["left", "right", "middle"]);
const clicks = () => integer({ minimum: 0 });
const rowKey = () => string({ description: "virtual-list row key (on_item_click / on_item_secondary_click)" });

/** `click`: gpui-kit `ClickEvent`; `key` names the row for `on_item_click`. */
export const ClickDataSchema = define(
  "ClickData",
  () => object({ click_count: clicks(), modifiers: ModifiersSchema }, { key: rowKey() }),
);
/** `mousedown`/`mouseup`: gpui-kit `MouseButtonEvent`; `key` names the row for `on_item_secondary_click`. */
export const MouseButtonDataSchema = define("MouseButtonData", () =>
  object(
    { button: button(), click_count: clicks(), position: PointSchema, modifiers: ModifiersSchema },
    { local_position: PointSchema, bounds: BoundsSchema, key: rowKey() },
  ));
/** `mousemove`: gpui-kit `MouseMoveEvent`. */
export const MouseMoveDataSchema = define(
  "MouseMoveData",
  () =>
    object({ position: PointSchema, local_position: PointSchema, bounds: BoundsSchema, modifiers: ModifiersSchema }),
);
/** `hover`: `on_hover(hovered)`. */
export const HoverDataSchema = define("HoverData", () => object({ hovered: boolean() }));
/** `wheel`: gpui-kit `ScrollWheelEvent`. */
export const WheelDataSchema = define("WheelData", () =>
  object({
    delta: PointSchema,
    touch_phase: enumOf(["started", "moved", "ended", "cancelled"]),
    position: PointSchema,
    modifiers: ModifiersSchema,
  }, { delta_lines: PointSchema, local_position: PointSchema, bounds: BoundsSchema }));
/** `key`: gpui-kit `KeyEvent` (`keystroke` spelled as a key binding, platform modifier = `cmd`). */
export const KeyDataSchema = define("KeyData", () =>
  object(
    { key: string(), keystroke: string(), modifiers: ModifiersSchema },
    { key_char: string(), is_held: boolean() },
  ));
/** `size`: `on_size_change({width, height})`, or `on_resize(sizes)` of a resizable group. */
export const SizeDataSchema = define("SizeData", () =>
  union([
    object({ width: number({ minimum: 0 }), height: number({ minimum: 0 }) }),
    object({ sizes: array(number({ minimum: 0 })) }),
  ]));
/**
 * `input`: a value-carrying control. `value` is what the handler receives: the text of an `InputState`/
 * `TextareaState` (with `event` = the state event), `checked` of `on_change`, `open` of `on_open_change`,
 * `"increment"`/`"decrement"` of `on_step`, `null` for `on_confirm`/`on_dismiss`.
 */
export const InputDataSchema = define("InputData", () =>
  object({ value: union([string(), boolean(), nullValue()]) }, {
    event: enumOf(["change", "submit", "focus", "blur", "paste_other", "confirm", "dismiss", "step", "open"]),
    secondary: boolean(),
    shift: boolean(),
  }));
/**
 * `link`: a link activated inside markdown/html whose element has `on.link` (TextView `on_link_click`), which receives
 * `href`. A link without that handler opens on the device, never on the Mac.
 */
export const LinkDataSchema = define("LinkData", () => object({ href: string({ pattern: "^https?://" }) }));

export const EVENT_KINDS = [
  "click",
  "mousedown",
  "mouseup",
  "mousemove",
  "hover",
  "wheel",
  "key",
  "size",
  "input",
  "link",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

// ---------------------------------------------------------------------------------------------------------------------
// Client → bridge.

/**
 * `since` is the highest `seq` the client holds and `session` the bridge `hello.session` it holds it for: together they
 * ask to resume that session (see `BridgeHello.resumed`). Either alone starts a fresh session.
 */
export const ClientHelloSchema = define("ClientHello", () =>
  object({
    t: literal("hello"),
    v: literal(PROTOCOL_VERSION),
    device: nonEmpty(),
    class: DeviceClassSchema,
    viewport: ViewportSchema,
  }, { since: seq(), session: nonEmpty() }));

export const NavSchema = define("Nav", () =>
  object(
    { t: literal("nav"), id: requestId(), action: enumOf(["push", "pop", "select", "replace"]) },
    { route: string({ pattern: "^/" }), stack: nonEmpty(), child: nonEmpty() },
  ));

const eventBase = { t: literal("event"), id: requestId(), view: nonEmpty(), handler: integer({ minimum: 0 }) };

/** A handler invocation; `handler` is an id from the view's current tree (`on`). */
export const ClientEventSchema = define("ClientEvent", () =>
  tagged("kind", [
    object({ ...eventBase, kind: literal("click"), data: ClickDataSchema }),
    object({ ...eventBase, kind: literal("mousedown"), data: MouseButtonDataSchema }),
    object({ ...eventBase, kind: literal("mouseup"), data: MouseButtonDataSchema }),
    object({ ...eventBase, kind: literal("mousemove"), data: MouseMoveDataSchema }),
    object({ ...eventBase, kind: literal("hover"), data: HoverDataSchema }),
    object({ ...eventBase, kind: literal("wheel"), data: WheelDataSchema }),
    object({ ...eventBase, kind: literal("key"), data: KeyDataSchema }),
    object({ ...eventBase, kind: literal("size"), data: SizeDataSchema }),
    object({ ...eventBase, kind: literal("input"), data: InputDataSchema }),
    object({ ...eventBase, kind: literal("link"), data: LinkDataSchema }),
  ]));

/** A keys.json chord or palette entry → `nextCommand()` / `run()`. */
export const CommandSchema = define(
  "Command",
  () => object({ t: literal("command"), id: requestId(), name: nonEmpty() }, { args: jsonObjectRef }),
);

/** Attach to a terminal; binary frames follow on the channel announced by `term.size`. The remote never resizes. */
export const TermOpenSchema = define(
  "TermOpen",
  () => object({ t: literal("term.open"), id: requestId(), terminal: nonEmpty(), mode: enumOf(["observe", "type"]) }),
);

export const TermCloseSchema = define(
  "TermClose",
  () => object({ t: literal("term.close"), id: requestId(), terminal: nonEmpty() }),
);

/** Page visibility; push notifications are muted while a device is visible. */
export const VisibleSchema = define("Visible", () => object({ t: literal("visible"), visible: boolean() }));

export const PushSubSchema = define(
  "PushSub",
  () => object({ t: literal("push.sub"), id: requestId(), subscription: PushSubscriptionSchema }),
);

/**
 * One test notification to this device's own push subscriptions, sent at once even while a device is visible; the ack's
 * `message` says what each push service answered (`sent to 1 subscription (201)`, `no subscription for this device`,
 * `push service answered 403: BadJwtToken`), `ok` = at least one accepted it. At most one per 5 s per device (else
 * `ok:false, error:"refused"`). Allowed on `scope:"read"` devices: it reaches only this device.
 */
export const PushTestSchema = define("PushTest", () => object({ t: literal("push.test"), id: requestId() }));

const layoutBase = { t: literal("layout"), id: requestId() };

/** Most entries one layout `set` changes (a divider drag sets two: a weight pair). */
export const LAYOUT_CHANGES_MAX = 8;

/**
 * One node's change in a layout `set`: its size (`{px}` or `{weight}`, of the node's kind) and/or, for an R2 panel,
 * `collapsed`; at least one of them (the bridge refuses a change with neither).
 */
export const LayoutChangeSchema = define("LayoutChange", () =>
  object({ node: nonEmpty() }, {
    size: union([object({ px: number({ minimum: 0 }) }), object({ weight: number({ minimum: 0 }) })]),
    collapsed: boolean(),
  }));
export type LayoutChange = Static<typeof LayoutChangeSchema>;

/**
 * This device's layout profile (the bridge keeps one per device, layout and device class; never written to the Mac).
 * `set`: 1–{@link LAYOUT_CHANGES_MAX} changes, each to a different node, applied all or none (one ack, one rate-limit
 * unit, one `patch.screens`); a node the device may not resize here (`overridable()`, the graph's `resize`), a size of
 * the other kind, `collapsed` on a node that cannot collapse, a node listed twice or a profile over its cap refuses the
 * whole message (`ok:false, error:"refused"`). `reset`: drop one node's entry (`node`) or, without `node`, every entry
 * of this layout and class. Allowed on `scope:"read"` devices: it changes only this device's view.
 */
export const LayoutMessageSchema = define("LayoutMessage", () =>
  tagged("action", [
    object({
      ...layoutBase,
      action: literal("set"),
      changes: array(LayoutChangeSchema, { minItems: 1, maxItems: LAYOUT_CHANGES_MAX }),
    }),
    object({ ...layoutBase, action: literal("reset") }, { node: nonEmpty() }),
  ]));

/** Every client → bridge text message, discriminated on `t`. */
export const ClientMessageSchema = define("ClientMessage", () =>
  tagged("t", [
    ClientHelloSchema,
    NavSchema,
    ClientEventSchema,
    CommandSchema,
    TermOpenSchema,
    TermCloseSchema,
    VisibleSchema,
    PushSubSchema,
    PushTestSchema,
    LayoutMessageSchema,
  ]));
export type ClientMessage = Static<typeof ClientMessageSchema>;
export type ClientHello = Static<typeof ClientHelloSchema>;
export type Nav = Static<typeof NavSchema>;
export type ClientEvent = Static<typeof ClientEventSchema>;
export type Command = Static<typeof CommandSchema>;
export type TermOpen = Static<typeof TermOpenSchema>;
export type TermClose = Static<typeof TermCloseSchema>;
export type Visible = Static<typeof VisibleSchema>;
export type PushSub = Static<typeof PushSubSchema>;
export type PushTest = Static<typeof PushTestSchema>;
export type LayoutMessage = Static<typeof LayoutMessageSchema>;

export const CLIENT_MESSAGE_TYPES = [
  "hello",
  "nav",
  "event",
  "command",
  "term.open",
  "term.close",
  "visible",
  "push.sub",
  "push.test",
  "layout",
] as const;
const _clientTypesComplete: Same<(typeof CLIENT_MESSAGE_TYPES)[number], ClientMessage["t"]> = true;

// ---------------------------------------------------------------------------------------------------------------------
// Bridge → client.

/** CSS font-family lists the client uses (D10). */
export const FontsSchema = define("Fonts", () => object({ ui: nonEmpty(), mono: nonEmpty(), terminal: nonEmpty() }));
export type Fonts = Static<typeof FontsSchema>;

const theme = () => record(string(), { description: "theme colour name → #rrggbb[aa]" });

/**
 * `resumed: true` answers a client `hello {session, since}` whose session continues: `seq` repeats `since`, the
 * messages sent after it follow (patches, view trees, overlays) and the client keeps what it holds. Otherwise (absent
 * or false) the client drops its views, overlays and live state; a `snapshot` and the `view.tree`s follow. `compat`
 * ({@link HelloCompatSchema}) is absent only while the bridge has not checked the running Herdr.
 */
export const BridgeHelloSchema = define("BridgeHello", () =>
  object({
    t: literal("hello"),
    v: literal(PROTOCOL_VERSION),
    seq: seq(),
    session: nonEmpty(),
    layout: object({ name: nonEmpty(), tree: LayoutNodeSchema }),
    screens: ScreenGraphSchema,
    theme: theme(),
    settings: jsonObjectRef,
    fonts: FontsSchema,
    scope: ScopeSchema,
    hosts: array(HostStatusSchema),
  }, { resumed: boolean(), compat: HelloCompatSchema }));

/** Full live state; replaces everything the client holds outside view trees. */
export const SnapshotSchema = define("Snapshot", () =>
  object({
    t: literal("snapshot"),
    seq: seq(),
    spaces: array(SpaceInfoSchema),
    agents: array(AgentInfoSchema),
    terminals: array(TerminalInfoSchema),
    panes: array(PaneInfoSchema),
    focused: nullable(FocusedSchema),
    shared: SharedSchema,
  }));

/** Incremental update: view-tree ops, state ops (against the snapshot object), or a new ScreenGraph. */
export const PatchSchema = define("Patch", () =>
  object({
    t: literal("patch"),
    seq: seq(),
    views: array(object({ view: nonEmpty(), ops: JsonPatchSchema })),
  }, { state: JsonPatchSchema, screens: ScreenGraphSchema }));

/** First render of a view (and every re-render after a host restart). */
export const ViewTreeSchema = define(
  "ViewTree",
  () => object({ t: literal("view.tree"), view: nonEmpty(), tree: ElementNodeSchema }),
);

/** A mod opened an overlay (`openOverlay`); `view` renders its content. */
export const OverlaySchema = define("Overlay", () =>
  object({
    t: literal("overlay"),
    id: nonEmpty(),
    kind: enumOf(["dialog", "popup", "window"]),
    view: nonEmpty(),
  }, {
    at: union([literal("pointer"), object({ x: number(), y: number() })]),
    width: number({ exclusiveMinimum: 0, description: "px, or up to 1: a share of the window" }),
    height: number({ exclusiveMinimum: 0, description: "px, or up to 1: a share of the window" }),
    frame: literal("none"),
    modal: boolean(),
  }));

/** An overlay closed (`closeOverlay`, its host stopped, or its layout switched away). */
export const OverlayCloseSchema = define("OverlayClose", () => object({ t: literal("overlay.close"), id: nonEmpty() }));

/** The outcome of a request carrying `id`. */
export const AckSchema = define(
  "Ack",
  () => object({ t: literal("ack"), id: requestId(), ok: boolean() }, { error: enumOf(ACK_ERRORS), message: string() }),
);

/** A notification for this device; `action.open` (E11) opens a URL on the device. */
export const ToastSchema = define("Toast", () =>
  object({ t: literal("toast"), title: string() }, {
    body: string(),
    level: enumOf(["info", "success", "warning", "error"]),
    action: union([
      object({ name: nonEmpty() }, { args: jsonObjectRef }),
      object({ open: string({ pattern: "^https?://" }) }),
    ]),
  }));

/** Terminal geometry (the Mac's; D4) and the binary channel its frames use from now on. */
export const TermSizeSchema = define("TermSize", () =>
  object({
    t: literal("term.size"),
    terminal: nonEmpty(),
    channel: integer({ minimum: 0, maximum: 4294967295 }),
    cols: integer({ minimum: 1 }),
    rows: integer({ minimum: 1 }),
  }));

/** The bridge lost its state (core reconnect, restart): drop everything and wait for `hello`. */
export const ResetSchema = define("Reset", () => object({ t: literal("reset") }));

/** The Mac's theme, settings or fonts changed after `hello`: the new values of those `hello` fields. */
export const LookSchema = define(
  "Look",
  () => object({ t: literal("look"), theme: theme(), settings: jsonObjectRef, fonts: FontsSchema }),
);

/**
 * A mod's `write_to_clipboard(text)` for this device. Browsers write the clipboard only during a user gesture, so the
 * client offers the text (a toast with a Copy action) instead of writing it on arrival.
 */
export const ClipboardTextSchema = define(
  "ClipboardText",
  () => object({ t: literal("clipboard"), text: string() }),
);

/** A mod's own sound file, as the client writes asset URLs: `assets/mods/<folder>/…`, segments URL-encoded. */
export const SOUND_SRC_PATTERN = "^assets/mods/(?:(?!\\.\\.?/)[^/?#\\\\]+/)+(?!\\.\\.?$)[^/?#\\\\]+$";

/**
 * A mod's `playSound(path)` for this device only (the device whose event or command the call came from). `src` is the
 * sound's asset URL relative to the app's mount, as image URLs are (`assets/mods/win98/sounds/ding.mp3`); the bridge
 * sends only files its asset policy serves (`mods/**\/*.mp3|wav|ogg`).
 */
export const SoundSchema = define(
  "Sound",
  () => object({ t: literal("sound"), src: string({ pattern: SOUND_SRC_PATTERN }) }),
);

/** Every bridge → client text message, discriminated on `t`. */
export const BridgeMessageSchema = define("BridgeMessage", () =>
  tagged("t", [
    BridgeHelloSchema,
    SnapshotSchema,
    PatchSchema,
    ViewTreeSchema,
    OverlaySchema,
    OverlayCloseSchema,
    AckSchema,
    ToastSchema,
    TermSizeSchema,
    ResetSchema,
    LookSchema,
    ClipboardTextSchema,
    SoundSchema,
  ]));
export type BridgeMessage = Static<typeof BridgeMessageSchema>;
export type BridgeHello = Static<typeof BridgeHelloSchema>;
export type Snapshot = Static<typeof SnapshotSchema>;
export type Patch = Static<typeof PatchSchema>;
export type ViewTree = Static<typeof ViewTreeSchema>;
export type Overlay = Static<typeof OverlaySchema>;
export type OverlayClose = Static<typeof OverlayCloseSchema>;
export type Ack = Static<typeof AckSchema>;
export type Toast = Static<typeof ToastSchema>;
export type TermSize = Static<typeof TermSizeSchema>;
export type Reset = Static<typeof ResetSchema>;
export type Look = Static<typeof LookSchema>;
/** Named apart from the DOM's `Clipboard`. */
export type ClipboardText = Static<typeof ClipboardTextSchema>;
export type Sound = Static<typeof SoundSchema>;

export const BRIDGE_MESSAGE_TYPES = [
  "hello",
  "snapshot",
  "patch",
  "view.tree",
  "overlay",
  "overlay.close",
  "ack",
  "toast",
  "term.size",
  "reset",
  "look",
  "clipboard",
  "sound",
] as const;
const _bridgeTypesComplete: Same<(typeof BRIDGE_MESSAGE_TYPES)[number], BridgeMessage["t"]> = true;

// ---------------------------------------------------------------------------------------------------------------------
// Parsing.

/** Validates a parsed client message. */
export const parseClientMessage = (value: unknown): Validation<ClientMessage> => validate(ClientMessageSchema, value);
/** Parses and validates one client text frame. */
export const decodeClientMessage = (text: string): Validation<ClientMessage> => decode(ClientMessageSchema, text);
/** Validates a parsed bridge message. */
export const parseBridgeMessage = (value: unknown): Validation<BridgeMessage> => validate(BridgeMessageSchema, value);
/** Parses and validates one bridge text frame. */
export const decodeBridgeMessage = (text: string): Validation<BridgeMessage> => decode(BridgeMessageSchema, text);

/** Encodes a terminal binary frame: `[u32 channel, big-endian][bytes]`. */
export function encodeTerminalFrame(channel: number, bytes: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + bytes.length);
  new DataView(frame.buffer).setUint32(0, channel, false);
  frame.set(bytes, 4);
  return frame;
}

/** Splits a terminal binary frame into its channel and payload (a view, not a copy). */
export function decodeTerminalFrame(frame: Uint8Array): { channel: number; bytes: Uint8Array } {
  if (frame.length < 4) throw new RangeError(`terminal frame of ${frame.length} bytes has no channel header`);
  return {
    channel: new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false),
    bytes: frame.subarray(4),
  };
}
