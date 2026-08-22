"use client";

import { useCallback, useRef, useState, type PointerEvent } from "react";

/** Tunable, not product doctrine — see this file's own doc comment. */
const DEAD_ZONE_PX = 15;
const DRAG_DISTANCE_PX = 140;
const COMMIT_THRESHOLD = 0.5;

/**
 * Elements a broad room-level gesture surface must never steal a touch
 * from — real interactive controls (buttons, links, form fields) and
 * anything explicitly marked `data-gesture-ignore` (the comment/message
 * list's own scrollable container — see `ChatPanel`). Matched against
 * `event.target`, not `event.currentTarget`: the surface handler is
 * meant to sit on a common ancestor and observe bubbled events, so this
 * decides — per event — whether *this specific touch* started on
 * something that owns its own interaction.
 */
const INTERACTIVE_SELECTOR =
  'button, a, input, textarea, select, [role="button"], [contenteditable="true"], [data-gesture-ignore]';

/**
 * Pure math, exported for direct unit testing without simulating real
 * pointer-event physics (jsdom can't reliably fake touch/drag gestures) —
 * same reasoning `shouldPublish`/`classifyMediaError`/`resolveClaimDecision`
 * are already tested this way elsewhere in this project. Given how far a
 * drag has moved from where it started (`deltaY`, positive = finger moved
 * *down* — the "pull down to reveal what's underneath" direction this
 * pass's real-device correction settled on) and whether the panel was
 * already open when the drag began, returns the panel's live open
 * progress: `0` fully closed, `1` fully open. Movement within the dead
 * zone produces exactly zero effective change regardless of direction —
 * a stray finger movement during a normal tap never nudges the panel at
 * all, not just "nudges it a little."
 */
export function computeDragProgress(deltaY: number, startedOpen: boolean): number {
  const magnitude = Math.abs(deltaY);
  const effective = magnitude <= DEAD_ZONE_PX ? 0 : Math.sign(deltaY) * (magnitude - DEAD_ZONE_PX);
  const base = startedOpen ? 1 : 0;
  return Math.min(1, Math.max(0, base + effective / DRAG_DISTANCE_PX));
}

/**
 * Issue #21, corrected (real-device finding, 2026-08-22): the first
 * slice required grabbing a small dedicated handle — the actual product
 * intent is a *room-level* gesture, naturally started from broad video/
 * background surface, the same way pulling down a notification shade
 * doesn't require finding a specific handle first. This hook no longer
 * owns or exposes anything handle-specific; it owns the reveal state
 * (`open`/`progress`/`dragging`) plus a single `surfaceProps` bundle
 * meant to be spread onto one broad ancestor element (see
 * `MobileLandscapeRoom` — the stage wrapper containing the video,
 * header, and chat/controls overlay together). Two independent, always-
 * available triggers reach the *same* state: `openComments`/
 * `closeComments` (for the compact 💬 affordance and the explicit
 * hide control — plain function calls, no gesture involved) and the
 * surface's own drag handlers. Neither is "the real one" — both just
 * set the same `open` boolean.
 *
 * **Interactive-descendant exclusion**: `onPointerDown` checks
 * `event.target` against `INTERACTIVE_SELECTOR` *before* doing anything
 * — if the touch started on a button, link, form field, or anything
 * marked `data-gesture-ignore`, this returns immediately without
 * capturing the pointer or tracking a drag, so the touch reaches that
 * element completely normally (its own onClick, native text selection,
 * etc. — nothing here ever calls `preventDefault()`/`stopPropagation()`
 * on an excluded touch). This only works because the surface handler
 * sits on a genuine DOM ancestor of those controls (event delegation via
 * bubbling) rather than a separate overlay layered on top of them — a
 * `pointer-events: auto` layer *on top* of a button would swallow the
 * tap before it ever reached the button at all, which is why this isn't
 * built as a transparent overlay div.
 *
 * **Once a drag is already tracking** (the initial touch was *not* on an
 * excluded element), `onPointerMove` calls `preventDefault()` — this is
 * what keeps iOS Safari's own rubber-band/scroll from competing with the
 * manual drag, without needing a blanket `touch-action: none` on the
 * shared ancestor (which would have also disabled the *message list's*
 * own scrolling, since CSS `touch-action` is the *intersection* of an
 * element and all its ancestors — setting it on a shared ancestor of
 * both the gesture surface and the message list can't be scoped to only
 * one of them). The message list itself carries its own
 * `data-gesture-ignore` (excluding it from ever starting a tracked drag
 * here at all) and an explicit `touch-pan-y` (belt-and-suspenders,
 * reasserting normal vertical scroll for its own subtree). This is a
 * deliberate simplification, not a proven-reliable choice — flagged
 * explicitly as untested on a real device.
 *
 * Deliberately doesn't persist across a composition remount (rotation
 * resets it to closed) — ephemeral UI state, not the "live" state this
 * project's hooks-above-the-branch rule is about.
 */
export function useCommentsFocus() {
  const [open, setOpen] = useState(false);
  const [dragProgress, setDragProgress] = useState<number | null>(null);
  const dragRef = useRef<{ pointerId: number; startY: number; startedOpen: boolean } | null>(null);

  const progress = dragProgress ?? (open ? 1 : 0);
  const dragging = dragProgress !== null;

  const openComments = useCallback(() => setOpen(true), []);
  const closeComments = useCallback(() => setOpen(false), []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest(INTERACTIVE_SELECTOR)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startedOpen: open };
      setDragProgress(open ? 1 : 0);
    },
    [open],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const deltaY = event.clientY - drag.startY; // positive = finger moved down = reveal direction
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
    openComments,
    closeComments,
    surfaceProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
