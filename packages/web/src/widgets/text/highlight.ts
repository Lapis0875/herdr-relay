/**
 * Syntax highlighting (highlight.js core with the languages mods show: source files in `code`/`files`, fenced blocks
 * in markdown). Output is highlight.js HTML: the code escaped, tokens in `<span class="hljs-…">`.
 */

import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
  bash,
  c,
  cpp,
  css,
  diff,
  go,
  ini,
  java,
  javascript,
  json,
  kotlin,
  markdown,
  plaintext,
  python,
  ruby,
  rust,
  shell,
  sql,
  swift,
  typescript,
  xml,
  yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });
hljs.registerAliases(["zsh", "sh"], { languageName: "bash" });

/** Larger sources are shown plain: highlighting them would stall the page. */
const MAX_HIGHLIGHT_CHARS = 256 * 1024;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

/** `code` as highlighted HTML in `language` (a name or alias, case-insensitive); escaped plain text otherwise. */
export function highlight(code: string, language: string | undefined): string {
  const lang = language?.trim().toLowerCase();
  if (!lang || code.length > MAX_HIGHLIGHT_CHARS || !hljs.getLanguage(lang)) return escapeHtml(code);
  return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
}

/**
 * Splits highlighted HTML into lines, closing the spans open at each line end and reopening them on the next line,
 * so every line is well-formed HTML on its own (a comment spanning lines stays coloured on each).
 */
export function splitLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let line = "";
  const tag = /<span[^>]*>|<\/span>|\n/g;
  let last = 0;
  for (let m = tag.exec(html); m !== null; m = tag.exec(html)) {
    line += html.slice(last, m.index);
    last = m.index + m[0].length;
    if (m[0] === "\n") {
      lines.push(line + "</span>".repeat(open.length));
      line = open.join("");
    } else if (m[0] === "</span>") {
      open.pop();
      line += m[0];
    } else {
      open.push(m[0]);
      line += m[0];
    }
  }
  lines.push(line + html.slice(last));
  return lines;
}
