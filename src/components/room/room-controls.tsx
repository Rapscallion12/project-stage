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
import type { Identity } from "@/lib/identity";

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
 * Guests see the exact same "Request the mic" button everyone else
 * does — clicking it is the "action that genuinely requires an account"
 * PRODUCT.md's progressive authentication model describes, and that's
 * the moment the account prompt appears, inline. Never a separate,
 * permanently-visible "you can't do this" banner — PRODUCT.md is
 * explicit that guests should never be interrupted speculatively.
 */
export function RoomControls({
  eventId,
  isSpeaker,
  identity,
  hasPendingRequest: initialHasPendingRequest,
}: {
  eventId: string;
  isSpeaker: boolean;
  identity: Identity;
  hasPendingRequest: boolean;
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
    if (identity.type === "guest") {
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
    return (
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
        <Button variant="secondary" onClick={handleLeave} disabled={isPending}>
          {isPending ? "Leaving…" : "Leave the stage"}
        </Button>
        {error && (
          <p className="text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  if (hasPendingRequest) {
    return (
      <div className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-muted">Your request is live in chat.</p>
          <div className="flex gap-2">
            <Button onClick={handleClaim} disabled={isPending}>
              {isPending ? "Claiming…" : "Claim your seat"}
            </Button>
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
