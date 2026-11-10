/**
 * Just enough document for react-dom to mount, update and unmount elements and to hear events, for tests that mount
 * components (`*_test.tsx`). Nodes are `EventTarget`s with a `parentNode`, so Deno's own dispatch runs an event's
 * capture and bubble phases along the tree as a browser does (it ends at the document: listeners on `window` hear
 * only what is dispatched there). Moving the focus fires `blur`, `focusout`, `focus` and `focusin`. There is no
 * layout: every size is 0.
 */

import { assertEquals } from "@std/assert";

export class FakeNode extends EventTarget {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  constructor(readonly nodeType: number, readonly nodeName: string, readonly ownerDocument: FakeDocument | null) {
    super();
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes.at(-1) ?? null;
  }
  get nextSibling(): FakeNode | null {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get isConnected(): boolean {
    return this.getRootNode().nodeType === 9;
  }
  /** What Deno's event dispatch asks every node on an event's path. */
  getRootNode(): FakeNode {
    return this.parentNode?.getRootNode() ?? this;
  }
  contains(other: FakeNode | null): boolean {
    for (let node = other; node; node = node.parentNode) if (node === this) return true;
    return false;
  }
  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }
  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode): FakeNode {
    this.childNodes = this.childNodes.filter((n) => n !== child);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.childNodes.map((n) => n.textContent).join("");
  }
  set textContent(text: string) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    if (text) this.appendChild(new FakeText(text, this.ownerDocument!));
  }
}

export class FakeText extends FakeNode {
  constructor(public nodeValue: string, doc: FakeDocument) {
    super(3, "#text", doc);
  }
  override get textContent(): string {
    return this.nodeValue;
  }
  override set textContent(text: string) {
    this.nodeValue = text;
  }
}

/** An element's `style`: properties as set, plus the methods react-dom uses for custom properties. */
export class FakeStyle {
  [name: string]: unknown;
  setProperty(name: string, value: string): void {
    this[name] = value;
  }
  removeProperty(name: string): void {
    delete this[name];
  }
  getPropertyValue(name: string): string {
    const value = this[name];
    return typeof value === "string" ? value : "";
  }
}

class FakeClassList {
  constructor(private readonly element: FakeElement) {}
  #names(): string[] {
    return (this.element.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
  }
  add(...names: string[]): void {
    this.element.setAttribute("class", [...new Set([...this.#names(), ...names])].join(" "));
  }
  remove(...names: string[]): void {
    this.element.setAttribute("class", this.#names().filter((n) => !names.includes(n)).join(" "));
  }
  contains(name: string): boolean {
    return this.#names().includes(name);
  }
}

export class FakeElement extends FakeNode {
  readonly attributes = new Map<string, string>();
  readonly style = new FakeStyle();
  readonly classList: FakeClassList = new FakeClassList(this);
  readonly isContentEditable = false;
  /** A textarea's or input's text, and its caret (react-dom saves and restores the caret around a commit). */
  value = "";
  selectionStart = 0;
  selectionEnd = 0;
  scrollTop = 0;
  scrollLeft = 0;
  readonly offsetWidth = 0;
  readonly offsetHeight = 0;
  readonly clientWidth = 0;
  readonly clientHeight = 0;
  constructor(readonly tagName: string, doc: FakeDocument, readonly namespaceURI = "http://www.w3.org/1999/xhtml") {
    super(1, tagName, doc);
  }
  get className(): string {
    return this.getAttribute("class") ?? "";
  }
  set className(value: string) {
    this.setAttribute("class", value);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
  /** The first descendant matching `tag`, `.class` or `tag.class`. */
  querySelector(selector: string): FakeElement | null {
    const [tag, ...classes] = selector.split(".");
    return elementsWhere(
      this,
      (el) => (!tag || el.tagName === tag.toUpperCase()) && classes.every((c) => el.classList.contains(c)),
    )[0] ?? null;
  }
  focus(): void {
    this.ownerDocument!.moveFocus(this);
  }
  blur(): void {
    if (this.ownerDocument!.activeElement === this) this.ownerDocument!.moveFocus(this.ownerDocument!.body);
  }
}

export class FakeDocument extends FakeNode {
  readonly documentElement: FakeElement;
  readonly body: FakeElement;
  activeElement: FakeElement;
  readonly defaultView = globalThis;
  constructor() {
    super(9, "#document", null);
    this.documentElement = this.appendChild(new FakeElement("HTML", this));
    this.body = this.documentElement.appendChild(new FakeElement("BODY", this));
    this.activeElement = this.body;
  }
  createElement(tag: string): FakeElement {
    return new FakeElement(tag.toUpperCase(), this);
  }
  createElementNS(namespace: string, tag: string): FakeElement {
    return new FakeElement(tag, this, namespace);
  }
  createTextNode(text: string): FakeText {
    return new FakeText(text, this);
  }
  /** Moves the focus to `to` (the body: none), firing what a browser fires. */
  moveFocus(to: FakeElement): void {
    const from = this.activeElement;
    if (from === to) return;
    this.activeElement = to;
    if (from !== this.body) {
      fire(from, "blur", { relatedTarget: to === this.body ? null : to }, false);
      fire(from, "focusout", { relatedTarget: to === this.body ? null : to });
    }
    if (to !== this.body) {
      fire(to, "focus", { relatedTarget: from === this.body ? null : from }, false);
      fire(to, "focusin", { relatedTarget: from === this.body ? null : from });
    }
  }
}

/** `localStorage` in memory: a test never touches Deno's own origin storage on disk. */
export class MemoryStorage {
  readonly #items = new Map<string, string>();
  get length(): number {
    return this.#items.size;
  }
  key(i: number): string | null {
    return [...this.#items.keys()][i] ?? null;
  }
  getItem(key: string): string | null {
    return this.#items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.#items.delete(key);
  }
  clear(): void {
    this.#items.clear();
  }
}

/**
 * Installs the document and the browser globals a mounted component reads: `window`, `localStorage`, act's flag, and
 * `matchMedia` (a query matches when `media` says), `getComputedStyle` (no custom properties) and `ResizeObserver`
 * (never calls back).
 */
export function installDom(media: (query: string) => boolean = () => false): {
  doc: FakeDocument;
  storage: MemoryStorage;
} {
  const doc = new FakeDocument();
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true });
  Object.assign(globalThis, {
    window: globalThis,
    document: doc,
    IS_REACT_ACT_ENVIRONMENT: true,
    HTMLIFrameElement: class {},
    matchMedia: (query: string) => ({
      media: query,
      matches: media(query),
      addEventListener() {},
      removeEventListener() {},
    }),
    getComputedStyle: () => new FakeStyle(),
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  return { doc, storage };
}

const ignore = () => {};

/** Dispatches a `type` event at `target` carrying `props`, the fields of a DOM event (`key`, `inputType`, `data`…). */
export function fire(target: EventTarget, type: string, props: Record<string, unknown> = {}, bubbles = true): Event {
  const event = new Event(type, { bubbles, cancelable: true });
  for (const [name, value] of Object.entries(props)) Object.defineProperty(event, name, { value });
  // Deno's dispatch ends at a target with no listener of its own for the type (a fast path for the global object).
  target.addEventListener(type, ignore);
  target.dispatchEvent(event);
  return event;
}

export function elementsWhere(from: FakeNode, test: (el: FakeElement) => boolean): FakeElement[] {
  const out: FakeElement[] = [];
  const walk = (n: FakeNode) => {
    if (n !== from && n instanceof FakeElement && test(n)) out.push(n);
    n.childNodes.forEach(walk);
  };
  walk(from);
  return out;
}

export function elementsWithClass(from: FakeNode, cls: string): FakeElement[] {
  return elementsWhere(from, (el) => el.classList.contains(cls));
}

/** React's warnings (`console.error`) during `run` fail the test. */
export async function quietly(run: () => Promise<void>): Promise<void> {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args);
  try {
    await run();
  } finally {
    console.error = original;
  }
  assertEquals(errors, []);
}
