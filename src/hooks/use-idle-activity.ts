"use client";

import { useEffect, useRef, useState } from "react";

const DEFAULT_IDLE_DELAY_MS = 2500;

/**
 * Pre-launch interaction pass, Section 8: drives the "recedes while
 * watching, solid when used" adaptive-transparency behavior for the
 * lower-stage overlay (`StageOverlayShell`) — not a generic idle-
 * detection utility bolted on elsewhere.
 *
 * Two ways a caller keeps `idle` false:
 * - **Ambient activity** (`registerActivity`): any tap/keypress bubbling
 *   up through the overlay's own subtree — wired via `onPointerDownCapture`/
 *   `onKeyDownCapture`/`onFocusCapture` on the shell's interactive wrapper,
 *   so ordinary composer typing or tapping a control resets the idle timer
 *   without every individual control needing its own wiring.
 * - **Explicit holds** (`holdActive`/`releaseActive`): for state that
 *   lives *outside* that DOM subtree entirely — the reaction panel
 *   (a popover) and Expanded Comments (a full-screen sheet) both call
 *   these directly when they open/close, since focus/typing inside them
 *   would never otherwise bubble through the overlay. A caller can hold
 *   more than one thing open at once (a counter, not a boolean) — idle
 *   only resumes once every hold has released.
 *
 * `idle` flips true only after `idleDelayMs` of *genuine* inactivity — no
 * activity, no open hold — matching Section 8's own "after a short idle
 * delay, approximately 2-3 seconds" spec (default here: 2.5s).
 */
export function useIdleActivity(idleDelayMs: number = DEFAULT_IDLE_DELAY_MS) {
  const [idle, setIdle] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holdCountRef = useRef(0);

  function clearPendingIdle() {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }

  function scheduleIdle() {
    clearPendingIdle();
    if (holdCountRef.current > 0) return;
    timeoutRef.current = setTimeout(() => setIdle(true), idleDelayMs);
  }

  function registerActivity() {
    setIdle(false);
    scheduleIdle();
  }

  function holdActive() {
    holdCountRef.current += 1;
    setIdle(false);
    clearPendingIdle();
  }

  function releaseActive() {
    holdCountRef.current = Math.max(0, holdCountRef.current - 1);
    if (holdCountRef.current === 0) scheduleIdle();
  }

  useEffect(() => {
    scheduleIdle();
    return () => clearPendingIdle();
    // Only ever scheduled once on mount — registerActivity/holdActive/
    // releaseActive all manage the timer themselves afterward; re-running
    // this on every render would fight those.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { idle, registerActivity, holdActive, releaseActive };
}
