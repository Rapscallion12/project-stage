/**
 * "Going live" as a center-stage transition (issue #18 UX finding,
 * real-device report: the automatic-promotion countdown used to render
 * as a small inline pill inside `RoomControls`, competing directly with
 * the persistent bottom composer/controls and ambient comments — an
 * important transition read as just another notification).
 *
 * **Presentation only, not a new promotion system**: `countdown`/
 * `onCancel` are exactly `useAutomaticPromotion`'s existing
 * `promotionCountdown`/`onCancelPromotion` (see `EventRoom`) — no new
 * timer, no new state machine, nothing duplicated. `PortraitRoom`/
 * `MobileLandscapeRoom` render this *instead of* (not alongside) their
 * normal bottom composer/controls/ambient comments whenever
 * `promotionCountdown !== null`, and pass a dimming `scrimOpacity` to
 * `SpeakerStage` for the backdrop — both are existing mechanisms this
 * reuses, not new ones.
 *
 * **Never coexists with Speaker View**: `promotionCountdown` can only be
 * non-null while `!isSpeaker` (see `useAutomaticPromotion`'s own poll
 * guard) — by the time the role router's `participantRole === "speaker"`
 * check is true, this component's caller has already stopped rendering
 * it entirely (a different composition file mounts instead), the same
 * structural guarantee the role-consistency fix established for the
 * ordinary Audience/Speaker split. There is no frame where both can be
 * on screen.
 *
 * **Shared verbatim across portrait and landscape** — deliberately no
 * orientation-specific variant: centered flex content over `inset-0`
 * scales naturally to either a tall/narrow or short/wide box, and a
 * short landscape viewport needs the exact same "stop competing with
 * everything else" treatment portrait does, not a smaller/different one.
 */
export function CountdownOverlay({ countdown, onCancel }: { countdown: number; onCancel: () => void }) {
  return (
    <div
      data-testid="countdown-overlay"
      className="pointer-events-auto absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 px-6 text-center"
    >
      <p className="text-xs font-semibold tracking-[0.2em] text-white/70 uppercase">Going live</p>
      {/* key={countdown}: remounts on every tick so the pop animation replays once per digit — see the countdown-number-pop keyframe in globals.css. */}
      <p
        key={countdown}
        data-testid="countdown-number"
        className="animate-[countdown-number-pop_280ms_ease-out] text-7xl font-bold text-white sm:text-8xl"
      >
        {countdown}
      </p>
      <p className="max-w-xs text-sm text-white/80">Get ready — your camera and mic are about to go live</p>
      <button
        type="button"
        onClick={onCancel}
        className="mt-3 rounded-full border border-white/25 px-4 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white/80"
      >
        Cancel
      </button>
    </div>
  );
}
