/**
 * Writes `packages/protocol/schema/*.schema.json` from the TypeScript schemas and removes stale schema files.
 * Run through `deno task schema` (in `packages/protocol`), which also formats the output.
 */

import { schemaDocuments } from "../src/documents.ts";

const dir = new URL("../schema/", import.meta.url);
await Deno.mkdir(dir, { recursive: true });

const docs = schemaDocuments();
for (const entry of Deno.readDirSync(dir)) {
  if (entry.isFile && entry.name.endsWith(".schema.json") && !(entry.name in docs)) {
    await Deno.remove(new URL(entry.name, dir));
    console.log(`removed schema/${entry.name}`);
  }
}
for (const [file, doc] of Object.entries(docs)) {
  await Deno.writeTextFile(new URL(file, dir), `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote schema/${file}`);
}
