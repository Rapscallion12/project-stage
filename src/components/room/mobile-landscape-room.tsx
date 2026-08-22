import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { useCommentsMode } from "@/hooks/use-comments-mode";
import type { RoomLayoutProps } from "@/components/room/types";

/** Comments Mode's own height when open — a phone in landscape has less room to spare than portrait, so this stays shorter. Tunable, not validated against a real device yet. */
const COMMENTS_MODE_HEIGHT_PX = 208;
const SCRIM_OPACITY_WHEN_OPEN = 0.55;

/**
 * A phone rotated sideways, not a small desktop (real-device finding,
 * 2026-08-22): `EventRoom` used to render `LandscapeRoom` (now
 * `DesktopRoom`) for *any* landscape viewport, which turned rotation
 * into a jump to a dashboard-style layout — small video strip, a
 * permanent 320px chat sidebar, the full site header still eating its
 * usual share of an already-short viewport. This component exists so
 * that doesn't happen: same video-first/overlay philosophy as
 * `PortraitRoom` (stage fills the box, chat/controls layer *over* it via
 * the same `StageOverlayShell` both share), just laid out for a wide,
 * short box instead of a tall, narrow one — `SpeakerStage` gets
 * `orientation="landscape"` (side-by-side tiles, not stacked). `EventRoom`
 * mounts this only when `useOrientation()` is `"landscape"` *and*
 * `useIsDesktopViewport()` is false — an iPhone in landscape is
 * comfortably under the desktop width threshold, so it lands here, not
 * in `DesktopRoom`.
 *
 * **Watch Mode / Comments Mode, tap-driven (issue #21, gesture retired,
 * 2026-08-22)**: two rounds of real-device testing found the room-level
 * downward-drag gesture didn't produce a usable interaction — no
 * meaningful transition on an actual iPhone — and, independently, that
 * the *previous* "collapsed" state was never actually hidden, just
 * shorter, so comments/composer still permanently dominated the stage.
 * `useCommentsMode` (retired back to a plain boolean, no drag tracking
 * at all — see its own doc comment) now drives two clean, discrete
 * states: **Watch Mode** (`open === false`) shows only
 * `GuestNameEditor`/`joinSeatMessage`/`RoomControls` and the compact
 * `comments-toggle` — no chat panel rendered at all, not even a sliver.
 * **Comments Mode** (`open === true`) additionally mounts the full
 * `RoomChatPanel` at `COMMENTS_MODE_HEIGHT_PX` and darkens
 * `SpeakerStage`'s scrim. This is a deliberate, temporary foundation —
 * see DECISIONS.md's "Future Figma seam" note — not a redesign: the
 * eventual downward-drag reveal returns once Watch Mode and Comments
 * Mode both have a real, Figma-defined visual target to transition
 * between, not before.
 *
 * **Video geometry never changes** — `SpeakerStage`'s own size/position
 * (and the actual `<video>` elements/LiveKit tracks inside it) are a
 * sibling of the overlay, not a child of it; toggling Comments Mode on
 * or off never re-renders, resizes, or remounts it. The room's own
 * `RoomHeader` stays a translucent top overlay (reclaims its document-
 * flow footprint for the stage); `pr-16`/`pr-20` on its wrapper reserves
 * room for the top-right self-preview so the two don't visually collide.
 */
export function MobileLandscapeRoom({
  event,
  phase,
  countdownText,
  roomStatus,
  speakers,
  myIdentity,
  identity,
  isSpeaker,
  hasPendingRequest,
  onHasPendingRequestChange,
  promotionCountdown,
  onCancelPromotion,
  micRequestMode,
  onMicRequestModeChange,
  onTapEmptySeat,
  isJoiningSeat,
  joinSeatMessage,
  getParticipant,
  participantCount,
  connectionStatus,
  canPublish,
  needsMediaActivation,
  activateMedia,
  mediaError,
  localVideoTrack,
  onPrepareMedia,
  reconnectingIdentities,
  messages,
  reactions,
}: RoomLayoutProps) {
  const { open: commentsOpen, openComments, closeComments } = useCommentsMode();

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="relative min-h-0 flex-1">
        <SpeakerStage
          speakers={speakers}
          getParticipant={getParticipant}
          myIdentity={myIdentity}
          needsMediaActivation={needsMediaActivation}
          activateMedia={activateMedia}
          mediaError={mediaError}
          orientation="landscape"
          onTapEmptySeat={onTapEmptySeat}
          isJoiningSeat={isJoiningSeat}
          localVideoTrack={localVideoTrack}
          scrimOpacity={commentsOpen ? SCRIM_OPACITY_WHEN_OPEN : 0}
          reconnectingIdentities={reconnectingIdentities}
        />
        {/* Room header as a translucent top overlay — reclaims its document-flow footprint for the stage, same reasoning as the bottom overlay below. Right padding leaves room for the top-right self-preview so the two don't collide. */}
        <div
          data-testid="room-header-overlay"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/60 to-transparent"
        >
          <div className="stage-overlay pointer-events-auto pr-16 sm:pr-20">
            <RoomHeader
              eventTitle={event.title}
              roomStatus={roomStatus}
              countdownText={countdownText}
              participantCount={participantCount}
              connectionStatus={connectionStatus}
              compact
            />
          </div>
        </div>
        <StageOverlayShell topClassName="pt-8">
          {identity.type === "guest" && <GuestNameEditor initialName={identity.displayName} />}
          {joinSeatMessage && (
            <p className="text-xs text-red-500" role="alert">
              {joinSeatMessage}
            </p>
          )}
          <RoomControls
            eventId={event.id}
            isSpeaker={isSpeaker}
            hasPendingRequest={hasPendingRequest}
            promotionCountdown={promotionCountdown}
            onCancelPromotion={onCancelPromotion}
            canPublish={canPublish}
            needsMediaActivation={needsMediaActivation}
            activateMedia={activateMedia}
            onPrepareMedia={onPrepareMedia}
            mediaError={mediaError}
            connectionStatus={connectionStatus}
            phase={phase}
            countdownText={countdownText}
          />
          {/* Watch Mode's one persistent affordance — Comments Mode's own explicit "back to video" control, same button either way. */}
          <button
            type="button"
            data-testid="comments-toggle"
            onClick={commentsOpen ? closeComments : openComments}
            aria-expanded={commentsOpen}
            aria-label={commentsOpen ? "Hide comments" : "Show comments"}
            className="flex h-7 w-full shrink-0 items-center justify-center gap-1 text-xs text-white/70"
          >
            {commentsOpen ? (
              <>
                <span aria-hidden="true">⌄</span> Hide
              </>
            ) : (
              <>
                <span aria-hidden="true">💬</span> Comments
              </>
            )}
          </button>
          {/* Comments Mode only — not rendered at all in Watch Mode, not just shorter. */}
          {commentsOpen && (
            <div style={{ height: COMMENTS_MODE_HEIGHT_PX }} className="min-h-0 shrink-0">
              <RoomChatPanel
                eventId={event.id}
                messages={messages}
                reactions={reactions}
                micRequestMode={micRequestMode}
                onMicRequestModeChange={onMicRequestModeChange}
                onHasPendingRequestChange={onHasPendingRequestChange}
                onPrepareMedia={onPrepareMedia}
                className="h-full"
              />
            </div>
          )}
        </StageOverlayShell>
      </div>
    </div>
  );
}
