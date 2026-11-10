/**
 * Starts the app: reads launch parameters, installs the default theme, renders, registers the service worker
 * (`sw.js`: offline shell, Web Push), follows the device class across rotations and Split View, and connects.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { bridge } from "./client.ts";
import { appUrl, baseUrl, currentClass, takeLaunchParams } from "./env.ts";
import { resendSubscription } from "./push.ts";
import { unlockAudioOnGesture } from "./sound.ts";
import { blankState, initStore, setState } from "./store.ts";
import { applyTheme, DEFAULT_FONTS } from "./theme.ts";
import { App } from "./ui/App.tsx";
import { captureInstallPrompt } from "./ui/DevicePanel.tsx";

const CLASS_DEBOUNCE_MS = 150;

function registerServiceWorker(): void {
  if (!("serviceWorker" in navigator) || !isSecureContext) return;
  navigator.serviceWorker.register(appUrl("sw.js"), { scope: baseUrl().pathname }).catch((e) => {
    console.warn(`herdr-relay: service worker not registered: ${e instanceof Error ? e.message : e}`);
  });
  // A tapped notification while the app is open: focus that terminal.
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data as { type?: unknown; terminal?: unknown } | null;
    if (data?.type === "open" && typeof data.terminal === "string" && data.terminal.length <= 200) {
      bridge.focusTerminal(data.terminal);
    }
  });
}

/**
 * Rotation and iPad Split View change the device class live: the navigator recomposes at once (local graph), and a
 * new `hello` asks the bridge for that class's session graph.
 */
function followDeviceClass(): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let last = currentClass();
  const check = () => {
    const next = currentClass();
    if (next === last) return;
    last = next;
    setState({ deviceClass: next });
    bridge.rehello();
  };
  addEventListener("resize", () => {
    clearTimeout(timer);
    timer = setTimeout(check, CLASS_DEBOUNCE_MS);
  });
}

export function boot(root: HTMLElement): void {
  const launch = takeLaunchParams();
  initStore(blankState(currentClass()));
  applyTheme({}, { dark: matchMedia("(prefers-color-scheme: dark)").matches }, DEFAULT_FONTS);
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
  registerServiceWorker();
  captureInstallPrompt();
  followDeviceClass();
  unlockAudioOnGesture();
  addEventListener("herdr-relay:live", () => void resendSubscription());
  void bridge.start(launch.terminal);
}
