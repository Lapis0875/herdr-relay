/**
 * Widget stories (dev only, `/herdr-relay/dev/widgets`): each widget drawn from an element tree shaped like the ones
 * the bridge sends (styles as `toElementTree` produces them), through the real renderer (`TreeView` → `WidgetView`).
 * Handler invocations are logged under each story instead of going to the Mac; text fields get a simulated mod
 * (120 ms round trip, cleared on submit) so local echo can be watched. The live terminal story follows a real
 * terminal through the bridge, observe-only unless the person types.
 */

import { type ReactElement, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import type { ElementNode, ElNode, EventKind, JsonObject, TextNode } from "@herdr-relay/protocol";
import { renderTerminal } from "../../app/slots.tsx";
import { useApp } from "../../app/store.ts";
import { TreeView } from "../../render/view.tsx";
import { TerminalView } from "../terminal/TerminalView.tsx";
import { recordingSource } from "./recording.ts";

type Style = ElNode["style"];

const el = (tag: string, style: Style, rest: Partial<ElNode> = {}): ElNode => ({ k: "el", tag, style, ...rest });
const txt = (text: string, style: Style = {}): TextNode => ({ k: "text", style, text });

/** One Dark, as `theme()` reports it (the bridge's trees carry concrete colours). */
const C = {
  bg: "#21252b",
  panel: "#282c34",
  raised: "#2c313a",
  border: "#3a3f4b",
  fg: "#abb2bf",
  dim: "#5c6370",
  accent: "#61afef",
};

const frame = (extra: Style = {}): Style => ({
  borderTopWidth: 1,
  borderRightWidth: 1,
  borderBottomWidth: 1,
  borderLeftWidth: 1,
  borderStyle: "solid",
  borderColor: C.border,
  borderTopLeftRadius: 8,
  borderTopRightRadius: 8,
  borderBottomRightRadius: 8,
  borderBottomLeftRadius: 8,
  ...extra,
});

const column = (style: Style, children: ElementNode[], rest: Partial<ElNode> = {}) =>
  el("v_flex", { display: "flex", flexDirection: "column", ...style }, { children, ...rest });

// --- the frame every story is drawn in ---------------------------------------------------------------------------

interface LogLine {
  n: number;
  text: string;
}

function useLog(): [LogLine[], (text: string) => void] {
  const [lines, setLines] = useState<LogLine[]>([]);
  const n = useRef(0);
  const push = useCallback((text: string) => {
    setLines((l) => [{ n: ++n.current, text }, ...l].slice(0, 6));
  }, []);
  return [lines, push];
}

function Story(
  { id, title, about, height, log, children }: {
    id: string;
    title: string;
    about: ReactNode;
    height?: number | string;
    log?: LogLine[];
    children: ReactNode;
  },
): ReactElement {
  return (
    <section className="story" id={id} aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="story__title">{title}</h2>
      <p className="story__about">{about}</p>
      <div className="story__frame" style={{ height }} data-story={id}>{children}</div>
      {log
        ? (
          <ol className="story__log" aria-label={`${title}: events sent`} aria-live="polite">
            {log.length === 0
              ? <li className="story__log-empty">No events yet — interact with the widget above.</li>
              : log.map((l) => <li key={l.n}>{l.text}</li>)}
          </ol>
        )
        : null}
    </section>
  );
}

/** Sends nothing anywhere: logs `event {view, handler, kind, data}` as it would go to the bridge. */
function useSink(
  view: string,
  push: (text: string) => void,
  also?: (handler: number, kind: EventKind, data: unknown) => void,
) {
  return useCallback((handler: number, kind: EventKind, data: unknown) => {
    push(`event ${JSON.stringify({ view, handler, kind, data })}`);
    also?.(handler, kind, data);
  }, [view, push, also]);
}

// --- terminal ----------------------------------------------------------------------------------------------------

function TerminalDemo(): ReactElement {
  const source = useMemo(() => recordingSource(), []);
  return (
    <Story
      id="terminal-demo"
      title="Terminal · scale to fit"
      about={
        <>
          A 120×36 recording (no Mac needed). It is drawn at its own size and scaled to the frame’s width; pinch, ⌘/Ctrl
          + wheel or <b>1:1</b> shows it at full size. Typing echoes locally here.
        </>
      }
      height={360}
    >
      <TerminalView source={source} label="Terminal demo recording" canType stale={false} />
    </Story>
  );
}

function TerminalLive(): ReactElement {
  const terminals = useApp((s) => s.live?.terminals);
  const conn = useApp((s) => s.conn);
  const gate = useApp((s) => s.gate);
  const scope = useApp((s) => s.hello?.scope);
  const wanted = new URL(location.href).searchParams.get("term");
  const addresses = useMemo(() => (terminals ?? []).map((t) => t.address).filter(Boolean), [terminals]);
  const [picked, setPicked] = useState<string | null>(wanted);
  const terminal = picked ?? addresses[0] ?? null;
  const state = gate.kind !== "ready"
    ? `access: ${gate.kind}${gate.kind === "denied" ? ` (${gate.why})` : ""}`
    : conn.kind === "live"
    ? `live · ${scope ?? "?"} device · ${addresses.length} terminal${addresses.length === 1 ? "" : "s"}`
    : `connection: ${conn.kind}`;
  return (
    <Story
      id="terminal-live"
      title="Terminal · live from the Mac"
      about={
        <>
          The bridge’s terminal stream (<code>term.open</code> observe → <code>term.size</code>{" "}
          → binary frames), at the Mac’s size, never resized. <span className="story__state">{state}</span>
        </>
      }
      height="min(560px, 70vh)"
    >
      <div className="story__toolbar">
        <label className="story__label" htmlFor="story-term">Terminal</label>
        <select
          id="story-term"
          className="story__select"
          value={terminal ?? ""}
          onChange={(e) => setPicked(e.target.value || null)}
          disabled={addresses.length === 0}
        >
          {addresses.length === 0 ? <option value="">none yet</option> : null}
          {addresses.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div className="story__term">
        {terminal
          ? renderTerminal({ id: "story-live", terminal })
          : <p className="story__waiting">Waiting for the bridge’s terminal list…</p>}
      </div>
    </Story>
  );
}

// --- markdown / html ---------------------------------------------------------------------------------------------

const MARKDOWN = `# Release notes · v0.4

**herdr-relay** shows the Mac's mods on phones. This text is a \`TextView.markdown\`.

## What changed
- Terminals stream at the Mac's size and scale to fit
- [x] Markdown through *marked* + DOMPurify
- [ ] Editing code from a device (out of scope)

| Widget | Library | Notes |
|---|---|---|
| terminal | xterm.js 6 | observe first |
| code | highlight.js 11 | read-only |

\`\`\`ts
export function fit(width: number, cols: number): number {
  return Math.min(1, width / (cols * 7.8)); // never scale up
}
\`\`\`

> 한국어 문단도 어절 단위로 줄이 바뀌어야 합니다. 긴 문장이 화면 끝에서 단어 중간에 끊기지 않는지 확인하세요.

Links open on the device: [herdr.dev](https://example.com/herdr) — or go to the mod when it has \`on_link_click\`.
![a remote image](https://example.com/pixel.png) becomes a link, and <script>alert(1)</script> is removed.`;

const HTML = `<h3 style="color:red">Mail · Build finished</h3>
<p>Hi — the nightly build <b>passed</b>. <img src="https://example.com/track.gif" width="1" height="1">
See the <a href="https://example.com/build/42" onclick="steal()">build log</a> or
<a href="javascript:alert(1)">this unsafe link</a>.</p>
<ul><li>12 tests</li><li>0 failures</li></ul>
<form action="https://example.com"><input name="password"><button>Sign in</button></form>
<style>body{display:none}</style>`;

function TextStory({ id, format }: { id: string; format: "markdown" | "html" }): ReactElement {
  const [log, push] = useLog();
  const send = useSink(`story:${id}`, push);
  const tree = useMemo(
    () =>
      column({ width: "100%", height: "100%", padding: 16, overflowY: "auto", color: C.fg, fontSize: 14 }, [
        el("TextView", {}, {
          id: `doc-${format}`,
          on: format === "markdown" ? { link: 7 } : undefined,
          widget: { type: format, state: `doc-${format}`, props: { source: format === "markdown" ? MARKDOWN : HTML } },
        }),
      ]),
    [format],
  );
  return (
    <Story
      id={id}
      title={format === "markdown" ? "Markdown (TextView.markdown)" : "HTML (TextView.html)"}
      about={format === "markdown"
        ? "GFM via marked, sanitized by DOMPurify; fenced code is highlighted; this TextView has on_link_click."
        : "Mod HTML, sanitized: no styles, scripts, forms or remote images; unsafe links lose their href."}
      height={format === "markdown" ? 520 : 260}
      log={log}
    >
      <TreeView view={`story:${id}`} tree={tree} send={send} typing />
    </Story>
  );
}

// --- input / textarea --------------------------------------------------------------------------------------------

/** A text state the way a mod holds it: the device's input arrives 120 ms later; a submit clears it. */
function useModText(push: (text: string) => void): [string, (h: number, k: EventKind, d: unknown) => void] {
  const [value, setValue] = useState("");
  const onEvent = useCallback((_h: number, kind: EventKind, data: unknown) => {
    if (kind !== "input") return;
    const d = data as JsonObject;
    setTimeout(() => {
      if (d.event === "submit") {
        push(`mod: submitted ${JSON.stringify(d.value)} → set_value("")`);
        setValue("");
      } else if (typeof d.value === "string") setValue(d.value);
    }, 120);
  }, [push]);
  return [value, onEvent];
}

const inputStyle = (extra: Style = {}): Style =>
  frame({
    height: 36,
    paddingLeft: 10,
    paddingRight: 10,
    backgroundColor: C.bg,
    color: C.fg,
    fontSize: 12.8,
    borderColor: C.accent,
    borderTopLeftRadius: 9,
    borderTopRightRadius: 9,
    borderBottomRightRadius: 9,
    borderBottomLeftRadius: 9,
    ...extra,
  });

function InputStory(): ReactElement {
  const [log, push] = useLog();
  const [value, onEvent] = useModText(push);
  const send = useSink("story:input", push, onEvent);
  const tree = column({
    padding: 16,
    rowGap: 12,
    columnGap: 12,
    backgroundColor: C.raised,
    color: C.fg,
    height: "100%",
  }, [
    el("div", { fontSize: 11.5, color: C.dim }, {
      children: [txt("Rename the tab (Enter submits; the mod clears it)")],
    }),
    el("Input", inputStyle(), {
      on: { change: 2 },
      widget: { type: "input", state: "InputState:1", props: { placeholder: "New name…", value } },
    }),
    el("div", { fontSize: 11.5, color: C.dim }, { children: [txt("Masked, loading")] }),
    el("Input", inputStyle({ borderColor: C.border }), {
      on: { change: 3 },
      widget: { type: "input", state: "InputState:2", props: { value: "hunter2", masked: true, loading: true } },
    }),
    el("div", { fontSize: 11.5, color: C.dim }, { children: [txt("Disabled")] }),
    el("Input", inputStyle({ borderColor: C.border }), {
      on: { change: 4 },
      attrs: { disabled: true },
      widget: { type: "input", state: "InputState:3", props: { value: "read only for everyone" } },
    }),
  ]);
  return (
    <Story
      id="input"
      title="Input (InputState)"
      about="Local echo: typed text shows at once; the mod’s value arrives 120 ms later and does not move the caret."
      height={300}
      log={log}
    >
      <TreeView view="story:input" tree={tree} send={send} typing />
    </Story>
  );
}

function TextareaStory(): ReactElement {
  const [log, push] = useLog();
  const [value, onEvent] = useModText(push);
  const send = useSink("story:textarea", push, onEvent);
  const tree = column({
    padding: 16,
    rowGap: 12,
    columnGap: 12,
    backgroundColor: C.raised,
    color: C.fg,
    height: "100%",
  }, [
    el("div", { fontSize: 11.5, color: C.dim }, {
      children: [txt("set_auto_grow(2, 6): grows with the text, then scrolls · ⌘/Ctrl+Enter submits")],
    }),
    el("Textarea", inputStyle({ height: "auto", paddingTop: 8, paddingBottom: 8 }), {
      on: { change: 5 },
      widget: {
        type: "textarea",
        state: "TextareaState:1",
        props: { placeholder: "Message the agent…", value, auto_grow: { min_rows: 2, max_rows: 6 } },
      },
    }),
    el("div", { fontSize: 11.5, color: C.dim }, { children: [txt("rows: 3, soft_wrap(false)")] }),
    el("Textarea", inputStyle({ height: "auto", paddingTop: 8, paddingBottom: 8, borderColor: C.border }), {
      on: { change: 6 },
      widget: {
        type: "textarea",
        state: "TextareaState:2",
        props: {
          rows: 3,
          soft_wrap: false,
          value: "a long line that does not wrap but scrolls sideways instead — like a log line from the build output",
        },
      },
    }),
  ]);
  return (
    <Story
      id="textarea"
      title="Textarea (TextareaState)"
      about="Auto grow between min and max rows; soft wrap off scrolls sideways."
      height={360}
      log={log}
    >
      <TreeView view="story:textarea" tree={tree} send={send} typing />
    </Story>
  );
}

// --- code --------------------------------------------------------------------------------------------------------

const CODE = `/** Scale-to-fit (D4): the Mac's grid, never resized. */
import type { TermSize } from "@herdr-relay/protocol";

export class GridScale {
  #fit = 1;
  constructor(readonly viewport: HTMLElement) {}

  refit(width: number): number {
    // Never scale up: 1:1 is the Mac's own size.
    this.#fit = width > 0 ? Math.min(1, this.viewport.clientWidth / width) : 1;
    return this.#fit;
  }
}

const sizes: TermSize[] = [];
console.log(\`\${sizes.length} sizes\`, true, null, 0x1f);
`;

function CodeStory(): ReactElement {
  const tree = column({ height: "100%", backgroundColor: C.bg }, [
    el("Editor", { flexGrow: 1, flexShrink: 1, flexBasis: "0%", minHeight: 0 }, {
      widget: {
        type: "editor",
        state: "EditorState:1",
        props: { language: "typescript", value: CODE, readonly: true },
      },
    }),
  ]);
  const wrapped = column({ height: "100%", backgroundColor: C.bg }, [
    el("Editor", { flexGrow: 1, flexShrink: 1, flexBasis: "0%", minHeight: 0 }, {
      widget: {
        type: "editor",
        state: "EditorState:2",
        props: {
          language: "python",
          soft_wrap: true,
          line_numbers: true,
          syntax: { keyword: "#ff7ab2", string: "#ffd479", comment: "#7f8c98" },
          value:
            '# soft_wrap + custom syntax colours\ndef greet(name: str) -> str:\n    return f"안녕하세요, {name}! This line is long enough to wrap on a phone screen."\n',
        },
      },
    }),
  ]);
  return (
    <Story
      id="code"
      title="Code (Editor, read-only)"
      about="highlight.js with the theme’s ANSI colours, line numbers, selectable text; the second uses soft_wrap and syntax colours."
      height={520}
    >
      <div className="story__split">
        <div className="story__half">
          <TreeView view="story:code" tree={tree} send={null} typing={false} />
        </div>
        <div className="story__half story__half--short">
          <TreeView view="story:code2" tree={wrapped} send={null} typing={false} />
        </div>
      </div>
    </Story>
  );
}

// --- virtual list ------------------------------------------------------------------------------------------------

function ListStory(): ReactElement {
  const [log, push] = useLog();
  const send = useSink("story:vlist", push);
  const tree = useMemo(() => {
    const files = ["main.tsx", "client.ts", "store.ts", "Screen.tsx", "render.css", "widgets.css", "stream.ts"];
    const rows: ElementNode[] = Array.from({ length: 50 }, (_, i) =>
      el("h_flex", {
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        columnGap: 8,
        paddingLeft: 12,
        paddingRight: 12,
        height: 28,
        fontSize: 13,
        color: i % 7 === 0 ? C.accent : C.fg,
        backgroundColor: i % 2 ? C.panel : C.bg,
      }, {
        children: [
          el("div", { width: 18, color: i % 3 === 0 ? "#98c379" : "#e5c07b", fontWeight: 700 }, {
            children: [txt(i % 3 === 0 ? "A" : "M")],
          }),
          el("div", { flexGrow: 1 }, { children: [txt(`packages/web/src/${files[i % files.length]} · row ${i + 1}`)] }),
          el("div", { color: C.dim, fontSize: 11 }, { children: [txt(`+${(i * 7) % 40} −${(i * 3) % 11}`)] }),
        ],
      }));
    return column({ height: "100%", backgroundColor: C.bg }, [
      el("v_virtual_list", { width: "100%", height: "100%" }, {
        id: "changes-list",
        on: { item: 9, itemsecondary: 10 },
        widget: {
          type: "vlist",
          state: "changes-list",
          props: { count: 2048, keys: rows.map((_, i) => `file-${i + 1}`), sizes: 28 },
        },
        children: rows,
      }),
    ]);
  }, []);
  return (
    <Story
      id="vlist"
      title="Virtual list (v_virtual_list)"
      about="Only the rows in view are mounted; the host recorded the first 50 of 2,048. Tap a row (key reported); right-click or long-press for the secondary press."
      height={320}
      log={log}
    >
      <TreeView view="story:vlist" tree={tree} send={send} typing />
    </Story>
  );
}

// --- hover card --------------------------------------------------------------------------------------------------

function HoverCardStory(): ReactElement {
  const chip = (label: string, color: string) =>
    el(
      "h_flex",
      frame({
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        columnGap: 6,
        height: 30,
        paddingLeft: 10,
        paddingRight: 10,
        backgroundColor: C.raised,
        color: C.fg,
        fontSize: 13,
      }),
      {
        children: [
          el("div", {
            width: 8,
            height: 8,
            borderTopLeftRadius: 4,
            borderTopRightRadius: 4,
            borderBottomLeftRadius: 4,
            borderBottomRightRadius: 4,
            backgroundColor: color,
          }),
          txt(label),
        ],
      },
    );
  const card = (title: string, body: string) =>
    column({ rowGap: 4, maxWidth: 260, fontSize: 12.5, color: C.fg }, [
      el("div", { fontWeight: 600, fontSize: 13 }, { children: [txt(title)] }),
      el("div", { color: C.dim }, { children: [txt(body)] }),
    ]);
  const tree = el("h_flex", {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "flex-start",
    columnGap: 10,
    rowGap: 10,
    padding: 16,
    height: "100%",
    backgroundColor: C.bg,
  }, {
    children: [
      el("HoverCard", {}, {
        id: "agent-claude",
        attrs: { open_delay: 300 },
        widget: { type: "hovercard", state: "agent-claude", props: {} },
        slots: {
          trigger: chip("claude · working", "#61afef"),
          content: card("claude · t1", "Working for 14 min in ~/herdr-relay — last tool call: deno task bundle"),
        },
      }),
      el("HoverCard", {}, {
        id: "agent-codex",
        attrs: { anchor: "bottom_left" },
        widget: { type: "hovercard", state: "agent-codex", props: {} },
        slots: {
          trigger: chip("codex · blocked", "#e5c07b"),
          content: card("codex · t4", "Waiting for approval: run `git push`? (anchor: bottom_left)"),
        },
      }),
    ],
  });
  return (
    <Story
      id="hovercard"
      title="Hover card (HoverCard)"
      about="Rest the pointer (or focus with the keyboard) to open; touch: long-press the chip. Escape or a press elsewhere closes it."
      height={200}
    >
      <TreeView view="story:hovercard" tree={tree} send={null} typing={false} />
    </Story>
  );
}

// --- resizable ---------------------------------------------------------------------------------------------------

function ResizableStory(): ReactElement {
  const [log, push] = useLog();
  const send = useSink("story:resizable", push);
  // The mod re-rendering the same split with another `size_range` for the sidebar.
  const [sidebarMax, setSidebarMax] = useState(320);
  const pane = (label: string, bg: string) =>
    el("resizable_panel", {}, {
      children: [
        el("div", {
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          backgroundColor: bg,
          color: C.fg,
          fontSize: 13,
        }, { children: [txt(label)] }),
      ],
    });
  const sized = (node: ElNode, size: number, range: number[]): ElNode => ({
    ...node,
    style: { width: size, height: size },
    attrs: { size_range: range },
  });
  const tree = el("h_resizable", { width: "100%", height: "100%" }, {
    id: "workspace",
    on: { resize: 11 },
    widget: { type: "resizable", state: "workspace", props: {} },
    children: [
      sized(pane(`sidebar · 220 px (160–${sidebarMax})`, C.panel), 220, [160, sidebarMax]),
      el("resizable_panel", {}, {
        children: [
          el("v_resizable", { width: "100%", height: "100%" }, {
            id: "editor-split",
            on: { resize: 12 },
            widget: { type: "resizable", state: "editor-split", props: {} },
            children: [pane("editor (flexible)", C.bg), sized(pane("terminal · 120 px", C.raised), 120, [80])],
          }),
        ],
      }),
    ],
  });
  return (
    <Story
      id="resizable"
      title="Resizable (h_resizable / v_resizable)"
      about="Drag a divider (mouse, pen or finger) or focus it and use the arrow keys (Shift: 5×) or Home/End; on_resize hears every panel size when a move ends. Sizes are kept on this device: reload to see them restored. A narrower range from the mod redraws the sidebar within it at once."
      height={300}
      log={log}
    >
      <div className="story__toolbar">
        <label className="story__label" htmlFor="story-sidebar-max">Mod’s sidebar range</label>
        <select
          id="story-sidebar-max"
          className="story__select"
          value={sidebarMax}
          onChange={(e) => setSidebarMax(Number(e.target.value))}
        >
          <option value={320}>160–320 px</option>
          <option value={200}>160–200 px</option>
        </select>
      </div>
      <TreeView view="story:resizable" tree={tree} send={send} typing />
    </Story>
  );
}

// --- page --------------------------------------------------------------------------------------------------------

const STORIES: { id: string; label: string; render: () => ReactElement }[] = [
  { id: "terminal-live", label: "Terminal · live", render: () => <TerminalLive /> },
  { id: "terminal-demo", label: "Terminal · demo", render: () => <TerminalDemo /> },
  { id: "markdown", label: "Markdown", render: () => <TextStory id="markdown" format="markdown" /> },
  { id: "html", label: "HTML", render: () => <TextStory id="html" format="html" /> },
  { id: "input", label: "Input", render: () => <InputStory /> },
  { id: "textarea", label: "Textarea", render: () => <TextareaStory /> },
  { id: "code", label: "Code", render: () => <CodeStory /> },
  { id: "vlist", label: "Virtual list", render: () => <ListStory /> },
  { id: "hovercard", label: "Hover card", render: () => <HoverCardStory /> },
  { id: "resizable", label: "Resizable", render: () => <ResizableStory /> },
];

export function Stories(): ReactElement {
  const only = new URL(location.href).searchParams.get("story");
  const shown = STORIES.filter((s) => !only || s.id === only);
  return (
    <div className="stories" data-single={only ? "" : undefined}>
      <header className="stories__header">
        <h1 className="stories__title">Widget stories</h1>
        <p className="stories__note">Dev only (HERDR_RELAY_DEV). Events below each story are logged, not sent.</p>
        <nav aria-label="Stories">
          <ul className="stories__nav">
            {STORIES.map((s) => (
              <li key={s.id}>
                <a href={`dev/widgets?story=${s.id}`} aria-current={only === s.id ? "page" : undefined}>{s.label}</a>
              </li>
            ))}
            {only
              ? (
                <li>
                  <a href="dev/widgets">All</a>
                </li>
              )
              : null}
          </ul>
        </nav>
      </header>
      <main className="stories__list">{shown.map((s) => <s.render key={s.id} />)}</main>
    </div>
  );
}
