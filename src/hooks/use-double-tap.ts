"use client";

import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const DOUBLE_TAP_WINDOW_MS = 300;
const DOUBLE_TAP_MAX_DISTANCE_PX = 40;

/**
 * Pre-launch interaction pass, Section 2: manual double-tap detection —
 * deliberately not the native `dblclick` event, which mobile browsers do
 * not reliably fire for touch taps (it's a desktop-mouse-era event); this
 * is the standard mobile pattern instead, tracking two `pointerup`s
 * within a short time window and a small distance tolerance.
 *
 * **Gesture-conflict safety** (Section 2's own explicit requirement):
 * skips detection entirely when the tap landed on a real interactive
 * descendant (a `<button>`/`<a>`, or anything with `role="button"`) —
 * the avatar's `ProfileLink`, the "Tap to enable camera & mic" button,
 * etc. all keep working exactly as before; double-tapping *those*
 * specifically never also fires a reaction. Only taps on the tile's own
 * background surface count.
 *
 * Returns normalized (0-1) coordinates relative to the tapped element's
 * own bounding rect at the moment of the *second* tap — see Section 3's
 * own spec for why tile-relative, not absolute screen pixels.
 */
export function useDoubleTap(onDoubleTap: (x: number, y: number) => void) {
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    // Only the primary pointer/button — a secondary touch mid-gesture
    // (e.g. an accidental second finger) shouldn't count as this tap's
    // partner.
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest('button, a, [role="button"], input, textarea')) {
      lastTapRef.current = null;
      return;
    }

    const now = Date.now();
    const last = lastTapRef.current;
    const dx = last ? event.clientX - last.x : Infinity;
    const dy = last ? event.clientY - last.y : Infinity;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (last && now - last.time <= DOUBLE_TAP_WINDOW_MS && distance <= DOUBLE_TAP_MAX_DISTANCE_PX) {
      lastTapRef.current = null;
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      onDoubleTap(x, y);
      return;
    }

    lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };
  }

  return { onPointerUp: handlePointerUp };
}
