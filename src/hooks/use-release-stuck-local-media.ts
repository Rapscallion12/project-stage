import { useEffect } from "react";
import type { LocalVideoTrack } from "livekit-client";

/**
 * Issue #21 corrective pass, real-device finding: a stuck self-preview
 * with no way to leave the stage. Root cause — `handleTapEmptySeat`
 * (event-room.tsx) calls `prepareLocalMedia()` before the async
 * `joinOpenSeat` server action, and deliberately leaves the acquired
 * tracks held on every non-fatal failure path (queue-exists,
 * already-speaking, generic error — see that function's own doc
 * comment: "the candidate/audience state this returns to can still use
 * them"). That's correct for a *retryable* candidate/audience state, but
 * has no matching release for the terminal case this pass's real-device
 * test hit: a real join lost a race (see migration 00000000000024's new
 * `claim_speaker_seat` guard) and left this identity in plain audience —
 * not a candidate, not pending, not mid-countdown — while still holding
 * a local track. `SpeakerStage`'s self-preview slot renders purely on
 * `localVideoTrack` being non-null, with no `isSpeaker` check (by
 * design, so a *genuine* pre-publish candidate sees their own preview);
 * `useSeatReconciliation` only watches for the opposite contradiction
 * (`canPublish` true while `isSpeaker` false). Nothing upstream of this
 * hook currently reconciles "holding media with no legitimate reason
 * to."
 *
 * This is the general fix, not a simulator-specific one — it reads only
 * state `EventRoom` already computes for other purposes (`isSpeaker`,
 * `isJoiningSeat`, `hasPendingRequest`, `promotionCountdown`,
 * `micRequestMode`) and never introduces a second role system, honoring
 * the same #18 "either you authoritatively own a seat and get full
 * Speaker View, or you're audience with zero speaker-only state"
 * invariant this corrective pass calls out explicitly. Releases exactly
 * when every legitimate reason to be holding local media is absent:
 * not seated, no join in flight, no pending request, no promotion
 * countdown running, not mid mic-request composer flow.
 */
export function useReleaseStuckLocalMedia(params: {
  isSpeaker: boolean;
  isJoiningSeat: boolean;
  hasPendingRequest: boolean;
  promotionCountdown: number | null;
  micRequestMode: boolean;
  localVideoTrack: LocalVideoTrack | null;
  releaseLocalMedia: () => void;
}): void {
  const { isSpeaker, isJoiningSeat, hasPendingRequest, promotionCountdown, micRequestMode, localVideoTrack, releaseLocalMedia } = params;

  useEffect(() => {
    if (localVideoTrack === null) return;
    if (isSpeaker || isJoiningSeat || hasPendingRequest || promotionCountdown !== null || micRequestMode) return;
    console.error(
      "[useReleaseStuckLocalMedia] releasing local media held with no legitimate reason (not speaker, not joining, no pending request, no promotion countdown, not mid mic-request) — see this hook's own doc comment.",
    );
    releaseLocalMedia();
  }, [isSpeaker, isJoiningSeat, hasPendingRequest, promotionCountdown, micRequestMode, localVideoTrack, releaseLocalMedia]);
}
