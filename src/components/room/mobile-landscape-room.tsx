import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

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
 * `orientation="landscape"` (side-by-side tiles, not stacked), and the
 * overlay's own footprint is trimmed (`RoomHeader compact`, a shorter
 * chat panel, less top gradient padding) specifically because a phone in
 * landscape has meaningfully less vertical room than portrait to spend
 * on chrome. `EventRoom` mounts this only when `useOrientation()` is
 * `"landscape"` *and* `useIsDesktopViewport()` is false — an iPhone in
 * landscape is comfortably under the desktop width threshold, so it
 * lands here, not in `DesktopRoom`.
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
  messages,
  reactions,
}: RoomLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <RoomHeader
        eventTitle={event.title}
        roomStatus={roomStatus}
        countdownText={countdownText}
        participantCount={participantCount}
        connectionStatus={connectionStatus}
        compact
      />
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
        />
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
          {/* Shorter than PortraitRoom's h-40 — landscape has less vertical room to spend on chat before it competes with the stage. */}
          <div className="h-24 min-h-0">
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
