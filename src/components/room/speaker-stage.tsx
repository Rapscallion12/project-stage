import type { Participant } from "livekit-client";
import { SpeakerTile } from "@/components/room/speaker-tile";
import { getParticipantIdentity } from "@/lib/livekit/token";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * Both seats, always — an empty seat renders `SpeakerTile`'s own
 * placeholder rather than being omitted, so the layout (and the "this is
 * a two-speaker room" framing) never collapses to one column when a seat
 * is open.
 */
export function SpeakerStage({
  speakers,
  getParticipant,
  myIdentity,
  className,
}: {
  speakers: EventSpeaker[];
  getParticipant: (identity: string) => Participant | undefined;
  myIdentity: string;
  className?: string;
}) {
  const bySeat = (seatNumber: 1 | 2) => speakers.find((s) => s.seat_number === seatNumber) ?? null;

  return (
    <div className={className ?? "grid grid-cols-2 gap-3"}>
      {([1, 2] as const).map((seatNumber) => {
        const seat = bySeat(seatNumber);
        const identity = seat ? getParticipantIdentity({ type: "profile", id: seat.profile_id }) : null;
        return (
          <SpeakerTile
            key={seat?.id ?? `empty-${seatNumber}`}
            speaker={seat}
            participant={identity ? getParticipant(identity) : undefined}
            isLocal={identity === myIdentity}
          />
        );
      })}
    </div>
  );
}
