/**
 * Keyboard diagnostics (`app/ui/KeyboardDiagnostics.tsx`) never keep what is typed: the lines name the keys that type
 * nothing, and give a character key only its kind and an input's text only its length and kind. Checked on the pure
 * line ({@link describeEvent}) and on the mounted overlay, whose shown and copied text a typed secret never reaches.
 */

import { assert, assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describeEvent, KeyboardDiagnostics, setKeyboardDiagnostics } from "../src/app/ui/KeyboardDiagnostics.tsx";
import { elementsWhere, fire, installDom, quietly } from "./fake_dom.ts";

const { doc, storage } = installDom();
let copied: string | null = null;
Object.defineProperty(navigator, "clipboard", {
  configurable: true,
  value: {
    writeText(text: string) {
      copied = text;
      return Promise.resolve();
    },
  },
});

/** A keydown as a DOM `KeyboardEvent` reports it. */
function keydown(key: string, code: string, init: Record<string, unknown> = {}) {
  return {
    type: "keydown",
    key,
    code,
    keyCode: 0,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    repeat: false,
    isComposing: false,
    getModifierState: () => false,
    ...init,
  };
}

Deno.test("diagnostics: keys that type nothing keep their names", () => {
  const capsOn = { getModifierState: (k: string) => k === "CapsLock" };
  assertEquals(
    describeEvent(keydown("CapsLock", "CapsLock", capsOn)),
    "keydown key=CapsLock code=CapsLock capslock-on",
  );
  assertEquals(
    describeEvent(keydown("Shift", "ShiftLeft", { shiftKey: true })),
    "keydown key=Shift code=ShiftLeft shift",
  );
  assertEquals(describeEvent(keydown("Meta", "MetaLeft", { metaKey: true })), "keydown key=Meta code=MetaLeft cmd");
  // iPadOS: Ctrl+Space switches the input language; Globe/fn and 한/영.
  assertEquals(describeEvent(keydown(" ", "Space", { ctrlKey: true })), "keydown key=Space code=Space ctrl");
  assertEquals(describeEvent(keydown("Unidentified", "Fn")), "keydown key=Unidentified code=Fn");
  assertEquals(describeEvent(keydown("Fn", "Fn")), "keydown key=Fn code=Fn");
  assertEquals(describeEvent(keydown("HangulMode", "Lang1")), "keydown key=HangulMode code=Lang1");
  assertEquals(describeEvent(keydown("HanjaMode", "Lang2")), "keydown key=HanjaMode code=Lang2");
  for (const name of ["Enter", "Tab", "Escape", "Backspace", "ArrowLeft", "ArrowUp", "F5", "F12"]) {
    assertEquals(describeEvent(keydown(name, name, { repeat: true })), `keydown key=${name} code=${name} repeat`);
  }
  assertEquals(describeEvent({ type: "focusin" }), "focusin");
});

Deno.test("diagnostics: a character key is its kind, an input's text its length and kind", () => {
  // WebKit's Korean input: the jamo as the key, keyCode 229; iPadOS's hardware keyboard: its real keyCode.
  assertEquals(describeEvent(keydown("ㄱ", "KeyR", { keyCode: 229 })), "keydown key=jamo code=char kc=229");
  assertEquals(describeEvent(keydown("ㄱ", "KeyR", { keyCode: 82 })), "keydown key=jamo code=char");
  assertEquals(describeEvent(keydown("Process", "KeyA", { keyCode: 229 })), "keydown key=Process code=char kc=229");
  assertEquals(describeEvent(keydown("가", "KeyR", { isComposing: true })), "keydown key=hangul code=char composing");
  assertEquals(describeEvent(keydown("h", "KeyH", { keyCode: 72 })), "keydown key=char code=char");
  assertEquals(describeEvent(keydown("2", "Digit2", { keyCode: 50 })), "keydown key=char code=char");
  assertEquals(describeEvent(keydown("v", "KeyV", { keyCode: 86, metaKey: true })), "keydown key=char code=char cmd");
  assertEquals(describeEvent(keydown(" ", "Space", { keyCode: 32 })), "keydown key=char code=char", "Space types");
  assertEquals(describeEvent(keydown("", "")), "keydown key=- code=-");

  const input = (type: string, inputType: string, data: string | null, isComposing = false) => ({
    type,
    inputType,
    data,
    isComposing,
  });
  assertEquals(describeEvent(input("input", "insertText", "ㄱ")), "input type=insertText data=1:jamo");
  assertEquals(
    describeEvent(input("input", "insertReplacementText", "간")),
    "input type=insertReplacementText data=1:hangul",
  );
  assertEquals(
    describeEvent(input("beforeinput", "insertFromPaste", "hunter2")),
    "beforeinput type=insertFromPaste data=7:char",
  );
  assertEquals(describeEvent(input("input", "insertText", "a간")), "input type=insertText data=2:mixed");
  assertEquals(
    describeEvent(input("input", "deleteContentBackward", null, true)),
    "input type=deleteContentBackward data=null composing",
  );
  assertEquals(describeEvent({ type: "compositionstart", data: "" }), "compositionstart data=0");
  assertEquals(describeEvent({ type: "compositionupdate", data: "비밀" }), "compositionupdate data=2:hangul");
});

/** What a person typing `hunter2` then `비밀` (WebKit's Korean input, then a Chromium composition) fires at the page. */
function typeSecrets(): void {
  for (
    const [key, code, keyCode] of [
      ["h", "KeyH", 72],
      ["u", "KeyU", 85],
      ["n", "KeyN", 78],
      ["t", "KeyT", 84],
      [
        "e",
        "KeyE",
        69,
      ],
      ["r", "KeyR", 82],
      ["2", "Digit2", 50],
    ] as const
  ) {
    fire(globalThis, "keydown", keydown(key, code, { keyCode }));
    fire(globalThis, "beforeinput", { inputType: "insertText", data: key, isComposing: false });
    fire(globalThis, "input", { inputType: "insertText", data: key, isComposing: false });
    fire(globalThis, "keyup", { ...keydown(key, code, { keyCode }), type: "keyup" });
  }
  fire(globalThis, "input", { inputType: "insertFromPaste", data: "hunter2", isComposing: false });
  for (
    const [inputType, data, key, code] of [
      ["insertText", "ㅂ", "ㅂ", "KeyQ"],
      ["insertReplacementText", "비", "ㅣ", "KeyL"],
      ["insertText", "ㅁ", "ㅁ", "KeyA"],
      ["insertReplacementText", "미", "ㅣ", "KeyL"],
      ["insertReplacementText", "밀", "ㄹ", "KeyF"],
    ]
  ) {
    fire(globalThis, "input", { inputType, data, isComposing: false });
    fire(globalThis, "keydown", keydown(key, code, { keyCode: 229 }));
  }
  for (const data of ["ㅂ", "비", "빌", "비밀"]) fire(globalThis, "compositionupdate", { data });
  fire(globalThis, "compositionend", { data: "비밀" });
  fire(globalThis, "input", { inputType: "insertFromComposition", data: "비밀", isComposing: false });
  fire(globalThis, "keydown", keydown("Enter", "Enter", { keyCode: 13 }));
}

/** No trace of the secrets: neither the text, its characters' keys, nor their codes and key codes. */
function assertNoSecrets(text: string): void {
  for (const secret of ["hunter2", "비밀", "비", "밀", "ㅂ", "ㅁ", "ㄹ", "KeyH", "KeyQ", "Digit2", "kc=72", "kc=50"]) {
    assert(!text.includes(secret), `${JSON.stringify(secret)} in\n${text}`);
  }
  assertEquals(
    new Set(text.matchAll(/ key=(\S+)/g).map((m) => m[1])),
    new Set(["char", "jamo", "Enter"]),
    "key names",
  );
  assertEquals(
    new Set(text.matchAll(/ data=(\S+)/g).map((m) => m[1])),
    new Set(["1:char", "7:char", "1:jamo", "1:hangul", "2:hangul"]),
    "texts",
  );
  assertEquals([...text.matchAll(/ kc=(\S+)/g).map((m) => m[1])].filter((kc) => kc !== "229"), [], "key codes");
}

Deno.test("diagnostics: a typed secret is neither shown nor copied, and the switch is not kept", async () => {
  await quietly(async () => {
    const time = new FakeTime();
    try {
      const field = doc.body.appendChild(doc.createElement("textarea"));
      field.className = "xterm-helper-textarea";
      field.focus();
      const container = doc.body.appendChild(doc.createElement("div"));
      const root = createRoot(container as unknown as Element);
      await act(() => root.render(createElement(KeyboardDiagnostics)));
      assertEquals(container.childNodes.length, 0, "off: nothing shown");
      typeSecrets();
      await act(() => time.tickAsync(0));

      await act(() => setKeyboardDiagnostics(true));
      assertEquals(storage.length, 0, "the switch is this page's only");
      typeSecrets();
      // Each line is written once every listener has run.
      await act(() => time.tickAsync(0));
      const log = elementsWhere(container, (el) => el.tagName === "PRE")[0];
      const shown = log.textContent;
      assert(shown.includes("keydown key=char code=char @ TEXTAREA.xterm-helper-textarea"), shown);
      assert(shown.includes("keydown key=jamo code=char kc=229 @ TEXTAREA.xterm-helper-textarea"), shown);
      assertNoSecrets(shown);

      const copy = elementsWhere(container, (el) => el.tagName === "BUTTON" && el.textContent === "Copy")[0];
      await act(async () => {
        fire(copy, "click");
        await time.runMicrotasks();
      });
      assert(copied !== null, "Copy wrote the clipboard");
      assert(copied.startsWith("herdr-relay keyboard diagnostics"), copied);
      assert(copied.includes("keydown key=Enter code=Enter"), copied);
      assertNoSecrets(copied);
      // The "Copied" note leaves after 2 s.
      await act(() => time.tickAsync(2_000));

      await act(() => setKeyboardDiagnostics(false));
      assertEquals(container.childNodes.length, 0, "off again");
      await act(() => root.unmount());
    } finally {
      time.restore();
    }
  });
});
