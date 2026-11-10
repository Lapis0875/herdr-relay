import { assert, assertEquals, assertMatch } from "@std/assert";
import type { ElementNode } from "@herdr-relay/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import { TreeView } from "../src/render/view.tsx";
import "../src/widgets/mod.ts";

const fixtureRoot = "fixtures/trees/generic";
const snapshotRoot = "packages/web/test/__snapshots__";
const update = Deno.env.get("HERDR_RELAY_UPDATE_TREES") === "1";

async function trees(dir: string): Promise<string[]> {
  const paths: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) paths.push(...await trees(path));
    else if (entry.isFile && entry.name.endsWith(".json") && entry.name !== "calls.json") paths.push(path);
  }
  return paths.sort();
}

const paths = await trees(fixtureRoot);
Deno.test("generic tree fixture inventory is nonempty", () => assert(paths.length > 0));

function render(tree: ElementNode, view = "test:view"): string {
  return renderToStaticMarkup(<TreeView view={view} tree={tree} send={null} typing={false} />);
}

for (const path of paths) {
  Deno.test(`tree snapshot: ${path}`, async () => {
    const tree = JSON.parse(await Deno.readTextFile(path)) as ElementNode;
    const view = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1, -5));
    const actual = `${render(tree, view)}\n`;
    const snapshot = `${snapshotRoot}/${path.slice(fixtureRoot.length + 1)}.html`;
    if (update) {
      await Deno.mkdir(snapshot.slice(0, snapshot.lastIndexOf("/")), { recursive: true });
      await Deno.writeTextFile(snapshot, actual);
    } else {
      assertEquals(actual, await Deno.readTextFile(snapshot), `Snapshot differs: ${snapshot}`);
    }
  });
}

// SSR cannot calculate layout. On a coarse pointer the renderer CSS gives eligible
// icon-only buttons a centred 44px pseudo-element; assert that rule before counting it.
// Numeric and px axes use minWidth/minHeight; percentages and missing sizes are skipped.
// Text controls and rows retain mod sizes and are reported separately, not failed.
Deno.test("phone icon click targets: explicit dimensions are at least 44 CSS px", async () => {
  const css = await Deno.readTextFile("packages/web/src/render/render.css");
  assertMatch(
    css,
    /@media\s*\(pointer:\s*coarse\)\s*\{\s*\.r-focusable\[role="button"\]:not\(:has\(\.r-text\)\)::after\s*\{[^}]*width:\s*max\(100%,\s*44px\);[^}]*height:\s*max\(100%,\s*44px\)/s,
  );
  let expanded = 0;
  let checked = 0;
  let skipped = 0;
  let textTargets = 0;
  let undersizedTextTargets = 0;
  const violations: string[] = [];
  const px = (value: unknown): number | null => {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+(?:\.\d+)?px$/.test(value)) return Number.parseFloat(value);
    return null;
  };
  function visit(value: unknown, location: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${location}/${i}`));
      return;
    }
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    const on = node.on as Record<string, unknown> | undefined;
    if (typeof node.k === "string" && on && Object.hasOwn(on, "click")) {
      const style = (node.style ?? {}) as Record<string, unknown>;
      const html = render(node as unknown as ElementNode);
      const root = html.match(/<div class="r-view"[^>]*><([a-z][\w-]*)\b([^>]*)>/)?.[2] ?? "";
      const hasText = /class="[^"]*\br-text\b/.test(html);
      const touchExpanded = /class="[^"]*\br-focusable\b/.test(root) &&
        /role="button"/.test(root) && !hasText;
      if (hasText) textTargets++;
      let measured = false;
      let undersizedText = false;
      for (const [axis, minimum] of [["width", "minWidth"], ["height", "minHeight"]]) {
        const size = px(style[axis]);
        if (size === null) continue;
        measured = true;
        if (touchExpanded) {
          expanded++;
          break;
        }
        const effective = Math.max(size, px(style[minimum]) ?? 0);
        if (effective < 44) {
          if (hasText) undersizedText = true;
          else violations.push(`${location}: ${axis}=${effective}px`);
        }
      }
      if (undersizedText) undersizedTextTargets++;
      if (measured) checked++;
      else skipped++;
    }
    if (node.children) visit(node.children, `${location}/children`);
    if (node.slots && typeof node.slots === "object") {
      for (const [key, child] of Object.entries(node.slots)) visit(child, `${location}/slots/${key}`);
    }
  }
  for (const path of paths) visit(JSON.parse(await Deno.readTextFile(path)), path);
  console.log(
    `phone click targets: ${checked} with explicit px size (${expanded} expanded by touch CSS); ${skipped} skipped without explicit px size; ${textTargets} text/row targets (${undersizedTextTargets} explicitly undersized)`,
  );
  assert(checked > 0, "No explicitly sized click targets were measured");
  assertEquals(violations, [], `Click targets below 44px:\n${violations.join("\n")}`);
});

Deno.test("unknown kinds use the red unsupported placeholder", async () => {
  const html = render({ k: "future-kind", style: {} } as unknown as ElementNode);
  assertMatch(html, /class="r-unknown"/);
  assertMatch(html, /Unsupported element kind future-kind/);
  const css = await Deno.readTextFile("packages/web/src/render/render.css");
  assertMatch(css, /\.r-unknown\s*\{[^}]*color:\s*var\(--shell-danger\)/s);
});

Deno.test("error nodes display their reason", () => {
  const html = render({ k: "error", style: {}, folder: "example", reason: "render failed" });
  assertMatch(html, /r-error/);
  assertMatch(html, /render failed/);
  assertMatch(html, /example/);
});

for (const type of ["markdown", "input"] as const) {
  Deno.test(`${type} widget renders or shows a labelled placeholder`, () => {
    const html = render({ k: "el", style: {}, widget: { type, state: "test", props: {} } });
    assertMatch(
      html,
      type === "input" ? /<input\b|<textarea\b|aria-label="input widget/ : /markdown|aria-label="markdown widget/,
    );
  });
}

Deno.test("terminal node renders or shows a labelled placeholder", () => {
  const html = render({ k: "terminal", style: {}, terminal: "test-terminal" });
  assert(html.length > 0);
  if (html.includes("slot-placeholder")) assertMatch(html, /aria-label="Terminal /);
});

Deno.test("font manifest declares four licensed families with matching license digests", async () => {
  const root = "packages/web/public/fonts";
  const manifest = JSON.parse(await Deno.readTextFile(`${root}/fonts.manifest.json`));
  assertEquals(manifest.v, 1);
  assertEquals(manifest.families.map((f: { family: string }) => f.family).sort(), [
    "D2Coding",
    "Geist",
    "JetBrains Mono",
    "Pretendard",
  ]);
  for (const family of manifest.families) {
    assertEquals(family.license, "OFL-1.1");
    assertMatch(family.license_file, /^[\w-]+\/OFL\.txt$/);
    const bytes = await Deno.readFile(`${root}/${family.license_file}`);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    assertEquals(hex, family.license_sha256, family.family);
  }
});
