/**
 * Keyboard diagnostics: a switch in the device panel that shows, over the app, the last {@link MAX_LINES} keyboard,
 * input, composition and focus events this page received (key names, composing, modifiers, whether a listener
 * cancelled it, input type) and the focused element each landed on (tag, class, read-only, `inputmode`). "Copy" puts
 * them on the clipboard, for an input-language or IME problem only a real device shows. Recording is passive
 * (capture-phase listeners that never cancel or stop anything) and runs only while the switch is on; the switch is
 * this page's alone and off again after a reload.
 *
 * Nothing typed is recorded ({@link describeEvent}): passwords and tokens go through terminals, and the lines end up
 * in screenshots and reports. A key that types a character is only its kind, an input's or composition's text only
 * its length and kind; the keys that type nothing keep their names.
 */

import { type ReactElement, useEffect, useState, useSyncExternalStore } from "react";
import { copyText } from "./Toasts.tsx";

const MAX_LINES = 30;
const EVENTS = [
  "keydown",
  "keyup",
  "beforeinput",
  "input",
  "compositionstart",
  "compositionupdate",
  "compositionend",
  "focusin",
  "focusout",
] as const;

const listeners = new Set<() => void>();
let on = false;
let lines: readonly string[] = [];
let started = 0;

const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const isOn = () => on;

/** Turns the diagnostics on or off for this page (until a reload). */
export function setKeyboardDiagnostics(next: boolean): void {
  on = next;
  notify();
}

/** The device panel's switch state. */
export function useKeyboardDiagnostics(): boolean {
  return useSyncExternalStore(subscribe, isOn);
}

/** The focused element: `TEXTAREA.xterm-helper-textarea ro im=none`. */
function focused(): string {
  const el = document.activeElement as (HTMLElement & { readOnly?: boolean }) | null;
  if (!el || el === document.body) return "body";
  const cls = typeof el.className === "string" && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : "";
  const im = el.getAttribute("inputmode");
  return `${el.tagName}${cls}${el.readOnly ? " ro" : ""}${im ? ` im=${im}` : ""}${
    el.isContentEditable ? " editable" : ""
  }`;
}

/** `KeyboardEvent.key` of the keys that type no character: shown by name. */
const NAMED_KEYS: Record<string, true> = Object.fromEntries(
  ("Shift Control Alt AltGraph Meta OS Super Hyper Fn FnLock Symbol SymbolLock CapsLock NumLock ScrollLock " +
    "Unidentified Dead Process Convert NonConvert ModeChange AllCandidates PreviousCandidate NextCandidate " +
    "SingleCandidate CodeInput GroupFirst GroupLast GroupNext GroupPrevious HangulMode HanjaMode JunjaMode FinalMode " +
    "KanaMode KanjiMode Eisu Hiragana Katakana HiraganaKatakana Romaji Zenkaku Hankaku ZenkakuHankaku Alphanumeric " +
    "Enter Tab Escape Backspace Delete Insert Home End PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight " +
    "ContextMenu").split(" ").map((k) => [k, true]),
);
/** `KeyboardEvent.code` of the keys that type no character (the others say which character key it was). */
const NAMED_CODES: Record<string, true> = Object.fromEntries(
  ("ShiftLeft ShiftRight ControlLeft ControlRight AltLeft AltRight MetaLeft MetaRight OSLeft OSRight Fn FnLock " +
    "CapsLock NumLock ScrollLock Lang1 Lang2 Lang3 Lang4 Lang5 KanaMode Convert NonConvert Unidentified Enter " +
    "NumpadEnter Tab Escape Backspace Delete Insert Home End PageUp PageDown ArrowUp ArrowDown ArrowLeft ArrowRight " +
    "ContextMenu").split(" ").map((c) => [c, true]),
);
const F_KEY = /^F(?:[1-9]|1\d|2[0-4])$/;
const HANGUL = /^[\uac00-\ud7a3]$/u;
const JAMO = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]$/u;

/** What typed text is, without what it says: `hangul` (syllables), `jamo`, `char` (anything else) or `mixed`. */
function kindOf(text: string): string {
  const kinds = new Set([...text].map((c) => HANGUL.test(c) ? "hangul" : JAMO.test(c) ? "jamo" : "char"));
  return kinds.size === 1 ? [...kinds][0] : "mixed";
}

/** An input's or composition's text as its length and kind (`2:hangul`), `0` when empty. */
function textOf(data: string | null): string {
  if (data === null) return "null";
  const length = [...data].length;
  return length ? `${length}:${kindOf(data)}` : "0";
}

/** The fields of a keyboard, input or composition event the diagnostics read; DOM events have them. */
export interface DiagnosedEvent {
  readonly type: string;
  readonly key?: string;
  readonly code?: string;
  readonly keyCode?: number;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
  readonly repeat?: boolean;
  readonly isComposing?: boolean;
  readonly inputType?: string;
  readonly data?: string | null;
  getModifierState?(key: string): boolean;
}

/**
 * One event as a diagnostics line, with nothing typed in it. A key's `key` and `code` are its names only for the keys
 * that type no character (modifiers, locks, Globe/fn, input-method and language keys, Enter, Tab, Escape, Backspace,
 * arrows, F-keys; Space only in a Ctrl or ⌘ chord, Ctrl+Space being iPadOS's language switch); a character key is its
 * kind (`key=jamo code=char`). Its `keyCode` shows only as `kc=229`, the input method's. An input's or composition's
 * text is its length and kind (`data=1:hangul`), its `inputType` as it is.
 */
export function describeEvent(e: DiagnosedEvent): string {
  const parts: string[] = [e.type];
  if (e.key !== undefined) {
    const chord = e.ctrlKey === true || e.metaKey === true;
    const key = e.key;
    const code = e.code ?? "";
    const keyName = Object.hasOwn(NAMED_KEYS, key) || F_KEY.test(key)
      ? key
      : key === " " && chord
      ? "Space"
      : key === ""
      ? "-"
      : [...key].length === 1
      ? kindOf(key)
      : textOf(key);
    const codeName = Object.hasOwn(NAMED_CODES, code) || F_KEY.test(code) || (code === "Space" && chord)
      ? code
      : code === ""
      ? "-"
      : "char";
    parts.push(`key=${keyName}`, `code=${codeName}`);
    if (e.keyCode === 229) parts.push("kc=229");
    const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift", e.metaKey && "cmd"].filter(Boolean);
    if (mods.length) parts.push(mods.join("+"));
    if (e.getModifierState?.("CapsLock")) parts.push("capslock-on");
    if (e.repeat) parts.push("repeat");
  } else if (e.inputType !== undefined) {
    parts.push(`type=${e.inputType}`);
  }
  if (e.data !== undefined) parts.push(`data=${textOf(e.data)}`);
  if (e.isComposing) parts.push("composing");
  return parts.join(" ");
}

function record(e: Event): void {
  const at = Math.round(performance.now() - started);
  const line = `${at} ${describeEvent(e)}`;
  const where = focused();
  // Read once every listener has run: whether one of them cancelled the event. Turned off meanwhile: not kept.
  setTimeout(() => {
    if (!on) return;
    lines = [...lines.slice(1 - MAX_LINES), `${line}${e.defaultPrevented ? " PREVENTED" : ""} @ ${where}`];
    notify();
  });
}

/** What "Copy" puts on the clipboard: the device, then the lines. */
function report(): string {
  const nav = navigator as Navigator & { standalone?: boolean };
  const standalone = nav.standalone === true || matchMedia("(display-mode: standalone)").matches;
  return [
    `herdr-relay keyboard diagnostics, ${new Date().toISOString()}`,
    `${navigator.userAgent} · ${navigator.maxTouchPoints} touch points · ${standalone ? "Home Screen app" : "browser"}`,
    `languages ${navigator.languages.join(",")} · focus now ${focused()}`,
    ...lines,
  ].join("\n");
}

/** The floating event list while the switch is on; mounted once in the app root. */
export function KeyboardDiagnostics(): ReactElement | null {
  const shown = useKeyboardDiagnostics();
  const log = useSyncExternalStore(subscribe, () => lines);
  const [copied, setCopied] = useState<"" | "Copied" | "Copy failed">("");

  useEffect(() => {
    if (!shown) return;
    started = performance.now();
    for (const type of EVENTS) addEventListener(type, record, { capture: true, passive: true });
    return () => {
      for (const type of EVENTS) removeEventListener(type, record, { capture: true });
      lines = [];
    };
  }, [shown]);

  if (!shown) return null;
  // A press on these buttons must not take the focus off the field being diagnosed.
  const keep = (e: { preventDefault(): void }) => e.preventDefault();
  return (
    <aside className="kbd-diag" aria-label="Keyboard diagnostics">
      <div className="kbd-diag__bar">
        <span className="kbd-diag__title">Keyboard diagnostics</span>
        <span className="kbd-diag__note" role="status">{copied}</span>
        <button
          type="button"
          className="kbd-diag__button"
          onPointerDown={keep}
          onClick={async () => {
            setCopied((await copyText(report())) ? "Copied" : "Copy failed");
            setTimeout(() => setCopied(""), 2000);
          }}
        >
          Copy
        </button>
        <button
          type="button"
          className="kbd-diag__button"
          onPointerDown={keep}
          onClick={() => {
            lines = [];
            notify();
          }}
        >
          Clear
        </button>
        <button
          type="button"
          className="kbd-diag__button"
          onPointerDown={keep}
          onClick={() => setKeyboardDiagnostics(false)}
        >
          Turn Off
        </button>
      </div>
      {/* Newest first, so the latest lines stay in view; "Copy" keeps the order they came in. */}
      <pre className="kbd-diag__log" translate="no">
        {log.length ? log.toReversed().join("\n") : "Press keys in a terminal or a text field…"}
      </pre>
    </aside>
  );
}
