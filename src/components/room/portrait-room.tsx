import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * Video-first (issue #20): the stage takes essentially all remaining
 * space below the header (`flex-1`), replacing the old small
 * fixed-height speaker block. Controls and a *compact* chat strip live
 * below it in a fixed-height footer, not the page-filling chat panel
 * this used to be — expanding that strip into a full chat-focus view is
 * issue #21, not this one. The same `ChatPanel` instance is used here
 * (via `RoomChatPanel`) in both states so #21 can make it expandable
 * without ever swapping which component is mounted — see DECISIONS.md.
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
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
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
          orientation="portrait"
        />
      </div>
      <div className="flex shrink-0 flex-col border-t border-border">
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
        <div className="h-40 min-h-0">
          <RoomChatPanel eventId={event.id} messages={messages} reactions={reactions} className="h-full" />
        </div>
      </div>
    </div>
  );
}
