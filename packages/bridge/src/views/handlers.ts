/**
 * Handler ids of one view (PROTOCOL.md: "per view and invalidated on each view re-render"). A host numbers the handlers
 * of every render from 1 again, so its ids cannot reach devices: each render's `on` ids are replaced with fresh ids from
 * a bridge-wide counter that never repeats, and the view keeps only the latest render's table. An id from an older
 * render, or from before a host restart, therefore names nothing and is refused (`ack stale-handler`).
 *
 * A device event names a view id and an event `kind`; {@link eventArgs} checks the kind against the handler it targets
 * and builds the arguments the gpui-kit handler receives (the host appends `cx`).
 */

import type { ClientEvent, ElementNode, Handlers, JsonObject, JsonValue } from "@herdr-relay/protocol";

/** One handler of the current render. */
export interface HandlerEntry {
  /** The host's id for it in that render. */
  host: number;
  key: keyof Handlers;
  /** The mouse button (`mousedown`/`mouseup`) or action name (`action`). */
  sub?: string;
  /** Its element is a text widget (`input`/`textarea`/`editor`), whose `on_change` takes the whole `InputData`. */
  text: boolean;
}

const TEXT_WIDGETS: Record<string, true> = { input: true, textarea: true, editor: true };

/**
 * Replaces the host handler ids of a freshly converted tree in place (it belongs to the caller) with ids from `mint`,
 * and returns the table of the new ids.
 */
export function bindHandlers(tree: ElementNode, mint: () => number): Map<number, HandlerEntry> {
  const table = new Map<number, HandlerEntry>();
  const byHost = new Map<string, number>();
  const bind = (host: number, key: keyof Handlers, text: boolean, sub?: string): number => {
    const tag = `${key}\0${sub ?? ""}\0${host}`;
    const known = byHost.get(tag);
    if (known !== undefined) return known;
    const id = mint();
    byHost.set(tag, id);
    table.set(id, sub === undefined ? { host, key, text } : { host, key, sub, text });
    return id;
  };
  const visit = (node: ElementNode) => {
    const on = node.on as Record<string, number | Record<string, number>> | undefined;
    if (on) {
      const text = node.widget !== undefined && Object.hasOwn(TEXT_WIDGETS, node.widget.type);
      for (const key of Object.keys(on) as (keyof Handlers)[]) {
        const v = on[key];
        if (typeof v === "number") {
          on[key] = bind(v, key, text);
        } else {
          for (const sub of Object.keys(v)) v[sub] = bind(v[sub], key, text, sub);
        }
      }
    }
    if (node.slots) { for (const s of Object.values(node.slots)) visit(s); }
    if (node.children) { for (const c of node.children) visit(c); }
  };
  visit(tree);
  return table;
}

export type EventArgs = { ok: true; args: JsonValue[] } | { ok: false; message: string };

const wrongKind = (entry: HandlerEntry, kind: string): EventArgs => ({
  ok: false,
  message: `a ${kind} event cannot reach a ${entry.key} handler`,
});

/** `data` as a JSON object without the list-row `key` (it is passed separately where the handler wants it). */
function withoutKey(data: object): JsonObject {
  const { key: _key, ...rest } = data as JsonObject;
  return rest;
}

/** The arguments `entry`'s gpui-kit handler receives for device event `ev`, or why the event does not fit it. */
export function eventArgs(entry: HandlerEntry, ev: ClientEvent): EventArgs {
  const ok = (...args: JsonValue[]): EventArgs => ({ ok: true, args });
  switch (entry.key) {
    case "click":
    case "tokenclick":
      return ev.kind === "click" ? ok(withoutKey(ev.data)) : wrongKind(entry, ev.kind);
    case "item":
      if (ev.kind !== "click") return wrongKind(entry, ev.kind);
      return typeof ev.data.key === "string" ? ok(ev.data.key) : { ok: false, message: "a list row click needs a key" };
    case "itemsecondary":
      if (ev.kind !== "mousedown" && ev.kind !== "mouseup") return wrongKind(entry, ev.kind);
      return typeof ev.data.key === "string"
        ? ok(ev.data.key, withoutKey(ev.data))
        : { ok: false, message: "a list row press needs a key" };
    case "mousedown":
    case "mouseup":
      if (ev.kind !== entry.key) return wrongKind(entry, ev.kind);
      return ev.data.button === entry.sub
        ? ok(withoutKey(ev.data))
        : { ok: false, message: `the handler is for the ${entry.sub} button` };
    case "mousedownout":
      return ev.kind === "mousedown" ? ok(withoutKey(ev.data)) : wrongKind(entry, ev.kind);
    case "mousemove":
      return ev.kind === "mousemove" ? ok(ev.data) : wrongKind(entry, ev.kind);
    case "hover":
      return ev.kind === "hover" ? ok(ev.data.hovered) : wrongKind(entry, ev.kind);
    case "tokenhover":
      return ev.kind === "hover" ? ok(ev.data) : wrongKind(entry, ev.kind);
    case "wheel":
      return ev.kind === "wheel" ? ok(ev.data) : wrongKind(entry, ev.kind);
    case "keydown":
    case "keyup":
      return ev.kind === "key" ? ok(ev.data) : wrongKind(entry, ev.kind);
    case "modifiers":
      return ev.kind === "key" ? ok({ modifiers: ev.data.modifiers }) : wrongKind(entry, ev.kind);
    case "action":
      return ev.kind === "key" || ev.kind === "click" ? ok({ action: entry.sub ?? "" }) : wrongKind(entry, ev.kind);
    case "size":
      if (ev.kind !== "size") return wrongKind(entry, ev.kind);
      return "width" in ev.data ? ok(ev.data) : { ok: false, message: "on_size_change needs {width, height}" };
    case "resize":
      if (ev.kind !== "size") return wrongKind(entry, ev.kind);
      return "sizes" in ev.data ? ok(ev.data.sizes) : { ok: false, message: "on_resize needs {sizes}" };
    case "change":
      if (ev.kind !== "input") return wrongKind(entry, ev.kind);
      // A text widget's on_change is the host's input handler (whole InputData); a control's takes the value.
      return entry.text ? ok(ev.data) : ok(ev.data.value);
    case "step":
    case "openchange":
      return ev.kind === "input" ? ok(ev.data.value) : wrongKind(entry, ev.kind);
    case "confirm":
    case "dismiss":
      return ev.kind === "input" ? ok({}) : wrongKind(entry, ev.kind);
    case "link":
      return ev.kind === "link" ? ok(ev.data.href) : wrongKind(entry, ev.kind);
    case "drop":
      return { ok: false, message: "files cannot be dropped from a device" };
  }
}
