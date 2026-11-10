/**
 * The shell's terminal renderer (`provideTerminalRenderer`): every terminal screen, pane body, peek sheet and
 * `k:"terminal"` node. It follows the terminal through the bridge (`stream.ts`) in observe mode; an `act` device may
 * type into it. A screen that follows the focused agent while none is focused says so instead.
 */

import { type ReactElement, useMemo } from "react";
import type { TerminalRendererProps } from "../../app/slots.tsx";
import { bridgeTerminalSource } from "./stream.ts";
import { TerminalView } from "./TerminalView.tsx";

export function TerminalWidget({ terminal, agent, stale, scope }: TerminalRendererProps): ReactElement {
  const source = useMemo(() => (terminal ? bridgeTerminalSource(terminal) : null), [terminal]);
  if (!terminal || !source) {
    return (
      <div className="w-term w-term--empty" role="status">
        <span className="w-term__empty">
          {agent === "focused" ? "No agent is focused on the Mac" : "No terminal here"}
        </span>
      </div>
    );
  }
  return (
    <TerminalView
      key={terminal}
      source={source}
      label={`Terminal ${terminal}`}
      canType={scope === "act"}
      stale={stale}
    />
  );
}
