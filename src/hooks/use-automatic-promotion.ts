"use client";

import { useEffect, useState } from "react";
import {
  checkPromotionEligibility,
  claimOpenSeat,
  leaveSpeakerSeat,
  withdrawSpeakerRequest,
} from "@/app/events/[id]/room/actions";
import type { MediaError } from "@/hooks/use-live-room-connection";
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

  useEffect(() => {
    if (isSpeaker || !hasPendingRequest || phase !== "ready" || countdown !== null) return;

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
  }, [isSpeaker, hasPendingRequest, phase, countdown, eventId]);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      // The real, independently-revalidated claim — see
      // checkPromotionEligibility's doc comment for why this can't
      // itself be trusted from the countdown having merely reached zero.
      //
      // Real-device finding (2026-08-23): a successful claim marks the
      // request "granted" server-side (see claimOpenSeat), so it is no
      // longer pending in any meaningful sense — but nothing here used
      // to tell the caller that. `hasPendingRequest` stayed stuck true
      // in the background (merely hidden behind RoomControls' `isSpeaker`
      // branch taking priority while seated), and resurfaced a stale
      // "still pending" UI the moment the speaker later left the stage
      // and `isSpeaker` went false again. A failed/lost-race claim
      // deliberately does NOT clear it — see this hook's own doc comment
      // ("a stale/lost-race outcome... just silently resets to waiting").
      void claimOpenSeat(eventId)
        .then((result) => {
          if ("ok" in result) onHasPendingRequestChange(false);
        })
        .finally(() => setCountdown(null));
      return;
    }
    const timeout = setTimeout(() => setCountdown((seconds) => (seconds === null ? null : seconds - 1)), 1000);
    return () => clearTimeout(timeout);
    // onHasPendingRequestChange is a stable setState-style callback from
    // EventRoom, not something whose identity changes meaningfully here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [countdown, eventId]);

  useEffect(() => {
    if (!isSpeaker || (!needsMediaActivation && !mediaError)) return;
    const timeout = setTimeout(() => {
      void leaveSpeakerSeat(eventId);
    }, MEDIA_ACTIVATION_GRACE_MS);
    return () => clearTimeout(timeout);
  }, [isSpeaker, needsMediaActivation, mediaError, eventId]);

  function cancel() {
    setCountdown(null);
    void withdrawSpeakerRequest(eventId).then((result) => {
      if (!("error" in result)) onHasPendingRequestChange(false);
    });
  }

  return { countdown, cancel };
}
