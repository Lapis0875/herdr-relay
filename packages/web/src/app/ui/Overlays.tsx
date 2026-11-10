/**
 * Mod overlays (`overlay` / `overlay.close`, a mod's `openOverlay`): dialogs and windows as a centred modal (a
 * bottom sheet on a phone), popups anchored where they were opened, each showing its view. Closing one tells the
 * session (`overlay.close`), except on a read-only device, where it only closes here.
 */

import type { CSSProperties, ReactElement } from "react";
import type { Overlay } from "@herdr-relay/protocol";
import { bridge } from "../client.ts";
import { titleOf } from "../nav.ts";
import { renderView } from "../slots.tsx";
import { getState, setState, useApp } from "../store.ts";
import { Sheet } from "./Sheet.tsx";

/** Overlay sizes: up to 1 is a share of the window, above that px. */
function extent(v: number | undefined, fallback: string, axis: "vw" | "vh"): string {
  if (v === undefined) return fallback;
  return v <= 1 ? `${Math.round(v * 100)}${axis}` : `${v}px`;
}

function close(o: Overlay): void {
  setState((s) => ({ overlays: s.overlays.filter((x) => x.id !== o.id) }));
  if (getState().hello?.scope === "act") void bridge.command("overlay.close", { id: o.id });
}

export function Overlays(): ReactElement | null {
  const overlays = useApp((s) => s.overlays);
  const phone = useApp((s) => s.deviceClass === "phone");
  if (overlays.length === 0) return null;
  return <>{overlays.map((o) => <OverlayView key={o.id} o={o} phone={phone} />)}</>;
}

function OverlayView({ o, phone }: { o: Overlay; phone: boolean }): ReactElement {
  const label = titleOf(o.view.split(":").pop() ?? o.view);
  if (phone && o.kind !== "popup") {
    return (
      <Sheet side="bottom" label={label} onClose={() => close(o)} size={extent(o.height, "80vh", "vh")}>
        <div className="overlay__content overlay__content--sheet">{renderView(o.view)}</div>
      </Sheet>
    );
  }
  const width = extent(o.width, o.kind === "popup" ? "220px" : "min(560px, 92vw)", "vw");
  const height = extent(o.height, o.kind === "popup" ? "260px" : "min(640px, 80vh)", "vh");
  const style: CSSProperties = {
    width: `min(${width}, calc(100vw - 16px))`,
    height: `min(${height}, calc(100vh - 16px))`,
  };
  if (o.kind === "popup" && o.at && o.at !== "pointer") {
    style.left = `clamp(8px, ${o.at.x}px, calc(100vw - ${style.width} - 8px))`;
    style.top = `clamp(8px, ${o.at.y}px, calc(100vh - ${style.height} - 8px))`;
  }
  const modal = o.modal ?? o.kind !== "popup";
  return (
    <div className={`overlay overlay--${o.kind}`} data-modal={modal || undefined}>
      <div className="overlay__scrim" onClick={() => close(o)} aria-hidden="true" />
      <div
        className="overlay__box"
        data-frame={o.frame ?? "default"}
        role="dialog"
        aria-modal={modal}
        aria-label={label}
        style={style}
        onKeyDown={(e) => e.key === "Escape" && close(o)}
      >
        <div className="overlay__content">{renderView(o.view)}</div>
      </div>
    </div>
  );
}
