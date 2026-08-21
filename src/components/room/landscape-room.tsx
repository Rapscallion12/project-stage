import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * Video-first (issue #20), landscape variant: the stage fills the left
 * column edge to edge (no more centered/max-width/padded box around it —
 * side by side already gives video most of the width, so it should
 * actually use it), with the side panel narrow by comparison rather than
 * needing further compacting the way portrait's chat strip does. Used
 * for landscape phones and desktop browsers alike (see ARCHITECTURE.md's
 * responsive implementation notes). Presentation only, same as
 * PortraitRoom.
 */
export function LandscapeRoom({
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
            needsMediaActivation={needsMediaActivation}
            activateMedia={activateMedia}
            mediaError={mediaError}
            orientation="landscape"
          />
        </div>
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
      <div className="flex w-80 shrink-0 flex-col border-l border-border">
        {identity.type === "guest" && (
          <div className="shrink-0 border-b border-border px-3 py-2">
            <GuestNameEditor initialName={identity.displayName} />
          </div>
        )}
        <RoomChatPanel eventId={event.id} messages={messages} reactions={reactions} className="min-h-0 flex-1" />
      </div>
    </div>
  );
}
