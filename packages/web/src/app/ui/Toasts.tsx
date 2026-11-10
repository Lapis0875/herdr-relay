/**
 * Toasts from the bridge (`toast`) and from the app. A `toast.action.open` (E11, U3: a mod's `open <url>`) is a real
 * link that opens on this device, never on the Mac; it names the site it goes to. A `toast.action.name` runs that
 * command. A `clipboard` message (a mod's `write_to_clipboard`) shows its text with a Copy button: browsers write the
 * clipboard only inside a user gesture. Plain toasts leave after 6 s, toasts with an action after 20 s.
 */

import { type ReactElement, useEffect, useState } from "react";
import { bridge } from "../client.ts";
import { titleOf } from "../nav.ts";
import { dismissToast, type ToastItem, useApp } from "../store.ts";
import { Icon } from "./icons.tsx";

/** Writes `text` to this device's clipboard; call from a click. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // No Clipboard API (insecure context, older WebKit): the selection-based copy below.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.readOnly = true;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

function CopyButton({ t }: { t: ToastItem & { copy: string } }): ReactElement {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => dismissToast(t.key), 1_200);
    return () => clearTimeout(timer);
  }, [state, t.key]);
  if (state === "failed") return <span className="toast__note" role="status">Select the text to copy it</span>;
  return (
    <button
      type="button"
      className="toast__action"
      disabled={state === "copied"}
      onClick={async () => setState(await copyText(t.copy) ? "copied" : "failed")}
    >
      <Icon name={state === "copied" ? "check" : "copy"} size={16} />
      <span>{state === "copied" ? "Copied" : "Copy"}</span>
    </button>
  );
}

export function Toasts(): ReactElement {
  const toasts = useApp((s) => s.toasts);
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => <ToastView key={t.key} t={t} />)}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function ToastView({ t }: { t: ToastItem }): ReactElement {
  useEffect(() => {
    const timer = setTimeout(() => dismissToast(t.key), t.action || t.copy !== undefined ? 20_000 : 6_000);
    return () => clearTimeout(timer);
  }, [t]);
  const action = t.action;
  return (
    <div className="toast" data-level={t.level ?? "info"}>
      <div className="toast__text">
        <p className="toast__title">{t.title}</p>
        {t.body
          ? <p className={t.copy !== undefined ? "toast__body toast__body--copy" : "toast__body"}>{t.body}</p>
          : null}
      </div>
      {t.copy !== undefined ? <CopyButton t={{ ...t, copy: t.copy }} /> : null}
      {action && "open" in action
        ? (
          <a
            className="toast__action"
            href={action.open}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => dismissToast(t.key)}
          >
            <span>{`Open ${hostOf(action.open)}`}</span>
            <Icon name="external" size={16} />
          </a>
        )
        : null}
      {action && "name" in action
        ? (
          <button
            type="button"
            className="toast__action"
            onClick={() => {
              dismissToast(t.key);
              void bridge.command(action.name, action.args);
            }}
          >
            {titleOf(action.name.split(".").pop() ?? action.name)}
          </button>
        )
        : null}
      <button
        type="button"
        className="icon-button toast__close"
        onClick={() => dismissToast(t.key)}
        aria-label="Dismiss"
      >
        <Icon name="close" size={18} />
      </button>
    </div>
  );
}
