import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { useCommentsFocus } from "@/hooks/use-comments-focus";
import type { RoomLayoutProps } from "@/components/room/types";

/** h-24's own equivalent — identical to today's height at rest (progress 0), zero regression for the collapsed default. */
const COLLAPSED_CHAT_HEIGHT_PX = 96;
/** Tunable, not validated against a real short landscape viewport yet — see this pass's own verification report. */
const EXPANDED_CHAT_HEIGHT_PX = 160;
const MAX_SCRIM_OPACITY = 0.55;

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
 * **Comments-focus overlay (issue #21, first slice, 2026-08-22)**: the
 * chat/controls overlay's default state is compact — same height as
 * before this pass (`COLLAPSED_CHAT_HEIGHT_PX`, matching the old
 * always-on `h-24`) — and a dedicated grab handle (`useCommentsFocus`)
 * lets it grow taller to `EXPANDED_CHAT_HEIGHT_PX` on a tap or a drag,
 * darkening `SpeakerStage`'s own scrim as it does. **Video geometry never
 * changes** — `SpeakerStage`'s own size/position (and the actual
 * `<video>` elements/LiveKit tracks inside it) are completely untouched
 * by this; only the *height of the chat wrapper* and the *scrim's
 * opacity* animate, both purely presentational values passed down as
 * props/inline styles. The room's own `RoomHeader` is a translucent
 * overlay pinned to the stage's top edge (not a document-flow block
 * above it, unlike every other composition) specifically to reclaim its
 * footprint for the stage — `pr-16`/`pr-20` on its wrapper reserves room
 * for the top-right self-preview so the two don't visually collide.
 *
 * **Focus target corrected (real-device finding, 2026-08-22)**: the
 * first pass put the handle directly above `GuestNameEditor`, with
 * `RoomControls` between it and the chat — the *literal* thing the drag
 * revealed was the guest-name editor, not comments, exactly the
 * complaint. `GuestNameEditor`/`joinSeatMessage` and `RoomControls` now
 * sit *above* the handle, outside the expand/collapse relationship
 * entirely — fixed size, always visible, never growing — so the handle
 * sits directly against the one thing it actually controls: the chat
 * wrapper immediately below it. Still the same `StageOverlayShell`,
 * still the same underlying `useCommentsFocus` state; only the ordering
 * of what's inside it changed.
 *
 * The site-wide header's own compaction (globals.css, `body.room-active`
 * + a `(orientation: landscape) and (max-height: …)` media query) is
 * handled entirely outside this component — see `EventRoom`'s doc
 * comment — since that header lives in the root layout, not here.
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
  const { open: commentsFocused, progress, dragging, handleProps } = useCommentsFocus();
  const chatHeightPx =
    COLLAPSED_CHAT_HEIGHT_PX + (EXPANDED_CHAT_HEIGHT_PX - COLLAPSED_CHAT_HEIGHT_PX) * progress;

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
          scrimOpacity={progress * MAX_SCRIM_OPACITY}
          scrimInstant={dragging}
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
          {/* Fixed-size, always visible, never part of the expand/collapse — low-priority metadata stays out of the handle's own reveal target below. */}
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
          {/* The handle sits directly against the one thing it reveals — nothing else between it and the chat wrapper below. */}
          <button
            type="button"
            data-testid="comments-focus-handle"
            {...handleProps}
            aria-expanded={commentsFocused}
            aria-label={commentsFocused ? "Collapse comments" : "Expand comments"}
            className="flex h-6 w-full shrink-0 touch-none items-center justify-center"
          >
            <span aria-hidden="true" className="h-1 w-10 rounded-full bg-white/40" />
          </button>
          <div style={{ height: chatHeightPx }} className="min-h-0 shrink-0">
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
        </StageOverlayShell>
      </div>
    </div>
  );
}
