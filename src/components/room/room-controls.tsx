"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { leaveSpeakerSeat } from "@/app/events/[id]/room/actions";
import type { ConnectionStatus, MediaError } from "@/hooks/use-live-room-connection";
import type { EventPhase } from "@/lib/events";

/** Specific, named copy per failure reason — see MediaErrorReason's doc comment for why these are distinguished instead of a generic "camera off". */
function mediaErrorMessage(error: NonNullable<MediaError>): string {
  const device = error.source === "camera" ? "Camera" : "Microphone";
  switch (error.reason) {
    case "permission-denied":
      return `${device} permission was denied. Check your browser's site settings and try again.`;
    case "no-device":
      return `No ${error.source} found on this device.`;
    case "device-unavailable":
      return `${device} is unavailable right now — it may be in use by another app.`;
    case "init-failed":
      return `Couldn't start the ${error.source}. Try again.`;
  }
}

/**
 * The room's speaker-facing controls (issue #13/#3's "Leave the stage").
 * Always rendered — which of three states it shows depends on
 * `isSpeaker` and whether the caller currently has a pending request;
 * renders nothing at all for a plain audience member with neither.
 *
 * Issue #27 removed this component's fourth state (a standalone
 * "Request the mic" button + justification form) — that entry point is
 * now the composer's own 🎤 mode (see `ChatPanel`) and, for a genuinely
 * uncontested seat, tapping the empty tile directly (see `SpeakerTile`).
 *
 * Issue #23 removed the manual "Claim your seat" button too — a pending
 * requester now sees an automatic "You're up next" countdown
 * (`promotionCountdown`, driven by `useAutomaticPromotion` in
 * `EventRoom`, not by anything in this component) once the server
 * determines they're eligible, and the actual seat claim happens on its
 * own at the end of it. This component no longer *creates or claims*
 * anything — only reacts to state that already exists.
 * `hasPendingRequest`/`promotionCountdown` are controlled props (lifted
 * to `EventRoom`), not local state, since the composer and the
 * automatic-promotion hook are what actually drive them.
 *
 * "Withdraw" (waiting) and "Cancel" (mid-countdown) both call the same
 * `onCancelPromotion` — semantically identical, "stop trying to get a
 * seat," whether or not a countdown happens to be running right now.
 */
export function RoomControls({
  eventId,
  isSpeaker,
  hasPendingRequest,
  promotionCountdown,
  onCancelPromotion,
  canPublish,
  needsMediaActivation,
  activateMedia,
  mediaError,
  connectionStatus,
  phase,
  countdownText,
}: {
  eventId: string;
  isSpeaker: boolean;
  hasPendingRequest: boolean;
  promotionCountdown: number | null;
  onCancelPromotion: () => void;
  canPublish: boolean;
  needsMediaActivation: boolean;
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  connectionStatus: ConnectionStatus;
  /** Issue #17: requesting the mic works from lobby_open onward, but going live is still gated to "ready" — enforced server-side (checkPromotionEligibility/claimOpenSeat), not just here. */
  phase: EventPhase;
  countdownText: string | null;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleLeave() {
    setError(null);
    startTransition(async () => {
      const result = await leaveSpeakerSeat(eventId);
      if ("error" in result) setError(result.error);
    });
  }

  if (isSpeaker) {
    // Waiting-for-grant is only worth naming once actually connected —
    // while still connecting/reconnecting, RoomHeader's own status text
    // already covers it, and showing both would just be redundant.
    const waitingForGrant = !canPublish && !needsMediaActivation && connectionStatus === "connected";

    return (
      <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Button variant="secondary" onClick={handleLeave} disabled={isPending}>
            {isPending ? "Leaving…" : "Leave the stage"}
          </Button>
          {needsMediaActivation && (
            <Button
              onClick={() => {
                // Must be called directly here, not from inside another
                // callback/promise — this is the user gesture Safari
                // requires to even show the camera/mic permission prompt.
                // See useLiveRoomConnection's activateMedia doc comment.
                void activateMedia();
              }}
            >
              Enable camera &amp; mic
            </Button>
          )}
        </div>
        {waitingForGrant && <p className="text-xs text-muted">Setting up your mic access…</p>}
        {mediaError && (
          <p className="text-xs text-red-500" role="alert">
            {mediaErrorMessage(mediaError)}
          </p>
        )}
        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (hasPendingRequest) {
    if (promotionCountdown !== null) {
      return (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">You&apos;re up next</p>
              <p className="text-xs text-muted">Going live in {promotionCountdown}…</p>
            </div>
            <Button variant="ghost" onClick={onCancelPromotion}>
              Cancel
            </Button>
          </div>
        </div>
      );
    }

    const canClaimNow = phase === "ready";
    return (
      <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {canClaimNow
              ? "Your request is live in chat — you'll go live automatically when it's your turn."
              : `Your request is live in chat — you'll go live automatically once the conversation starts${countdownText ? ` (${countdownText.toLowerCase()})` : ""}.`}
          </p>
          <Button variant="ghost" onClick={onCancelPromotion}>
            Withdraw
          </Button>
        </div>
      </div>
    );
  }

  // Plain audience, no pending request — nothing to show. The entry
  // points now live elsewhere: the composer's 🎤 mode, or tapping an
  // empty seat directly (see SpeakerTile) — see this component's own doc
  // comment for why (issue #27).
  return null;
}
