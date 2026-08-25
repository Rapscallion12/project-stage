import { mediaErrorMessage } from "@/components/room/room-controls";
import { reconnectDiagnostics, useReconnectCountdown } from "@/hooks/use-reconnect-countdown";
import type { MediaError } from "@/hooks/use-live-room-connection";

/**
 * Speaker View's only entry point back to `activateMedia()` (issue #18,
 * lifecycle fix), and (issue #18 unified inactive-speaker finding) the
 * speaker's own view of the *other* half of "inactive" — camera and mic
 * both muted while still connected. Renders nothing when neither
 * condition applies — the common case, once camera/mic are actually
 * publishing and at least one is unmuted.
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
 * **Two distinct cases, one shared countdown slot** (issue #18 unified
 * inactive-speaker finding): `needsMediaActivation` (nothing published at
 * all — a fresh `useLiveRoomConnection` mount, e.g. a reload) gets the
 * original tappable "Tap to reconnect" — tapping calls `activateMedia()`,
 * a real recovery action. `bothMediaMuted` (already publishing, but both
 * tracks explicitly muted) gets non-interactive "Resume speaking" text
 * instead — tapping `activateMedia()` would be a no-op here (tracks are
 * already held), so this isn't a button; the actual recovery action is
 * the existing mic/camera toggle buttons in the control row below,
 * unmuting either one. `needsMediaActivation` takes precedence when
 * both are somehow true (shouldn't happen in practice — `bothMediaMuted`
 * is only meaningful once media is actually activated — but a plain
 * `if/else if` keeps that unambiguous either way).
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
 * a behavior change for that case — `needsMediaActivation` becoming true
 * here always means an already-seated speaker's tab came back fresh,
 * never a first-time activation (a genuine first promotion always runs
 * `prepareLocalMedia` ahead of time, so `mediaActivated` is already true
 * before `canPublish` ever flips). "Tap to enable camera & mic" (still
 * the correct wording for `RoomControls`/`SpeakerTile`'s own
 * first-activation entry points elsewhere) read as a fresh setup step
 * here instead of what it actually is: reconnecting camera/mic to the
 * seat this tab already holds.
 *
 * **Remaining-time countdown** (issue #18 reconnect-countdown finding,
 * broadened by the unified inactive-speaker finding): `inactiveSince` is
 * the viewer's own active-seat inactivity deadline — whichever of
 * `disconnected_at`/`media_inactive_since` is set (`EventRoom`, via
 * `lib/speaker-presence.ts`'s `inactiveSince`, sourced from the same
 * Realtime-subscribed `speakers` state) — never a fresh client-side
 * 11-second timer. `useReconnectCountdown` derives the display purely
 * from that authoritative deadline, so a reopened tab partway through an
 * existing grace window shows the real remaining time immediately,
 * ticking clears the instant the deadline is cleared (recovery, by
 * either cause), and crossing zero here is display-only — the seat's own
 * disappearance from `speakers` once the server actually releases it
 * (making this whole view unmount) is what actually reflects "gone,"
 * never this number by itself. `null` (not yet known, or genuinely not
 * inactive) shows either prompt without a countdown suffix.
 */
export function SpeakerMediaActivationPrompt({
  needsMediaActivation,
  bothMediaMuted,
  activateMedia,
  mediaError,
  inactiveSince,
}: {
  needsMediaActivation: boolean;
  /** Issue #18 unified inactive-speaker finding: true once media is activated but both camera and microphone are muted — see `lib/speaker-presence.ts`'s `isLocalMediaInactive`. Always false while `needsMediaActivation` is true (nothing to mute if nothing's published). */
  bothMediaMuted: boolean;
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  inactiveSince: string | null;
}) {
  const remainingSeconds = useReconnectCountdown(inactiveSince);

  if (!needsMediaActivation && !bothMediaMuted) return null;

  // Un-gated diagnostic showing exactly what this prompt received for
  // the viewer's own seat — see reconnectDiagnostics' own doc comment.
  // Rendered whenever this prompt renders at all, so a screenshot of a
  // missing-countdown report always includes it. Reuses `remainingSeconds`
  // verbatim — the exact value already driving the visible countdown
  // text below, so the diagnostic can never disagree with what's
  // actually on screen.
  const diag = reconnectDiagnostics(inactiveSince, remainingSeconds);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center gap-1.5 px-4">
      <div
        data-testid="diagnostic-speaker-reconnect"
        className="pointer-events-none rounded bg-amber-700/90 px-1.5 py-0.5 font-mono text-[8px] leading-tight break-all text-white"
      >
        raw={diag.raw} parsed={diag.parsed} deadline={diag.deadline} remain={String(diag.remainingSeconds)} active=
        {String(diag.active)} needsAct={String(needsMediaActivation)} bothMuted={String(bothMediaMuted)}
      </div>
      {needsMediaActivation ? (
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
      ) : (
        // bothMediaMuted: already publishing, nothing to tap here — the
        // real recovery action is the mic/camera toggle row below.
        <div
          data-testid="speaker-resume-speaking"
          className="pointer-events-auto rounded-full border border-white/30 bg-black/50 px-4 py-2 text-sm font-medium text-white"
        >
          Resume speaking
          {remainingSeconds !== null && (
            <span data-testid="speaker-reconnect-countdown"> · {remainingSeconds}s</span>
          )}
        </div>
      )}
      {mediaError && (
        <p className="pointer-events-auto max-w-xs rounded-lg bg-black/50 px-3 py-1.5 text-center text-xs text-red-400" role="alert">
          {mediaErrorMessage(mediaError)}
        </p>
      )}
    </div>
  );
}
