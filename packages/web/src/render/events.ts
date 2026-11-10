/**
 * Device input → the gpui-kit event payloads of `event.data` (`@herdr-relay/protocol` `messages.ts`).
 *
 * Keys are spelled as GPUI's `Keystroke::unparse` writes a binding (gpui-kit `KeyEvent`): modifiers in the order
 * `fn-ctrl-alt-cmd-shift-`, then the key. The platform modifier is `cmd` everywhere. A letter keeps `shift` as a
 * modifier (`cmd-shift-s`); any other printable key is the character it types with shift folded in (`?`, not
 * `shift-/`), as GPUI reports it on macOS. With Option (which composes characters on a Mac), or with Ctrl/Cmd on a
 * non-Latin layout, the key is the US-layout key at that position (`alt-a`, `cmd-s` on a Korean layout), the way
 * GPUI falls back to the Latin layout. Composition (IME) and dead keys produce nothing, nor do keys an input method
 * takes ({@link imeKey}) or the operating system keeps ({@link systemKey}).
 */

import type { Modifiers } from "@herdr-relay/protocol";

/** What both DOM and React keyboard/pointer events offer. */
interface ModifierSource {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState(key: string): boolean;
}

interface KeySource extends ModifierSource {
  key: string;
  code: string;
  repeat: boolean;
  keyCode?: number;
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
}

/**
 * Keys pressed on their own that are the operating system's: modifiers and locks (Caps Lock switches the input
 * language on iPadOS and macOS when set to), the Globe/fn key, and the input-method keys of Korean, Japanese and
 * Chinese keyboards (UI Events `key` values; `Lang1`–`Lang5` codes: 한/영, 한자, かな, 英数).
 */
const SYSTEM_KEYS: Record<string, true> = Object.fromEntries(
  ("Shift Control Alt AltGraph Meta OS Super Hyper Fn FnLock Symbol SymbolLock CapsLock NumLock ScrollLock " +
    "Unidentified Process Convert NonConvert ModeChange AllCandidates PreviousCandidate NextCandidate SingleCandidate " +
    "CodeInput GroupFirst GroupLast GroupNext GroupPrevious HangulMode HanjaMode JunjaMode FinalMode KanaMode " +
    "KanjiMode Eisu Hiragana Katakana HiraganaKatakana Romaji Zenkaku Hankaku ZenkakuHankaku Alphanumeric")
    .split(" ").map((k) => [k, true]),
);
const SYSTEM_CODES: Record<string, true> = {
  Fn: true,
  FnLock: true,
  Lang1: true,
  Lang2: true,
  Lang3: true,
  Lang4: true,
  Lang5: true,
};

let appleTouch: boolean | undefined;

/** iPadOS or iOS: an iPhone/iPad user agent, or the Mac one iPadOS sends by default, with touch points. */
export function isAppleTouch(): boolean {
  if (appleTouch === undefined) {
    const nav = typeof navigator === "object" ? navigator : undefined;
    const ua = nav?.userAgent ?? "";
    appleTouch = /\b(iPad|iPhone|iPod)\b/.test(ua) || (/\bMacintosh\b/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
  }
  return appleTouch;
}

/**
 * A key the operating system keeps: a device neither sends it anywhere nor cancels its default action, so the OS
 * still switches its input language or keyboard with it. The {@link SYSTEM_KEYS} pressed on their own, and on an
 * iPad or iPhone Ctrl+Space (with Shift or Option too), iPadOS's next-input-language chord. iPadOS takes that chord
 * before the page whenever the focused field has a keyboard session; a page sees it only when the field has none (it
 * was read-only when it got the focus), and a terminal then types no NUL for it. Desktop systems take their switch
 * chords before a page sees them, so there a Ctrl+Space that arrives is a key (NUL in a terminal, `ctrl-space`).
 */
export function systemKey(e: KeySource, onAppleTouch = isAppleTouch()): boolean {
  if (Object.hasOwn(SYSTEM_KEYS, e.key) || Object.hasOwn(SYSTEM_CODES, e.code)) return true;
  return onAppleTouch && e.ctrlKey && !e.metaKey && (e.code === "Space" || e.key === " ");
}

/** A Hangul jamo: what a key of a Korean layout is before the input method composes it. */
const JAMO = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]$/;

/**
 * A key pressed for an input method: one in a composition (`isComposing`), one the input method took (`keyCode`
 * 229, as macOS WebKit reports every jamo its Korean input edits in place), or a jamo key without Ctrl/⌘ (iPadOS's
 * hardware-keyboard Korean input reports `key: "ㄱ"`, `keyCode` 82, and composes it from the input events that
 * follow). Its text arrives as input events; the key itself is nobody's: never sent, never cancelled.
 */
export function imeKey(e: KeySource): boolean {
  if (e.isComposing === true || e.nativeEvent?.isComposing === true || e.keyCode === 229) return true;
  return JAMO.test(e.key) && !e.ctrlKey && !e.metaKey;
}

export function modifiersOf(e: ModifierSource): Modifiers {
  return {
    shift: e.shiftKey,
    control: e.ctrlKey,
    alt: e.altKey,
    platform: e.metaKey,
    function: e.getModifierState("Fn"),
  };
}

/** `KeyboardEvent.key` values with a GPUI name. */
const NAMED_KEYS: Record<string, string> = {
  Enter: "enter",
  Escape: "escape",
  Backspace: "backspace",
  Delete: "delete",
  Tab: "tab",
  " ": "space",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  PageUp: "pageup",
  PageDown: "pagedown",
  Home: "home",
  End: "end",
  Insert: "insert",
};

/** Modifier keys: their own presses are modifier changes (`on_modifiers_changed`), never key presses. */
const MODIFIER_KEYS: Record<string, string> = {
  Shift: "shift",
  Control: "control",
  Alt: "alt",
  Meta: "platform",
  Fn: "function",
};

/** US-layout characters by `KeyboardEvent.code`, unshifted and shifted. */
const US_KEYS: Record<string, readonly [string, string]> = {
  Digit1: ["1", "!"],
  Digit2: ["2", "@"],
  Digit3: ["3", "#"],
  Digit4: ["4", "$"],
  Digit5: ["5", "%"],
  Digit6: ["6", "^"],
  Digit7: ["7", "&"],
  Digit8: ["8", "*"],
  Digit9: ["9", "("],
  Digit0: ["0", ")"],
  Minus: ["-", "_"],
  Equal: ["=", "+"],
  BracketLeft: ["[", "{"],
  BracketRight: ["]", "}"],
  Backslash: ["\\", "|"],
  Semicolon: [";", ":"],
  Quote: ["'", '"'],
  Comma: [",", "<"],
  Period: [".", ">"],
  Slash: ["/", "?"],
  Backquote: ["`", "~"],
};

/** The US-layout character at `code`, or `undefined` for keys off that table. */
function usKey(code: string, shift: boolean): string | undefined {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1].toLowerCase();
  return Object.hasOwn(US_KEYS, code) ? US_KEYS[code][shift ? 1 : 0] : undefined;
}

/** The binding spelling of `key` under `m` (`Keystroke::unparse`). */
export function unparse(m: Modifiers, key: string): string {
  let s = "";
  if (m.function) s += "fn-";
  if (m.control) s += "ctrl-";
  if (m.alt) s += "alt-";
  if (m.platform) s += "cmd-";
  if (m.shift) s += "shift-";
  return s + key;
}

/** gpui-kit `KeyEvent` (`event.data` of kind `key`). */
export interface KeyPayload {
  key: string;
  keystroke: string;
  modifiers: Modifiers;
  key_char?: string;
  is_held?: boolean;
}

/** The `KeyEvent` of a key press or release, or `null` for presses GPUI does not report as keys. */
export function keyPayload(e: KeySource, down: boolean): KeyPayload | null {
  if (imeKey(e) || systemKey(e)) return null;
  const modifiers = modifiersOf(e);
  const held = down ? { is_held: e.repeat } : {};
  let key = Object.hasOwn(NAMED_KEYS, e.key) ? NAMED_KEYS[e.key] : undefined;
  const fn = /^F([1-9]|[12][0-9]|3[0-5])$/.exec(e.key);
  if (key === undefined && fn) key = `f${fn[1]}`;
  if (key !== undefined) {
    const typed = key === "space" && !modifiers.control && !modifiers.platform ? { key_char: " " } : {};
    return { key, keystroke: unparse(modifiers, key), modifiers, ...typed, ...held };
  }
  // Modifier-only presses, media keys, `Dead`, `Process`, `Unidentified`: not keys.
  if ([...e.key].length !== 1) return null;
  const commands = modifiers.control || modifiers.platform;
  // deno-lint-ignore no-control-regex
  const latin = /^[\x00-\x7f]$/.test(e.key);
  const ch = modifiers.alt || (commands && !latin) ? usKey(e.code, modifiers.shift) ?? e.key : e.key;
  const lower = ch.toLowerCase();
  const isLetter = lower !== ch.toUpperCase();
  const strokeModifiers = isLetter ? modifiers : { ...modifiers, shift: false };
  const typed = commands ? {} : { key_char: e.key };
  const name = isLetter ? lower : ch;
  return { key: name, keystroke: unparse(strokeModifiers, name), modifiers: strokeModifiers, ...typed, ...held };
}

/** A modifier key's own press or release, for `on_modifiers_changed`; `null` for every other key. */
export function modifierPayload(e: KeySource): KeyPayload | null {
  if (!Object.hasOwn(MODIFIER_KEYS, e.key)) return null;
  const modifiers = modifiersOf(e);
  return { key: MODIFIER_KEYS[e.key], keystroke: unparse(modifiers, "").replace(/-$/, ""), modifiers };
}

// ---------------------------------------------------------------------------------------------------------------------
// Pointer payloads.

interface Point {
  x: number;
  y: number;
}

export interface Placed {
  position: Point;
  local_position: Point;
  bounds: { x: number; y: number; width: number; height: number };
}

/** Where a pointer event happened: in the window, and against `el`'s box. */
export function placed(e: { clientX: number; clientY: number }, el: Element): Placed {
  const r = el.getBoundingClientRect();
  return {
    position: { x: e.clientX, y: e.clientY },
    local_position: { x: e.clientX - r.left, y: e.clientY - r.top },
    bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
  };
}

export type Button = "left" | "middle" | "right";

/** `PointerEvent.button` → gpui-kit `MouseButton` (other buttons are not GPUI buttons). */
export function buttonOf(button: number): Button | null {
  return button === 0 ? "left" : button === 1 ? "middle" : button === 2 ? "right" : null;
}

const MULTI_PRESS_MS = 500;
const MULTI_PRESS_SLOP = 6;
let lastPress = { at: -Infinity, x: 0, y: 0, button: "", count: 0 };
const pressCounts = new WeakMap<Event, number>();

/**
 * The press count of a pointer press (`click_count`: 2 on a double press). Pointer events carry none, so presses of
 * one button within 500 ms and 6 px of the previous one count up. Every listener of one press gets the same count.
 */
export function pressCount(e: PointerEvent, button: Button): number {
  const known = pressCounts.get(e);
  if (known !== undefined) return known;
  const near = Math.abs(e.clientX - lastPress.x) <= MULTI_PRESS_SLOP &&
    Math.abs(e.clientY - lastPress.y) <= MULTI_PRESS_SLOP;
  const again = button === lastPress.button && e.timeStamp - lastPress.at <= MULTI_PRESS_MS && near;
  lastPress = { at: e.timeStamp, x: e.clientX, y: e.clientY, button, count: again ? lastPress.count + 1 : 1 };
  pressCounts.set(e, lastPress.count);
  return lastPress.count;
}

/** The count of the press a release ends. */
export function releaseCount(button: Button): number {
  return lastPress.button === button ? lastPress.count : 1;
}

/**
 * One DOM event reaches only the innermost element listening for it, per kind: GPUI lets an inner handler stop
 * propagation, and a device cannot learn whether it did. Returns `true` for the first claim of `kind` on `e`.
 */
const claims = new WeakMap<Event, Set<string>>();
export function claim(e: Event, kind: string): boolean {
  let seen = claims.get(e);
  if (!seen) {
    seen = new Set();
    claims.set(e, seen);
  }
  if (seen.has(kind)) return false;
  seen.add(kind);
  return true;
}
