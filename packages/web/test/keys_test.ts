import { assert, assertEquals } from "@std/assert";
import { imeKey, isAppleTouch, keyPayload, systemKey } from "../src/render/events.ts";

/** A keydown as the DOM reports it (`keyCode` 0 unless given). */
function press(key: string, code: string, init: Partial<KeyboardEventInit & { keyCode: number }> = {}) {
  return {
    key,
    code,
    repeat: false,
    keyCode: init.keyCode ?? 0,
    isComposing: init.isComposing ?? false,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    altKey: init.altKey ?? false,
    metaKey: init.metaKey ?? false,
    getModifierState: () => false,
  };
}

Deno.test("the language and modifier keys are the operating system's on every device", () => {
  for (
    const [key, code] of [
      ["CapsLock", "CapsLock"],
      ["Shift", "ShiftLeft"],
      ["Control", "ControlLeft"],
      ["Meta", "MetaLeft"],
      ["Fn", "Fn"],
      ["Unidentified", "Fn"],
      ["HangulMode", "Lang1"],
      ["HanjaMode", "Lang2"],
      ["Eisu", "Lang2"],
    ]
  ) {
    assert(systemKey(press(key, code), false), `${key} (${code}) on a desktop`);
    assert(systemKey(press(key, code), true), `${key} (${code}) on an iPad`);
  }
  for (const [key, code] of [["a", "KeyA"], [" ", "Space"], ["Enter", "Enter"], ["ㅇ", "KeyD"]]) {
    assert(!systemKey(press(key, code), true), `${key} is a key`);
  }
});

Deno.test("Ctrl+Space switches the input language on an iPad, and is a key on a desktop", () => {
  for (const mods of [{ ctrlKey: true }, { ctrlKey: true, shiftKey: true }, { ctrlKey: true, altKey: true }]) {
    assert(systemKey(press(" ", "Space", mods), true), JSON.stringify(mods));
    assert(!systemKey(press(" ", "Space", mods), false), JSON.stringify(mods));
  }
  assert(!systemKey(press(" ", "Space", { ctrlKey: true, metaKey: true }), true), "⌘ chords stay keys");
  assert(!systemKey(press(" ", "Space"), true), "Space alone types");
  assertEquals(keyPayload(press(" ", "Space", { ctrlKey: true }), true)?.keystroke, "ctrl-space", "desktop");
  assertEquals(isAppleTouch(), false, "Deno is no iPad");
});

Deno.test("keys an input method takes are nobody's: never a GPUI key", () => {
  // WebKit's Korean input: keyCode 229 with the jamo as the key, `isComposing` false.
  const jamo = press("ㄱ", "KeyR", { keyCode: 229 });
  assert(imeKey(jamo));
  assertEquals(keyPayload(jamo, true), null);
  const composing = press("ㅏ", "KeyK", { isComposing: true });
  assert(imeKey(composing));
  assertEquals(keyPayload(composing, true), null);
  assert(imeKey({ ...press("a", "KeyA"), nativeEvent: { isComposing: true } }), "React: the native event's flag");
  // iPadOS hardware-keyboard Korean input (seen in the iOS 27 simulator): the jamo as the key, its real keyCode.
  const ipadJamo = press("ㄱ", "KeyR", { keyCode: 82 });
  assert(imeKey(ipadJamo));
  assertEquals(keyPayload(ipadJamo, true), null);
  assert(!imeKey(press("ㄱ", "KeyR", { keyCode: 82, ctrlKey: true })), "a Ctrl chord on a Korean layout is a key");
  assertEquals(keyPayload(press("ㄱ", "KeyR", { keyCode: 82, metaKey: true }), true)?.keystroke, "cmd-r");
  assert(!imeKey(press("a", "KeyA", { keyCode: 65 })));
  assertEquals(keyPayload(press("a", "KeyA", { keyCode: 65 }), true)?.keystroke, "a");
});
