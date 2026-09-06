"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(callback: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  // No real preference to ask about on the server — defaults to false
  // (full motion) for the same reason useOrientation defaults to
  // "portrait": whichever value is picked here only matters for one
  // possible mismatch on first client render, immediately corrected via
  // useSyncExternalStore the same tick real preference is known.
  return false;
}

/**
 * Interaction/UX pass (issue #21-adjacent): `window.matchMedia`-backed,
 * same `useSyncExternalStore` pattern as `useOrientation` — genuinely
 * external, mutable browser state, not something to poll via
 * `useEffect`+`useState`. Used by the timer speaker-swap animation
 * (skips the FLIP transform entirely) and the reaction burst/cooldown
 * animations (simplified/instant) — see each caller's own doc comment
 * for exactly what it disables.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
