"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 1024px)";

function subscribe(callback: () => void) {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

function getSnapshot(): boolean {
  return window.matchMedia(QUERY).matches;
}

function getServerSnapshot(): boolean {
  return false;
}

/**
 * A second, independent axis from `useOrientation` — *how much width is
 * actually available*, not aspect ratio. Deliberately a fixed width
 * threshold (Tailwind's own `lg` breakpoint, 1024px), not `width >
 * height`: an iPhone in landscape is roughly 700–950px wide at most,
 * comfortably below this, so it stays classified as mobile — exactly the
 * real-device finding that motivated this hook (rotating a phone must
 * never accidentally read as "desktop"). A genuine desktop/laptop window
 * is reliably ≥1024px even when not maximized.
 *
 * Combined with `useOrientation`, this is what lets `EventRoom` pick
 * between three room compositions instead of two — mobile portrait
 * (`PortraitRoom`), mobile landscape (`MobileLandscapeRoom`, same
 * video-first/overlay philosophy as portrait), and desktop (`DesktopRoom`,
 * a real sidebar) — see EventRoom's own doc comment. Same
 * `useSyncExternalStore`/`matchMedia` shape as `useOrientation` — a
 * genuinely external, mutable signal (the window can be resized while
 * mounted), not something `useEffect`+`useState` should own (see that
 * hook's own comment for why). `getServerSnapshot` defaults to `false`
 * (mobile) for the same reason `useOrientation` defaults to portrait: no
 * real viewport exists on the server, and a mobile-first default avoids
 * a first-paint flash into the wrong composition for the common case.
 */
export function useIsDesktopViewport(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
