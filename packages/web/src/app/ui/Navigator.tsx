/**
 * The navigator (DESIGN.md §3): the routes on the session's stack as layers over the home route — `push` routes as
 * full pages with a back button, `sheet` routes as side sheets (tablet-portrait panels), the `drawer` route sliding
 * from its side (edge swipe or the shell button) — plus the layout's floating entries (R4) as sheets with a 44 px
 * handle when they peek, and the session's peek terminal. Back is the header button, the scrim, Escape, a swipe
 * back towards the edge, or the system back button (one history entry per stack level).
 */

import {
  type CSSProperties,
  type ReactElement,
  type TouchEvent as ReactTouchEvent,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HOME_ROUTE, recomposeTree, type ScreenGraph, type ScreenRoute, type ScreenSheet } from "@herdr-relay/protocol";
import { bridge } from "../client.ts";
import { drawerRoute, leadingBarOf, liveStack, titleOf } from "../nav.ts";
import { setState, shownGraph, useApp } from "../store.ts";
import { indexLayout, lookStyle } from "../theme.ts";
import { Icon } from "./icons.tsx";
import { ScreenContext, ScreenView } from "./Screen.tsx";
import { Sheet } from "./Sheet.tsx";
import { connTone, ShellButton, TONE_TEXT } from "./Status.tsx";

/** How long a closed layer stays for its exit animation (matches `--motion-exit` in app.css). */
const EXIT_MS = 200;
const EDGE_PX = 24;
const SWIPE_PX = 56;

interface Layer {
  route: ScreenRoute;
  leaving: boolean;
  /** Part of the stack a new graph arrived with (bridge `hello`, cache): shown in place, never animated in. */
  settled: boolean;
}

/**
 * The layers on screen. The stack a graph epoch starts with (`graphEpoch`: a bridge `hello` or the cache) is shown
 * exactly as it is from its first frame — no route slides in over the previous screen and nothing removed by it lingers
 * — so the live hello's stack is what the device shows at once. Routes pushed afterwards animate in; removed ones stay
 * mounted for their exit animation, and a removal always completes (the bridge's answer to an optimistic step may
 * arrive within the exit).
 */
function useLayers(routes: ScreenRoute[], epoch: number): Layer[] {
  // Adjusting state while rendering (React's pattern for derived state): the first frame of a new epoch is settled.
  const [settled, setSettled] = useState(() => ({ epoch, paths: new Set(routes.map((r) => r.path)) }));
  let settledPaths = settled.paths;
  if (settled.epoch !== epoch) {
    settledPaths = new Set(routes.map((r) => r.path));
    setSettled({ epoch, paths: settledPaths });
  }
  const [leaving, setLeaving] = useState<ScreenRoute[]>([]);
  const prev = useRef({ routes, epoch });
  useEffect(() => {
    const before = prev.current;
    prev.current = { routes, epoch };
    const now = new Set(routes.map((r) => r.path));
    if (before.epoch !== epoch) {
      setLeaving((l) => (l.length ? [] : l));
      return;
    }
    const gone = before.routes.filter((r) => !now.has(r.path));
    setLeaving((l) => {
      const kept = l.filter((r) => !now.has(r.path));
      return gone.length === 0 && kept.length === l.length ? l : [...kept, ...gone];
    });
    if (gone.length === 0) return;
    // A route that left animates in again when it comes back.
    setSettled((s) => ({ epoch: s.epoch, paths: new Set([...s.paths].filter((p) => now.has(p))) }));
    setTimeout(() => setLeaving((l) => l.filter((r) => !gone.includes(r))), EXIT_MS);
  }, [routes, epoch]);
  const shown = new Set(routes.map((r) => r.path));
  return [
    ...routes.map((route) => ({ route, leaving: false, settled: settledPaths.has(route.path) })),
    ...leaving.filter((r) => !shown.has(r.path)).map((route) => ({ route, leaving: true, settled: false })),
  ];
}

/** `history.state.herdrRelay`: the navigator depth an entry stands for (`0` for the page's own entry). */
function entryLevel(): number {
  const level = (history.state as { herdrRelay?: unknown } | null)?.herdrRelay;
  return typeof level === "number" && Number.isInteger(level) && level >= 0 ? level : 0;
}

/**
 * One history entry per stack level, so the system back button (Android, browser back) pops the navigator; levels
 * closed in the app (Back button, scrim, swipe) take their entries back out, so back never lands on a dead entry.
 * Only a traversal back below the entries we pushed pops: a `popstate` that lands on our current level (older WebKit
 * fires one on load) or moves forward changes nothing, so it can never take a route off the bridge's stack.
 */
function useHistoryBack(depth: number): void {
  const entries = useRef(0);
  /** `popstate`s caused by our own `history.go`. */
  const ignore = useRef(0);
  const depthRef = useRef(depth);
  depthRef.current = depth;
  useEffect(() => {
    // A reloaded page may sit on an entry we pushed before: it is this page's level 0 now.
    if (entryLevel() !== 0) history.replaceState({ ...(history.state ?? {}), herdrRelay: 0 }, "");
    const onPop = () => {
      if (ignore.current > 0) {
        ignore.current--;
        return;
      }
      const target = entryLevel();
      if (target >= entries.current) return;
      const steps = entries.current - target;
      entries.current = target;
      for (let k = 0; k < steps && depthRef.current - k > 0; k++) void bridge.nav({ action: "pop" });
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    if (depth < entries.current) {
      const extra = entries.current - depth;
      entries.current = depth;
      ignore.current++;
      history.go(-extra);
      return;
    }
    while (entries.current < depth) {
      entries.current++;
      history.pushState({ herdrRelay: entries.current }, "");
    }
  }, [depth]);
}

const pop = () => void bridge.nav({ action: "pop" });

export function Navigator(): ReactElement | null {
  const shown = useApp(shownGraph);
  const hello = useApp((s) => s.hello);
  const deviceClass = useApp((s) => s.deviceClass);
  const stale = useApp((s) => s.stale !== null);
  const epoch = useApp((s) => s.graphEpoch);

  // A rotation or Split View changed the class before the bridge answered: recompose the layout locally.
  const graph: ScreenGraph | null = useMemo(() => {
    if (!shown || !hello || shown.class === deviceClass) return shown;
    return recomposeTree(hello.layout.name, hello.layout.tree, deviceClass);
  }, [shown, hello, deviceClass]);
  const index = useMemo(() => indexLayout(hello?.layout.tree ?? {}), [hello?.layout.tree]);
  const stack = useMemo(() => (graph ? liveStack(graph) : []), [graph]);
  const layers = useLayers(stack, epoch);
  useHistoryBack(Math.max(0, stack.length - 1));

  const home = stack[0];
  const screenClass = graph?.class ?? deviceClass;
  const leadingBar = home ? leadingBarOf(home.screen, screenClass) : null;
  const ctx = useMemo(() => ({ index, deviceClass: screenClass, leadingBar }), [index, screenClass, leadingBar]);

  // Edge swipe opens the drawer (phone).
  const drawer = graph ? drawerRoute(graph) : undefined;
  const touch = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    const fromEdge = drawer?.side === "right" ? innerWidth - t.clientX : t.clientX;
    touch.current = drawer && fromEdge < EDGE_PX && !stack.includes(drawer) ? { x: t.clientX, y: t.clientY } : null;
  };
  const onTouchMove = (e: ReactTouchEvent) => {
    const start = touch.current;
    if (!start || !drawer) return;
    const t = e.touches[0];
    const dx = (t.clientX - start.x) * (drawer.side === "right" ? -1 : 1);
    if (dx > SWIPE_PX && Math.abs(t.clientY - start.y) < dx / 2) {
      touch.current = null;
      void bridge.nav({ action: "push", route: drawer.path });
    }
  };

  if (!graph || !home) return null;
  const rootLook = lookStyle(hello?.layout.tree, false);
  const coveredBelow = (i: number) => stack.slice(i + 1).some((r) => r.open === "push");
  // A drawer or side sheet above is modal (`aria-modal`): what it overlays stays drawn but takes no focus or input.
  const modalAbove = (i: number) => stack.slice(i + 1).some((r) => r.open === "drawer" || r.open === "sheet");
  const settledPaths = new Set(layers.filter((l) => l.settled).map((l) => l.route.path));
  // Covered by routes that did not slide in: hidden at once, not after the push animation.
  const coverSettled = (i: number) =>
    stack.slice(i + 1).filter((r) => r.open === "push").every((r) => settledPaths.has(r.path));

  return (
    <ScreenContext.Provider value={ctx}>
      <div
        className="nav"
        data-class={graph.class}
        data-stale={stale || undefined}
        style={rootLook}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      >
        <div className="nav__content">
          {layers.map(({ route, leaving, settled }) => {
            const i = stack.indexOf(route);
            const covered = !leaving && i >= 0 && coveredBelow(i);
            const cover = covered ? (coverSettled(i) ? "settled" : "animated") : undefined;
            const blocked = !leaving && i >= 0 && modalAbove(i);
            if (route.path === HOME_ROUTE || route.open === "root") {
              return (
                <HomeLayer
                  key={route.path}
                  route={route}
                  cover={cover}
                  blocked={blocked}
                  hasLeadingBar={leadingBar !== null}
                />
              );
            }
            if (route.open === "push") {
              return (
                <PushLayer
                  key={route.path}
                  route={route}
                  leaving={leaving}
                  cover={cover}
                  blocked={blocked}
                  settled={settled}
                />
              );
            }
            return <SideLayer key={route.path} route={route} leaving={leaving} settled={settled} />;
          })}
        </div>
        <FloatingSheets sheets={graph.sheets} phone={graph.class === "phone"} />
      </div>
    </ScreenContext.Provider>
  );
}

/** How a layer is covered by pushed routes: `settled` ones hide it at once, `animated` ones after they slid in. */
type Cover = "settled" | "animated" | undefined;

function HomeLayer(
  { route, cover, blocked, hasLeadingBar }: {
    route: ScreenRoute;
    cover: Cover;
    blocked: boolean;
    hasLeadingBar: boolean;
  },
): ReactElement {
  const hidden = cover !== undefined || blocked;
  return (
    <section
      className="layer layer--home"
      data-covered={cover}
      inert={hidden}
      aria-hidden={hidden || undefined}
      aria-label={titleOf(route.node)}
    >
      {hasLeadingBar ? null : (
        <div className="layer__float-button">
          <ShellButton />
        </div>
      )}
      <ScreenView node={route.screen} axis="column" root />
    </section>
  );
}

function PushLayer(
  { route, leaving, cover, blocked, settled }: {
    route: ScreenRoute;
    leaving: boolean;
    cover: Cover;
    blocked: boolean;
    settled: boolean;
  },
): ReactElement {
  const swipe = useRef<number | null>(null);
  const hidden = cover !== undefined || leaving || blocked;
  return (
    <section
      className="layer layer--push"
      data-leaving={leaving || undefined}
      data-covered={cover}
      data-settled={settled || undefined}
      inert={hidden}
      aria-hidden={hidden || undefined}
      aria-label={titleOf(route.node)}
      onTouchStart={(e) => (swipe.current = e.touches[0].clientX < EDGE_PX ? e.touches[0].clientX : null)}
      onTouchMove={(e) => {
        if (swipe.current !== null && e.touches[0].clientX - swipe.current > SWIPE_PX * 1.5) {
          swipe.current = null;
          pop();
        }
      }}
    >
      <header className="route-header">
        <button type="button" className="route-header__back" onClick={pop} aria-label="Back">
          <Icon name="back" size={22} />
          <span>Back</span>
        </button>
        <h2 className="route-header__title">{titleOf(route.node)}</h2>
        <span className="route-header__spacer" />
      </header>
      <div className="layer__body">
        <ScreenView node={route.screen} axis="column" root />
      </div>
    </section>
  );
}

/** Drawer (phone) and sheet routes (tablet-portrait trailing panels). */
function SideLayer(
  { route, leaving, settled }: { route: ScreenRoute; leaving: boolean; settled: boolean },
): ReactElement {
  const node = useContext(ScreenContext).index.get(route.node);
  const panel = useRef<HTMLElement>(null);
  useEffect(() => panel.current?.focus({ preventScroll: true }), []);
  const side = route.side ?? (route.open === "drawer" ? "left" : "right");
  const drawer = route.open === "drawer";
  // A panel keeps its layout width (clamped to its min/max), within 90 % of the screen.
  const px = Math.max(node?.min ?? 0, drawer ? 300 : 420, Math.min(node?.size?.px ?? 0, node?.max ?? Infinity));
  const swipe = useRef<number | null>(null);
  const style: CSSProperties = { ["--side-width" as string]: `min(${drawer ? 86 : 90}vw, ${px}px)` };
  return (
    <div
      className={`side side--${side}${drawer ? " side--drawer" : ""}`}
      data-leaving={leaving || undefined}
      data-settled={settled || undefined}
      style={style}
      inert={leaving}
    >
      <div className="side__scrim" onClick={pop} aria-hidden="true" />
      <section
        className="side__panel"
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={titleOf(route.node)}
        onKeyDown={(e) => e.key === "Escape" && pop()}
        onTouchStart={(e) => (swipe.current = e.touches[0].clientX)}
        onTouchMove={(e) => {
          const start = swipe.current;
          if (start === null) return;
          const dx = (e.touches[0].clientX - start) * (side === "left" ? -1 : 1);
          if (dx > SWIPE_PX) {
            swipe.current = null;
            pop();
          }
        }}
      >
        {drawer ? null : (
          <header className="side__header">
            <h2 className="side__title">{titleOf(route.node)}</h2>
            <button type="button" className="icon-button" onClick={pop} aria-label={`Close ${titleOf(route.node)}`}>
              <Icon name="close" />
            </button>
          </header>
        )}
        <div className="side__body">
          <ScreenView node={route.screen} axis="column" root />
        </div>
        {drawer ? <DrawerFooter /> : null}
      </section>
    </div>
  );
}

/** The drawer's last row: this device and its connection, opening the device panel. */
function DrawerFooter(): ReactElement {
  const device = useApp((s) => (s.gate.kind === "ready" ? s.gate.device : null));
  const tone = useApp(connTone);
  return (
    <footer className="drawer-footer">
      <button
        type="button"
        className="drawer-footer__button"
        onClick={() => {
          pop();
          setState({ panel: "device" });
        }}
      >
        <Icon name="bell" size={20} />
        <span className="drawer-footer__text">
          <span className="drawer-footer__title">Device &amp; Notifications</span>
          <span className="drawer-footer__sub">
            <span className="status-dot" data-tone={tone} aria-hidden="true" />
            {`${device?.name ?? "this device"} · ${TONE_TEXT[tone]}`}
          </span>
        </span>
        <Icon name="forward" size={18} />
      </button>
    </footer>
  );
}

/** R4 floating entries (and the session's peek terminal) as sheets; `peek` ones collapse to a 44 px handle. */
function FloatingSheets({ sheets, phone }: { sheets: readonly ScreenSheet[]; phone: boolean }): ReactElement | null {
  const [open, setOpen] = useState<string | null>(null);
  if (sheets.length === 0) return null;
  const docked = sheets.filter((s) => s.peek !== undefined && !s.id.startsWith("peek:"));
  const expanded = sheets.filter((s) => s.id === open || s.peek === undefined || s.id.startsWith("peek:"));
  return (
    <>
      {phone && docked.length
        ? (
          <div className="dock">
            {docked.map((s) => <PeekHandle key={s.id} sheet={s} onOpen={() => setOpen(s.id)} />)}
          </div>
        )
        : null}
      {phone ? null : docked.map((s) => <PeekHandle key={s.id} sheet={s} onOpen={() => setOpen(s.id)} />)}
      {expanded.map((s) => {
        const peek = s.id.startsWith("peek:");
        const side = phone ? "bottom" : s.edge;
        return (
          <Sheet
            key={s.id}
            side={side}
            label={titleOf(s.id)}
            size={side === "bottom" || side === "top" ? "72vh" : "min(90vw, 420px)"}
            className="sheet--floating"
            onClose={() => (peek ? pop() : setOpen(null))}
          >
            <div className="sheet__screen">
              <ScreenView node={s.screen} axis="column" root />
            </div>
          </Sheet>
        );
      })}
    </>
  );
}

function PeekHandle({ sheet, onOpen }: { sheet: ScreenSheet; onOpen: () => void }): ReactElement {
  return (
    <button
      type="button"
      className={`peek peek--${sheet.edge} peek--${sheet.align}`}
      aria-haspopup="dialog"
      onClick={onOpen}
      style={{ ["--peek" as string]: `${Math.max(44, sheet.peek ?? 44)}px` }}
    >
      <span className="peek__grip" aria-hidden="true" />
      <span className="peek__label">{titleOf(sheet.id)}</span>
    </button>
  );
}
