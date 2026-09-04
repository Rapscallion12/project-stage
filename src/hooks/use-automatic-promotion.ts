"use client";

import { useCallback, useEffect, useState } from "react";
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
 * Media Readiness pass (issue #21): bounded window a candidate gets, once
 * the countdown reaches zero, to grant camera+microphone before this hook
 * gives up on them and releases the reservation for the next eligible
 * candidate — see the readiness-timeout effect below. Distinct from
 * `MEDIA_ACTIVATION_GRACE_MS` above, which governs an *already-seated*
 * speaker going silent (both muted) — that grace period is untouched by
 * this pass (Section 17: it solves a different, after-join problem).
 */
const MEDIA_READINESS_TIMEOUT_MS = 45_000;

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
 * **Issue #21, sixth corrective pass: reactive first, polling as a
 * backstop — not the other way around.** This used to poll
 * `checkPromotionEligibility` exclusively, on a fixed interval, with no
 * way to notice a reservation any sooner than the next tick — a
 * real-device pass found this adding several seconds of pure waiting on
 * top of the intentional countdown below, even though the reservation
 * itself (the seat-aware, atomic RPC — see `ensureActiveSelectionRound`,
 * room/actions.ts) typically completes in well under a second.
 * `isCurrentlyReservedCandidate` is derived by the caller from the
 * *same* `pendingRequests` state already flowing into `EventRoom` via
 * Realtime (`is_current_candidate`/`reserved_seat_number`, set by that
 * same RPC) — when it flips true, the effect below starts the countdown
 * immediately, no round trip needed. The poll remains, unchanged in
 * cadence, purely as a backstop for the case a Realtime delta was
 * missed (rank can also change from reactions on a *different*
 * candidate's request message without any `event_speakers` row
 * changing, which a purely occupancy-Realtime approach would miss) —
 * only candidates with a pending request poll at all (a small, bounded
 * set), and only while genuinely waiting (not once seated, not once
 * counting down). The countdown itself is still never trusted as
 * eligibility: the claim at the end independently re-validates
 * server-side regardless of which path (reactive or polled) triggered
 * it.
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
  /** Issue #21, sixth corrective pass: the reactive fast-path signal — see this hook's own doc comment. Derived by the caller from already-live `pendingRequests` state, not fetched here. */
  isCurrentlyReservedCandidate: boolean;
  isSpeaker: boolean;
  phase: EventPhase;
  needsMediaActivation: boolean;
  mediaError: MediaError;
  /**
   * Media Readiness pass (issue #21): whether camera/microphone tracks
   * have actually been verified for *this* candidacy — see
   * `MediaReadinessState` (use-live-room-connection.ts). The claim effect
   * below will not fire `claimOpenSeat` until both are true, closing the
   * "unprepared candidate becomes seated, kicked later" gap the grace
   * period at `MEDIA_ACTIVATION_GRACE_MS` used to be the only defense
   * against. The caller is responsible for actually prompting the
   * candidate to grant media (see `MediaReadinessPrompt`) — this hook
   * only reacts to the resulting readiness, it never calls
   * `prepareLocalMedia` itself (that acquisition must originate from a
   * real click, not a timer, for the Safari gesture requirement this
   * codebase already documents elsewhere).
   */
  cameraReady: boolean;
  microphoneReady: boolean;
  onHasPendingRequestChange: (value: boolean) => void;
  /** Issue #18 real-device finding (2026-08-28): called immediately once `claimOpenSeat` reports success — see the claim effect below for why this can't wait solely on `isSpeaker` eventually flipping via Realtime the way it used to. */
  onClaimSucceeded: () => void;
}) {
  const {
    eventId,
    hasPendingRequest,
    isCurrentlyReservedCandidate,
    isSpeaker,
    phase,
    needsMediaActivation,
    mediaError,
    cameraReady,
    microphoneReady,
    onHasPendingRequestChange,
    onClaimSucceeded,
  } = params;
  const mediaReady = cameraReady && microphoneReady;
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
      // `await` first so every `setCountdown` call below — including the
      // reactive fast path — runs in a callback continuation rather than
      // synchronously within the effect body itself (this codebase's
      // `react-hooks/set-state-in-effect` lint rule flags the latter; see
      // this hook's own doc comment). The yield is a single microtask —
      // not a meaningful delay — so it doesn't reintroduce the "stale by
      // a whole cycle" latency this fast path exists to eliminate.
      await Promise.resolve();
      if (cancelled) return;

      // Issue #21, sixth corrective pass: the reactive fast path — see
      // this hook's own doc comment. Already-live Realtime state says
      // this identity is the reserved candidate; start immediately, no
      // `checkPromotionEligibility` round trip needed.
      if (isCurrentlyReservedCandidate) {
        setCountdown(PROMOTION_COUNTDOWN_SECONDS);
        return;
      }

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
  }, [isSpeaker, hasPendingRequest, phase, countdown, eventId, isCancelling, isCurrentlyReservedCandidate]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      // Media Readiness pass (issue #21): the hard seat-claim invariant —
      // `claimOpenSeat` below must never fire for this candidacy until
      // both devices are verified. Countdown simply stays frozen at 0
      // (already an established, legitimate display state per the long
      // comment below) while unready; `MediaReadinessPrompt` is what the
      // candidate actually sees and acts on during this window, and the
      // readiness-timeout effect further down is what stops this from
      // holding the reservation forever if they never do.
      if (!mediaReady) return;
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
        if (!("ok" in result)) {
          setCountdown(null);
          return;
        }
        // Issue #18 real-device finding (2026-08-28): previously relied
        // solely on isSpeaker eventually flipping via Realtime (see the
        // long comment above) — exactly the assumption a missed delta
        // breaks, leaving the countdown overlay frozen at 0 forever
        // instead of ever handing off to Speaker View. A direct refetch
        // here means a genuinely successful claim reflects immediately
        // regardless of whether the Realtime INSERT ever arrives.
        onClaimSucceeded();
      });
      return;
    }
    const timeout = setTimeout(() => setCountdown((seconds) => (seconds === null ? null : seconds - 1)), 1000);
    return () => clearTimeout(timeout);
  }, [countdown, eventId, onClaimSucceeded, mediaReady]);

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

  const cancel = useCallback(() => {
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
  }, [eventId, onHasPendingRequestChange]);

  // Media Readiness pass (issue #21), Section 18: a candidate must not
  // hold the reservation forever just because they never grant media (or
  // keep failing/retrying). Once the countdown has actually reached zero
  // and readiness still isn't both-true, this starts a single bounded
  // timer; if it elapses before `mediaReady` flips true, it releases the
  // reservation through the *existing* authoritative candidate-release
  // path — the same `cancel()`/`withdrawSpeakerRequest` "Cancel" already
  // uses — which is what actually frees the seat for the next eligible
  // candidate (no new replacement-queue mechanism). Any progress
  // (`mediaReady` becoming true, or the countdown/candidacy resetting for
  // an unrelated reason) clears and restarts this the same way the
  // 1-second countdown timeout above already does.
  useEffect(() => {
    if (countdown !== 0 || mediaReady) return;
    const timeout = setTimeout(() => {
      cancel();
    }, MEDIA_READINESS_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [countdown, mediaReady, cancel]);

  return { countdown, cancel, mediaReady };
}
