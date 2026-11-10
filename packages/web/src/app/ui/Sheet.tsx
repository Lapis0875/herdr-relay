/**
 * A modal panel sliding in from an edge (More sheet, device panel, side sheets, drawer, expanded floating sheets):
 * a scrim that closes it, Escape to close, focus moved in on open and given back on close, scroll contained.
 */

import { type CSSProperties, type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { Icon } from "./icons.tsx";

export type SheetSide = "bottom" | "right" | "left" | "top";

export interface SheetProps {
  side: SheetSide;
  /** Accessible name; also the visible title unless `title` is `null`. */
  label: string;
  title?: ReactNode | null;
  onClose: () => void;
  children: ReactNode;
  /** Width (left/right) or max height (bottom/top) as CSS. */
  size?: string;
  className?: string;
  /** Extra header controls before the close button. */
  actions?: ReactNode;
  /** `false`: no header (the content draws its own). */
  header?: boolean;
}

export function Sheet(
  { side, label, title, onClose, children, size, className, actions, header = true }: SheetProps,
): ReactElement {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = panel.current;
    const first = el?.querySelector<HTMLElement>("[data-autofocus]") ?? el;
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close.current();
      }
    };
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("keydown", onKey);
      if (before && document.contains(before)) before.focus({ preventScroll: true });
    };
  }, []);

  const style: CSSProperties = size ? { ["--sheet-size" as string]: size } : {};
  return (
    <div className={`sheet sheet--${side}${className ? ` ${className}` : ""}`} style={style}>
      <div className="sheet__scrim" onClick={onClose} aria-hidden="true" />
      <div className="sheet__panel" role="dialog" aria-modal="true" aria-label={label} ref={panel} tabIndex={-1}>
        {side === "bottom" ? <div className="sheet__grabber" aria-hidden="true" /> : null}
        {header
          ? (
            <div className="sheet__header">
              <h2 className="sheet__title">{title === undefined ? label : title}</h2>
              {actions}
              <button type="button" className="icon-button" onClick={onClose} aria-label={`Close ${label}`}>
                <Icon name="close" />
              </button>
            </div>
          )
          : null}
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}
