import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * Chat maximized, discussion secondary but always visible — a compact
 * speaker strip stays above the feed rather than being hidden behind a
 * tab, so the conversation is still comfortable to watch while chat gets
 * the primary real estate. Presentation only: every prop here is owned by
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
      <RoomChatPanel eventId={event.id} messages={messages} reactions={reactions} className="min-h-0 flex-1" />
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
    </div>
  );
}
