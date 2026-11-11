/**
 * One `ElementNode` → DOM, by kind. Nodes are memoised by identity: a patch copies only the containers on its paths
 * (`app/jsonpatch.ts`), so untouched subtrees skip rendering. Siblings are keyed by their GPUI id where it is unique
 * among them, else by position. Nothing here throws on a malformed node: an unknown kind draws a red placeholder,
 * an asset path outside the app home an error block.
 */

import { memo, type ReactElement, type ReactNode, useContext, useLayoutEffect, useRef, useState } from "react";
import type {
  ElementNode,
  ElNode,
  ErrorNode,
  ImageNode,
  SvgNode,
  TerminalNode,
  TextNode,
  ViewNode,
} from "@herdr-relay/protocol";
import { renderTerminal, renderView } from "../app/slots.tsx";
import { RenderContext } from "./context.ts";
import { useElement } from "./interact.ts";
import { PathView } from "./path.tsx";
import { useScrollTo } from "./scroll.ts";
import { nodeCss } from "./style.ts";
import { WidgetView } from "./widgets.tsx";

/** Slots drawn before the children, then after them (`fallback` stands in for a failed `image` only). */
const SLOTS_BEFORE = ["header", "trigger", "image", "decrement_button", "input"] as const;
const SLOTS_AFTER = ["increment_button", "content", "panel", "footer"] as const;

/**
 * An app-home-relative asset path (`mods/<folder>/icons/x.svg`) as a URL of the bridge's static route, relative to
 * the document base (`/herdr-relay/`); `null` for anything that could leave it (absolute, `..`, schemes, …).
 */
export function assetUrl(src: unknown): string | null {
  if (typeof src !== "string" || src.length === 0 || src.length > 1024) return null;
  const segments = src.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || /[\\:\0?#]/.test(s))) return null;
  return `assets/${segments.map(encodeURIComponent).join("/")}`;
}

/** Children of a node, keyed. */
export function renderChildren(children: unknown): ReactNode[] {
  if (!Array.isArray(children)) return [];
  const seen = new Set<string>();
  return children.map((child, i) => {
    const id = typeof child === "object" && child !== null && typeof child.id === "string" ? child.id : null;
    let key = String(i);
    if (id !== null && !seen.has(id)) {
      seen.add(id);
      key = `#${id}`;
    }
    return <Node key={key} node={child} />;
  });
}

function renderSlots(slots: unknown): Record<string, ReactNode> {
  if (typeof slots !== "object" || slots === null) return {};
  const out: Record<string, ReactNode> = {};
  for (const [name, el] of Object.entries(slots)) out[name] = <Node key={`slot:${name}`} node={el} />;
  return out;
}

/** `frames(list, ms)`: each string in turn as the element's text, on one clock shared by every view. */
function Frames({ frames }: { frames: unknown }): ReactNode {
  const [list, ms] = Array.isArray(frames) ? frames : [];
  const strings = Array.isArray(list) && list.every((f) => typeof f === "string") ? list as string[] : [];
  const steps = typeof ms === "number" && ms >= 16 ? strings.length : 0;
  const cycle = steps > 1 ? steps * (ms as number) : 0;
  const reel = useRef<HTMLSpanElement>(null);
  // The reel joins the shared clock once mounted (the markup itself stays deterministic).
  useLayoutEffect(() => {
    if (reel.current && steps > 1) reel.current.style.animationDelay = `${-(Date.now() % cycle)}ms`;
  }, [cycle, steps]);
  if (steps <= 1) return strings[0] ?? null;
  return (
    <span className="r-frames" aria-hidden="true">
      <span
        ref={reel}
        className="r-frames__reel"
        style={{ animation: `herdr-r-frames ${cycle}ms steps(${steps}) infinite` }}
      >
        {strings.map((f, i) => <span key={i} className="r-frames__frame">{f}</span>)}
      </span>
    </span>
  );
}

function El({ node }: { node: ElNode }): ReactElement {
  const { dom, el } = useElement(node, "r-el");
  const slots = renderSlots(node.slots);
  const widget = typeof node.widget === "object" && node.widget !== null && typeof node.widget.type === "string";
  const children = node.anim?.frames
    ? [<Frames key="frames" frames={node.anim.frames} />]
    : renderChildren(node.children);
  // `scrollTo` counts the node's children; the slots drawn before them come first in the DOM.
  useScrollTo(el, node, widget || node.anim?.frames ? null : SLOTS_BEFORE.filter((s) => slots[s]).length);
  if (widget) {
    return (
      <WidgetView node={node as ElNode & { widget: NonNullable<ElNode["widget"]> }} dom={dom} slots={slots}>
        {children}
      </WidgetView>
    );
  }
  return (
    <div {...dom}>
      {SLOTS_BEFORE.map((s) => slots[s])}
      {children}
      {SLOTS_AFTER.map((s) => slots[s])}
    </div>
  );
}

function Text({ node }: { node: TextNode }): ReactElement {
  const css = nodeCss(node.style);
  const text = typeof node.text === "string" ? node.text : String(node.text ?? "");
  return <span className={css.className ? `r-text ${css.className}` : "r-text"} style={css.style}>{text}</span>;
}

/** `svg(path)`: a single-colour icon, tinted with the text colour (GPUI draws it as a mask). */
function Svg({ node }: { node: SvgNode }): ReactElement {
  const src = assetUrl(node.src);
  const mask = src ? `url("${src}")` : undefined;
  const { dom } = useElement(node, "r-el r-svg", mask ? { WebkitMaskImage: mask, maskImage: mask } : undefined);
  if (!src) return <Failure node={node} reason={`svg path ${JSON.stringify(node.src)} is outside the app home`} />;
  return <div {...dom} aria-hidden={dom.role || dom["aria-label"] ? undefined : true} />;
}

/** `image(path)`: full colour, fitted inside its box; the `fallback` slot if it does not load. */
function Image({ node }: { node: ImageNode }): ReactElement {
  const src = assetUrl(node.src);
  const { dom } = useElement(node, "r-el r-image");
  const [failed, setFailed] = useState<string | null>(null);
  if (!src) return <Failure node={node} reason={`image path ${JSON.stringify(node.src)} is outside the app home`} />;
  if (failed === src && node.slots?.fallback) return <Node node={node.slots.fallback} />;
  const { width, height } = node.style ?? {};
  const label = typeof node.attrs?.accessibility_label === "string" ? node.attrs.accessibility_label : "";
  return (
    <img
      {...dom}
      src={src}
      alt={label}
      width={typeof width === "number" ? width : undefined}
      height={typeof height === "number" ? height : undefined}
      decoding="async"
      draggable={false}
      data-failed={failed === src ? "" : undefined}
      onError={() => setFailed(src)}
    />
  );
}

function Terminal({ node }: { node: TerminalNode }): ReactElement {
  const env = useContext(RenderContext);
  const { dom } = useElement(node, "r-el r-terminal");
  const terminal = typeof node.terminal === "string" ? node.terminal : "";
  return <div {...dom}>{renderTerminal({ id: `${env.view}#${terminal}`, terminal })}</div>;
}

/** A retained nested view: its own `view.tree`, laid out in place (no box of its own unless styled). */
function Nested({ node }: { node: ViewNode }): ReactElement {
  const styled = Object.keys(node.style ?? {}).length > 0;
  const { dom } = useElement(node, styled ? "r-el r-nested" : "r-el r-nested r-contents");
  return <div {...dom}>{typeof node.view === "string" && node.view ? renderView(node.view) : null}</div>;
}

/** `k:"error"`: a block (or element) that cannot render, with the reason. */
function ErrorBlock({ node }: { node: ErrorNode }): ReactElement {
  const { dom } = useElement(node, "r-el r-error");
  const reason = typeof node.reason === "string" && node.reason ? node.reason : "no reason given";
  const folder = typeof node.folder === "string" && node.folder ? node.folder : null;
  return (
    <div {...dom} title={reason} data-folder={folder ?? undefined}>
      <span className="r-error__title">
        {folder
          ? (
            <>
              Mod <span translate="no">{folder}</span> can’t be shown
            </>
          )
          : "This part can’t be shown"}
      </span>
      <span className="r-error__reason">{reason}</span>
    </div>
  );
}

/** An element whose own data is unusable, drawn in its frame. */
function Failure({ node, reason }: { node: ElementNode; reason: string }): ReactElement {
  return <ErrorBlock node={{ k: "error", style: node.style ?? {}, reason }} />;
}

/** A node kind this renderer does not know (a newer bridge, a corrupted patch). */
function Unknown({ node }: { node: unknown }): ReactElement {
  const o = (typeof node === "object" && node !== null ? node : {}) as { k?: unknown; style?: unknown };
  const kind = typeof o.k === "string" ? o.k : o === node ? "(no kind)" : typeof node;
  const css = nodeCss(typeof o.style === "object" && o.style !== null ? o.style as ElementNode["style"] : undefined);
  return (
    <div className="r-unknown" style={css.style} role="img" aria-label={`Unsupported element kind ${kind}`}>
      <span className="r-unknown__label" translate="no">{`unknown element · ${kind}`}</span>
    </div>
  );
}

/** One node of an element tree. */
export const Node = memo(function Node({ node }: { node: ElementNode }): ReactElement {
  if (typeof node !== "object" || node === null) return <Unknown node={node} />;
  switch (node.k) {
    case "el":
      return <El node={node} />;
    case "text":
      return <Text node={node} />;
    case "svg":
      return <Svg node={node} />;
    case "image":
      return <Image node={node} />;
    case "path":
      return <PathView node={node} />;
    case "terminal":
      return <Terminal node={node} />;
    case "view":
      return <Nested node={node} />;
    case "error":
      return <ErrorBlock node={node} />;
    default:
      return <Unknown node={node} />;
  }
});
