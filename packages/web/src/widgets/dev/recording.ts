/**
 * A canned terminal for the dev stories: a 120×36 screen (colours, box drawing, Korean, wide glyphs) that keeps
 * updating, painted the way the bridge does (size, then a full paint), with a tiny local line discipline so the
 * typing path can be tried without touching a real terminal.
 */

import type { StreamStatus, TerminalSink, TerminalSource } from "../terminal/stream.ts";

const COLS = 120;
const ROWS = 36;
const ESC = "\x1b";
const encoder = new TextEncoder();

const sgr = (codes: string) => `${ESC}[${codes}m`;
const at = (row: number, col: number) => `${ESC}[${row};${col}H`;

function paint(): string {
  const out: string[] = [`${ESC}[2J${ESC}[H`];
  const title = " herdr-relay · demo recording (no Mac attached) ";
  out.push(sgr("7"), title.padEnd(COLS), sgr("0"), "\r\n\r\n");
  out.push(`${sgr("1;32")}~/herdr-relay${sgr("0")} ${sgr("2")}(main)${sgr("0")} $ ls -la packages/web/src\r\n`);
  const files: [string, string, string][] = [
    ["drwxr-xr-x", "app", "1;34"],
    ["drwxr-xr-x", "render", "1;34"],
    ["drwxr-xr-x", "widgets", "1;34"],
    ["-rw-r--r--", "main.tsx", "0"],
    ["-rwxr-xr-x", "build.sh", "1;32"],
  ];
  for (const [mode, name, color] of files) {
    out.push(
      `${mode}  lapis  staff  ${String(name.length * 73).padStart(5)}  Nov 10 09:41  ${sgr(color)}${name}${
        sgr("0")
      }\r\n`,
    );
  }
  out.push("\r\n16 colours  ");
  for (let i = 0; i < 16; i++) out.push(`${sgr(i < 8 ? `4${i}` : `10${i - 8}`)}   `);
  out.push(sgr("0"), "\r\n256 colours ");
  for (let i = 16; i < 232; i += 2) out.push(`${ESC}[48;5;${i}m `);
  out.push(sgr("0"), "\r\ntruecolour  ");
  for (let i = 0; i < 108; i++) {
    const r = Math.round(255 * (i / 107));
    out.push(`${ESC}[48;2;${r};${80};${255 - r}m `);
  }
  out.push(sgr("0"), "\r\n\r\n");
  const rows = [
    ["agent", "status", "since"],
    ["claude · t1", "working", "09:12"],
    ["codex · t4", "blocked", "09:30"],
    ["오케스트레이터 · t7", "done ✓", "08:55"],
  ];
  const w = [24, 12, 8];
  const cell = (s: string, n: number) => {
    // Hangul is two columns wide.
    const width = [...s].reduce((sum, ch) => sum + (/[\u1100-\u11ff\uac00-\ud7a3]/.test(ch) ? 2 : 1), 0);
    return ` ${s}${" ".repeat(Math.max(0, n - width - 1))}`;
  };
  out.push(`┌${w.map((n) => "─".repeat(n)).join("┬")}┐\r\n`);
  rows.forEach((r, i) => {
    out.push(`│${r.map((s, j) => (i === 0 ? sgr("1") : "") + cell(s, w[j]) + sgr("0")).join("│")}│\r\n`);
    if (i === 0) out.push(`├${w.map((n) => "─".repeat(n)).join("┼")}┤\r\n`);
  });
  out.push(`└${w.map((n) => "─".repeat(n)).join("┴")}┘\r\n\r\n`);
  out.push(`${sgr("36")}한글 출력: 터미널 글꼴은 D2Coding — 줄바꿈과 폭(2칸)이 맞아야 합니다.${sgr("0")}\r\n`);
  out.push(
    `${sgr("33")}warning${
      sgr("0")
    }: scale-to-fit draws all ${COLS} columns; pinch or 1:1 shows them at the Mac's size\r\n`,
  );
  out.push(at(ROWS - 1, 1), `${sgr("1;32")}~/herdr-relay${sgr("0")} $ `);
  return out.join("");
}

function progress(tick: number): string {
  const width = 40;
  const done = tick % (width + 1);
  const bar = `${"█".repeat(done)}${"░".repeat(width - done)}`;
  return `${ESC}7${at(ROWS - 3, 1)}${ESC}[2Kbuilding ${sgr("32")}${bar}${sgr("0")} ${
    String(Math.round((done / width) * 100)).padStart(3)
  }%${ESC}8`;
}

/** A demo terminal; typed keys echo locally (Enter starts a new prompt, ^C cancels). */
export function recordingSource(): TerminalSource {
  let sink: TerminalSink | null = null;
  let typing = false;
  const status = (s: StreamStatus) => sink?.status(s);
  const write = (s: string) => sink?.data(encoder.encode(s));
  return {
    attach(next) {
      sink = next;
      status({ kind: "opening" });
      let tick = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      const start = setTimeout(() => {
        next.size(COLS, ROWS);
        write(paint());
        status({ kind: "live", typing });
        timer = setInterval(() => write(progress(tick++)), 400);
      }, 250);
      return () => {
        clearTimeout(start);
        clearInterval(timer);
        sink = null;
      };
    },
    type(bytes) {
      if (!typing) {
        typing = true;
        status({ kind: "live", typing: true });
      }
      const text = new TextDecoder().decode(bytes);
      if (text === "\r") write(`\r\n${sgr("1;32")}~/herdr-relay${sgr("0")} $ `);
      else if (text === "\x7f") write("\b \b");
      else if (text === "\x03") write(`^C\r\n${sgr("1;32")}~/herdr-relay${sgr("0")} $ `);
      else if (!text.startsWith(ESC)) write(text);
      return Promise.resolve(true);
    },
  };
}
