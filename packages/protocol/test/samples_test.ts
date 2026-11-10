// Every valid sample under samples/{client,bridge,control,shapes} validates and every sample under samples/invalid
// fails — both against the TypeScript validators and against the committed JSON Schema files ("both ways").

import { assert, assertEquals } from "@std/assert";
import {
  BRIDGE_MESSAGE_TYPES,
  BRIDGE_TO_HOST_TYPES,
  BridgeMessageSchema,
  ClickStateSchema,
  CLIENT_MESSAGE_TYPES,
  ClientMessageSchema,
  ControlMessageSchema,
  ElementTreeSchema,
  HOST_TO_BRIDGE_TYPES,
  HostStateSchema,
  type JsonObject,
  JsonPatchSchema,
  PlacementSchema,
  PolicyLogRecordSchema,
  PushSubscriptionSchema,
  RecordedTreeSchema,
  type Schema,
  ScreenGraphSchema,
  StyleSchema,
  validate,
  validateJson,
} from "../mod.ts";

const SAMPLES = new URL("../samples/", import.meta.url);
const SCHEMAS = new URL("../schema/", import.meta.url);

const readJson = (url: URL): unknown => JSON.parse(Deno.readTextFileSync(url));
const listJson = (dir: URL): string[] =>
  [...Deno.readDirSync(dir)].filter((e) => e.isFile && e.name.endsWith(".json")).map((e) => e.name).sort();

const docs: Record<string, JsonObject> = Object.fromEntries(
  listJson(SCHEMAS).map((f) => [f, readJson(new URL(f, SCHEMAS)) as JsonObject]),
);

/** Errors from validating `value` against a committed schema document. */
function checkDoc(file: string, value: unknown) {
  const doc = docs[file];
  assert(doc !== undefined, `schema/${file} is missing`);
  const defs = doc.$defs as Record<string, JsonObject>;
  return validateJson(doc, value, (name) => defs[name]);
}

interface Group {
  /** TS-side schema. */
  schema: Schema<unknown>;
  /** Kinds that must each have one valid sample `<kind>.json` and at least one invalid `<kind>.<case>.json`. */
  kinds: readonly string[];
  /** Committed schema documents a sample is checked against. */
  docsFor: (value: unknown) => string[];
}

const tOf = (v: unknown) => (typeof v === "object" && v !== null && "t" in v ? String(v.t) : undefined);
const controlDocs = (v: unknown) => {
  const t = tOf(v);
  if ((BRIDGE_TO_HOST_TYPES as readonly (string | undefined)[]).includes(t)) {
    return ["control-bridge-to-host.schema.json"];
  }
  if ((HOST_TO_BRIDGE_TYPES as readonly (string | undefined)[]).includes(t)) {
    return ["control-host-to-bridge.schema.json"];
  }
  return ["control-bridge-to-host.schema.json", "control-host-to-bridge.schema.json"];
};

const MESSAGE_GROUPS: Record<string, Group> = {
  client: { schema: ClientMessageSchema, kinds: CLIENT_MESSAGE_TYPES, docsFor: () => ["client-message.schema.json"] },
  bridge: { schema: BridgeMessageSchema, kinds: BRIDGE_MESSAGE_TYPES, docsFor: () => ["bridge-message.schema.json"] },
  control: {
    schema: ControlMessageSchema,
    kinds: [...BRIDGE_TO_HOST_TYPES, ...HOST_TO_BRIDGE_TYPES],
    docsFor: controlDocs,
  },
};

/** The shapes PROTOCOL.md names without a field list, plus the two trees and the policy record. */
const SHAPES: Record<string, [Schema<unknown>, string]> = {
  ClickState: [ClickStateSchema, "click-state.schema.json"],
  HostState: [HostStateSchema, "host-state.schema.json"],
  Placement: [PlacementSchema, "placement.schema.json"],
  Style: [StyleSchema, "style.schema.json"],
  JsonPatch: [JsonPatchSchema, "json-patch.schema.json"],
  PushSubscription: [PushSubscriptionSchema, "push-subscription.schema.json"],
  ScreenGraph: [ScreenGraphSchema, "screen-graph.schema.json"],
  ElementTree: [ElementTreeSchema, "element-tree.schema.json"],
  RecordedTree: [RecordedTreeSchema, "recorded-tree.schema.json"],
  PolicyLogRecord: [PolicyLogRecordSchema, "policy-log-record.schema.json"],
};

/** The kind an invalid sample file belongs to: the longest `<kind>.` prefix. */
const kindOf = (file: string, kinds: readonly string[]) =>
  kinds.filter((k) => file.startsWith(`${k}.`)).sort((a, b) => b.length - a.length)[0];

const describe = (errors: { path: string; message: string }[]) =>
  errors.map((e) => `${e.path || "/"}: ${e.message}`).join("\n");

function expectValid(group: Group, file: string, value: unknown): void {
  const r = validate(group.schema, value);
  assert(r.ok, `${file} should validate:\n${r.ok ? "" : describe(r.errors)}`);
  for (const doc of group.docsFor(value)) {
    const errors = checkDoc(doc, value);
    assertEquals(errors, [], `${file} should validate against schema/${doc}:\n${describe(errors)}`);
  }
}

function expectInvalid(group: Group, file: string, value: unknown): void {
  assert(!validate(group.schema, value).ok, `${file} should fail the TypeScript validator`);
  for (const doc of group.docsFor(value)) {
    assert(checkDoc(doc, value).length > 0, `${file} should fail schema/${doc}`);
  }
}

Deno.test("client layout reset without a node validates both ways", () => {
  expectValid(MESSAGE_GROUPS.client, "layout reset", { t: "layout", id: 7, action: "reset" });
});

for (const [dir, group] of Object.entries(MESSAGE_GROUPS)) {
  Deno.test(`samples/${dir}: one valid sample per message kind, each validates`, async (t) => {
    const files = listJson(new URL(`${dir}/`, SAMPLES));
    assertEquals(files, group.kinds.map((k) => `${k}.json`).sort());
    for (const file of files) {
      await t.step(file, () => {
        const value = readJson(new URL(`${dir}/${file}`, SAMPLES));
        assertEquals(tOf(value), file.slice(0, -".json".length), `${file} carries the wrong t`);
        expectValid(group, file, value);
      });
    }
  });

  Deno.test(`samples/invalid/${dir}: at least one per message kind, each fails`, async (t) => {
    const files = listJson(new URL(`invalid/${dir}/`, SAMPLES));
    const covered = new Set(files.map((f) => kindOf(f, group.kinds)));
    for (const kind of group.kinds) assert(covered.has(kind), `no invalid sample for ${dir} message "${kind}"`);
    for (const file of files) {
      await t.step(file, () => expectInvalid(group, file, readJson(new URL(`invalid/${dir}/${file}`, SAMPLES))));
    }
  });
}

Deno.test("samples/shapes: every named shape has a sample that validates", async (t) => {
  const files = listJson(new URL("shapes/", SAMPLES));
  assertEquals(files, Object.keys(SHAPES).map((s) => `${s}.json`).sort());
  for (const file of files) {
    const [schema, doc] = SHAPES[file.slice(0, -".json".length)];
    await t.step(
      file,
      () =>
        expectValid({ schema, kinds: [], docsFor: () => [doc] }, file, readJson(new URL(`shapes/${file}`, SAMPLES))),
    );
  }
});

Deno.test("samples/invalid/shapes: at least one per shape, each fails", async (t) => {
  const files = listJson(new URL("invalid/shapes/", SAMPLES));
  const shapes = Object.keys(SHAPES);
  const covered = new Set(files.map((f) => kindOf(f, shapes)));
  for (const shape of shapes) assert(covered.has(shape), `no invalid sample for shape ${shape}`);
  for (const file of files) {
    const kind = kindOf(file, shapes);
    assert(kind !== undefined, `${file} does not name a shape`);
    const [schema, doc] = SHAPES[kind];
    await t.step(
      file,
      () =>
        expectInvalid(
          { schema, kinds: [], docsFor: () => [doc] },
          file,
          readJson(new URL(`invalid/shapes/${file}`, SAMPLES)),
        ),
    );
  }
});
