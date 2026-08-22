"use client";

import { useCallback, useRef, useState, type PointerEvent } from "react";

/** Tunable, not product doctrine — see this file's own doc comment. */
const DEAD_ZONE_PX = 10;
const DRAG_DISTANCE_PX = 120;
const COMMIT_THRESHOLD = 0.5;

/**
 * Pure math, exported for direct unit testing without simulating real
 * pointer-event physics (jsdom can't reliably fake touch/drag gestures) —
 * same reasoning `shouldPublish`/`classifyMediaError`/`resolveClaimDecision`
 * are already tested this way elsewhere in this project. Given how far a
 * drag has moved from where it started (`deltaY`, positive = finger moved
 * up — the Maps/Music-style expanding-panel convention #21's own issue
 * body cites) and whether the panel was already open when the drag
 * began, returns the panel's live open progress: `0` fully closed, `1`
 * fully open. Movement within the dead zone produces exactly zero
 * effective change regardless of direction — a stray finger movement
 * during a normal tap (on a speaker tile, a reaction button, the
 * composer) never nudges the panel at all, not just "nudges it a
 * little."
 */
export function computeDragProgress(deltaY: number, startedOpen: boolean): number {
  const magnitude = Math.abs(deltaY);
  const effective = magnitude <= DEAD_ZONE_PX ? 0 : Math.sign(deltaY) * (magnitude - DEAD_ZONE_PX);
  const base = startedOpen ? 1 : 0;
  return Math.min(1, Math.max(0, base + effective / DRAG_DISTANCE_PX));
}

/**
 * Issue #21, first slice: the comments-overlay focus toggle — a dedicated
 * drag handle (never the message list's own scroll gesture, never a
 * whole-stage swipe) plus a plain tap, exactly as #21's own issue body
 * specifies. `open`/`progress`/`dragging` are meant to drive presentation
 * only (scrim opacity, an overlay's height/transform) — this hook never
 * touches LiveKit, track attachment, or seat state, and deliberately
 * doesn't persist across a composition remount (rotation resets it to
 * closed) since it's ephemeral UI state, not the "live" state this
 * project's hooks-above-the-branch rule is about.
 *
 * **Ownership boundary vs. scrolling the comments themselves**: this
 * hook's pointer handlers are meant to be spread only onto a small,
 * dedicated handle element — never onto the message list. A touch that
 * starts on the handle is captured here (`setPointerCapture`, `touch-
 * action: none` on the handle in the caller's own className) and never
 * reaches the message list's native `overflow-y-auto` scroll; a touch
 * that starts inside the message list is never seen by this hook at all
 * and scrolls normally. Ownership is decided entirely by *where a touch
 * starts*, not by direction-of-motion heuristics — the simpler, lower-
 * risk boundary #21's own issue body already prescribes.
 *
 * Velocity/flick-based release is deliberately not implemented — release
 * commits purely on final position vs. a fixed threshold. A flick-aware
 * release is a reasonable future refinement, not required for this
 * pass's acceptance bar (the first comments-overlay state).
 */
export function useCommentsFocus() {
  const [open, setOpen] = useState(false);
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startedOpen: boolean } | null>(null);
  // True once a drag has actually crossed the dead zone — lets the plain
  // onClick (which a tap-with-negligible-movement still fires natively,
  // browser click-suppression-after-drag isn't relied on) know a real
  // drag already decided the outcome, so it doesn't also toggle on top
  // of it. Cleared as soon as it's been consulted once.
  const draggedRef = useRef(false);

  const progress = dragProgress ?? (open ? 1 : 0);
  const dragging = dragProgress !== null;

  const onClick = useCallback(() => {
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    setOpen((value) => !value);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startedOpen: open };
      draggedRef.current = false;
      setDragProgress(open ? 1 : 0);
    },
    [open],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const deltaY = drag.startY - event.clientY;
    if (Math.abs(deltaY) > DEAD_ZONE_PX) draggedRef.current = true;
    setDragProgress(computeDragProgress(deltaY, drag.startedOpen));
  }, []);

  const endDrag = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      const finalProgress = dragProgress ?? (drag.startedOpen ? 1 : 0);
      setOpen(finalProgress >= COMMIT_THRESHOLD);
      setDragProgress(null);
      dragRef.current = null;
    },
    [dragProgress],
  );

  return {
    open,
    progress,
    dragging,
    handleProps: {
      onClick,
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
