"use client";

import { useState, useTransition } from "react";
import { leaveSpeakerSeat } from "@/app/events/[id]/room/actions";

/**
 * "Leave the stage" (issue #18) — reuses the *same* `leaveSpeakerSeat`
 * Server Action `RoomControls`' own "Leave the stage" button already
 * uses. No new server logic, no new authorization path.
 *
 * **Mic/camera toggles moved out** (real-device finding, UI cleanup
 * pass): they used to live in this same row, floating above the
 * composer — real-device testing found that read as crowded, and as two
 * separate "control regions" competing for attention. They now live in
 * `WatchModeControls`' persistent bottom row instead (via
 * `SpeakerMediaToggles`, the exact same toggle logic, just relocated —
 * see that component's own doc comment), in the position React/Vote
 * normally occupy for an audience member. This component is back to
 * being exactly what its name says: leave-the-stage, and nothing else.
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
