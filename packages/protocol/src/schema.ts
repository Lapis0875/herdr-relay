/**
 * Zero-dependency JSON Schema (draft 2020-12 subset) builder, registry and validator.
 *
 * Every protocol shape is written once with the builders below. The builder value carries the TypeScript type of the
 * values it accepts (`Static<typeof X>`), its JSON Schema (`X.json`, committed under `schema/*.json` by
 * `deno task schema`), and is what `validate()` checks at run time — so the TS types, the JSON Schemas and the
 * runtime validators cannot drift apart. Recursive shapes (`ElementNode`, `RecordedNode`, `ScreenNode`,
 * `LayoutNode`, `JsonValue`) are hand-written interfaces with a compile-time check against their schema.
 *
 * The validator understands exactly the keywords the builders emit and throws on any other keyword, so a schema file
 * it accepts is one it fully checks.
 */

/** Any JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

declare const TYPE: unique symbol;

/** A JSON Schema fragment that carries the TypeScript type of the values it accepts. */
export interface Schema<T> {
  readonly json: JsonObject;
  readonly [TYPE]: T;
}

/** The TypeScript type accepted by a schema. */
export type Static<S> = S extends Schema<infer T> ? T : never;

/** `true` when `A` and `B` are mutually assignable; used for compile-time schema/interface checks. */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Simplify<T> = { [K in keyof T]: T[K] };
type Shape = Readonly<Record<string, Schema<unknown>>>;
type Empty = Record<never, never>;

/** The object type described by required and optional property schemas. */
export type ObjectOf<R extends Shape, O extends Shape> = Simplify<
  & { -readonly [K in keyof R]: Static<R[K]> }
  & { -readonly [K in keyof O]?: Static<O[K]> }
>;

const make = <T>(json: JsonObject): Schema<T> => ({ json }) as Schema<T>;

function clean(json: Record<string, JsonValue | undefined>): JsonObject {
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(json)) if (v !== undefined) out[k] = v;
  return out;
}

/** Schema annotations accepted by every builder. */
export interface Annotations {
  description?: string;
}

export interface StringOptions extends Annotations {
  pattern?: string;
  minLength?: number;
  maxLength?: number;
}

export interface NumberOptions extends Annotations {
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
}

export interface ArrayOptions extends Annotations {
  minItems?: number;
  maxItems?: number;
}

export interface RecordOptions extends Annotations {
  /** Regular expression every key must match. */
  keys?: string;
  minProperties?: number;
}

export function string(options: StringOptions = {}): Schema<string> {
  return make(clean({ type: "string", ...options }));
}

export function number(options: NumberOptions = {}): Schema<number> {
  return make(clean({ type: "number", ...options }));
}

export function integer(options: NumberOptions = {}): Schema<number> {
  return make(clean({ type: "integer", ...options }));
}

export function boolean(annotations: Annotations = {}): Schema<boolean> {
  return make(clean({ type: "boolean", ...annotations }));
}

export function nullValue(annotations: Annotations = {}): Schema<null> {
  return make(clean({ type: "null", ...annotations }));
}

/** Exactly one value. */
export function literal<const V extends string | number | boolean>(value: V, annotations: Annotations = {}): Schema<V> {
  return make(clean({ const: value, ...annotations }));
}

/** One of a fixed list of strings. */
export function enumOf<const V extends readonly string[]>(values: V, annotations: Annotations = {}): Schema<V[number]> {
  return make(clean({ enum: [...values], ...annotations }));
}

export function array<T>(items: Schema<T>, options: ArrayOptions = {}): Schema<T[]> {
  return make(clean({ type: "array", items: items.json, ...options }));
}

/** A fixed-length array. */
export function tuple<const I extends readonly Schema<unknown>[]>(
  items: I,
  annotations: Annotations = {},
): Schema<{ -readonly [K in keyof I]: Static<I[K]> }> {
  return make(clean({
    type: "array",
    prefixItems: items.map((i) => i.json),
    items: false,
    minItems: items.length,
    ...annotations,
  }));
}

/** An array whose leading items have fixed schemas and whose remaining items share one schema. */
export function tupleRest<const I extends readonly Schema<unknown>[], R>(
  items: I,
  rest: Schema<R>,
  annotations: Annotations = {},
): Schema<[...{ -readonly [K in keyof I]: Static<I[K]> }, ...R[]]> {
  return make(clean({
    type: "array",
    prefixItems: items.map((i) => i.json),
    items: rest.json,
    minItems: items.length,
    ...annotations,
  }));
}

function properties(required: Shape, optional: Shape): JsonObject {
  const props: JsonObject = {};
  for (const [k, s] of Object.entries(required)) props[k] = s.json;
  for (const [k, s] of Object.entries(optional)) props[k] = s.json;
  return props;
}

/** A closed object: the listed properties only. */
export function object<R extends Shape, O extends Shape = Empty>(
  required: R,
  optional?: O,
  annotations: Annotations = {},
): Schema<ObjectOf<R, O>> {
  const opt: Shape = optional ?? {};
  return make(clean({
    type: "object",
    properties: properties(required, opt),
    required: Object.keys(required),
    additionalProperties: false,
    ...annotations,
  }));
}

/** An object with typed known properties that also allows any other JSON-valued property. */
export function openObject<R extends Shape, O extends Shape = Empty>(
  required: R,
  optional?: O,
  annotations: Annotations = {},
): Schema<ObjectOf<R, O> & { [key: string]: unknown }> {
  const opt: Shape = optional ?? {};
  return make(clean({
    type: "object",
    properties: properties(required, opt),
    required: Object.keys(required),
    additionalProperties: jsonValueRef.json,
    ...annotations,
  }));
}

/** An object used as a map: any keys (optionally matching `keys`), one value schema. */
export function record<T>(values: Schema<T>, options: RecordOptions = {}): Schema<Record<string, T>> {
  const { keys, ...rest } = options;
  return make(clean({
    type: "object",
    additionalProperties: values.json,
    propertyNames: keys === undefined ? undefined : { pattern: keys },
    ...rest,
  }));
}

/** Any of the branches. */
export function union<const B extends readonly Schema<unknown>[]>(
  branches: B,
  annotations: Annotations = {},
): Schema<Static<B[number]>> {
  return make(clean({ anyOf: branches.map((b) => b.json), ...annotations }));
}

/**
 * Exactly one of the branches, selected by the constant value of `property` (a discriminated union). Emits `oneOf`
 * plus the OpenAPI-style `discriminator` annotation, which this validator uses for dispatch and error messages and
 * standard validators ignore.
 */
export function tagged<const B extends readonly Schema<unknown>[]>(
  property: string,
  branches: B,
  annotations: Annotations = {},
): Schema<Static<B[number]>> {
  return make(clean({
    oneOf: branches.map((b) => b.json),
    discriminator: { propertyName: property },
    ...annotations,
  }));
}

export function nullable<T>(schema: Schema<T>): Schema<T | null> {
  return make({ anyOf: [schema.json, { type: "null" }] });
}

// ---------------------------------------------------------------------------------------------------------------------
// Named definitions (`$defs`).

const DEFINITIONS = new Map<string, () => Schema<unknown>>();

/**
 * Registers a named definition and returns a `$ref` to it. `get` is called lazily, so a definition may refer to
 * itself (recursive shapes) or to definitions declared later.
 */
export function define<T>(name: string, get: () => Schema<T>): Schema<T> {
  if (DEFINITIONS.has(name)) throw new Error(`schema definition "${name}" is defined twice`);
  DEFINITIONS.set(name, get);
  return make<T>({ $ref: `#/$defs/${name}` });
}

/** The JSON Schema of a registered definition. */
export function definition(name: string): JsonObject | undefined {
  return DEFINITIONS.get(name)?.().json;
}

export const jsonValueRef: Schema<JsonValue> = define("JsonValue", () =>
  make<JsonValue>({
    anyOf: [
      { type: "null" },
      { type: "boolean" },
      { type: "number" },
      { type: "string" },
      { type: "array", items: { $ref: "#/$defs/JsonValue" } },
      { type: "object", additionalProperties: { $ref: "#/$defs/JsonValue" } },
    ],
  }));

export const jsonObjectRef: Schema<JsonObject> = define("JsonObject", () => record(jsonValueRef));

const REF_PREFIX = "#/$defs/";

function collectRefs(json: JsonValue, out: Set<string>): void {
  if (Array.isArray(json)) {
    for (const v of json) collectRefs(v, out);
  } else if (json !== null && typeof json === "object") {
    for (const [k, v] of Object.entries(json)) {
      if (k === "$ref" && typeof v === "string" && v.startsWith(REF_PREFIX)) out.add(v.slice(REF_PREFIX.length));
      else collectRefs(v, out);
    }
  }
}

/**
 * A self-contained JSON Schema document for `root`: `$schema`, `$id`, `title`, the root schema and every definition it
 * reaches (sorted by name).
 */
export function schemaDocument(id: string, title: string, root: Schema<unknown>): JsonObject {
  const seen = new Set<string>();
  const queue = new Set<string>();
  collectRefs(root.json, queue);
  while (queue.size > 0) {
    const [name] = queue;
    queue.delete(name);
    if (seen.has(name)) continue;
    seen.add(name);
    const def = definition(name);
    if (def === undefined) throw new Error(`schema definition "${name}" is not registered`);
    const next = new Set<string>();
    collectRefs(def, next);
    for (const n of next) if (!seen.has(n)) queue.add(n);
  }
  const defs: JsonObject = {};
  for (const name of [...seen].sort()) defs[name] = definition(name)!;
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:herdr-relay:schema:${id}`,
    title,
    ...root.json,
    $defs: defs,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Validation.

/** One validation failure: `path` is the JSON Pointer of the offending value (`""` = the whole value). */
export interface ValidationError {
  path: string;
  message: string;
}

export type Validation<T> = { ok: true; value: T } | { ok: false; errors: ValidationError[] };

/** Looks up a `$defs` entry by name. */
export type DefinitionResolver = (name: string) => JsonObject | undefined;

/** Every keyword the validator interprets (`true`) or skips as an annotation (`false`). Anything else throws. */
const KEYWORDS: Record<string, boolean> = {
  $ref: true,
  const: true,
  enum: true,
  type: true,
  properties: true,
  required: true,
  additionalProperties: true,
  propertyNames: true,
  minProperties: true,
  items: true,
  prefixItems: true,
  minItems: true,
  maxItems: true,
  minLength: true,
  maxLength: true,
  pattern: true,
  minimum: true,
  maximum: true,
  exclusiveMinimum: true,
  exclusiveMaximum: true,
  anyOf: true,
  oneOf: true,
  description: false,
  title: false,
  $schema: false,
  $id: false,
  $defs: false,
  $comment: false,
  discriminator: false,
};

const patterns = new Map<string, RegExp>();
function regex(pattern: string): RegExp {
  let r = patterns.get(pattern);
  if (r === undefined) {
    r = new RegExp(pattern, "u");
    patterns.set(pattern, r);
  }
  return r;
}

/** Appends one escaped reference token to a JSON Pointer (RFC 6901). */
export const jsonPointer = (path: string, key: string | number): string =>
  `${path}/${String(key).replaceAll("~", "~0").replaceAll("/", "~1")}`;

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function hasType(v: unknown, type: string): boolean {
  switch (type) {
    case "null":
      return v === null;
    case "boolean":
      return typeof v === "boolean";
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isSafeInteger(v);
    case "array":
      return Array.isArray(v);
    case "object":
      return isObject(v);
    default:
      throw new Error(`unsupported JSON Schema type "${type}"`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

const show = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s;
};

class Checker {
  constructor(private readonly resolve: DefinitionResolver) {}

  private deref(schema: JsonObject): JsonObject {
    let s = schema;
    for (let i = 0; typeof s.$ref === "string" && i < 64; i++) s = this.target(s.$ref);
    return s;
  }

  private target(ref: string): JsonObject {
    if (!ref.startsWith(REF_PREFIX)) throw new Error(`unsupported $ref "${ref}"`);
    const def = this.resolve(ref.slice(REF_PREFIX.length));
    if (def === undefined) throw new Error(`unresolved $ref "${ref}"`);
    return def;
  }

  /** The constant values a branch can have at `property` (through `$ref`, `anyOf`, `oneOf`). */
  private tags(schema: JsonObject, property: string): JsonValue[] {
    const s = this.deref(schema);
    const branches = (s.oneOf ?? s.anyOf) as JsonObject[] | undefined;
    if (branches !== undefined) return branches.flatMap((b) => this.tags(b, property));
    const prop = (s.properties as JsonObject | undefined)?.[property] as JsonObject | undefined;
    return prop !== undefined && "const" in prop ? [prop.const] : [];
  }

  check(schema: JsonObject, value: unknown, path: string, errors: ValidationError[]): void {
    for (const key of Object.keys(schema)) {
      if (!Object.hasOwn(KEYWORDS, key)) throw new Error(`unsupported JSON Schema keyword "${key}"`);
    }
    if (typeof schema.$ref === "string") this.check(this.target(schema.$ref), value, path, errors);
    if ("const" in schema && !deepEqual(value, schema.const)) {
      errors.push({ path, message: `must be ${show(schema.const)}, got ${show(value)}` });
      return;
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) {
      errors.push({ path, message: `must be one of ${schema.enum.map(show).join(", ")}, got ${show(value)}` });
      return;
    }
    if (schema.type !== undefined) {
      const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
      if (!types.some((t) => hasType(value, t))) {
        errors.push({ path, message: `must be ${types.join(" or ")}, got ${typeOf(value)}` });
        return;
      }
    }
    if (typeof value === "string") this.checkString(schema, value, path, errors);
    if (typeof value === "number") this.checkNumber(schema, value, path, errors);
    if (Array.isArray(value)) this.checkArray(schema, value, path, errors);
    if (isObject(value)) this.checkObject(schema, value, path, errors);
    if (Array.isArray(schema.anyOf)) this.checkAnyOf(schema.anyOf as JsonObject[], value, path, errors);
    if (Array.isArray(schema.oneOf)) this.checkOneOf(schema, value, path, errors);
  }

  private checkString(schema: JsonObject, value: string, path: string, errors: ValidationError[]): void {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) {
      errors.push({ path, message: `must have at least ${schema.minLength} characters` });
    }
    if (typeof schema.maxLength === "number" && length > schema.maxLength) {
      errors.push({ path, message: `must have at most ${schema.maxLength} characters` });
    }
    if (typeof schema.pattern === "string" && !regex(schema.pattern).test(value)) {
      errors.push({ path, message: `must match ${schema.pattern}, got ${show(value)}` });
    }
  }

  private checkNumber(schema: JsonObject, value: number, path: string, errors: ValidationError[]): void {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}, got ${value}` });
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}, got ${value}` });
    }
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
      errors.push({ path, message: `must be > ${schema.exclusiveMinimum}, got ${value}` });
    }
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
      errors.push({ path, message: `must be < ${schema.exclusiveMaximum}, got ${value}` });
    }
  }

  private checkArray(schema: JsonObject, value: unknown[], path: string, errors: ValidationError[]): void {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push({ path, message: `must have at least ${schema.minItems} items, got ${value.length}` });
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push({ path, message: `must have at most ${schema.maxItems} items, got ${value.length}` });
    }
    const prefix = (schema.prefixItems ?? []) as JsonObject[];
    prefix.forEach((s, i) => {
      if (i < value.length) this.check(s, value[i], jsonPointer(path, i), errors);
    });
    if (schema.items === false) {
      if (value.length > prefix.length) {
        errors.push({ path, message: `must have at most ${prefix.length} items, got ${value.length}` });
      }
    } else if (isObject(schema.items)) {
      for (let i = prefix.length; i < value.length; i++) {
        this.check(schema.items as JsonObject, value[i], jsonPointer(path, i), errors);
      }
    }
  }

  private checkObject(
    schema: JsonObject,
    value: Record<string, unknown>,
    path: string,
    errors: ValidationError[],
  ): void {
    const props = (schema.properties ?? {}) as JsonObject;
    for (const name of (schema.required ?? []) as string[]) {
      if (!Object.hasOwn(value, name) || value[name] === undefined) {
        errors.push({ path, message: `missing property "${name}"` });
      }
    }
    const keys = Object.keys(value).filter((k) => value[k] !== undefined);
    if (typeof schema.minProperties === "number" && keys.length < schema.minProperties) {
      errors.push({ path, message: `must have at least ${schema.minProperties} properties` });
    }
    const names = schema.propertyNames as JsonObject | undefined;
    for (const k of keys) {
      if (names !== undefined) {
        const keyErrors: ValidationError[] = [];
        this.check(names, k, jsonPointer(path, k), keyErrors);
        if (keyErrors.length > 0) {
          errors.push({ path: jsonPointer(path, k), message: `property name ${keyErrors[0].message}` });
        }
      }
      if (Object.hasOwn(props, k)) {
        this.check(props[k] as JsonObject, value[k], jsonPointer(path, k), errors);
      } else if (schema.additionalProperties === false) {
        errors.push({ path: jsonPointer(path, k), message: `unexpected property "${k}"` });
      } else if (isObject(schema.additionalProperties)) {
        this.check(schema.additionalProperties as JsonObject, value[k], jsonPointer(path, k), errors);
      }
    }
  }

  private attempt(schema: JsonObject, value: unknown, path: string): ValidationError[] {
    const errors: ValidationError[] = [];
    this.check(schema, value, path, errors);
    return errors;
  }

  private nearest(results: ValidationError[][]): ValidationError[] {
    return results.reduce((best, r) => (r.length < best.length ? r : best));
  }

  private checkAnyOf(branches: JsonObject[], value: unknown, path: string, errors: ValidationError[]): void {
    const results: ValidationError[][] = [];
    for (const b of branches) {
      const r = this.attempt(b, value, path);
      if (r.length === 0) return;
      results.push(r);
    }
    errors.push({ path, message: "does not match any allowed shape; closest mismatch:" }, ...this.nearest(results));
  }

  private checkOneOf(schema: JsonObject, value: unknown, path: string, errors: ValidationError[]): void {
    const branches = schema.oneOf as JsonObject[];
    const property = (schema.discriminator as JsonObject | undefined)?.propertyName;
    if (typeof property === "string") {
      if (!isObject(value)) {
        errors.push({ path, message: `must be object, got ${typeOf(value)}` });
        return;
      }
      const tag = value[property];
      const allowed: JsonValue[] = [];
      for (const b of branches) {
        const tags = this.tags(b, property);
        allowed.push(...tags);
        if (tags.some((t) => deepEqual(t, tag))) {
          this.check(b, value, path, errors);
          return;
        }
      }
      errors.push({
        path: jsonPointer(path, property),
        message: `must be one of ${allowed.map(show).join(", ")}, got ${show(tag)}`,
      });
      return;
    }
    const results = branches.map((b) => this.attempt(b, value, path));
    const matches = results.filter((r) => r.length === 0).length;
    if (matches === 1) return;
    if (matches > 1) errors.push({ path, message: `matches ${matches} shapes; exactly one is allowed` });
    else {errors.push(
        { path, message: "does not match any allowed shape; closest mismatch:" },
        ...this.nearest(results),
      );}
  }
}

/** Validates `value` against a plain JSON Schema object, resolving `#/$defs/<name>` through `resolve`. */
export function validateJson(schema: JsonObject, value: unknown, resolve: DefinitionResolver): ValidationError[] {
  const errors: ValidationError[] = [];
  new Checker(resolve).check(schema, value, "", errors);
  return errors;
}

/** Validates a value against a schema whose `$ref`s resolve through the registered definitions. */
export function validate<T>(schema: Schema<T>, value: unknown): Validation<T> {
  const errors = validateJson(schema.json, value, definition);
  return errors.length === 0 ? { ok: true, value: value as T } : { ok: false, errors };
}

/** Type guard form of `validate`. */
export function is<T>(schema: Schema<T>, value: unknown): value is T {
  return validateJson(schema.json, value, definition).length === 0;
}

/** Parses JSON text and validates it. Invalid JSON is reported as an error at path `""`. */
export function decode<T>(schema: Schema<T>, text: string): Validation<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [{ path: "", message: `invalid JSON: ${(e as Error).message}` }] };
  }
  return validate(schema, value);
}

/** Thrown by `assertValid`. */
export class ProtocolError extends Error {
  constructor(readonly errors: ValidationError[]) {
    super(errors.map((e) => `${e.path || "/"}: ${e.message}`).join("; "));
    this.name = "ProtocolError";
  }
}

/** Returns `value` typed as `T`, or throws a `ProtocolError` listing every mismatch. */
export function assertValid<T>(schema: Schema<T>, value: unknown): T {
  const r = validate(schema, value);
  if (!r.ok) throw new ProtocolError(r.errors);
  return r.value;
}
