/**
 * The JSON Schema documents committed under `packages/protocol/schema/` (regenerate with `deno task schema` in
 * `packages/protocol`; a test fails when the committed files differ from these).
 */

import { BridgeToHostSchema, HostStateSchema, HostToBridgeSchema, PlacementSchema } from "./control.ts";
import { StyleSchema } from "./gpui-style.ts";
import { JsonPatchSchema } from "./json-patch.ts";
import { BridgeMessageSchema, ClientMessageSchema, PushSubscriptionSchema } from "./messages.ts";
import { PolicyLogRecordSchema } from "./policy-log.ts";
import { PolicyProfileFileSchema } from "./profile.ts";
import { ClickStateSchema } from "./recompose.ts";
import { type JsonObject, type Schema, schemaDocument } from "./schema.ts";
import { ScreenGraphSchema } from "./screens.ts";
import { ElementTreeSchema, RecordedTreeSchema } from "./tree.ts";

/** File name → title and root schema. */
export const SCHEMA_FILES: Readonly<Record<string, { title: string; schema: Schema<unknown> }>> = {
  "client-message.schema.json": { title: "Client → bridge WebSocket text message", schema: ClientMessageSchema },
  "bridge-message.schema.json": { title: "Bridge → client WebSocket text message", schema: BridgeMessageSchema },
  "control-bridge-to-host.schema.json": { title: "Bridge → mod host control line", schema: BridgeToHostSchema },
  "control-host-to-bridge.schema.json": { title: "Mod host → bridge control line", schema: HostToBridgeSchema },
  "element-tree.schema.json": { title: "ElementTree (client render tree)", schema: ElementTreeSchema },
  "recorded-tree.schema.json": { title: "RecordedTree (mod host render record)", schema: RecordedTreeSchema },
  "screen-graph.schema.json": { title: "ScreenGraph (recomposed layout)", schema: ScreenGraphSchema },
  "host-state.schema.json": { title: "HostState (per-folder herdr snapshot)", schema: HostStateSchema },
  "placement.schema.json": { title: "Placement (floating copy position)", schema: PlacementSchema },
  "style.schema.json": { title: "Style (CSS declarations)", schema: StyleSchema },
  "json-patch.schema.json": { title: "JSON Patch (RFC 6902)", schema: JsonPatchSchema },
  "push-subscription.schema.json": { title: "PushSubscription (W3C Push API)", schema: PushSubscriptionSchema },
  "policy-log-record.schema.json": { title: "Policy decision log record", schema: PolicyLogRecordSchema },
  "policy-profile.schema.json": {
    title: "Policy profile file (one profile or a list)",
    schema: PolicyProfileFileSchema,
  },
  "click-state.schema.json": { title: "ClickState (layouts/.state/<name>.json)", schema: ClickStateSchema },
};

/** Every schema document, by file name. */
export function schemaDocuments(): Record<string, JsonObject> {
  return Object.fromEntries(
    Object.entries(SCHEMA_FILES).map(([file, { title, schema }]) => [
      file,
      schemaDocument(file.replace(/\.schema\.json$/, ""), title, schema),
    ]),
  );
}
