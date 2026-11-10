/** The app root: access screens until the device may connect, then the navigator with its shell layers. */

import type { ReactElement } from "react";
import { useApp } from "../store.ts";
import { DevicePanel } from "./DevicePanel.tsx";
import { KeyboardDiagnostics } from "./KeyboardDiagnostics.tsx";
import { Navigator } from "./Navigator.tsx";
import { Overlays } from "./Overlays.tsx";
import { DeniedScreen, PairingScreen } from "./Pairing.tsx";
import { ConnectingScreen, StatusBanner } from "./Status.tsx";
import { Toasts } from "./Toasts.tsx";

function Main(): ReactElement {
  const gate = useApp((s) => s.gate);
  const hasGraph = useApp((s) => s.graph !== null);
  if (gate.kind === "pair") return <PairingScreen pairing={gate.pairing} login={gate.login} />;
  if (gate.kind === "denied") return <DeniedScreen status={gate.status} why={gate.why} />;
  if (!hasGraph) return <ConnectingScreen />;
  return (
    <>
      <StatusBanner />
      <Navigator />
      <Overlays />
      <DevicePanel />
    </>
  );
}

export function App(): ReactElement {
  return (
    <div className="app">
      <Main />
      <Toasts />
      <KeyboardDiagnostics />
    </div>
  );
}
