import { mediaErrorMessage } from "@/components/room/room-controls";
import { useReconnectCountdown } from "@/hooks/use-reconnect-countdown";
import type { MediaError } from "@/hooks/use-live-room-connection";

/**
 * Speaker View's only entry point back to `activateMedia()` (issue #18,
 * lifecycle fix). Renders nothing when `needsMediaActivation` is false —
 * the common case, once camera/mic are actually publishing.
 *
 * **Why this exists**: `SpeakerStage`'s `soloMode` never renders the
 * viewer's own seat's tile (the whole point of full-bleed Speaker View),
 * and neither `PortraitSpeakerView` nor `MobileLandscapeSpeakerView`
 * render `RoomControls` (Phase 1 deliberately excludes it — see their own
 * doc comments). Every *other* room composition has one of those two as
 * its "tap to enable camera & mic" entry point; Speaker View had neither,
 * which meant `needsMediaActivation` becoming true here had **no way to
 * ever resolve** — not a rendering glitch, a genuinely missing trigger
 * for an already-correct mechanism.
 *
 * **When this actually happens**: any time this tab's `useLiveRoomConnection`
 * instance is fresh (a real route-level remount — e.g. navigating away via
 * the site header's "VIRTUAL STAGE" link, which genuinely disconnects
 * LiveKit and, via the existing webhook, may or may not have released the
 * seat yet depending on timing — see DECISIONS.md) while the viewer is
 * still seated. `mediaActivatedRef`/`preparedTracksRef` reset to their
 * initial values on every fresh hook instance by design; `canPublish`
 * becoming true on such a mount deliberately does **not** auto-publish
 * (see `useLiveRoomConnection`'s own comment on why — the same Safari
 * gesture requirement `activateMedia`/`prepareLocalMedia` exist for
 * everywhere else in this app), so a real tap is required exactly once.
 *
 * **Reuses the existing path verbatim**: calls the *same* `activateMedia`
 * (→ `prepareLocalMedia` → `createLocalTracks` once, published on
 * connect) already used by `SpeakerTile`'s own local-activation tap
 * target and `RoomControls`' "Enable camera & mic" button — no new
 * acquisition logic, no new server call. Idempotent by construction
 * (`prepareLocalMedia` no-ops if tracks are already held or an
 * acquisition is already in flight), so this can't cause a duplicate
 * `getUserMedia` prompt even if tapped more than once.
 *
 * **Positioned mid-stage, not pinned to the bottom edge** (issue #18,
 * Phase 2): the bottom of the stage is now `SpeakerControlBar`'s "Leave
 * the stage" pill and the composer row — both only present once actually
 * publishing, but this prompt needs to stay clear of them regardless,
 * without needing to know their exact rendered height.
 *
 * **"Tap to reconnect" wording** (issue #18 UX finding): copy only, not
 * a behavior change — see "When this actually happens" above:
 * `needsMediaActivation` becoming true here always means an already-
 * seated speaker's tab came back fresh, never a first-time activation
 * (a genuine first promotion always runs `prepareLocalMedia` ahead of
 * time, so `mediaActivated` is already true before `canPublish` ever
 * flips). "Tap to enable camera & mic" (still the correct wording for
 * `RoomControls`/`SpeakerTile`'s own first-activation entry points
 * elsewhere) read as a fresh setup step here instead of what it actually
 * is: reconnecting camera/mic to the seat this tab already holds.
 *
 * **Remaining-time countdown** (issue #18 reconnect-countdown finding):
 * `disconnectedAt` is the viewer's own active-seat `disconnected_at`
 * (`EventRoom`, sourced from the same Realtime-subscribed `speakers`
 * state, itself set by the LiveKit webhook — see migration
 * 00000000000016) — never a fresh client-side 11-second timer.
 * `useReconnectCountdown` derives the display purely from that
 * authoritative deadline, so a reopened tab partway through an existing
 * grace window shows the real remaining time immediately, ticking
 * clears the instant `disconnectedAt` is cleared (reconnect), and
 * crossing zero here is display-only — the seat's own disappearance
 * from `speakers` once the server actually releases it (making this
 * whole view unmount) is what actually reflects "gone," never this
 * number by itself. `null` (not yet known, or genuinely not
 * disconnected) shows the prompt without a countdown suffix.
 */
export function SpeakerMediaActivationPrompt({
  needsMediaActivation,
  activateMedia,
  mediaError,
  disconnectedAt,
}: {
  needsMediaActivation: boolean;
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  disconnectedAt: string | null;
}) {
  const remainingSeconds = useReconnectCountdown(disconnectedAt);

  if (!needsMediaActivation) return null;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1.5 px-4">
      <button
        type="button"
        data-testid="speaker-view-activate-media"
        onClick={() => {
          // Must be called directly here, not from inside another
          // callback/promise — the same real user gesture Safari
          // requires for the underlying getUserMedia call. See
          // useLiveRoomConnection's activateMedia doc comment.
          void activateMedia();
        }}
        className="pointer-events-auto rounded-full border border-white/30 bg-black/50 px-4 py-2 text-sm font-medium text-white"
      >
        Tap to reconnect
        {remainingSeconds !== null && (
          <span data-testid="speaker-reconnect-countdown"> · {remainingSeconds}s</span>
        )}
      </button>
      {mediaError && (
        <p className="pointer-events-auto max-w-xs rounded-lg bg-black/50 px-3 py-1.5 text-center text-xs text-red-400" role="alert">
          {mediaErrorMessage(mediaError)}
        </p>
      )}
    </div>
  );
}
