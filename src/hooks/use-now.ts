"use client";

import { useSyncExternalStore } from "react";

// useSyncExternalStore's contract: getSnapshot() must return a value
// that's stable between calls unless the external store actually
// changed — React calls it both before and after commit to check for
// "tearing," and if the two calls disagree it schedules an immediate
// re-render to reconcile. The previous version of this hook returned
// `Date.now()` directly from getSnapshot, which changes on essentially
// every call (including React's own consistency-check calls) — React
// perceived that as "the store changed" on every single check, forcing
// a synchronous re-render, which called getSnapshot again, saw yet
// another new value, and so on: exactly the "Maximum update depth
// exceeded" loop this caused in the lobby (LobbyRoom and EventCountdown/
// EventEntryStatus all call useNow()). Confirmed via a regression test
// (use-now.test.tsx) that deterministically forces Date.now() to
// increment on every call — this reproduced the exact error, with
// React's own diagnostic ("The result of getSnapshot should be cached to
// avoid an infinite loop") pointing straight at the cause.
//
// The fix: getSnapshot reads a cached value that only advances when the
// subscribed interval actually fires, not on every call.
let cachedNow = Date.now();

function subscribe(callback: () => void) {
  const id = setInterval(() => {
    cachedNow = Date.now();
    callback();
  }, 1000);
  return () => clearInterval(id);
}

function getSnapshot() {
  return cachedNow;
}

function getServerSnapshot() {
  return null;
}

/**
 * A ticking clock (updates every second), read via useSyncExternalStore
 * rather than useState+useEffect — the wall clock is genuinely external
 * mutable state, which is exactly what useSyncExternalStore is for, and
 * it avoids the extra render pass ESLint's react-hooks/set-state-in-effect
 * rule flags for the setState-on-mount pattern. Returns null during
 * SSR/before hydration (there is no "current time" that could match
 * between server and client), so consumers should render a placeholder
 * until it's non-null.
 */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
