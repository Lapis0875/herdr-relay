// Key bindings (`cx.bind_keys`, gpui-kit `KeyBinding`) and the rules GPUI's `Window::dispatch_key_event` applies to a
// key press before any `on_key_down` listener hears it: keystroke, key-context and context-predicate parsing (GPUI's
// grammar), binding precedence (the deepest matching context first, then the binding installed last), chords of
// several strokes held as pending input, and the replay of pending strokes that complete no chord. Pure: `runtime.js`
// owns the keymap and each copy's pending input, finds the element path of a press and runs the listeners.

/** How long a pending chord prefix waits for its next stroke (GPUI). */
export const PENDING_INPUT_MS = 1000;

/** Modifier spellings → `Modifiers` field. `secondary` is GPUI's `cmd` on macOS, where Herdr runs. */
const MODIFIER_NAMES = Object.freeze({
  ctrl: "control",
  alt: "alt",
  shift: "shift",
  fn: "function",
  cmd: "platform",
  super: "platform",
  win: "platform",
  secondary: "platform",
});
/** A keystroke of modifiers only names the first of these that is set as its key, without that modifier (GPUI). */
const MODIFIER_KEYS = ["shift", "control", "alt", "platform", "function"];

/** Precedence of the predicate operators (GPUI); `!` binds tighter than all of them. */
const NOT_PRECEDENCE = 5;
const OPERATORS = [
  [">", 1, (parent, child) => ({ op: "child", parent, child })],
  ["&&", 3, (l, r) => ({ op: "and", l, r })],
  ["||", 2, (l, r) => ({ op: "or", l, r })],
  ["==", 4, (l, r) => equality("eq", l, r)],
  ["!=", 4, (l, r) => equality("ne", l, r)],
];

/** A run of GPUI identifier characters (alphanumeric, `_`, `-`). */
const IDENTIFIER = /^[\p{Alphabetic}\p{N}_-]*/u;

const noModifiers = () => ({ control: false, alt: false, shift: false, platform: false, function: false });
const lowerAscii = (s) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());
const skipSpace = (s) => s.replace(/^\s+/u, "");
const firstChar = (s) => JSON.stringify(String.fromCodePoint(s.codePointAt(0)));

// ---------------------------------------------------------------------------------------------------------------------
// Keystrokes.

/** GPUI `Keystroke::parse`: one stroke as a binding spells it (`"cmd-shift-s"`, `"escape"`, `"ctrl--"`, `"A"`). */
export function parseKeystroke(source) {
  const modifiers = noModifiers();
  let key = null;
  const parts = source.split("-");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const name = lowerAscii(part);
    if (Object.hasOwn(MODIFIER_NAMES, name)) {
      modifiers[MODIFIER_NAMES[name]] = true;
      continue;
    }
    if (i + 1 < parts.length) {
      const next = parts[i + 1];
      if (next === "" && source.endsWith("-")) {
        key = "-";
        break;
      }
      // `key->char`: the character only labels the binding; matching uses the key.
      if (next.length > 1 && next.startsWith(">")) {
        key = part;
        i++;
        continue;
      }
      throw new SyntaxError("the key must come last");
    }
    if (part.length === 1 && part >= "A" && part <= "Z") modifiers.shift = true;
    key = name;
  }
  if (key === null) {
    const modifier = MODIFIER_KEYS.find((m) => modifiers[m]);
    if (modifier !== undefined) {
      key = modifier;
      modifiers[modifier] = false;
    }
  }
  if (key === null || key === "") throw new SyntaxError("no key");
  return { key, modifiers };
}

/** A binding's chord: one keystroke or a whitespace-separated sequence (`"ctrl-k ctrl-s"`). */
export function parseKeystrokes(source) {
  const strokes = source.split(/\s+/u).filter((s) => s !== "");
  if (strokes.length === 0) throw new SyntaxError("no keystroke");
  return strokes.map(parseKeystroke);
}

/**
 * The stroke a device `KeyEvent` carries (`key`, `modifiers`; `key_char` is the character it types), or `null` when
 * `event` is not one.
 */
export function typedKeystroke(event) {
  if (event === null || typeof event !== "object" || typeof event.key !== "string") return null;
  const m = event.modifiers;
  if (m === null || typeof m !== "object") return null;
  const modifiers = {
    control: m.control === true,
    alt: m.alt === true,
    shift: m.shift === true,
    platform: m.platform === true,
    function: m.function === true,
  };
  const keyChar = typeof event.key_char === "string" && event.key_char !== "" ? event.key_char : null;
  return { key: event.key, modifiers, keyChar };
}

const sameModifiers = (a, b) =>
  a.control === b.control && a.alt === b.alt && a.shift === b.shift && a.platform === b.platform &&
  a.function === b.function;

/**
 * GPUI `Keystroke::should_match`: the typed stroke matches a binding's stroke by key and modifiers, or by the character
 * it types with only `ctrl`/`cmd` held (a typed `shift-/` that types `?` matches the binding `"?"`).
 */
function strokeMatches(typed, target) {
  if (typed.keyChar !== null && target.key === typed.keyChar) {
    const held = { ...noModifiers(), control: typed.modifiers.control, platform: typed.modifiers.platform };
    if (sameModifiers(target.modifiers, held)) return true;
  }
  return target.key === typed.key && sameModifiers(target.modifiers, typed.modifiers);
}

/** `null`: `typed` does not lead into chord `target`; `true`: it is a strict prefix of it; `false`: it is the chord. */
function matchStrokes(target, typed) {
  if (target.length < typed.length) return null;
  for (let i = 0; i < typed.length; i++) if (!strokeMatches(typed[i], target[i])) return null;
  return target.length > typed.length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Key contexts and context predicates.

/**
 * GPUI `KeyContext::parse`: what `key_context(...)` declares, whitespace-separated identifiers and `key=value` pairs
 * (`"Editor mode=full"`) → `Map` key → value (`null` for a bare identifier). Throws on anything else.
 */
export function parseKeyContext(source) {
  if (typeof source !== "string") throw new TypeError(`a key context is a string, not ${typeof source}`);
  const context = new Map();
  let rest = skipSpace(source);
  while (rest !== "") {
    const key = IDENTIFIER.exec(rest)[0];
    if (key === "") throw new SyntaxError(`unexpected ${firstChar(rest)}`);
    rest = skipSpace(rest.slice(key.length));
    if (rest.startsWith("=")) {
      rest = skipSpace(rest.slice(1));
      const value = IDENTIFIER.exec(rest)[0];
      if (value === "") throw new SyntaxError(`${key}= needs a value`);
      rest = skipSpace(rest.slice(value.length));
      context.set(key, value);
    } else if (!context.has(key)) {
      context.set(key, null);
    }
  }
  return context;
}

function equality(op, l, r) {
  if (l.op !== "id" || r.op !== "id") throw new SyntaxError("both sides of == and != must be identifiers");
  return { op, key: l.name, value: r.name };
}

function parsePrimary(source) {
  if (source === "") throw new SyntaxError("unexpected end");
  if (source.startsWith("(")) {
    const [pred, rest] = parseExpr(skipSpace(source.slice(1)), 0);
    if (!rest.startsWith(")")) throw new SyntaxError("expected a ')'");
    return [pred, skipSpace(rest.slice(1))];
  }
  if (source.startsWith("!")) {
    const [pred, rest] = parseExpr(skipSpace(source.slice(1)), NOT_PRECEDENCE);
    return [{ op: "not", pred }, rest];
  }
  const name = IDENTIFIER.exec(source)[0];
  if (name === "") throw new SyntaxError(`unexpected ${firstChar(source)}`);
  return [{ op: "id", name }, skipSpace(source.slice(name.length))];
}

function parseExpr(source, minPrecedence) {
  let [pred, rest] = parsePrimary(source);
  for (;;) {
    const op = OPERATORS.find(([token, precedence]) => precedence >= minPrecedence && rest.startsWith(token));
    if (op === undefined) return [pred, rest];
    const [token, precedence, make] = op;
    const [right, after] = parseExpr(skipSpace(rest.slice(token.length)), precedence + 1);
    pred = make(pred, right);
    rest = after;
  }
}

/**
 * GPUI `KeyBindingContextPredicate::parse`: identifiers, `==`/`!=` between identifiers, `!`, `&&`, `||`, `>` (a
 * context inside another) and parentheses (`"Pane && !modal"`, `"Workspace > Editor"`).
 */
export function parsePredicate(source) {
  const [pred, rest] = parseExpr(skipSpace(source), 0);
  if (rest !== "") throw new SyntaxError(`unexpected ${firstChar(rest)}`);
  return pred;
}

/**
 * GPUI `KeyBindingContextPredicate::eval_inner`: `pred` against the innermost context of `contexts` (the context
 * stack cut at the depth being tried); `!` and `>` look at `all`, the whole stack.
 */
function evalAt(pred, contexts, all) {
  const last = contexts.at(-1);
  if (last === undefined) return false;
  switch (pred.op) {
    case "id":
      return last.has(pred.name);
    case "eq":
      return last.get(pred.key) === pred.value;
    case "ne": {
      const value = last.get(pred.key);
      return value === undefined || value === null || value !== pred.value;
    }
    case "not":
      return !all.some((_, i) => evalAt(pred.pred, all.slice(0, i + 1), all));
    case "child":
      return evalAt(pred.child, contexts, all) &&
        contexts.slice(0, -1).some((_, i) => evalAt(pred.parent, contexts.slice(0, i + 1), all));
    case "and":
      return evalAt(pred.l, contexts, all) && evalAt(pred.r, contexts, all);
    case "or":
      return evalAt(pred.l, contexts, all) || evalAt(pred.r, contexts, all);
  }
  return false;
}

/** GPUI `depth_of`: the deepest prefix of the context stack `pred` holds for, or `null` when it holds for none. */
function depthOf(pred, contexts) {
  for (let depth = contexts.length; depth > 0; depth--) {
    if (evalAt(pred, contexts.slice(0, depth), contexts)) return depth;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Bindings.

function parsed(at, field, source, parse) {
  try {
    return parse(source);
  } catch (e) {
    throw new SyntaxError(`${at}: ${field} ${JSON.stringify(source)}: ${e?.message ?? e}`);
  }
}

/**
 * Validates a whole `cx.bind_keys` list before any of it is installed (Herdr: a keymap half applied because one entry
 * had a typo is worse than one not applied): every entry needs a parsable `keystroke`, a non-empty `action` and, when
 * present, a parsable `context` predicate. Throws on the first bad entry.
 */
export function parseBindings(list) {
  if (!Array.isArray(list)) throw new TypeError("cx.bind_keys() takes an array of {keystroke, action, context?}");
  return list.map((entry, i) => {
    const at = `cx.bind_keys(): binding ${i}`;
    if (entry === null || typeof entry !== "object") throw new TypeError(`${at} is not an object`);
    const { keystroke, action, context } = entry;
    if (typeof keystroke !== "string") throw new TypeError(`${at}: keystroke is not a string`);
    if (typeof action !== "string" || action === "") throw new TypeError(`${at}: action is not a non-empty string`);
    if (context !== undefined && context !== null && typeof context !== "string") {
      throw new TypeError(`${at}: context is not a string`);
    }
    const keystrokes = parsed(at, "keystroke", keystroke, parseKeystrokes);
    const predicate = typeof context === "string" ? parsed(at, "context", context, parsePredicate) : null;
    return { keystrokes, action, predicate, identity: JSON.stringify([keystrokes, action, context ?? null]) };
  });
}

/** An application keymap: bindings in installation order (on equal context depth, the later one wins). */
export class Keymap {
  #bindings = [];

  get size() {
    return this.#bindings.length;
  }

  /**
   * Installs bindings from {@link parseBindings} and answers how many. An identical binding installed earlier is
   * dropped: the new one always wins over it, and a view that binds in `init` must not grow the keymap per copy.
   */
  add(bindings) {
    for (const b of bindings) {
      const i = this.#bindings.findIndex((x) => x.identity === b.identity);
      if (i >= 0) this.#bindings.splice(i, 1);
      this.#bindings.push(b);
    }
    return bindings.length;
  }

  /**
   * GPUI `Keymap::bindings_for_input`: the bindings typed strokes `input` complete in context stack `contexts`, best
   * first (deepest context depth, then latest), and whether `input` is also the prefix of a longer chord installed
   * after the best of them.
   */
  bindingsFor(input, contexts) {
    const matched = [];
    const pending = [];
    for (let ix = this.#bindings.length - 1; ix >= 0; ix--) {
      const b = this.#bindings[ix];
      const depth = b.predicate === null ? contexts.length : depthOf(b.predicate, contexts);
      if (depth === null) continue;
      const prefix = matchStrokes(b.keystrokes, input);
      if (prefix === null) continue;
      if (prefix) pending.push(ix);
      else matched.push({ depth, ix, b });
    }
    matched.sort((x, y) => y.depth - x.depth || y.ix - x.ix);
    const best = matched.length > 0 ? matched[0].ix : null;
    return { bindings: matched.map((m) => m.b), partial: pending.some((ix) => best === null || ix > best) };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Dispatch of typed input. An entry is one held press `{stroke, ...}`; the caller's fields ride along untouched.

/** GPUI `replay_prefix`: the longest leading run of `input` that completes a binding (else its first stroke) is due. */
function replayPrefix(keymap, input, contexts) {
  for (let last = input.length - 1; last >= 0; last--) {
    const { bindings } = keymap.bindingsFor(input.slice(0, last + 1).map((e) => e.stroke), contexts);
    if (bindings.length > 0) return { suffix: input.slice(last + 1), replay: [{ entry: input[last], bindings }] };
  }
  return { suffix: input.slice(1), replay: [{ entry: input[0], bindings: [] }] };
}

/**
 * GPUI `DispatchTree::dispatch_key`: the pending entries plus press `entry`, in context stack `contexts`. Returns
 * `pending` (every entry to hold while a longer chord may follow), else the `bindings` the input completes, best first
 * (none: the press goes to its key listener); `replay` lists earlier held presses to replay first, each with the
 * bindings it completes (none: replay it to its key listener).
 */
export function resolveKey(keymap, pending, entry, contexts) {
  const input = [...pending, entry];
  const { bindings, partial } = keymap.bindingsFor(input.map((e) => e.stroke), contexts);
  if (partial) return { pending: input, bindings: [], replay: [] };
  if (bindings.length > 0 || pending.length === 0) return { pending: null, bindings, replay: [] };
  const { suffix, replay } = replayPrefix(keymap, pending, contexts);
  const r = resolveKey(keymap, suffix, entry, contexts);
  return { ...r, replay: [...replay, ...r.replay] };
}

/** GPUI `flush_dispatch`: held presses whose chord timed out, as replays (see {@link resolveKey}). */
export function flushKeys(keymap, pending, contexts) {
  const replay = [];
  for (let input = pending; input.length > 0;) {
    const r = replayPrefix(keymap, input, contexts);
    input = r.suffix;
    replay.push(...r.replay);
  }
  return replay;
}
