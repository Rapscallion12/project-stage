"use client";

import { useState, useTransition } from "react";
import { leaveSpeakerSeat } from "@/app/events/[id]/room/actions";

/**
 * Speaker View's purpose-built control surface (issue #18) — a single
 * compact "Leave the stage" pill for now, added specifically so the
 * user could stress-test the join/leave cycle without navigating away
 * each time (which only ever vacates a seat via the LiveKit disconnect
 * webhook, not a real in-UI action). Calls the *same* `leaveSpeakerSeat`
 * Server Action `RoomControls`' own "Leave the stage" button already
 * uses — no new server logic, no new authorization path.
 *
 * **Deliberately not `RoomControls`**: that component's `isSpeaker`
 * branch renders a padded, bordered block (button row + status text +
 * error text) sized for the old always-visible control strip — real-
 * device testing already flagged that treatment as "occupies far too
 * much of the video" against this composition's minimal chrome (see the
 * Phase 2 fix pass in DECISIONS.md). This is a single small glass pill
 * instead, matching `WatchModeControls`'/`SpeakerMediaActivationPrompt`'s
 * visual language.
 *
 * **What happens after a successful leave**: nothing further needs to
 * happen here — `useActiveSpeakers`' own Realtime subscription picks up
 * the row's `left_at` being set, `isSpeaker` flips false in `EventRoom`,
 * and the role router in `PortraitRoom`/`MobileLandscapeRoom` switches
 * back to the ordinary Audience/Candidate composition on its own. The
 * underlying `canPublish → false` reaction inside `useLiveRoomConnection`
 * (already existing, unchanged) is what actually stops the published
 * camera/mic and clears `localVideoTrack`, hiding `SelfPreview` —
 * nothing new needed here either.
 *
 * **Mic/camera toggles are a deliberate, separate follow-up** to this
 * same component, not a different one — see the approved Speaker View
 * plan's Phase 3. Adding them later means extending this file, not
 * building a new bar alongside it.
 */
export function SpeakerControlBar({ eventId }: { eventId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleLeave() {
    setError(null);
    startTransition(async () => {
      const result = await leaveSpeakerSeat(eventId);
      if ("error" in result) setError(result.error);
    });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        data-testid="speaker-leave-button"
        onClick={handleLeave}
        disabled={isPending}
        className="flex h-9 w-fit items-center gap-1.5 self-start rounded-full border border-white/30 bg-black/50 px-4 text-sm font-medium text-white disabled:opacity-60"
      >
        {isPending ? "Leaving…" : "Leave the stage"}
      </button>
      {error && (
        <p className="rounded-lg bg-black/35 px-3 py-1.5 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
