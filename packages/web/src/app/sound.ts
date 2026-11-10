/**
 * The Mac's sounds on this device (`sound {src}`: a mod's `playSound`, e.g. Herdr 98's clicks and chords). `src` is
 * mount-relative (`assets/mods/…/x.mp3`). Sounds play only while the page is visible and are never queued; a play
 * the browser refuses is dropped silently. Browsers (iOS above all) allow audio only after a user gesture: the first
 * press or key on the page unlocks a small pool of audio elements, which the sounds then reuse. A per-device mute
 * switch (the device panel) is kept in `localStorage`.
 */

import { useSyncExternalStore } from "react";
import { appUrl } from "./env.ts";

const MUTED_KEY = "herdr-relay.sound.muted";
const POOL_SIZE = 4;
/** A valid, empty WAV: what unlocks an audio element inside the first gesture. */
const SILENCE = "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

const pool: HTMLAudioElement[] = [];
const listeners = new Set<() => void>();
let unlocking = false;

function element(): HTMLAudioElement {
  if (pool.length < POOL_SIZE) {
    const a = new Audio();
    a.preload = "auto";
    pool.push(a);
    return a;
  }
  // A free element, else the one that started longest ago.
  return pool.find((a) => a.paused || a.ended) ?? pool.reduce((x, y) => (x.currentTime >= y.currentTime ? x : y));
}

/** Unlocks the pool on the first user gesture (call once at boot). */
export function unlockAudioOnGesture(): void {
  if (unlocking) return;
  unlocking = true;
  const unlock = () => {
    removeEventListener("pointerdown", unlock, true);
    removeEventListener("keydown", unlock, true);
    while (pool.length < POOL_SIZE) element();
    for (const a of pool) {
      a.src = SILENCE;
      a.play().then(() => a.pause(), () => {});
    }
  };
  addEventListener("pointerdown", unlock, true);
  addEventListener("keydown", unlock, true);
}

export function soundMuted(): boolean {
  try {
    return localStorage.getItem(MUTED_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean): void {
  try {
    if (muted) localStorage.setItem(MUTED_KEY, "1");
    else localStorage.removeItem(MUTED_KEY);
  } catch {
    // Storage refused (private mode): the switch still flips for this page.
  }
  for (const l of listeners) l();
}

/** The mute switch's state, for the device panel. */
export function useSoundMuted(): boolean {
  return useSyncExternalStore((l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  }, soundMuted);
}

/** Plays a bridge `sound`; resolves whether it started (muted, hidden or refused: `false`). */
export async function playSound(src: string): Promise<boolean> {
  if (soundMuted() || document.visibilityState !== "visible") return false;
  const a = element();
  a.src = appUrl(src);
  try {
    await a.play();
    return true;
  } catch {
    return false;
  }
}
