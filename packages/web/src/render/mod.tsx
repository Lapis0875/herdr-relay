/**
 * The element-tree renderer (T16). Imported by `src/main.tsx` for its side effect: it installs `ViewRenderer` as the
 * shell's view renderer before boot. Widgets (T17) install themselves with `provideWidgetRenderer`.
 */

import { provideViewRenderer } from "../app/slots.tsx";
import { ViewRenderer } from "./view.tsx";

provideViewRenderer(ViewRenderer);

export { assetUrl, Node, renderChildren } from "./node.tsx";
export { TreeView, type TreeViewProps, ViewRenderer } from "./view.tsx";
export { provideWidgetRenderer, type WidgetProps } from "./widgets.tsx";
export { type EventSink, RenderContext, type RenderEnv } from "./context.ts";
export { keyPayload, unparse } from "./events.ts";
