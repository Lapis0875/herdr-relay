/**
 * A terminal's typing lifecycle on a touch screen (`widgets/terminal/TerminalView.tsx` with `ime.ts`), mounted with
 * react-dom on the in-memory document (`fake_dom.ts`). xterm itself needs a real DOM (and Deno resolves its CommonJS
 * build), so the view gets a stand-in that keeps what the input layer depends on: `input()` fires `onData` at once,
 * as xterm's `CoreService.triggerDataEvent` does; `blur()` takes the focus from its textarea, firing `focusout`; the
 * textarea sends inserted text itself unless the input layer stops it, Enter as CR unless the custom key handler
 * refuses the key, and a composition's text from the textarea after it ends (`CompositionHelper`). The Korean input
 * is WebKit's: no composition events, each syllable inserted and then rewritten in place (xterm.js #6284).
 */

import { assert, assertEquals } from "@std/assert";
import { delay } from "@std/async";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { blankState, initStore } from "../src/app/store.ts";
import type { TerminalSink, TerminalSource } from "../src/widgets/terminal/stream.ts";
import { TerminalView, type XtermModules, xtermModules } from "../src/widgets/terminal/TerminalView.tsx";
import { elementsWhere, type FakeElement, fire, installDom, quietly } from "./fake_dom.ts";

const { doc } = installDom((query) => query === "(pointer: coarse)");

interface Disposable {
  dispose(): void;
}

class Emitter<T> {
  readonly #listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): Disposable => {
    this.#listeners.add(listener);
    return { dispose: () => void this.#listeners.delete(listener) };
  };
  fire(value: T): void {
    for (const listener of this.#listeners) listener(value);
  }
}

/** The part of xterm's `Terminal` the view and its input layer use. */
class FakeTerminal {
  readonly options: Record<string, unknown>;
  readonly unicode = { activeVersion: "" };
  readonly buffer = { active: { cursorX: 0, cursorY: 0 } };
  readonly modes = { applicationCursorKeysMode: false };
  cols = 80;
  rows = 24;
  element: FakeElement | undefined;
  textarea: FakeElement | undefined;
  readonly #data = new Emitter<string>();
  readonly onData = this.#data.event;
  readonly onKey = new Emitter<{ key: string; domEvent: Event }>().event;
  readonly onRender = new Emitter<void>().event;
  readonly onWriteParsed = new Emitter<void>().event;
  constructor(options: Record<string, unknown>) {
    this.options = { ...options };
  }
  loadAddon(): void {}
  #keyHandler: (e: KeyboardEvent) => boolean = () => true;
  attachCustomKeyEventHandler(handler: (e: KeyboardEvent) => boolean): void {
    this.#keyHandler = handler;
  }
  open(parent: FakeElement): void {
    const element = doc.createElement("div");
    element.className = "terminal xterm";
    const helpers = element.appendChild(doc.createElement("div"));
    helpers.className = "xterm-helpers";
    const textarea = helpers.appendChild(doc.createElement("textarea"));
    textarea.className = "xterm-helper-textarea";
    helpers.appendChild(doc.createElement("div")).className = "composition-view";
    element.appendChild(doc.createElement("div")).className = "xterm-screen";
    // xterm's own `insertText` handling: text an input method inserts is sent as it arrives.
    textarea.addEventListener("input", (e) => {
      const { inputType, data, isComposing } = e as InputEvent;
      if (inputType === "insertText" && data && !isComposing) this.input(data);
    });
    // Its key handling, for Enter: after the custom key handler, CR.
    textarea.addEventListener("keydown", (e) => {
      if (this.#keyHandler(e as KeyboardEvent) && (e as KeyboardEvent).key === "Enter") this.input("\r");
    });
    // Its composition helper: what the composition added to the textarea, read once the end has been handled.
    let start = 0;
    textarea.addEventListener("compositionstart", () => (start = textarea.value.length));
    textarea.addEventListener("compositionend", () => {
      setTimeout(() => {
        const text = textarea.value.substring(start);
        if (text) this.input(text);
      });
    });
    parent.appendChild(element);
    this.element = element;
    this.textarea = textarea;
  }
  /** `CoreService.triggerDataEvent`: `onData` hears it before this returns. */
  input(data: string): void {
    this.#data.fire(data);
  }
  write(): void {}
  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }
  focus(): void {
    this.textarea?.focus();
  }
  blur(): void {
    this.textarea?.blur();
  }
  dispose(): void {
    this.element?.parentNode?.removeChild(this.element);
  }
}

xtermModules.load = () =>
  Promise.resolve([{ Terminal: FakeTerminal }, { Unicode11Addon: class {} }] as unknown as XtermModules);

interface Mounted {
  root: Root;
  /** What reached the Mac, one entry per `source.type`. */
  sent: string[];
  sink: TerminalSink;
  area: FakeElement;
  /** xterm's composition view: the syllable held (not sent yet). */
  held: FakeElement;
  /** The keyboard toggle. */
  toggle: () => FakeElement;
}

/** A terminal an `act` device follows on a touch screen, live. */
async function mount(): Promise<Mounted> {
  initStore(blankState("phone"));
  const container = doc.body.appendChild(doc.createElement("div"));
  const root = createRoot(container as unknown as Element);
  const sent: string[] = [];
  let sink: TerminalSink | null = null;
  const decoder = new TextDecoder();
  const source: TerminalSource = {
    attach(s) {
      sink = s;
      s.size(80, 24);
      s.status({ kind: "live", typing: false });
      return () => {};
    },
    type(bytes) {
      sent.push(decoder.decode(bytes));
      return Promise.resolve(true);
    },
  };
  // A thenable callback: act keeps flushing until the view has loaded its terminal (a promise) and attached the source.
  await act(() => {
    root.render(<TerminalView source={source} label="Terminal t1" canType stale={false} />);
    return Promise.resolve();
  });
  assert(sink, "the view attached its source");
  const area = elementsWhere(container, (el) => el.classList.contains("xterm-helper-textarea"))[0];
  const held = elementsWhere(container, (el) => el.classList.contains("composition-view"))[0];
  const toggle = () => elementsWhere(container, (el) => el.classList.contains("w-term__button--icon"))[0];
  return { root, sent, sink, area, held, toggle };
}

type Step = readonly [inputType: string, data: string, key: string, code: string];
/** 간 and 나 as WebKit's Korean 2-Set input types them: each input, then its keyCode-229 keydown. */
const GAN: readonly Step[] = [
  ["insertText", "ㄱ", "ㄱ", "KeyR"],
  ["insertReplacementText", "가", "ㅏ", "KeyK"],
  ["insertReplacementText", "간", "ㄴ", "KeyS"],
];
const NA: readonly Step[] = [["insertText", "ㄴ", "ㄴ", "KeyS"], ["insertReplacementText", "나", "ㅏ", "KeyK"]];

/** A keydown and keyup at `area`, as the DOM reports them. */
function press(area: FakeElement, key: string, code: string, keyCode: number): void {
  const init = {
    key,
    code,
    keyCode,
    isComposing: false,
    repeat: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    getModifierState: () => false,
  };
  fire(area, "keydown", init);
  fire(area, "keyup", init);
}

function korean(area: FakeElement, steps: readonly Step[]): void {
  for (const [inputType, data, key, code] of steps) {
    fire(area, "input", { inputType, data, isComposing: false });
    press(area, key, code, 229);
  }
}

/** A composition of `text` at `area` (Chromium's order), the textarea's value written as the browser writes it. */
function compose(area: FakeElement, text: string, phase: "start" | "end" | "whole"): void {
  if (phase !== "end") {
    fire(area, "compositionstart", { data: "" });
    area.value += text;
    fire(area, "compositionupdate", { data: text });
    fire(area, "input", { inputType: "insertCompositionText", data: text, isComposing: true });
  }
  if (phase !== "start") fire(area, "compositionend", { data: text });
}

/** Until xterm's composition helper and the input layer have run their timers. */
const settle = () => delay(10);

Deno.test("terminal: Hide keyboard sends the syllable still being typed exactly once, then nothing", async () => {
  await quietly(async () => {
    const { root, sent, area, held, toggle } = await mount();
    assertEquals(toggle().getAttribute("aria-label"), "Type into this terminal");
    await act(() => void fire(toggle(), "click"));
    assertEquals(toggle().getAttribute("aria-label"), "Hide keyboard");
    assertEquals(doc.activeElement, area, "typing focuses the terminal");

    await act(() => korean(area, GAN));
    assertEquals(sent, [], "the syllable is still open");
    assertEquals(held.textContent, "간");

    await act(() => void fire(toggle(), "click"));
    assertEquals(sent, ["간"]);
    assertEquals(toggle().getAttribute("aria-label"), "Type into this terminal");
    assert(doc.activeElement !== area, "the keyboard went with the focus");
    assertEquals(held.textContent, "", "nothing is held any more");

    // Nothing after: the focus coming and going, and text an input method inserts while the terminal is not typing.
    await act(() => {
      area.focus();
      area.blur();
      fire(area, "input", { inputType: "insertText", data: "ㄴ", isComposing: false });
      area.focus();
      area.blur();
    });
    assertEquals(sent, ["간"]);
    await act(() => root.unmount());
  });
});

Deno.test("terminal: a syllable open when typing stops being possible is dropped; live again, the next key sends only itself", async () => {
  await quietly(async () => {
    const { root, sent, sink, area, held, toggle } = await mount();
    await act(() => void fire(toggle(), "click"));
    await act(() => korean(area, GAN));
    assertEquals(held.textContent, "간");

    await act(() => sink.status({ kind: "offline" }));
    assertEquals(toggle().getAttribute("aria-pressed"), "false", "typing stopped");
    assert(toggle().hasAttribute("disabled"));
    assertEquals(held.textContent, "", "dropped, unsent");

    // Back without a blur: the key that starts typing again sends itself, not the old syllable.
    await act(() => sink.status({ kind: "live", typing: false }));
    assertEquals(doc.activeElement, area, "the terminal kept the focus");
    await act(() => press(area, "Enter", "Enter", 13));
    assertEquals(sent, ["\r"]);
    // What is typed now goes, once.
    await act(() => {
      korean(area, NA);
      press(area, "Enter", "Enter", 13);
    });
    assertEquals(sent, ["\r", "나", "\r"]);
    await act(() => root.unmount());
  });
});

Deno.test("terminal: what is typed while typing is not possible is never sent, not even once it is", async () => {
  await quietly(async () => {
    const { root, sent, sink, area, held, toggle } = await mount();
    await act(() => void fire(toggle(), "click"));
    await act(() => sink.status({ kind: "offline" }));
    await act(() => korean(area, GAN));
    assertEquals(held.textContent, "", "nothing held");
    assertEquals(sent, []);

    await act(() => sink.status({ kind: "live", typing: false }));
    await act(() => press(area, "Enter", "Enter", 13));
    assertEquals(sent, ["\r"]);
    // WebKit's input before the keydown that starts typing again is held and sent.
    await act(() => sink.status({ kind: "offline" }));
    await act(() => sink.status({ kind: "live", typing: false }));
    await act(() => {
      korean(area, NA);
      press(area, "Enter", "Enter", 13);
    });
    assertEquals(sent, ["\r", "나", "\r"]);
    await act(() => area.blur());
    assertEquals(sent, ["\r", "나", "\r"]);
    await act(() => root.unmount());
  });
});

Deno.test("terminal: a composition typed while typing is not possible sends nothing when it ends", async () => {
  await quietly(async () => {
    const { root, sent, sink, area, toggle } = await mount();
    await act(() => void fire(toggle(), "click"));
    await act(async () => {
      compose(area, "日本", "whole");
      await settle();
    });
    assertEquals(sent, ["日本"], "a composition while typing is possible goes once");

    // Under way when the stream goes offline, ended once it is back and typing again (the toggle, as on a phone).
    await act(() => compose(area, "語", "start"));
    await act(() => sink.status({ kind: "offline" }));
    await act(() => sink.status({ kind: "live", typing: false }));
    await act(() => void fire(toggle(), "click"));
    assertEquals(toggle().getAttribute("aria-pressed"), "true");
    await act(async () => {
      compose(area, "語", "end");
      await settle();
    });
    assertEquals(sent, ["日本"], "under way when typing stopped");
    // Begun while offline, ended once it is back and typing again.
    await act(() => sink.status({ kind: "offline" }));
    await act(() => compose(area, "かな", "start"));
    await act(() => sink.status({ kind: "live", typing: false }));
    await act(() => void fire(toggle(), "click"));
    await act(async () => {
      compose(area, "かな", "end");
      await settle();
    });
    assertEquals(sent, ["日本"], "begun while typing was not possible");

    // The next one goes again.
    await act(async () => {
      compose(area, "漢字", "whole");
      await settle();
    });
    assertEquals(sent, ["日本", "漢字"]);
    await act(() => root.unmount());
  });
});
