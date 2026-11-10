/**
 * Scale-to-fit for a terminal grid (D4: observe at the Mac's cols×rows, scale to fit the width, pinch to 1:1). The
 * grid is drawn at its natural size and scaled down to the viewport's width, never up. A pinch (two touches) or
 * Ctrl/⌘ + wheel (a trackpad pinch) zooms between that and 1:1 around the gesture's centre and settles on whichever
 * is nearer when it ends; `toggle()` is the same for a button. The viewport scrolls whatever the scaled grid exceeds.
 * Styles are written directly (no render per frame of a gesture).
 */

export type ZoomMode = "fit" | "actual";

interface Point {
  x: number;
  y: number;
}

/** A wheel zoom settles this long after its last event. */
const WHEEL_SETTLE_MS = 200;
/** How far one wheel delta unit zooms. */
const WHEEL_RATE = 0.01;

export class GridScale {
  #w = 0;
  #h = 0;
  #fit = 1;
  #scale = 1;
  #mode: ZoomMode = "fit";
  readonly #touches = new Map<number, Point>();
  #pinch: { distance: number; scale: number } | null = null;
  #wheelTimer: ReturnType<typeof setTimeout> | undefined;
  #wheelAt: Point = { x: 0, y: 0 };

  constructor(
    readonly viewport: HTMLElement,
    readonly sizer: HTMLElement,
    readonly screen: HTMLElement,
    /** The settled mode changed, or whether zooming does anything (`canZoom`: the grid is wider than the view). */
    readonly onChange: (mode: ZoomMode, canZoom: boolean) => void,
  ) {}

  /** The grid's unscaled size (a new geometry or font): fit again. */
  setNatural(w: number, h: number): void {
    if (w === this.#w && h === this.#h) return;
    this.#w = w;
    this.#h = h;
    this.screen.style.width = `${w}px`;
    this.screen.style.height = `${h}px`;
    this.refit();
  }

  /** Scrolls the viewport so grid row `row` of `rows` (the cursor's, after a paint) is in view, centred if it was not. */
  reveal(row: number, rows: number): void {
    if (rows <= 0 || this.#h <= 0) return;
    const v = this.viewport;
    const y = ((row + 0.5) / rows) * this.#h * this.#scale;
    if (y < v.scrollTop || y > v.scrollTop + v.clientHeight) v.scrollTop = y - v.clientHeight / 2;
  }

  /** The viewport changed size. */
  refit(): void {
    const avail = this.viewport.clientWidth;
    this.#fit = this.#w > 0 && avail > 0 ? Math.min(1, avail / this.#w) : 1;
    this.#apply(this.#mode === "fit" ? this.#fit : 1, null);
    this.#notify();
  }

  /** Fit ⇄ 1:1 around the viewport's centre. */
  toggle(): void {
    this.#settle(this.#mode === "fit" ? 1 : this.#fit, this.#centre());
  }

  // --- gestures (listeners installed by the view) --------------------------------------------------------------------

  pointerDown(e: PointerEvent): void {
    if (e.pointerType !== "touch") return;
    this.#touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.#touches.size === 2) this.#pinch = { distance: this.#spread(), scale: this.#scale };
  }

  pointerMove(e: PointerEvent): void {
    if (!this.#touches.has(e.pointerId)) return;
    this.#touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const pinch = this.#pinch;
    if (!pinch || this.#touches.size < 2 || pinch.distance <= 0) return;
    this.#apply(this.#clamp(pinch.scale * (this.#spread() / pinch.distance)), this.#midpoint());
  }

  pointerUp(e: PointerEvent): void {
    if (!this.#touches.has(e.pointerId)) return;
    const mid = this.#midpoint();
    this.#touches.delete(e.pointerId);
    if (this.#pinch && this.#touches.size < 2) {
      this.#pinch = null;
      this.#settle(this.#nearest(), mid);
    }
  }

  /** Ctrl/⌘ + wheel zooms (a trackpad pinch arrives this way); a plain wheel scrolls as usual. */
  wheel(e: WheelEvent): void {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    e.stopPropagation();
    const r = this.viewport.getBoundingClientRect();
    this.#wheelAt = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.#apply(this.#clamp(this.#scale * Math.exp(-e.deltaY * WHEEL_RATE)), this.#wheelAt);
    clearTimeout(this.#wheelTimer);
    this.#wheelTimer = setTimeout(() => this.#settle(this.#nearest(), this.#wheelAt), WHEEL_SETTLE_MS);
  }

  dispose(): void {
    clearTimeout(this.#wheelTimer);
  }

  // --- internals -----------------------------------------------------------------------------------------------------

  #clamp(s: number): number {
    return Math.min(1, Math.max(this.#fit, s));
  }

  #nearest(): number {
    return this.#scale >= (this.#fit + 1) / 2 ? 1 : this.#fit;
  }

  #settle(scale: number, anchor: Point | null): void {
    this.#mode = scale >= 1 && this.#fit < 1 ? "actual" : "fit";
    this.#apply(scale, anchor);
    this.#notify();
  }

  /** Scales to `s`, keeping the grid point under `anchor` (viewport px) where it is. */
  #apply(s: number, anchor: Point | null): void {
    const v = this.viewport;
    const before = this.#scale;
    const at = anchor ?? { x: 0, y: 0 };
    const gx = (v.scrollLeft + at.x) / before;
    const gy = (v.scrollTop + at.y) / before;
    this.#scale = s;
    this.sizer.style.width = `${this.#w * s}px`;
    this.sizer.style.height = `${this.#h * s}px`;
    this.screen.style.transform = `scale(${s})`;
    if (anchor) {
      v.scrollLeft = gx * s - at.x;
      v.scrollTop = gy * s - at.y;
    }
  }

  #notify(): void {
    this.onChange(this.#mode, this.#fit < 0.999);
  }

  #centre(): Point {
    return { x: this.viewport.clientWidth / 2, y: this.viewport.clientHeight / 2 };
  }

  #spread(): number {
    const [a, b] = [...this.#touches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }

  #midpoint(): Point {
    const pts = [...this.#touches.values()].slice(0, 2);
    if (pts.length === 0) return this.#centre();
    const r = this.viewport.getBoundingClientRect();
    const x = pts.reduce((sum, p) => sum + p.x, 0) / pts.length;
    const y = pts.reduce((sum, p) => sum + p.y, 0) / pts.length;
    return { x: x - r.left, y: y - r.top };
  }
}
