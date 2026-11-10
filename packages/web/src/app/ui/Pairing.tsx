/**
 * Access screens: pairing (DESIGN.md §4: `herdr-relay pair` on the Mac prints a 6-digit code valid 2 minutes; the
 * device redeems it and gets its httpOnly cookie) and "cannot open" with what to do about each gate refusal.
 */

import { type FormEvent, type ReactElement, useRef, useState } from "react";
import { HttpError, pairDevice } from "../api.ts";
import { bridge } from "../client.ts";
import { guessDeviceName } from "../env.ts";
import { Icon } from "./icons.tsx";
import { AppMark } from "./Status.tsx";

export function PairingScreen({ pairing, login }: { pairing: boolean; login: string | null }): ReactElement {
  const [code, setCode] = useState("");
  const [name, setName] = useState(guessDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeInput = useRef<HTMLInputElement>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) {
      setError("Enter all 6 digits of the code.");
      codeInput.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await pairDevice(code, name.trim() || guessDeviceName());
      await bridge.recheck();
    } catch (err) {
      setError(
        err instanceof HttpError
          ? err.status === 403 && /code/.test(err.message)
            ? "That code is wrong or expired. Run herdr-relay pair on the Mac for a new one."
            : err.message
          : "The Mac did not answer. Check that the bridge is running, then try again.",
      );
      setCode("");
      codeInput.current?.focus();
    } finally {
      setBusy(false);
    }
  };

  if (!pairing) {
    return (
      <main className="center-screen">
        <div className="center-card">
          <AppMark />
          <h1 className="center-card__title">Pairing Is Off</h1>
          <p className="center-card__text">
            This Mac runs herdr-relay without its sandbox, so it does not accept devices from the tailnet.
          </p>
          <button type="button" className="button" onClick={() => void bridge.recheck()}>
            <Icon name="refresh" size={18} />
            Check Again
          </button>
        </div>
      </main>
    );
  }

  return (
    <main className="center-screen">
      <form className="center-card pair" onSubmit={submit} noValidate>
        <AppMark />
        <h1 className="center-card__title">Pair This Device</h1>
        <p className="center-card__text">
          On the Mac, run <code translate="no">herdr-relay pair</code>{" "}
          and enter the code it prints. Codes work once, for 2&nbsp;minutes.
        </p>
        {login ? <p className="pair__who">{`Signed in to Tailscale as ${login}`}</p> : null}
        <label className="field">
          <span className="field__label">Pairing code</span>
          <input
            ref={codeInput}
            className="field__input field__input--code"
            name="one-time-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="000000"
            value={code}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? "pair-error" : undefined}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
        </label>
        <label className="field">
          <span className="field__label">Device name</span>
          <input
            className="field__input"
            name="device-name"
            autoComplete="off"
            maxLength={64}
            placeholder="Kitchen iPad…"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <p id="pair-error" className="field__error" role="alert">{error}</p>
        <button type="submit" className="button button--primary button--wide" disabled={busy}>
          {busy ? <span className="spinner spinner--small" aria-hidden="true" /> : <Icon name="key" size={18} />}
          {busy ? "Pairing…" : "Pair Device"}
        </button>
      </form>
    </main>
  );
}

function hint(status: number, why: string): string {
  if (status === 401 && /token/.test(why)) {
    return "On this Mac (a simulator or emulator), open the app with the loopback token: /herdr-relay/?token=<the contents of ~/.herdr/herdr-relay/token>.";
  }
  if (/owner/.test(why)) return "Sign in to Tailscale on this device as the Mac's owner.";
  if (status === 421) {
    return "Open the app at the Mac's Tailscale address (https://<mac>.<tailnet>.ts.net/herdr-relay/).";
  }
  if (status === 503) return "Tailscale is not running on the Mac.";
  if (/insecure|tailnet access is off/.test(why)) {
    return "The bridge runs without its sandbox and refuses tailnet devices.";
  }
  return "Check the bridge on the Mac (herdr-relay) and try again.";
}

export function DeniedScreen({ status, why }: { status: number; why: string }): ReactElement {
  return (
    <main className="center-screen">
      <div className="center-card">
        <AppMark />
        <h1 className="center-card__title">Can’t Open herdr-relay</h1>
        <p className="center-card__text">
          <strong>{why}</strong>
          <span className="center-card__code">{` (${status})`}</span>
        </p>
        <p className="center-card__text center-card__text--muted">{hint(status, why)}</p>
        <button type="button" className="button" onClick={() => void bridge.recheck()}>
          <Icon name="refresh" size={18} />
          Try Again
        </button>
      </div>
    </main>
  );
}
