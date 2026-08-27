import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * Desktop-only (renamed from `LandscapeRoom`, real-device finding,
 * 2026-08-22): stage left, a real dedicated chat sidebar right — a
 * classic video-call/live-chat structure, not an overlay, because
 * desktop genuinely has the width to spare for both without covering the
 * speakers. This used to render for *any* landscape-oriented viewport,
 * phone included — a real-device test rotating a phone found that
 * wrong: a 320px sidebar eats most of a phone's width, squeezing video
 * to a strip and turning the room into a cramped dashboard instead of
 * staying video-first. `EventRoom` now only mounts this when
 * `useIsDesktopViewport()` is true (a width threshold, not orientation —
 * an iPhone in landscape stays classified as mobile and gets
 * `MobileLandscapeRoom` instead, which keeps the overlay philosophy
 * `PortraitRoom` already uses). Presentation only, same discipline as
 * every other room composition — all live state still lives in
 * `EventRoom`, above this branch.
 *
 * **Anti-squashing note (2026-08-22)**: right at the desktop width
 * threshold (1024px), a fixed `w-80` (320px) sidebar left the two
 * side-by-side tiles pathologically narrow — `SpeakerStage`'s tiles have
 * no minimum width or aspect-ratio floor, so `object-cover` crops video
 * heavily once a tile gets tall-and-narrow instead of landscape-shaped.
 * Fixed with one isolated, responsive width class on the sidebar itself
 * (`w-64 xl:w-80` — narrower only below the 1280px `xl` breakpoint, back
 * to the original width above it) — everything else about this
 * composition, and every other one, is untouched. A hard minimum width
 * on the stage column itself would be a further, more thorough fix;
 * left to #18 rather than expanded here.
 */
export function DesktopRoom({
  event,
  phase,
  countdownText,
  roomStatus,
  speakers,
  myIdentity,
  identity,
  isSpeaker,
  mySeatNumber,
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
  isPreviewBuild,
  messages,
  reactions,
}: RoomLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-row overflow-hidden">
      <div className="flex min-h-0 flex-1 flex-col">
        <RoomHeader
          eventTitle={event.title}
          roomStatus={roomStatus}
          countdownText={countdownText}
          participantCount={participantCount}
          connectionStatus={connectionStatus}
        />
        <div className="min-h-0 flex-1">
          <SpeakerStage
            speakers={speakers}
            getParticipant={getParticipant}
            myIdentity={myIdentity}
            isSpeaker={isSpeaker}
            mySeatNumber={mySeatNumber}
            needsMediaActivation={needsMediaActivation}
            activateMedia={activateMedia}
            mediaError={mediaError}
            orientation="landscape"
            onTapEmptySeat={onTapEmptySeat}
            isJoiningSeat={isJoiningSeat}
            localVideoTrack={localVideoTrack}
            reconnectingIdentities={reconnectingIdentities}
            isPreviewBuild={isPreviewBuild}
          />
        </div>
        {joinSeatMessage && (
          <p className="px-4 pt-2 text-xs text-red-500" role="alert">
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
      </div>
      {/* w-64 below the xl breakpoint (1280px), not a fixed w-80 — real-device follow-up: right at the desktop threshold (1024px) a fixed 320px sidebar left the two side-by-side video tiles pathologically narrow. A small, isolated width reduction in the cramped zone only; the sidebar returns to its original, already-acceptable w-80 once there's room to spare. See DECISIONS.md. */}
      <div className="flex w-64 shrink-0 flex-col border-l border-border xl:w-80">
        {identity.type === "guest" && (
          <div className="shrink-0 border-b border-border px-3 py-2">
            <GuestNameEditor initialName={identity.displayName} />
          </div>
        )}
        <RoomChatPanel
          eventId={event.id}
          messages={messages}
          reactions={reactions}
          micRequestMode={micRequestMode}
          onMicRequestModeChange={onMicRequestModeChange}
          onHasPendingRequestChange={onHasPendingRequestChange}
          onPrepareMedia={onPrepareMedia}
          className="min-h-0 flex-1"
        />
      </div>
    </div>
  );
}
