import { cn } from "@/lib/utils";

/**
 * Live microphone/camera mute toggle buttons (issue #18) — relocated
 * here, unchanged, from `SpeakerControlBar`'s own floating row (real-
 * device finding: two separate copies of "the mic/camera controls," one
 * floating above the composer and one implied by the persistent bottom
 * row, read as crowded/duplicated). This is the *only* copy now — used
 * as `WatchModeControls`' `micCameraSlot` for a seated speaker, sitting
 * in the exact position React/Vote normally occupy for an audience
 * member. `SpeakerControlBar` keeps only "Leave the stage."
 *
 * Same props, same `toggleMicrophone`/`toggleCamera` wiring, same
 * `LocalTrack.mute()`/`.unmute()` behavior underneath (see
 * `useLiveRoomConnection`'s own doc comment) — a relocation, not a
 * second implementation. `canToggleMedia` (true only once actually
 * publishing) still gates both buttons to disabled rather than a silent
 * no-op tap.
 */
export function SpeakerMediaToggles({
  microphoneMuted,
  cameraMuted,
  onToggleMicrophone,
  onToggleCamera,
  canToggleMedia,
}: {
  microphoneMuted: boolean;
  cameraMuted: boolean;
  onToggleMicrophone: () => Promise<void>;
  onToggleCamera: () => Promise<void>;
  canToggleMedia: boolean;
}) {
  return (
    <>
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
    </>
  );
}
