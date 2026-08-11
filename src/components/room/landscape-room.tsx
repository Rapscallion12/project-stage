import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
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
  roomStatus,
  speakers,
  myIdentity,
  isSpeaker,
  getParticipant,
  participantCount,
  connectionStatus,
  messages,
  reactions,
}: RoomLayoutProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-row">
      <div className="flex min-h-0 flex-1 flex-col">
        <RoomHeader
          eventTitle={event.title}
          roomStatus={roomStatus}
          participantCount={participantCount}
          connectionStatus={connectionStatus}
        />
        <div className="flex flex-1 items-center justify-center p-4">
          <SpeakerStage
            speakers={speakers}
            getParticipant={getParticipant}
            myIdentity={myIdentity}
            className="grid w-full max-w-4xl grid-cols-2 gap-4"
          />
        </div>
        {isSpeaker && <RoomControls eventId={event.id} />}
      </div>
      <RoomChatPanel
        eventId={event.id}
        messages={messages}
        reactions={reactions}
        className="w-80 shrink-0 border-l border-border"
      />
    </div>
  );
}
