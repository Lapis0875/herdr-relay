/**
 * Entry of the dev-only widget story page (`deno task bundle:dev` → `dist/dev/widgets.js`, served at
 * `/herdr-relay/dev/widgets` only while the bridge runs with `HERDR_RELAY_DEV`). Never part of `dist/app.js`. It
 * sets up the app's store and bridge connection (loopback `?token=` as the app takes it) so the live terminal story
 * has a stream, then renders the stories instead of the app.
 */

import "../../render/mod.tsx";
import "../mod.ts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bridge } from "../../app/client.ts";
import { currentClass, takeLaunchParams } from "../../app/env.ts";
import { blankState, initStore } from "../../app/store.ts";
import { applyTheme, DEFAULT_FONTS } from "../../app/theme.ts";
import { Stories } from "./stories.tsx";

takeLaunchParams();
initStore(blankState(currentClass()));
applyTheme({}, { dark: matchMedia("(prefers-color-scheme: dark)").matches }, DEFAULT_FONTS);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Stories />
  </StrictMode>,
);
void bridge.start(null);
