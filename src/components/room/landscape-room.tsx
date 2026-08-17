import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * Discussion maximized, chat becomes a narrower secondary panel — the
 * inverse priority from portrait. Used for landscape phones and desktop
 * browsers alike (both get the wide-viewport treatment; see
 * ARCHITECTURE.md's responsive implementation notes on desktop/mobile
 * sharing structure where it genuinely doesn't differ). Presentation
 * only, same as PortraitRoom.
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
    <div className="flex min-h-0 flex-1 flex-row">
      <div className="flex min-h-0 flex-1 flex-col">
        <RoomHeader
          eventTitle={event.title}
          roomStatus={roomStatus}
          countdownText={countdownText}
          participantCount={participantCount}
          connectionStatus={connectionStatus}
        />
        <div className="flex flex-1 items-center justify-center p-4">
          <SpeakerStage
            speakers={speakers}
            getParticipant={getParticipant}
            myIdentity={myIdentity}
            needsMediaActivation={needsMediaActivation}
            activateMedia={activateMedia}
            mediaError={mediaError}
            className="grid w-full max-w-4xl grid-cols-2 gap-4"
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
