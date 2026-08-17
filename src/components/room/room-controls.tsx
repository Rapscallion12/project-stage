"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  claimOpenSeat,
  leaveSpeakerSeat,
  requestToSpeak,
  withdrawSpeakerRequest,
} from "@/app/events/[id]/room/actions";
import type { ConnectionStatus, MediaError } from "@/hooks/use-live-room-connection";
import { PROTOTYPE_CONFIG } from "@/lib/config";
import type { EventPhase } from "@/lib/events";
import type { Identity } from "@/lib/identity";

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
 * The room's speaker-facing and request-facing controls (issues #13/#3's
 * "Leave the stage", and issue #14's request/withdraw/claim). Always
 * rendered (not gated behind `isSpeaker` the way it was before issue
 * #14) — which of four states it shows depends on `isSpeaker`,
 * `identity.type`, and whether the caller currently has a pending
 * request. No dedicated queue screen: everything here is a small control
 * strip, and the request itself shows up as a normal, badged message in
 * the existing chat feed (see MessageItem), not a separate view.
 *
 * `hasPendingRequest` is local state seeded from a server-fetched prop
 * and updated optimistically after each action's result — there's no
 * realtime subscription for "my own request status" in this issue
 * (speaker_requests is in the Realtime publication for future use, see
 * migration 00000000000011, but nothing subscribes to it yet).
 *
 * Guests see the exact same "Request the mic" button everyone else does.
 * With `PROTOTYPE_CONFIG.guestParticipationEnabled` off (its state before
 * issue #16), clicking it is the "action that genuinely requires an
 * account" PRODUCT.md's progressive authentication model describes, and
 * that's the moment the account prompt appears, inline — never a
 * separate, permanently-visible "you can't do this" banner, since
 * PRODUCT.md is explicit that guests should never be interrupted
 * speculatively. With the flag on (issue #16's explicit, reversible
 * prototype-testing exception), a guest proceeds through the exact same
 * request/claim flow an account holder does instead.
 */
export function RoomControls({
  eventId,
  isSpeaker,
  identity,
  hasPendingRequest: initialHasPendingRequest,
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
  identity: Identity;
  hasPendingRequest: boolean;
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
  const [hasPendingRequest, setHasPendingRequest] = useState(initialHasPendingRequest);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [requestBody, setRequestBody] = useState("");

  function handleLeave() {
    setError(null);
    startTransition(async () => {
      const result = await leaveSpeakerSeat(eventId);
      if ("error" in result) setError(result.error);
    });
  }

  function handleRequestClick() {
    // Issue #16: guest speaking is an explicit, reversible prototype-
    // testing exception (PRODUCT.md/DECISIONS.md) — with the flag on, a
    // guest gets the exact same request form an account holder does;
    // with it off, this is unchanged from before #16.
    if (identity.type === "guest" && !PROTOTYPE_CONFIG.guestParticipationEnabled) {
      setError("Create an account to request the mic.");
      return;
    }
    setError(null);
    setShowRequestForm(true);
  }

  function handleSubmitRequest() {
    setError(null);
    startTransition(async () => {
      const result = await requestToSpeak(eventId, requestBody);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setHasPendingRequest(true);
      setShowRequestForm(false);
      setRequestBody("");
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
      setHasPendingRequest(false);
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
      setHasPendingRequest(false);
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

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
      {showRequestForm ? (
        <div className="flex gap-2">
          <Input
            value={requestBody}
            onChange={(event) => setRequestBody(event.target.value)}
            placeholder="Why should you get the mic?"
            maxLength={500}
            className="flex-1"
          />
          <Button onClick={handleSubmitRequest} disabled={isPending || !requestBody.trim()}>
            {isPending ? "Submitting…" : "Submit"}
          </Button>
          <Button variant="ghost" onClick={() => setShowRequestForm(false)} disabled={isPending}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={handleRequestClick}>
          Request the mic
        </Button>
      )}
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
