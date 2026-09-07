"use client";

import { useEffect, useRef } from "react";
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
 *
 * **`onSingleTap`** (speaker presentation-toggle correction, real-device
 * report): optional — when given, a tap that *isn't* joined by a second
 * tap within `DOUBLE_TAP_WINDOW_MS` fires this instead, after that same
 * window elapses. This is the standard single-vs-double-tap
 * disambiguation strategy: the first tap can never immediately commit to
 * "single," because a second tap might still land — so it's held as a
 * *pending* single tap on a bounded timer, fired only once the window
 * passes with nothing else arriving. If a genuine second tap *does*
 * arrive in time, the pending single tap is cancelled outright (the
 * `clearTimeout` below) and only `onDoubleTap` fires — the two are
 * mutually exclusive by construction, never both. Takes no coordinates
 * (unlike `onDoubleTap`): its one caller, `SpeakerTile`'s own
 * "single tap my tile to return to Speaker-Focused View," needs no tap
 * location. Omitted entirely (the default) reproduces this hook's exact
 * original behavior — every other caller (every double-tap-to-react
 * tile that isn't also the local speaker's own Normal Stage View tile)
 * is completely unaffected.
 */
export function useDoubleTap(onDoubleTap: (x: number, y: number) => void, onSingleTap?: () => void) {
  const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
  const pendingSingleTapRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearPendingSingleTap() {
    if (pendingSingleTapRef.current !== null) {
      clearTimeout(pendingSingleTapRef.current);
      pendingSingleTapRef.current = null;
    }
  }

  // Never leave a pending single-tap timer running past this tile's own
  // lifetime — e.g. tapping once, then the toggle it *would* have fired
  // unmounts this exact tile (Normal Stage View exiting for some other
  // reason) before the window elapses.
  useEffect(() => clearPendingSingleTap, []);

  function handlePointerUp(event: ReactPointerEvent<HTMLElement>) {
    // Only the primary pointer/button — a secondary touch mid-gesture
    // (e.g. an accidental second finger) shouldn't count as this tap's
    // partner.
    if (event.pointerType === "mouse" && event.button !== 0) return;

    const target = event.target as HTMLElement;
    if (target.closest('button, a, [role="button"], input, textarea')) {
      lastTapRef.current = null;
      clearPendingSingleTap();
      return;
    }

    const now = Date.now();
    const last = lastTapRef.current;
    const dx = last ? event.clientX - last.x : Infinity;
    const dy = last ? event.clientY - last.y : Infinity;
    const distance = Math.sqrt(dx * dx + dy * dy);

    if (last && now - last.time <= DOUBLE_TAP_WINDOW_MS && distance <= DOUBLE_TAP_MAX_DISTANCE_PX) {
      lastTapRef.current = null;
      // The pending single-tap from the *first* tap of this pair must
      // never fire — this is a double tap, not two singles.
      clearPendingSingleTap();
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      onDoubleTap(x, y);
      return;
    }

    lastTapRef.current = { time: now, x: event.clientX, y: event.clientY };

    if (onSingleTap) {
      clearPendingSingleTap();
      pendingSingleTapRef.current = setTimeout(() => {
        pendingSingleTapRef.current = null;
        // This tap sequence is resolved the moment the single tap fires —
        // clear it so a later, unrelated tap can never pair with this
        // now-stale one and misfire as a double tap (the window check
        // above is `now - last.time <= DOUBLE_TAP_WINDOW_MS`, which a
        // tap landing at exactly this timeout's own fire time would
        // otherwise still satisfy).
        lastTapRef.current = null;
        onSingleTap();
      }, DOUBLE_TAP_WINDOW_MS);
    }
  }

  return { onPointerUp: handlePointerUp };
}
