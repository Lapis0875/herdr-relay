/**
 * A terminal screen: xterm.js at the Mac's cols×rows (D4: never resized from here), scaled to fit the width, pinch or
 * the zoom button for 1:1 (`scale.ts`). Under it a slim bar says what the device is doing — opening, observing,
 * typing, offline (the last screen stays), refused (with Retry) — and holds the zoom button and, for `act` devices on
 * touch screens, the keyboard toggle with the keys a phone keyboard lacks (Esc, Tab, ^C, arrows).
 *
 * Typing is explicit so a stray tap can never send anything to the Mac: nothing typed is sent until a key is pressed
 * with the terminal focused or the keyboard button is turned on (touch); only then do keystrokes reach `source.type`.
 * Mouse reports of programs that track the mouse follow the same switch. Until then xterm's textarea has
 * `inputmode="none"`, so a tap brings up no on-screen keyboard (not once a hardware keyboard has typed into a terminal,
 * which brings up none anyway). It is never read-only: iPadOS gives a field a keyboard session (input-language
 * switching with Caps Lock, Globe or Ctrl+Space; IME composition) only if the field is editable when it gets the focus
 * and never revisits that, while `inputmode` takes effect at once. Input methods and the keys the operating system keeps
 * go through `ime.ts`.
 */

import type * as Unicode11 from "@xterm/addon-unicode11";
import type * as Xterm from "@xterm/xterm";
import type { ITheme, Terminal } from "@xterm/xterm";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useApp } from "../../app/store.ts";
import { claim } from "../../render/events.ts";
import { WidgetIcon } from "../icons.tsx";
import { attachTerminalInput, type TerminalInput } from "./ime.ts";
import { GridScale, type ZoomMode } from "./scale.ts";
import type { StreamStatus, TerminalSource } from "./stream.ts";

export interface TerminalViewProps {
  source: TerminalSource;
  /** What the terminal is, for assistive technology (`Terminal t1`). */
  label: string;
  /** This device may type (`act` scope and a source that takes input). */
  canType: boolean;
  /** The data is not live (offline, reconnecting). */
  stale: boolean;
}

/** The grid's font size when the Mac's is unknown (px). */
const DEFAULT_FONT_SIZE = 13;
const SCROLLBACK = 1_000;
/** How long after a `term.size` the view follows the cursor while the paint arrives (ms). */
const REVEAL_MS = 600;
const encoder = new TextEncoder();
/** `KeyboardEvent.key` of the modifier keys: pressed on their own they do not start typing. */
const BARE_MODIFIERS: Record<string, true> = { Shift: true, Control: true, Alt: true, AltGraph: true, Meta: true };

/**
 * A key pressed in a terminal that was not typing yet started typing there. No on-screen keyboard was showing, so it
 * came from a hardware keyboard: with one attached a tap brings up no on-screen keyboard, and the terminals of this
 * page stop asking for none (`inputmode`), under which iPadOS switches no input language.
 */
let hardwareKeyboard = false;

/** Asks for no on-screen keyboard in `area` (xterm's textarea) unless the person types or has a hardware keyboard. */
function askKeyboard(area: HTMLTextAreaElement | undefined, typing: boolean): void {
  if (typing || hardwareKeyboard) area?.removeAttribute("inputmode");
  else area?.setAttribute("inputmode", "none");
}

/** xterm's module and its Unicode 11 addon's. */
export type XtermModules = [typeof Xterm, typeof Unicode11];

/**
 * Loads xterm and its Unicode 11 widths, on mount: xterm needs a DOM, and server rendering and tests import the
 * widgets without one. Tests that mount a terminal replace `load` (Deno resolves xterm's CommonJS build, which has no
 * named exports).
 */
export const xtermModules: { load: () => Promise<XtermModules> } = {
  load: () => Promise.all([import("@xterm/xterm"), import("@xterm/addon-unicode11")]),
};

/** Keys a phone keyboard lacks, as the bytes a terminal sends for them. */
const EXTRA_KEYS: readonly { label: string; name: string; bytes: (appCursor: boolean) => string }[] = [
  { label: "Esc", name: "Escape", bytes: () => "\x1b" },
  { label: "Tab", name: "Tab", bytes: () => "\t" },
  { label: "^C", name: "Control C", bytes: () => "\x03" },
  { label: "←", name: "Left arrow", bytes: (app) => (app ? "\x1bOD" : "\x1b[D") },
  { label: "↓", name: "Down arrow", bytes: (app) => (app ? "\x1bOB" : "\x1b[B") },
  { label: "↑", name: "Up arrow", bytes: (app) => (app ? "\x1bOA" : "\x1b[A") },
  { label: "→", name: "Right arrow", bytes: (app) => (app ? "\x1bOC" : "\x1b[C") },
];

/** The terminal palette from the theme's custom properties (`--herdr-ansi0` … `--herdr-ansi15`). */
function xtermTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string): string | undefined => css.getPropertyValue(`--herdr-${name}`).trim() || undefined;
  const background = v("terminal_background") ?? v("background");
  const foreground = v("terminal_foreground") ?? v("foreground");
  const ansi = (n: number) => v(`ansi${n}`);
  return {
    background,
    foreground,
    cursor: v("cursor") ?? foreground,
    cursorAccent: background,
    selectionBackground: v("selection"),
    black: ansi(0),
    red: ansi(1),
    green: ansi(2),
    yellow: ansi(3),
    blue: ansi(4),
    magenta: ansi(5),
    cyan: ansi(6),
    white: ansi(7),
    brightBlack: ansi(8),
    brightRed: ansi(9),
    brightGreen: ansi(10),
    brightYellow: ansi(11),
    brightBlue: ansi(12),
    brightMagenta: ansi(13),
    brightCyan: ansi(14),
    brightWhite: ansi(15),
  };
}

function terminalFont(): string {
  const stack = getComputedStyle(document.documentElement).getPropertyValue("--font-terminal").trim();
  return stack || "ui-monospace, monospace";
}

/** The Mac's terminal font size × zoom when its settings say (`settings()`), else {@link DEFAULT_FONT_SIZE}. */
function fontSizeOf(settings: Readonly<Record<string, unknown>> | undefined): number {
  const n = (v: unknown, lo: number, hi: number) => (typeof v === "number" && v >= lo && v <= hi ? v : undefined);
  const size = n(settings?.terminal_font_size, 6, 48) ?? n(settings?.font_size, 6, 48) ?? DEFAULT_FONT_SIZE;
  return Math.round(size * (n(settings?.zoom, 0.5, 3) ?? 1) * 100) / 100;
}

function statusText(status: StreamStatus, grid: { cols: number; rows: number } | null, canType: boolean): string {
  const geometry = grid ? ` · ${grid.cols}×${grid.rows}` : "";
  switch (status.kind) {
    case "offline":
      return grid ? `Offline — last screen${geometry}` : "Offline";
    case "opening":
      return "Connecting…";
    case "refused":
      return status.message;
    case "live":
      return `${status.typing ? "Typing" : canType ? "Observing" : "Read-only"}${geometry}`;
  }
}

const coarseQuery = () => matchMedia("(pointer: coarse)");

function useCoarsePointer(): boolean {
  // No `matchMedia` outside a browser (server rendering, tests).
  const [coarse, setCoarse] = useState(() => typeof matchMedia === "function" && coarseQuery().matches);
  useEffect(() => {
    const q = coarseQuery();
    const on = () => setCoarse(q.matches);
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return coarse;
}

export function TerminalView({ source, label, canType, stale }: TerminalViewProps): ReactElement {
  const viewport = useRef<HTMLDivElement>(null);
  const sizer = useRef<HTMLDivElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const input = useRef<TerminalInput | null>(null);
  const scale = useRef<GridScale | null>(null);
  const [status, setStatus] = useState<StreamStatus>({ kind: "opening" });
  const [grid, setGrid] = useState<{ cols: number; rows: number } | null>(null);
  const [zoom, setZoom] = useState<{ mode: ZoomMode; canZoom: boolean }>({ mode: "fit", canZoom: false });
  /** Keystrokes go to the Mac (see the module comment). */
  const [engaged, setEngaged] = useState(false);
  const coarse = useCoarsePointer();
  const theme = useApp((s) => s.hello?.theme);
  const fonts = useApp((s) => s.hello?.fonts);
  const settings = useApp((s) => s.hello?.settings);
  const fontSize = fontSizeOf(settings);
  const typable = canType && !stale && status.kind === "live" && source.type !== undefined;
  const live = useRef({ typable, engaged, source });
  live.current = { typable, engaged, source };
  const fontSizeNow = useRef(fontSize);
  fontSizeNow.current = fontSize;

  // The terminal and its stream: one per source. xterm is loaded on mount ({@link xtermModules}).
  useEffect(() => {
    let stopped = false;
    let teardown = () => {};
    void xtermModules.load().then(([xtermModule, unicode]) => {
      if (stopped) return;
      const host = screen.current!;
      const xterm = new xtermModule.Terminal({
        cols: 80,
        rows: 24,
        allowProposedApi: true,
        cursorBlink: false,
        cursorInactiveStyle: "outline",
        fontFamily: terminalFont(),
        fontSize: fontSizeNow.current,
        scrollback: SCROLLBACK,
        theme: xtermTheme(),
      });
      xterm.loadAddon(new unicode.Unicode11Addon());
      xterm.unicode.activeVersion = "11";
      xterm.open(host);
      askKeyboard(xterm.textarea, false);
      term.current = xterm;
      const inputLayer = attachTerminalInput(xterm);
      inputLayer.setEnabled(live.current.typable);
      input.current = inputLayer;
      const gridScale = new GridScale(viewport.current!, sizer.current!, host, (mode, canZoom) => {
        setZoom((z) => (z.mode === mode && z.canZoom === canZoom ? z : { mode, canZoom }));
      });
      scale.current = gridScale;

      // The grid's natural size follows its cell size (font, geometry).
      const gridEl = host.querySelector<HTMLElement>(".xterm-screen");
      const measure = () => {
        if (gridEl && gridEl.offsetWidth > 0) gridScale.setNatural(gridEl.offsetWidth, gridEl.offsetHeight);
      };
      const gridObserver = new ResizeObserver(measure);
      if (gridEl) gridObserver.observe(gridEl);
      const viewObserver = new ResizeObserver(() => gridScale.refit());
      viewObserver.observe(viewport.current!);
      measure();

      const typed = xterm.onData((data) => {
        const { typable, engaged, source } = live.current;
        if (typable && engaged) void source.type?.(encoder.encode(data));
      });
      // While a full paint arrives, keep the cursor's row in view (where a prompt or an agent's input is).
      let revealUntil = 0;
      const parsed = xterm.onWriteParsed(() => {
        if (performance.now() < revealUntil) gridScale.reveal(xterm.buffer.active.cursorY, xterm.rows);
      });
      const stop = source.attach({
        size(cols, rows) {
          xterm.resize(cols, rows);
          // A full paint follows: start over (RIS), in order with the bytes already queued.
          xterm.write("\x1bc");
          setGrid({ cols, rows });
          measure();
          revealUntil = performance.now() + REVEAL_MS;
        },
        data(bytes) {
          xterm.write(bytes);
        },
        status: setStatus,
      });

      // Fonts load late on a cold start: measure the cells again whenever some arrive. xterm measures when its
      // `fontFamily` option changes, so alternate between two spellings of the same stack.
      const fontsLoaded = () => {
        const stack = terminalFont();
        xterm.options.fontFamily = xterm.options.fontFamily === stack ? `${stack} ` : stack;
        measure();
      };
      document.fonts?.addEventListener("loadingdone", fontsLoaded);

      teardown = () => {
        document.fonts?.removeEventListener("loadingdone", fontsLoaded);
        stop();
        typed.dispose();
        parsed.dispose();
        gridObserver.disconnect();
        viewObserver.disconnect();
        gridScale.dispose();
        inputLayer.dispose();
        xterm.dispose();
        term.current = null;
        input.current = null;
        scale.current = null;
      };
    });
    return () => {
      stopped = true;
      teardown();
    };
  }, [source]);

  // The look follows the Mac's (`look` after `hello`).
  useEffect(() => {
    const xterm = term.current;
    if (!xterm) return;
    xterm.options.theme = xtermTheme();
    xterm.options.fontFamily = terminalFont();
    xterm.options.fontSize = fontSize;
  }, [theme, fonts, fontSize]);

  // What is typed while typing is not possible (offline, stale, read-only, refused) is never kept for later (`ime.ts`).
  useEffect(() => {
    input.current?.setEnabled(typable);
  }, [typable]);

  // No on-screen keyboard until the person starts typing (and none again when typing is no longer possible).
  useEffect(() => {
    askKeyboard(term.current?.textarea, typable && engaged);
    if (!typable && engaged) setEngaged(false);
  }, [typable, engaged]);

  // Gestures: pinch, Ctrl/⌘ + wheel. Native listeners: the wheel must be cancellable, before xterm sees it.
  useEffect(() => {
    const v = viewport.current!;
    const down = (e: PointerEvent) => scale.current?.pointerDown(e);
    const move = (e: PointerEvent) => scale.current?.pointerMove(e);
    const up = (e: PointerEvent) => scale.current?.pointerUp(e);
    const wheel = (e: WheelEvent) => scale.current?.wheel(e);
    // Safari's own pinch would zoom the page.
    const gesture = (e: Event) => e.preventDefault();
    v.addEventListener("pointerdown", down);
    v.addEventListener("pointermove", move);
    v.addEventListener("pointerup", up);
    v.addEventListener("pointercancel", up);
    v.addEventListener("wheel", wheel, { capture: true, passive: false });
    v.addEventListener("gesturestart", gesture);
    return () => {
      v.removeEventListener("pointerdown", down);
      v.removeEventListener("pointermove", move);
      v.removeEventListener("pointerup", up);
      v.removeEventListener("pointercancel", up);
      v.removeEventListener("wheel", wheel, { capture: true });
      v.removeEventListener("gesturestart", gesture);
    };
  }, []);

  /** Starts typing: keystrokes go to the Mac, the on-screen keyboard may show, the terminal is focused. */
  const startTyping = useCallback((xterm: Terminal) => {
    live.current.engaged = true;
    // At once, not on the next render: the key that starts typing may be an input method's.
    askKeyboard(xterm.textarea, true);
    xterm.focus();
    setEngaged(true);
  }, []);

  /**
   * A key pressed in the focused terminal starts typing; runs before xterm handles the key. A modifier on its own does
   * not (it may start a ⌘ shortcut of the browser). Caps Lock, Globe and the other input-language keys do, though they
   * type nothing: iPadOS switches no language while the field asks for no on-screen keyboard, so this first press is
   * spent on starting to type (the next one switches) and later terminals no longer ask ({@link hardwareKeyboard}).
   */
  const onKeyDownCapture = useCallback((e: ReactKeyboardEvent) => {
    const { typable, engaged } = live.current;
    const xterm = term.current;
    if (!typable || engaged || Object.hasOwn(BARE_MODIFIERS, e.key) || !xterm) return;
    hardwareKeyboard = true;
    startTyping(xterm);
  }, [startTyping]);

  const toggleKeyboard = () => {
    const xterm = term.current;
    if (!xterm) return;
    if (!engaged) {
      startTyping(xterm);
      return;
    }
    // The syllable an input method still holds was typed while typing was on: it is sent now, through `typed` with the
    // same checks, before typing stops. The blur's own commit would come after, when nothing is sent any more.
    input.current?.commit();
    askKeyboard(xterm.textarea, false);
    live.current.engaged = false;
    setEngaged(false);
    xterm.blur();
  };

  const sendKey = (bytes: (appCursor: boolean) => string) => {
    const xterm = term.current;
    if (!xterm || !typable) return;
    void source.type?.(encoder.encode(bytes(xterm.modes.applicationCursorKeysMode)));
    xterm.focus();
  };

  const text = statusText(status, grid, canType && source.type !== undefined);
  const showKeys = coarse && engaged && typable;
  return (
    <div
      className="w-term"
      data-status={status.kind}
      data-stale={stale ? "" : undefined}
      data-typing={engaged && typable ? "" : undefined}
      role="group"
      aria-label={label}
      // Keys pressed in the terminal are the terminal's: mod key handlers around it do not hear them (GPUI focus).
      onKeyDown={(e) => {
        claim(e.nativeEvent, "key");
        claim(e.nativeEvent, "modifiers");
      }}
      onKeyUp={(e) => {
        claim(e.nativeEvent, "key");
        claim(e.nativeEvent, "modifiers");
      }}
    >
      <div
        ref={viewport}
        className="w-term__viewport"
        onKeyDownCapture={onKeyDownCapture}
        // A terminal mounted before a hardware keyboard was known asks for none no longer.
        onFocus={() => askKeyboard(term.current?.textarea, live.current.typable && live.current.engaged)}
        onBlur={(e) => {
          // Touch: the keyboard went away with the focus.
          if (coarse && !e.currentTarget.contains(e.relatedTarget as Node | null)) setEngaged(false);
        }}
      >
        <div ref={sizer} className="w-term__sizer">
          <div ref={screen} className="w-term__screen" translate="no" />
        </div>
      </div>
      <div className="w-term__bar">
        {showKeys
          ? (
            <div className="w-term__keys" role="toolbar" aria-label="Terminal keys">
              {EXTRA_KEYS.map((k) => (
                <button
                  key={k.name}
                  type="button"
                  className="w-term__key"
                  aria-label={k.name}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => sendKey(k.bytes)}
                >
                  {k.label}
                </button>
              ))}
            </div>
          )
          : (
            <span className="w-term__status" role="status" aria-live="polite">
              <span className="w-term__dot" aria-hidden="true" />
              <span className="w-term__status-text">{text}</span>
            </span>
          )}
        {status.kind === "refused" && source.retry
          ? (
            <button type="button" className="w-term__button" onClick={() => source.retry?.()}>
              <WidgetIcon name="refresh" size={16} />
              Retry
            </button>
          )
          : null}
        {coarse && canType && source.type
          ? (
            <button
              type="button"
              className="w-term__button w-term__button--icon"
              aria-label={engaged ? "Hide keyboard" : "Type into this terminal"}
              aria-pressed={engaged}
              disabled={!typable}
              onPointerDown={(e) => e.preventDefault()}
              onClick={toggleKeyboard}
            >
              <WidgetIcon name="keyboard" />
            </button>
          )
          : null}
        <button
          type="button"
          className="w-term__button"
          aria-label={zoom.mode === "fit" ? "Show at 1:1" : "Fit to width"}
          disabled={!zoom.canZoom}
          onClick={() => scale.current?.toggle()}
        >
          <WidgetIcon name={zoom.mode === "fit" ? "expand" : "shrink"} size={16} />
          <span aria-hidden="true">{zoom.mode === "fit" ? "1:1" : "Fit"}</span>
        </button>
      </div>
    </div>
  );
}
