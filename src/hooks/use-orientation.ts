"use client";

import { useSyncExternalStore } from "react";

export type Orientation = "portrait" | "landscape";

const QUERY = "(orientation: portrait)";

function subscribe(callback: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): Orientation {
  return window.matchMedia(QUERY).matches ? "portrait" : "landscape";
}

function getServerSnapshot(): Orientation {
  return "portrait";
}

/**
 * `window.matchMedia('(orientation: portrait)')` with a change listener —
 * not a viewport-width breakpoint, since orientation and screen size are
 * different axes (see ARCHITECTURE.md's mobile orientation implementation
 * notes). Read via `useSyncExternalStore` rather than `useEffect`+
 * `useState`, same reasoning as `useNow` (see its own comment): setting
 * state synchronously inside an effect on every mount/param change is a
 * lint violation (`react-hooks/set-state-in-effect`) precisely because
 * it's the wrong tool for "subscribe to external state" — this is
 * genuinely external, mutable browser state. `getServerSnapshot` returns
 * a fixed "portrait" default for the server render / before hydration,
 * since there is no client viewport to ask about on the server.
 *
 * Callers must not put anything stateful/live behind this hook's result —
 * see the room's component structure: `useLiveRoomConnection`,
 * `useActiveSpeakers`, and `useLobbyRealtime` are all called in a
 * component that renders unconditionally, above whichever presentation
 * component this hook's value selects between.
 */
export function useOrientation(): Orientation {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
