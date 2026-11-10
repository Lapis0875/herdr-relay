/**
 * herdr-relay web client entry (`deno task bundle` → `dist/app.js`). Renderers register here before boot:
 * `./render/mod.tsx` (T16) calls `provideViewRenderer`; `./widgets/mod.ts` (T17) calls `provideTerminalRenderer`
 * and `provideWidgetRenderer`.
 */

import "./render/mod.tsx";
import "./widgets/mod.ts";
import { boot } from "./app/boot.tsx";

boot(document.getElementById("root")!);
