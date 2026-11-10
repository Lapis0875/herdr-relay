/**
 * `Input.new(InputState)` and `Textarea.new(TextareaState)`: a native field in the element's frame (the node's style
 * is the frame: border, padding, background; the field inside is bare).
 *
 * Local echo: what is typed shows at once and goes to the state's input handler (`on.change`) as
 * `event {kind:"input", data:{value, event:"change"}}`, coalesced to one per {@link CHANGE_DELAY_MS}; the round trip
 * re-renders the copy with the new `value`. Values coming back that this field sent itself are not re-applied (the
 * person may have typed on meanwhile); any other value is the mod's own (`set_value`, cleared after a submit) and
 * replaces the text. Composition (IME) text is sent when it is committed.
 *
 * Enter in an input, ⌘/Ctrl+Enter in a textarea, submit (`event:"submit"` with `secondary`/`shift`). Options:
 * `placeholder`, `masked` (password), `loading` (busy), `rows`, `auto_grow {min_rows, max_rows}` (set_auto_grow:
 * the height follows the text between the two), `soft_wrap` (default on). A `read` device, stale data or a
 * `disabled` element shows the text read-only.
 */

import {
  type ChangeEvent,
  type KeyboardEvent,
  type ReactElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { JsonValue } from "@herdr-relay/protocol";
import { RenderContext } from "../../render/context.ts";
import { imeKey } from "../../render/events.ts";
import type { WidgetProps } from "../../render/widgets.tsx";

/** Typing is sent at most this often (the last value always goes). */
const CHANGE_DELAY_MS = 40;

type Field = HTMLInputElement | HTMLTextAreaElement;

interface AutoGrow {
  min: number;
  max: number;
}

function autoGrowOf(v: JsonValue | undefined): AutoGrow | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const min = typeof v.min_rows === "number" && v.min_rows >= 1 ? Math.floor(v.min_rows) : 1;
  const max = typeof v.max_rows === "number" && v.max_rows >= min ? Math.floor(v.max_rows) : Math.max(min, 8);
  return { min, max };
}

/** Sets a textarea's height to its text's, between `rows.min` and `rows.max` lines. */
function grow(el: HTMLTextAreaElement, rows: AutoGrow): void {
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
  const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  el.style.height = "auto";
  const content = el.scrollHeight - pad;
  const height = Math.min(rows.max * line, Math.max(rows.min * line, content)) + pad;
  el.style.height = `${height}px`;
  el.style.overflowY = content > rows.max * line + 1 ? "auto" : "hidden";
}

export function TextInput({ node, dom }: WidgetProps): ReactElement {
  const env = useContext(RenderContext);
  const p = node.widget.props ?? {};
  const multiline = node.widget.type === "textarea";
  const remote = typeof p.value === "string" ? p.value : "";
  const change = typeof node.on?.change === "number" ? node.on.change : undefined;
  const disabled = node.attrs?.disabled === true;
  const editable = env.send !== null && env.typing && change !== undefined && !disabled;
  const autoGrow = multiline ? autoGrowOf(p.auto_grow) : null;
  const rows = typeof p.rows === "number" && p.rows >= 1 ? Math.floor(p.rows) : undefined;
  const wrap = p.soft_wrap !== false;
  const placeholder = typeof p.placeholder === "string" ? p.placeholder : undefined;
  const loading = p.loading === true;

  const [value, setValue] = useState(remote);
  const field = useRef<Field | null>(null);
  /** Values this field sent whose echo may still come back. */
  const sent = useRef(new Set<string>());
  const pending = useRef<{ timer: ReturnType<typeof setTimeout> | undefined; value: string | null }>({
    timer: undefined,
    value: null,
  });
  const composing = useRef(false);
  const live = useRef({ send: env.send, change });
  live.current = { send: env.send, change };

  // A value from the Mac: ours coming back, or the mod's own.
  useLayoutEffect(() => {
    if (sent.current.has(remote)) {
      if (remote === field.current?.value) sent.current.clear();
      return;
    }
    sent.current.clear();
    setValue(remote);
  }, [remote]);

  const flush = useCallback(() => {
    const p = pending.current;
    clearTimeout(p.timer);
    p.timer = undefined;
    const { send, change } = live.current;
    if (p.value === null || !send || change === undefined) return;
    sent.current.add(p.value);
    send(change, "input", { value: p.value, event: "change" });
    p.value = null;
  }, []);

  useEffect(() => () => clearTimeout(pending.current.timer), []);

  const queue = (next: string) => {
    pending.current.value = next;
    pending.current.timer ??= setTimeout(flush, CHANGE_DELAY_MS);
  };

  const submit = (e: KeyboardEvent<Field>) => {
    const { send, change } = live.current;
    if (!send || change === undefined) return;
    e.preventDefault();
    clearTimeout(pending.current.timer);
    pending.current = { timer: undefined, value: null };
    // The submit carries the value; the mod's handler may clear it, which must then show.
    sent.current.clear();
    sent.current.add(value);
    send(change, "input", { value, event: "submit", secondary: e.metaKey || e.ctrlKey, shift: e.shiftKey });
  };

  useLayoutEffect(() => {
    const el = field.current;
    if (autoGrow && el instanceof HTMLTextAreaElement) grow(el, autoGrow);
  }, [value, autoGrow?.min, autoGrow?.max]);

  const onChange = (e: ChangeEvent<Field>) => {
    setValue(e.target.value);
    if (!composing.current) queue(e.target.value);
  };

  const onKeyDown = (e: KeyboardEvent<Field>) => {
    // An Enter the input method takes (keyCode 229: Safari sends the key that commits a composition after its end)
    // commits the text; it is not a submit.
    if (e.key !== "Enter" || imeKey(e) || composing.current || !editable) return;
    if (!multiline) submit(e);
    else if (e.metaKey || e.ctrlKey) submit(e);
  };

  const common = {
    ref: (el: Field | null) => {
      field.current = el;
    },
    className: "w-field__input",
    value,
    placeholder,
    readOnly: !editable,
    disabled,
    "aria-readonly": !editable || undefined,
    "aria-busy": loading || undefined,
    "aria-label": dom["aria-label"] ?? placeholder,
    title: editable || disabled ? undefined : "Read-only on this device",
    autoComplete: "off",
    autoCapitalize: "off",
    autoCorrect: "off",
    spellCheck: false,
    // An overlay's text field takes the keyboard when the overlay opens (`TreeView`).
    "data-track-focus": env.overlay ? "" : undefined,
    onChange,
    onKeyDown,
    onCompositionStart: () => {
      composing.current = true;
    },
    onCompositionEnd: (e: { currentTarget: Field }) => {
      composing.current = false;
      queue(e.currentTarget.value);
    },
    onBlur: flush,
  };

  const { "aria-label": _label, ...frame } = dom;
  return (
    <div
      {...frame}
      className={`${dom.className} w-field`}
      data-multiline={multiline ? "" : undefined}
      data-readonly={editable ? undefined : ""}
    >
      {multiline
        ? <textarea {...common} rows={autoGrow?.min ?? rows} wrap={wrap ? "soft" : "off"} />
        : <input {...common} type={p.masked === true ? "password" : "text"} enterKeyHint="go" />}
      {loading ? <span className="w-field__spinner" aria-hidden="true" /> : null}
    </div>
  );
}
