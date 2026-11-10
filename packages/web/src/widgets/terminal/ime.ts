/**
 * What input methods type into a terminal, sent once and only when committed, and the keys a terminal leaves to the
 * operating system. Installed on an opened xterm; its listeners sit on the terminal element in the capture phase, so
 * they run before xterm's own on its textarea.
 *
 * - Keys the operating system keeps (`systemKey`: Caps Lock, Globe/fn, input-language keys, Ctrl+Space on an iPad,
 *   modifiers on their own) and keys an input method takes (`imeKey`: keyCode 229, `isComposing`) never reach xterm's
 *   key handling, which sends Ctrl+Space as NUL and cancels it: iPadOS then keeps its input language.
 * - A composition (Chromium; Japanese and Chinese input methods) is xterm's: its composition helper sends the text
 *   from the textarea when the composition ends. Text inserted meanwhile does not also go through xterm's own
 *   `insertText` path.
 * - WebKit's Korean input fires no composition events (WebKit bug 274700, xterm.js #6284): it inserts each new
 *   syllable (`insertText`) and rewrites it in place as later jamo arrive (`insertReplacementText`), the keyCode-229
 *   keydown after its input. The open syllable is held here and shown in xterm's composition view, and sent once it is
 *   done: when the next syllable or other text starts, a key of its own (Enter, Space, arrows, Ctrl chords…) is
 *   pressed, a composition starts, the terminal loses the focus or its view stops typing ({@link TerminalInput}).
 *   A syllable the input method takes back (Backspace on its last jamo) is never sent; an input method that deletes
 *   the syllable and inserts the next state instead works the same way.
 * - Any other text an input method inserts (a late `insertText` after a keyCode-229 keydown, as iOS commits a
 *   candidate; punctuation in Korean mode) is sent as it arrives: xterm drops it while the key is down.
 * - Nothing is kept while the view cannot type (offline, stale, read-only, refused: `setEnabled(false)`), so nothing
 *   typed then reaches the Mac once it can again. The open syllable is dropped unsent when typing becomes impossible,
 *   what an input method inserts meanwhile is dropped, and a composition under way then, or begun meanwhile, is
 *   cleared from the textarea when it ends, before xterm's composition helper reads it. While the view can type, the
 *   input before its keyCode-229 keydown is held as always, also when that keydown is the one that starts typing.
 */

import type { Terminal } from "@xterm/xterm";
import { imeKey, systemKey } from "../../render/events.ts";

/** One Hangul syllable or jamo: what WebKit's Korean input edits in place. */
const HANGUL = /^[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7a3\ud7b0-\ud7ff]$/;
const DEL = "\x7f";

/** The input layer of one terminal. */
export interface TerminalInput {
  /**
   * Sends the open syllable now, if any: a view that stops typing calls it first, while what is sent still reaches the
   * Mac (the blur that follows would send it after).
   */
  commit(): void;
  /**
   * Whether the view can type (initially not). Turned off, the open syllable is dropped unsent and nothing typed is
   * kept until it is turned on again.
   */
  setEnabled(enabled: boolean): void;
  /** Removes the input layer. */
  dispose(): void;
}

/** Installs the input layer on `xterm` (opened). */
export function attachTerminalInput(xterm: Terminal): TerminalInput {
  const host = xterm.element;
  if (!host) throw new Error("attachTerminalInput: the terminal is not open");
  const screen = host.querySelector<HTMLElement>(".xterm-screen");
  const view = host.querySelector<HTMLElement>(".composition-view");

  /** The Hangul syllable WebKit is still editing in place (not sent yet). */
  let pending: string | null = null;
  /** A composition is under way: xterm's composition helper owns its text. */
  let composing = false;
  /** A composition just ended: until xterm's helper has read the textarea, what was typed meanwhile is in it. */
  let settling = false;
  /** The key down was the input method's: xterm left it alone. */
  let imeDown = false;
  /** Text xterm sent on a keypress, whose `insertText` follows. */
  let echo: string | null = null;
  /** The view can type: what is typed may be held and sent. */
  let enabled = false;
  /** Part of the composition under way was typed while the view could not type: xterm's helper sends none of it. */
  let discard = false;

  const send = (text: string) => xterm.input(text, true);

  const place = () => {
    if (!view || !screen || xterm.cols === 0 || xterm.rows === 0) return;
    const width = screen.offsetWidth / xterm.cols;
    const height = screen.offsetHeight / xterm.rows;
    const cursor = xterm.buffer.active;
    view.style.left = `${Math.min(cursor.cursorX, xterm.cols - 1) * width}px`;
    view.style.top = `${cursor.cursorY * height}px`;
    view.style.height = `${height}px`;
    view.style.lineHeight = `${height}px`;
    view.style.fontFamily = xterm.options.fontFamily ?? "";
    view.style.fontSize = `${xterm.options.fontSize}px`;
  };

  /** Holds `text` as the open syllable, shown at the cursor in xterm's composition view as a composition shows. */
  const hold = (text: string | null) => {
    pending = text === "" ? null : text;
    if (!view) return;
    view.textContent = pending ?? "";
    if (pending === null) {
      view.classList.remove("active");
      return;
    }
    place();
    view.classList.add("active");
  };
  /** Sends the open syllable, if any. */
  const commit = () => {
    if (pending === null) return;
    const text = pending;
    hold(null);
    send(text);
  };

  xterm.attachCustomKeyEventHandler((e) => !imeKey(e) && !systemKey(e));
  const keyed = xterm.onKey(({ key, domEvent }) => {
    echo = domEvent.type === "keypress" ? key : null;
  });
  const rendered = xterm.onRender(() => {
    if (pending !== null) place();
  });

  const stop = new AbortController();
  const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void) =>
    host.addEventListener(type, fn, { capture: true, signal: stop.signal });

  on("keydown", (e) => {
    echo = null;
    imeDown = imeKey(e);
    // A key of its own ends the syllable before xterm sends the key.
    if (!imeDown && !systemKey(e)) commit();
  });
  on("keyup", () => {
    imeDown = false;
  });
  on("input", (e) => {
    const ev = e as InputEvent;
    if (composing || settling) {
      if (ev.inputType === "insertText") e.stopPropagation();
      return;
    }
    // Typed while the view cannot type: neither held nor sent (xterm's own `insertText` path included).
    if (!enabled) {
      if (ev.inputType === "insertText") e.stopPropagation();
      return;
    }
    switch (ev.inputType) {
      case "insertText": {
        e.stopPropagation();
        const text = ev.data ?? "";
        if (echo !== null && text === echo) {
          echo = null;
          return;
        }
        commit();
        if (HANGUL.test(text)) hold(text);
        else if (text !== "") send(text);
        return;
      }
      case "insertReplacementText":
        if (pending === null) return;
        e.stopPropagation();
        hold(ev.data ?? ev.dataTransfer?.getData("text/plain") ?? "");
        return;
      case "deleteContentBackward":
        if (pending !== null) {
          e.stopPropagation();
          hold(null);
        } else if (imeDown) send(DEL);
        return;
    }
  });
  on("compositionstart", () => {
    commit();
    composing = true;
    discard = !enabled;
  });
  on("compositionend", () => {
    composing = false;
    settling = true;
    // Emptied before xterm's helper reads it (its listener is the textarea's, after this one): it sends nothing.
    if (discard && xterm.textarea) xterm.textarea.value = "";
    discard = false;
    // After the helper's own `setTimeout(0)`, registered after this listener.
    setTimeout(() => setTimeout(() => (settling = false)));
  });
  on("focusout", commit);

  return {
    commit,
    setEnabled(next) {
      enabled = next;
      if (enabled) return;
      hold(null);
      if (composing) discard = true;
    },
    dispose() {
      stop.abort();
      keyed.dispose();
      rendered.dispose();
      xterm.attachCustomKeyEventHandler(() => true);
      hold(null);
    },
  };
}
