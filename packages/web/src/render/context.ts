/**
 * What every node of one rendered view shares: the view id handler ids belong to, and where handler invocations go.
 */

import { createContext } from "react";
import type { EventKind } from "@herdr-relay/protocol";

/** Sends one handler invocation of the current tree (`event {view, handler, kind, data}`). */
export type EventSink = (handler: number, kind: EventKind, data: unknown) => void;

export interface RenderEnv {
  /** The view whose handler ids the tree carries; `""` outside any view. */
  view: string;
  /** `null`: nothing is sent (the data is stale, or the tree is shown outside a session). */
  send: EventSink | null;
  /** `key` and `input` events may be sent (an `act` device): a `read` device would only be refused. */
  typing: boolean;
  /** The view is an overlay copy (`<folder>:overlay:<id>`): its focus target takes the keyboard when it opens. */
  overlay: boolean;
}

export const NO_ENV: RenderEnv = { view: "", send: null, typing: false, overlay: false };

export const RenderContext = createContext<RenderEnv>(NO_ENV);
