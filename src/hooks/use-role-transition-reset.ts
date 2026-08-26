"use client";

import { useEffect, useRef } from "react";

/**
 * Issue #18 consistency fix: becoming a speaker invalidates any
 * candidate-only local state — a pending mic request, the composer's
 * request-mode toggle, a stale join-seat error message. Before this,
 * each individual path that can grant a seat was responsible for
 * remembering to clear its own piece of that state (e.g.
 * `useAutomaticPromotion`'s countdown resolution resets
 * `hasPendingRequest` itself, on success, after its own claim call
 * resolves) — correct per-path, but not a single place guaranteeing
 * "candidate state never outlives the candidate role," and easy to miss
 * for a future promotion path. This hook is that single place: it fires
 * exactly once per false→true transition of `isSpeaker`, regardless of
 * which path caused it, so newly-invalid local state can't linger no
 * matter how the seat was actually reached.
 *
 * Deliberately keyed on the *transition* (a ref-tracked previous value),
 * not "whenever isSpeaker is true" — the caller's `onReset` calls
 * `setState`, so running it unconditionally on every render where
 * `isSpeaker` is already true would be a render-triggers-render loop.
 * Also deliberately does nothing on mount if `isSpeaker` starts `true`
 * (e.g. a page load that lands already-seated) — there's no prior
 * candidate state to invalidate in that case.
 */
export function useRoleTransitionReset(params: { isSpeaker: boolean; onReset: () => void }) {
  const { isSpeaker, onReset } = params;
  const wasSpeaker = useRef(isSpeaker);

  useEffect(() => {
    if (isSpeaker && !wasSpeaker.current) {
      onReset();
    }
    wasSpeaker.current = isSpeaker;
  }, [isSpeaker, onReset]);
}
