import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * Chat gets the remaining real estate below a fixed-height header block
 * (speaker strip + controls), rather than controls trailing after a
 * variable-height chat feed. Issue #17 real-device follow-up: with
 * RoomControls previously positioned *after* RoomChatPanel, its "Request
 * the mic" control depended on the chat feed's height to determine how
 * far down the page it landed — on a real phone this meant it required
 * scrolling past however much chat/diagnostics content came before it to
 * even discover it existed, the same discoverability failure the tile
 * placement fix already addressed once for camera/mic activation.
 * Controls now sit directly below the speaker stage instead, so they're
 * reachable without depending on chat content height at all; only the
 * chat feed itself (already internally scrollable) absorbs the
 * remaining space. Presentation only: every prop here is owned by
 * EventRoom, above the orientation branch.
 */
export function PortraitRoom({
  event,
  phase,
  countdownText,
  roomStatus,
  speakers,
  myIdentity,
  identity,
  isSpeaker,
  hasPendingRequest,
  getParticipant,
  participantCount,
  connectionStatus,
  canPublish,
  needsMediaActivation,
  activateMedia,
  mediaError,
  messages,
  reactions,
}: RoomLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RoomHeader
        eventTitle={event.title}
        roomStatus={roomStatus}
        countdownText={countdownText}
        participantCount={participantCount}
        connectionStatus={connectionStatus}
      />
      <div className="shrink-0 p-3">
        <SpeakerStage
          speakers={speakers}
          getParticipant={getParticipant}
          myIdentity={myIdentity}
          needsMediaActivation={needsMediaActivation}
          activateMedia={activateMedia}
          mediaError={mediaError}
        />
      </div>
      {identity.type === "guest" && (
        <div className="shrink-0 px-3 pb-2">
          <GuestNameEditor initialName={identity.displayName} />
        </div>
      )}
      <RoomControls
        eventId={event.id}
        isSpeaker={isSpeaker}
        identity={identity}
        hasPendingRequest={hasPendingRequest}
        canPublish={canPublish}
        needsMediaActivation={needsMediaActivation}
        activateMedia={activateMedia}
        mediaError={mediaError}
        connectionStatus={connectionStatus}
        phase={phase}
        countdownText={countdownText}
      />
      <RoomChatPanel eventId={event.id} messages={messages} reactions={reactions} className="min-h-0 flex-1" />
    </div>
  );
}
