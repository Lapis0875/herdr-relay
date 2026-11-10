// The committed JSON Schema files are exactly what the TypeScript schemas generate, and the validator behaves as a
// draft 2020-12 subset validator (discriminated dispatch, closed objects, refusal of keywords it does not implement).

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  assertValid,
  ClientMessageSchema,
  decode,
  decodeClientMessage,
  type JsonObject,
  ProtocolError,
  SCHEMA_FILES,
  schemaDocuments,
  validate,
  validateJson,
} from "../mod.ts";

const SCHEMAS = new URL("../schema/", import.meta.url);

Deno.test("schema/*.json matches the TypeScript schemas (run `deno task schema` in packages/protocol)", () => {
  const committed = [...Deno.readDirSync(SCHEMAS)].filter((e) => e.isFile).map((e) => e.name).sort();
  assertEquals(committed, Object.keys(SCHEMA_FILES).sort());
  const generated = schemaDocuments();
  for (const file of committed) {
    assertEquals(JSON.parse(Deno.readTextFileSync(new URL(file, SCHEMAS))), generated[file], `schema/${file} is stale`);
  }
});

Deno.test("every committed document is self-contained", () => {
  for (const [file, doc] of Object.entries(schemaDocuments())) {
    const defs = doc.$defs as Record<string, JsonObject>;
    const refs = JSON.stringify(doc).match(/"#\/\$defs\/[^"]+"/g) ?? [];
    for (const ref of refs) {
      const name = ref.slice('"#/$defs/'.length, -1);
      assert(name in defs, `${file} refers to missing definition ${name}`);
    }
  }
});

Deno.test("discriminated unions report the allowed tags", () => {
  const r = validate(ClientMessageSchema, { t: "term.resize", id: 1 });
  assert(!r.ok);
  assertEquals(r.errors.length, 1);
  assertEquals(r.errors[0].path, "/t");
  assert(r.errors[0].message.includes('"term.open"'), r.errors[0].message);
});

Deno.test("a non-object is rejected by a discriminated union", () => {
  const r = validate(ClientMessageSchema, "hello");
  assert(!r.ok);
  assertEquals(r.errors[0].message, "must be object, got string");
});

Deno.test("Object.prototype keys are ordinary unknown properties", () => {
  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    const r = decodeClientMessage(`{"t":"visible","visible":true,${JSON.stringify(key)}:1}`);
    assert(!r.ok, key);
    assertEquals(r.errors, [{ path: `/${key}`, message: `unexpected property "${key}"` }]);
  }
  assert(!decodeClientMessage('{"t":"constructor"}').ok);
});

Deno.test("closed objects reject unknown properties with a pointer to them", () => {
  const r = validate(ClientMessageSchema, { t: "visible", visible: true, "a/b": 1 });
  assert(!r.ok);
  assertEquals(r.errors, [{ path: "/a~1b", message: 'unexpected property "a/b"' }]);
});

Deno.test("decode reports invalid JSON instead of throwing", () => {
  const r = decodeClientMessage("{not json");
  assert(!r.ok);
  assertEquals(r.errors[0].path, "");
  assert(r.errors[0].message.startsWith("invalid JSON"));
  assert(decode(ClientMessageSchema, '{"t":"visible","visible":false}').ok);
});

Deno.test("assertValid returns the typed value or throws ProtocolError", () => {
  const v = assertValid(ClientMessageSchema, { t: "visible", visible: true });
  assertEquals(v.t, "visible");
  const e = assertThrows(() => assertValid(ClientMessageSchema, { t: "visible" }), ProtocolError);
  assertEquals(e.errors, [{ path: "", message: 'missing property "visible"' }]);
});

Deno.test("the validator refuses keywords it does not implement", () => {
  assertThrows(() => validateJson({ type: "string", format: "uri" }, "x", () => undefined), Error, '"format"');
  assertThrows(() => validateJson({ $ref: "#/$defs/Missing" }, 1, () => undefined), Error, "unresolved");
});

Deno.test("integers, finite numbers and patterns", () => {
  const none = () => undefined;
  assertEquals(validateJson({ type: "integer" }, 1.5, none).length, 1);
  assertEquals(validateJson({ type: "number" }, Number.NaN, none).length, 1);
  assertEquals(validateJson({ type: "string", pattern: "^a" }, "ba", none).length, 1);
  assertEquals(
    validateJson({ type: "array", prefixItems: [{ type: "string" }], items: false }, ["a", 1], none).length,
    1,
  );
});
