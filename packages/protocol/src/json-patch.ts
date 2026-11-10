/** JSON Patch (RFC 6902) operations, as carried by `patch.views[].ops` and `patch.state`. */

import { array, define, jsonValueRef, literal, object, type Static, string, tagged } from "./schema.ts";

/** RFC 6901 JSON Pointer: `""` (whole document) or `/`-separated tokens with `~0`/`~1` escapes. */
export const JSON_POINTER_PATTERN = "^(?:/(?:[^~/]|~[01])*)*$";

export const JsonPatchOperationSchema = define("JsonPatchOperation", () => {
  const path = string({ pattern: JSON_POINTER_PATTERN });
  return tagged("op", [
    object({ op: literal("add"), path, value: jsonValueRef }),
    object({ op: literal("remove"), path }),
    object({ op: literal("replace"), path, value: jsonValueRef }),
    object({ op: literal("move"), from: path, path }),
    object({ op: literal("copy"), from: path, path }),
    object({ op: literal("test"), path, value: jsonValueRef }),
  ]);
});
export type JsonPatchOperation = Static<typeof JsonPatchOperationSchema>;

/** A JSON Patch document: operations applied in order, atomically. */
export const JsonPatchSchema = define("JsonPatch", () => array(JsonPatchOperationSchema));
export type JsonPatch = Static<typeof JsonPatchSchema>;
