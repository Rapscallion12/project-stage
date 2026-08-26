"use client";

import { useEffect, useRef } from "react";

/**
 * Issue #18 real-device finding (2026-08-28): the previous round's fix
 * (`useActiveSpeakers` resyncing on every Realtime `SUBSCRIBED`
 * callback) closed the gap for a missed delta *discovered at
 * (re)connect time* — but the split-layout report reproduced again on
 * the clean build, with a new, decisive observation: tapping "Join" a
 * *second* time immediately fixed it. That proves the reconciliation
 * mechanism itself (`useActiveSpeakers`' `refetch()`) was already
 * correct — `joinOpenSeat`'s `already-speaking` result already triggers
 * it (see `EventRoom`'s `handleTapEmptySeat`). The only real gap left
 * was that nothing *automatic* ever called it; the user had to
 * accidentally rediscover the contradiction by tapping something.
 *
 * This hook is the automatic version of the exact same reconciliation —
 * it never talks to the server itself and never introduces a second
 * "am I really a speaker" flag; it just calls the *same* `refetch`
 * `EventRoom` already has, from more places, so the client's
 * `mySeatNumber`/`participantRole` (still the one canonical value
 * everything else derives from) never has to wait for the user to
 * accidentally trigger a fix.
 *
 * **The watchdog, not polling**: `canPublish` (from
 * `useLiveRoomConnection`, itself only ever true once LiveKit's server
 * has genuinely granted this identity publish rights for its own seat)
 * is the single most direct "does LiveKit currently believe I'm a
 * speaker" signal available client-side, and it's already live state,
 * not something this hook has to ask for — so watching it costs
 * nothing extra. `canPublish && !isSpeaker` is exactly the
 * contradiction the real-device report captured (LiveKit says speaker,
 * the DB-derived client role says audience) — including the "local
 * camera/mic publication starting" case: actual publishing is always
 * gated on `canPublish` already being true (see
 * `useLiveRoomConnection`'s `needsMediaActivation`/`activateMedia`), so
 * there's no publishing state that isn't already covered by watching
 * this one boolean first. Triggers `refetch()` once per contradiction
 * *episode* (the ref, not a poll or an interval) — resolved either by
 * the refetch correcting `isSpeaker` (the common case) or by the
 * contradiction genuinely clearing on its own; React's own effect
 * dependency comparison already means the effect body simply doesn't
 * re-run while `[canPublish, isSpeaker]` haven't changed, so this can't
 * become a tight loop even without the ref, but the ref keeps a rapid
 * true→false→true flicker from re-triggering redundantly too.
 *
 * **Visibility/focus restoration**: event-driven (a `visibilitychange`/
 * `focus` listener), not a timer — a backgrounded mobile browser tab is
 * exactly where a Realtime WebSocket can silently degrade without the
 * app ever being told, so resyncing the moment the tab is looked at
 * again is a cheap, well-targeted place to catch that, independent of
 * whether any local contradiction happens to be visible yet.
 */
export function useSeatReconciliation(params: { isSpeaker: boolean; canPublish: boolean; refetch: () => Promise<void> }): void {
  const { isSpeaker, canPublish, refetch } = params;
  const hasTriggeredForContradictionRef = useRef(false);

  useEffect(() => {
    const contradicted = canPublish && !isSpeaker;
    if (!contradicted) {
      hasTriggeredForContradictionRef.current = false;
      return;
    }
    if (hasTriggeredForContradictionRef.current) return;
    hasTriggeredForContradictionRef.current = true;
    void refetch();
  }, [canPublish, isSpeaker, refetch]);

  useEffect(() => {
    function handleVisibilityRestored() {
      if (document.visibilityState === "visible") void refetch();
    }
    document.addEventListener("visibilitychange", handleVisibilityRestored);
    window.addEventListener("focus", handleVisibilityRestored);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityRestored);
      window.removeEventListener("focus", handleVisibilityRestored);
    };
  }, [refetch]);
}
