/**
 * Element nodes carrying a `widget` (`tree.ts` `WIDGET_TYPES`). The widgets are T17's (`src/widgets/**`): its
 * `widgets/mod.ts` installs one per type with `provideWidgetRenderer(type, Component)` before boot. A `scrollbar` is
 * the scroll container's own (the browser draws it), so its stand-in draws nothing; a type without a renderer (a
 * newer bridge) draws a labelled placeholder box in the element's own frame.
 */

import type { ComponentType, ReactElement, ReactNode } from "react";
import type { ElNode, JsonValue, Widget, WidgetType } from "@herdr-relay/protocol";
import type { ElementDom } from "./interact.ts";

export interface WidgetProps {
  /** The element node (`node.widget` set). */
  node: ElNode & { widget: Widget };
  /** Props for the widget's root element: the node's classes, style, ARIA and listeners, `ref` included. */
  dom: ElementDom;
  /** The node's children, already rendered (list rows, resizable panels). */
  children: ReactNode[];
  /** The node's named slots, already rendered (`trigger`, `content`, …). */
  slots: Readonly<Record<string, ReactNode>>;
}

function ScrollbarStandIn({ dom }: WidgetProps): ReactElement {
  return <div {...dom} className={`${dom.className} r-scrollbar`} aria-hidden="true" />;
}

const renderers: Partial<Record<WidgetType, ComponentType<WidgetProps>>> = { scrollbar: ScrollbarStandIn };

/** Installs the widget for one type (T17). Call before boot renders. */
export function provideWidgetRenderer(type: WidgetType, component: ComponentType<WidgetProps>): void {
  renderers[type] = component;
}

const text = (v: JsonValue | undefined): string => (typeof v === "string" ? v : "");

/** A one-line description of what the placeholder stands for. */
function detailOf(widget: Widget): string {
  const p = widget.props ?? {};
  if (widget.type === "markdown" || widget.type === "html") {
    return text(p.source).replace(/\s+/g, " ").trim().slice(0, 120);
  }
  return text(p.placeholder) || text(p.value) || text(p.language) || widget.state;
}

function Placeholder({ node, dom }: WidgetProps): ReactElement {
  const type = node.widget.type;
  const detail = detailOf(node.widget);
  return (
    <div
      {...dom}
      className={`${dom.className} r-widget`}
      data-widget={type}
      role={dom.role ?? "img"}
      aria-label={`${type} widget (pending)${detail ? `: ${detail}` : ""}`}
    >
      <span className="r-widget__badge" translate="no">{type}</span>
      {detail ? <span className="r-widget__detail">{detail}</span> : null}
    </div>
  );
}

/** The widget drawing `props.node` (installed, else a placeholder). */
export function WidgetView(props: WidgetProps): ReactElement {
  const type = props.node.widget.type;
  const Renderer = (Object.hasOwn(renderers, type) ? renderers[type] : undefined) ?? Placeholder;
  return <Renderer {...props} />;
}
