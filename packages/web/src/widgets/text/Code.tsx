/**
 * `Editor.new(EditorState)` on a device: read-only code (DESIGN.md §6, editing from a device is out of scope, D2/D3).
 * The state's options apply: `language` (highlight.js), `line_numbers` (default on), `soft_wrap` (default off),
 * `font_family`, `font_size`, and `syntax` colours by semantic name (default: the theme's ANSI colours). Text can be
 * selected and copied.
 */

import { type CSSProperties, type ReactElement, useMemo } from "react";
import type { JsonValue } from "@herdr-relay/protocol";
import type { WidgetProps } from "../../render/widgets.tsx";
import { highlight, splitLines } from "./highlight.ts";

/** `EditorState` `syntax` names → the custom property its token colour is read from (`widgets.css`). */
const SYNTAX: Record<string, string> = {
  keyword: "--syn-keyword",
  string: "--syn-string",
  "string.escape": "--syn-escape",
  comment: "--syn-comment",
  function: "--syn-function",
  type: "--syn-type",
  number: "--syn-number",
  constant: "--syn-constant",
  boolean: "--syn-boolean",
  variable: "--syn-variable",
  operator: "--syn-operator",
  punctuation: "--syn-punctuation",
};

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function syntaxVars(syntax: JsonValue | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof syntax !== "object" || syntax === null || Array.isArray(syntax)) return out;
  for (const [name, color] of Object.entries(syntax)) {
    if (Object.hasOwn(SYNTAX, name) && typeof color === "string" && HEX.test(color)) out[SYNTAX[name]] = color;
  }
  return out;
}

export function Code({ node, dom }: WidgetProps): ReactElement {
  const p = node.widget.props ?? {};
  const value = typeof p.value === "string" ? p.value : "";
  const language = typeof p.language === "string" ? p.language : undefined;
  const numbers = p.line_numbers !== false;
  const wrap = p.soft_wrap === true;
  const html = useMemo(() => {
    const lines = splitLines(highlight(value, language));
    return lines.map((line, i) =>
      `<span class="w-code__line">${numbers ? `<span class="w-code__ln">${i + 1}</span>` : ""}` +
      `<span class="w-code__text">${line}</span></span>`
    ).join("");
  }, [value, language, numbers]);
  const lineCount = useMemo(() => value.split("\n").length, [value]);
  const style: CSSProperties & Record<string, string | number> = { ...dom.style, ...syntaxVars(p.syntax) };
  style["--ln-digits"] = `${String(lineCount).length}ch`;
  if (typeof p.font_family === "string" && p.font_family) style.fontFamily = p.font_family;
  if (typeof p.font_size === "number" && p.font_size >= 6 && p.font_size <= 64) style.fontSize = p.font_size;
  return (
    <div
      {...dom}
      className={`${dom.className} w-code`}
      style={style}
      data-wrap={wrap ? "" : undefined}
      role={dom.role ?? "region"}
      aria-label={dom["aria-label"] ?? (language ? `Code, ${language}` : "Code")}
      tabIndex={dom.tabIndex ?? 0}
    >
      <pre className="w-code__pre" translate="no">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    </div>
  );
}
