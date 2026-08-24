"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { leaveSpeakerSeat } from "@/app/events/[id]/room/actions";

/**
 * Speaker View's purpose-built control surface (issue #18) — live
 * microphone/camera mute toggles plus a compact "Leave the stage" pill.
 * Leave-stage calls the *same* `leaveSpeakerSeat` Server Action
 * `RoomControls`' own "Leave the stage" button already uses — no new
 * server logic, no new authorization path.
 *
 * **Deliberately not `RoomControls`**: that component's `isSpeaker`
 * branch renders a padded, bordered block (button row + status text +
 * error text) sized for the old always-visible control strip — real-
 * device testing already flagged that treatment as "occupies far too
 * much of the video" against this composition's minimal chrome (see the
 * Phase 2 fix pass in DECISIONS.md). This is small glass pills instead,
 * matching `WatchModeControls`'/`SpeakerMediaActivationPrompt`'s visual
 * language.
 *
 * **Mic/camera toggles call `toggleMicrophone`/`toggleCamera` directly**
 * — see `useLiveRoomConnection`'s own doc comment for why those mute the
 * *already-published* track in place (`LocalTrack.mute()`/`.unmute()`)
 * rather than unpublishing/reacquiring it. `canToggleMedia` (true only
 * once actually publishing — `canPublish && !needsMediaActivation`) is
 * the caller's job to compute and pass down; before that, there's no
 * published track to mute at all, so the buttons render disabled rather
 * than silently no-op'ing on tap.
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
export function SpeakerControlBar({
  eventId,
  microphoneMuted,
  cameraMuted,
  onToggleMicrophone,
  onToggleCamera,
  canToggleMedia,
}: {
  eventId: string;
  microphoneMuted: boolean;
  cameraMuted: boolean;
  onToggleMicrophone: () => Promise<void>;
  onToggleCamera: () => Promise<void>;
  /** True only once actually publishing — see this component's own doc comment. */
  canToggleMedia: boolean;
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

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="speaker-mic-toggle"
          onClick={() => {
            void onToggleMicrophone();
          }}
          disabled={!canToggleMedia}
          aria-pressed={microphoneMuted}
          aria-label={microphoneMuted ? "Unmute microphone" : "Mute microphone"}
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-lg transition-colors disabled:opacity-40",
            microphoneMuted ? "border-red-400/60 bg-red-500/30" : "border-white/30 bg-white/[0.14]",
          )}
        >
          <span aria-hidden="true">{microphoneMuted ? "🔇" : "🎙️"}</span>
        </button>
        <button
          type="button"
          data-testid="speaker-camera-toggle"
          onClick={() => {
            void onToggleCamera();
          }}
          disabled={!canToggleMedia}
          aria-pressed={cameraMuted}
          aria-label={cameraMuted ? "Turn camera on" : "Turn camera off"}
          className={cn(
            "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-lg transition-colors disabled:opacity-40",
            cameraMuted ? "border-red-400/60 bg-red-500/30" : "border-white/30 bg-white/[0.14]",
          )}
        >
          <span aria-hidden="true">{cameraMuted ? "📷" : "🎥"}</span>
        </button>
        <button
          type="button"
          data-testid="speaker-leave-button"
          onClick={handleLeave}
          disabled={isPending}
          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-white/30 bg-black/50 px-4 text-sm font-medium text-white disabled:opacity-60"
        >
          {isPending ? "Leaving…" : "Leave the stage"}
        </button>
      </div>
      {error && (
        <p className="rounded-lg bg-black/35 px-3 py-1.5 text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
