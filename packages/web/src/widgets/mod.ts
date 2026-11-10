/**
 * Client widgets (T17), installed before boot (`src/main.tsx` imports this module for its side effect): the terminal
 * renderer for every terminal screen and `k:"terminal"` node (`app/slots.tsx`), and one renderer per element widget
 * type (`render/widgets.tsx`). The dev-only story page is a separate bundle (`dev/main.tsx`, `deno task bundle:dev`).
 */

import { provideTerminalRenderer } from "../app/slots.tsx";
import { provideWidgetRenderer } from "../render/widgets.tsx";
import { HoverCard } from "./HoverCard.tsx";
import { Resizable } from "./Resizable.tsx";
import { TerminalWidget } from "./terminal/TerminalWidget.tsx";
import { Code } from "./text/Code.tsx";
import { TextInput } from "./text/TextInput.tsx";
import { TextView } from "./text/TextView.tsx";
import { VirtualList } from "./VirtualList.tsx";

provideTerminalRenderer(TerminalWidget);
provideWidgetRenderer("input", TextInput);
provideWidgetRenderer("textarea", TextInput);
provideWidgetRenderer("editor", Code);
provideWidgetRenderer("markdown", TextView);
provideWidgetRenderer("html", TextView);
provideWidgetRenderer("vlist", VirtualList);
provideWidgetRenderer("hovercard", HoverCard);
provideWidgetRenderer("resizable", Resizable);
