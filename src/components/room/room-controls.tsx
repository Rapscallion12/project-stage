"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { claimOpenSeat, leaveSpeakerSeat, withdrawSpeakerRequest } from "@/app/events/[id]/room/actions";
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
 * The room's speaker-facing controls (issues #13/#3's "Leave the stage",
 * and issue #14's withdraw/claim for a *contested* seat's queue). Always
 * rendered — which of three states it shows depends on `isSpeaker` and
 * whether the caller currently has a pending request; renders nothing at
 * all for a plain audience member with neither.
 *
 * Issue #27 removed this component's fourth state (a standalone
 * "Request the mic" button + justification form) — that entry point is
 * now the composer's own 🎤 mode (see `ChatPanel`) and, for a genuinely
 * uncontested seat, tapping the empty tile directly (see `SpeakerTile`).
 * This component no longer creates a request at all, only reacts to one
 * that already exists — `hasPendingRequest` is a controlled prop now
 * (lifted to `EventRoom`), not local state, since the composer is what
 * sets it true on a successful submission and this component only reads
 * it to decide what to show.
 *
 * The "Claim your seat"/"Withdraw" pair below is unchanged from issue
 * #14 — a ranked requester's self-service claim once eligible for a
 * *contested* seat. Automatic promotion (removing this manual step) is
 * issue #23's job, not touched here.
 */
export function RoomControls({
  eventId,
  isSpeaker,
  hasPendingRequest,
  onHasPendingRequestChange,
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
  onHasPendingRequestChange: (value: boolean) => void;
  canPublish: boolean;
  needsMediaActivation: boolean;
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  connectionStatus: ConnectionStatus;
  /** Issue #17: requesting the mic works from lobby_open onward, but claiming a seat (going live) is still gated to "ready" — enforced server-side in claimOpenSeat, not just here. */
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

  function handleWithdraw() {
    setError(null);
    startTransition(async () => {
      const result = await withdrawSpeakerRequest(eventId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onHasPendingRequestChange(false);
    });
  }

  function handleClaim() {
    setError(null);
    startTransition(async () => {
      const result = await claimOpenSeat(eventId);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // useActiveSpeakers' own Realtime subscription picks up the new
      // event_speakers row and this component's `isSpeaker` prop flips
      // on its own from there — nothing else to update locally.
      onHasPendingRequestChange(false);
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
    const canClaimNow = phase === "ready";
    return (
      <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">
            {canClaimNow
              ? "Your request is live in chat."
              : `Your request is live in chat — you can claim a seat once the conversation starts${countdownText ? ` (${countdownText.toLowerCase()})` : ""}.`}
          </p>
          <div className="flex gap-2">
            {canClaimNow && (
              <Button onClick={handleClaim} disabled={isPending}>
                {isPending ? "Claiming…" : "Claim your seat"}
              </Button>
            )}
            <Button variant="ghost" onClick={handleWithdraw} disabled={isPending}>
              Withdraw
            </Button>
          </div>
        </div>
        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  // Plain audience, no pending request — nothing to show. The entry
  // points now live elsewhere: the composer's 🎤 mode, or tapping an
  // empty seat directly (see SpeakerTile) — see this component's own doc
  // comment for why (issue #27).
  return null;
}
