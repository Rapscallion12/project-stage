"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { leaveSpeakerSeat } from "@/app/events/[id]/room/actions";
import type { ConnectionStatus, MediaError } from "@/hooks/use-live-room-connection";
import type { EventPhase } from "@/lib/events";

/**
 * Specific, named copy per failure reason — see MediaErrorReason's doc
 * comment for why these are distinguished instead of a generic "camera
 * off". Exported (issue #18, Speaker View lifecycle fix) so
 * `SpeakerMediaActivationPrompt` can surface the same specific copy
 * rather than duplicating this switch.
 */
export function mediaErrorMessage(error: NonNullable<MediaError>): string {
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
 *
 * Issue #22: a candidate's camera/mic are normally acquired up front (see
 * ChatPanel's mic-request submit), so `mediaError` can legitimately be set
 * *before* this component ever reaches its `isSpeaker` branch — the
 * pending branch below surfaces it with its own retry action
 * (`onPrepareMedia`) for exactly that case, not just the already-seated
 * one.
 *
 * `compact` (issue #21, "05 — Social Stage" Phase 2 fix): real-device
 * testing found the `hasPendingRequest` states' paragraph-plus-button
 * treatment "occupies far too much of the video" against Watch Mode's
 * now-minimal chrome. `compact` renders those two states (waiting,
 * counting down) as a single-line pill instead — same information, same
 * `onCancelPromotion` action, same `mediaErrorNotice` — nothing removed,
 * only the layout. The `isSpeaker` branch (Leave the stage) is
 * deliberately untouched by this flag — it wasn't the state real-device
 * testing flagged, and compacting it isn't part of this fix.
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
  onPrepareMedia,
  mediaError,
  connectionStatus,
  phase,
  countdownText,
  compact = false,
}: {
  eventId: string;
  isSpeaker: boolean;
  hasPendingRequest: boolean;
  promotionCountdown: number | null;
  onCancelPromotion: () => void;
  canPublish: boolean;
  needsMediaActivation: boolean;
  activateMedia: () => Promise<void>;
  /** Issue #22: retries camera/mic acquisition for a still-pending candidate whose prepareLocalMedia failed — same gesture requirement as activateMedia. */
  onPrepareMedia: () => Promise<void>;
  mediaError: MediaError;
  connectionStatus: ConnectionStatus;
  /** Issue #17: requesting the mic works from lobby_open onward, but going live is still gated to "ready" — enforced server-side (checkPromotionEligibility/claimOpenSeat), not just here. */
  phase: EventPhase;
  countdownText: string | null;
  /** See this component's own doc comment above. Only affects the two `hasPendingRequest` states. */
  compact?: boolean;
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
    // Issue #22: shown in both sub-states below — a still-pending
    // candidate's camera/mic are normally already being acquired in the
    // background (see ChatPanel), so a failure here needs its own visible
    // recovery action, not just the isSpeaker branch's.
    const mediaErrorNotice = mediaError && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-red-500" role="alert">
          {mediaErrorMessage(mediaError)}
        </p>
        <Button
          variant="ghost"
          className="min-h-0 px-3 py-1 text-xs"
          onClick={() => {
            // Same gesture requirement as activateMedia — invoked directly
            // from this click, not from inside another callback.
            void onPrepareMedia();
          }}
        >
          Try again
        </Button>
      </div>
    );

    if (compact) {
      return (
        <div className="flex shrink-0 flex-col gap-1.5">
          <div className="flex items-center gap-2 rounded-full border border-white/30 bg-white/[0.14] py-1.5 pr-2 pl-3 text-xs text-white">
            <span aria-hidden="true">🎙</span>
            <span className="flex-1 truncate">
              {promotionCountdown !== null ? `Going live in ${promotionCountdown}…` : "Request sent"}
            </span>
            <button
              type="button"
              onClick={onCancelPromotion}
              className="shrink-0 rounded-full px-2 py-1 font-medium text-white/70 transition-colors hover:text-white"
            >
              Cancel
            </button>
          </div>
          {mediaErrorNotice}
        </div>
      );
    }

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
          {mediaErrorNotice}
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
        {mediaErrorNotice}
      </div>
    );
  }

  // Plain audience, no pending request — nothing to show. The entry
  // points now live elsewhere: the composer's 🎤 mode, or tapping an
  // empty seat directly (see SpeakerTile) — see this component's own doc
  // comment for why (issue #27).
  return null;
}
