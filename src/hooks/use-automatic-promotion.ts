"use client";

import { useEffect, useState } from "react";
import {
  checkPromotionEligibility,
  claimOpenSeat,
  leaveSpeakerSeat,
  withdrawSpeakerRequest,
} from "@/app/events/[id]/room/actions";
import type { MediaError } from "@/hooks/use-live-room-connection";
import { useRoleTransitionReset } from "@/hooks/use-role-transition-reset";
import type { EventPhase } from "@/lib/events";

/** Tunable, not product doctrine — see this file's own doc comment. */
const POLL_INTERVAL_MS = 4000;
export const PROMOTION_COUNTDOWN_SECONDS = 3;
const MEDIA_ACTIVATION_GRACE_MS = 30_000;

/**
 * Issue #23: replaces the manual "Claim your seat" button with automatic,
 * server-authorized promotion. The countdown this hook drives is
 * deliberately *not* an eligibility mechanism — see `checkPromotionEligibility`'s
 * own doc comment (room/actions.ts) for why: it's a client-side timer
 * that exists only to notify a candidate, give them a moment to prepare,
 * and let them cancel. The actual claim at the end independently
 * re-validates eligibility server-side, exactly as the removed manual
 * button's click handler always did — a stale/lost-race outcome here
 * just silently resets to waiting, never surfaced as an alarming error,
 * since losing a race that was never guaranteed isn't a real failure.
 *
 * **Detection is polling, not purely Realtime-reactive**, on purpose:
 * eligibility depends on rank, which can change from reactions on a
 * *different* candidate's request message without any `event_speakers`
 * row changing at all — a purely Realtime-on-event_speakers approach
 * would miss that. Only candidates with a pending request poll (a small,
 * bounded set — nothing like #25's audience-wide-polling concern this
 * project already ruled out elsewhere), and only while genuinely waiting
 * (not once seated, not once counting down).
 *
 * **Grace-period self-eviction**: issue #23's own approved design calls
 * for a promoted candidate who cancels, disconnects, or never becomes
 * media-ready to be skipped in favor of the next eligible one.
 * Disconnection is already handled by existing infrastructure (issue
 * #13's LiveKit webhook). This hook covers the one case that wasn't:
 * seated but silently never taps "enable camera & mic" (or tries and
 * fails) — after a bounded grace period, self-evicts via the existing
 * `leaveSpeakerSeat` (the same path "Leave the stage" already uses, no
 * new authority), freeing the seat for the next candidate's own polling
 * to pick up naturally. This applies uniformly regardless of *how* the
 * seat was reached (this promotion path or issue #27's direct join) —
 * there's no reason to treat the two differently, and nothing here
 * special-cases which one happened.
 */
export function useAutomaticPromotion(params: {
  eventId: string;
  hasPendingRequest: boolean;
  isSpeaker: boolean;
  phase: EventPhase;
  needsMediaActivation: boolean;
  mediaError: MediaError;
  onHasPendingRequestChange: (value: boolean) => void;
}) {
  const { eventId, hasPendingRequest, isSpeaker, phase, needsMediaActivation, mediaError, onHasPendingRequestChange } =
    params;
  const [countdown, setCountdown] = useState<number | null>(null);
  // Issue #18 UX finding fix: true for exactly as long as a Cancel is in
  // flight (from the moment the user taps it until `withdrawSpeakerRequest`
  // actually resolves) — see `cancel()` and the polling effect below for
  // the race this closes.
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => {
    if (isSpeaker || !hasPendingRequest || phase !== "ready" || countdown !== null || isCancelling) return;

    let cancelled = false;
    async function poll() {
      const result = await checkPromotionEligibility(eventId);
      if (!cancelled && result.eligible) {
        setCountdown(PROMOTION_COUNTDOWN_SECONDS);
      }
    }
    void poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // Issue #18 UX finding fix: `isCancelling` in the guard/deps closes a
    // real race — `cancel()` sets `countdown` to `null` immediately (so
    // the center-stage overlay disappears at once), which alone would
    // re-run *this* effect the same render. Without `isCancelling`,
    // `hasPendingRequest` is still `true` at that instant (the server
    // withdrawal hasn't resolved yet), so the guard above would pass and
    // immediately start a *new* poll — and if `checkPromotionEligibility`
    // still reports eligible (because the withdrawal genuinely hasn't
    // landed server-side yet), that poll would call `setCountdown` again,
    // resurrecting the just-canceled promotion. `isCancelling` suppresses
    // polling for exactly the window where that race is possible.
  }, [isSpeaker, hasPendingRequest, phase, countdown, eventId, isCancelling]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      // The real, independently-revalidated claim — see
      // checkPromotionEligibility's doc comment for why this can't
      // itself be trusted from the countdown having merely reached zero.
      //
      // Issue #18 UX finding fix: on *success*, this deliberately no
      // longer resets `countdown` or `hasPendingRequest` itself. Both used
      // to reset here, racing an entirely independent completion — the
      // Realtime push that flips `isSpeaker` true (see EventRoom) — with
      // no guaranteed ordering between the two. When this reset won that
      // race, the composition (still gated on `isSpeaker`, not yet true)
      // fell back to plain Watch Mode for one or more render frames before
      // `isSpeaker` caught up: the exact "candidate UI flash right before
      // Speaker View" real-device report this fix addresses. `isSpeaker`
      // flipping true is now the single authoritative signal that ends
      // this state — the effect below resets `countdown` once that
      // happens (in `useAutomaticPromotion` itself), and `EventRoom`'s
      // `useRoleTransitionReset` resets `hasPendingRequest` (and
      // `micRequestMode`/`joinSeatMessage`) the same way, regardless of
      // which path granted the seat. Until `isSpeaker` flips, the
      // countdown overlay simply stays on screen (frozen at 0) — still a
      // legitimate part of the same transition, never a fallback to stale
      // candidate UI. A *failed*/lost-race claim is different: nothing
      // else will ever flip `isSpeaker` true for this attempt, so
      // `countdown` must still reset here to fall back to waiting — see
      // this hook's own doc comment ("a stale/lost-race outcome... just
      // silently resets to waiting").
      void claimOpenSeat(eventId).then((result) => {
        if (!("ok" in result)) setCountdown(null);
      });
      return;
    }
    const timeout = setTimeout(() => setCountdown((seconds) => (seconds === null ? null : seconds - 1)), 1000);
    return () => clearTimeout(timeout);
  }, [countdown, eventId]);

  // Issue #18 UX finding fix: the single reconciliation point for this
  // hook's own `countdown` state, keyed to the one authoritative
  // `isSpeaker` signal — reuses the *same* `useRoleTransitionReset` hook
  // `EventRoom` already calls for `hasPendingRequest`/`micRequestMode`/
  // `joinSeatMessage`, rather than a second, parallel reconciliation
  // mechanism. Without this, a countdown left frozen at 0 by a successful
  // claim (see above) would still be sitting non-null the next time this
  // composition renders (e.g. after the speaker later leaves the stage),
  // incorrectly resurrecting the center-stage overlay.
  useRoleTransitionReset({
    isSpeaker,
    onReset: () => setCountdown(null),
  });

  useEffect(() => {
    if (!isSpeaker || (!needsMediaActivation && !mediaError)) return;
    const timeout = setTimeout(() => {
      void leaveSpeakerSeat(eventId);
    }, MEDIA_ACTIVATION_GRACE_MS);
    return () => clearTimeout(timeout);
  }, [isSpeaker, needsMediaActivation, mediaError, eventId]);

  function cancel() {
    setIsCancelling(true);
    setCountdown(null);
    // Both state updates below happen in this one `.then()` callback,
    // deliberately not split across `.then()`/`.finally()` — two chained
    // continuations run in two separate microtask ticks, which (even with
    // `isCancelling` above) can still land `onHasPendingRequestChange`
    // and clearing `isCancelling` in two different renders, briefly
    // reopening the exact re-arm race this fix closes. Calling both
    // together lets them batch into the same commit.
    void withdrawSpeakerRequest(eventId).then((result) => {
      if (!("error" in result)) onHasPendingRequestChange(false);
      setIsCancelling(false);
    });
  }

  return { countdown, cancel };
}
