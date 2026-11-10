/**
 * Mod-supplied markdown and HTML (`TextView.markdown/html`) → safe HTML for the device: marked (GFM) for markdown,
 * then DOMPurify for both. What survives is text structure only:
 *
 * - no scripts, styles, forms, controls, embeds or media: markdown images become links to them (HTML images are
 *   dropped), so a mail or page never fetches anything (tracking pixels, remote content) just by being shown; GFM
 *   task-list boxes stay, disabled;
 * - links only to `http(s):` and `mailto:`; they open on the device in a new tab (a TextView with `on_link_click`
 *   gets the click instead, `TextView.tsx`);
 * - no `id`/`style`, and `class` only for highlight.js tokens, so content cannot restyle or spoof the app.
 *
 * Fenced code blocks are highlighted (`highlight.ts`).
 */

import DOMPurify from "dompurify";
import { Marked } from "marked";
import { escapeHtml, highlight } from "./highlight.ts";

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = lang?.match(/^[\w+#.-]+/)?.[0];
      const cls = language ? ` class="hljs language-${escapeHtml(language)}"` : ' class="hljs"';
      return `<pre><code${cls}>${highlight(text, language)}</code></pre>\n`;
    },
    image({ href, text }) {
      return `<a href="${escapeHtml(href)}">${escapeHtml(text || "image")}</a>`;
    },
  },
});

const SAFE_HREF = /^(https?:|mailto:)/i;
const TOKEN_CLASS = /^(hljs|language-)[\w-]*$/;

/** DOMPurify needs a DOM: the browser's. Without one (Deno tests, server rendering) the source shows as plain text. */
const purify = typeof document === "undefined" ? null : DOMPurify(window);

purify?.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "class") {
    data.attrValue = data.attrValue.split(/\s+/).filter((c) => TOKEN_CLASS.test(c)).join(" ");
    if (!data.attrValue) data.keepAttr = false;
  }
});

purify?.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "INPUT") {
    // Only GFM task-list boxes, and never as a control.
    if (node.getAttribute("type") === "checkbox") node.setAttribute("disabled", "");
    else node.remove();
    return;
  }
  if (node.tagName !== "A") return;
  const href = node.getAttribute("href")?.trim() ?? "";
  if (!SAFE_HREF.test(href)) {
    node.removeAttribute("href");
    return;
  }
  node.setAttribute("target", "_blank");
  node.setAttribute("rel", "noopener noreferrer");
});

const PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [
    "style",
    "form",
    "button",
    "textarea",
    "select",
    "option",
    "img",
    "picture",
    "source",
    "video",
    "audio",
    "track",
    "iframe",
    "object",
    "embed",
    "link",
    "meta",
    "base",
  ],
  FORBID_ATTR: ["id", "style", "name", "srcset"],
  ALLOW_DATA_ATTR: false,
};

export function sanitizeHtml(html: string): string {
  return purify ? purify.sanitize(html, PURIFY) : escapeHtml(html);
}

export function renderMarkdown(source: string): string {
  return sanitizeHtml(markdown.parse(source, { async: false }));
}
