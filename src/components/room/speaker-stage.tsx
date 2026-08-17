import type { Participant } from "livekit-client";
import { SpeakerTile } from "@/components/room/speaker-tile";
import { getParticipantIdentity } from "@/lib/livekit/token";
import type { MediaError } from "@/hooks/use-live-room-connection";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * Both seats, always — an empty seat renders `SpeakerTile`'s own
 * placeholder rather than being omitted, so the layout (and the "this is
 * a two-speaker room" framing) never collapses to one column when a seat
 * is open. `needsMediaActivation`/`activateMedia`/`mediaError` describe
 * the *local* participant only — passed to every tile, but only the tile
 * matching `myIdentity` ever acts on them (see SpeakerTile).
 */
export function SpeakerStage({
  speakers,
  getParticipant,
  myIdentity,
  needsMediaActivation,
  activateMedia,
  mediaError,
  className,
}: {
  speakers: EventSpeaker[];
  getParticipant: (identity: string) => Participant | undefined;
  myIdentity: string;
  needsMediaActivation: boolean;
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  className?: string;
}) {
  const bySeat = (seatNumber: 1 | 2) => speakers.find((s) => s.seat_number === seatNumber) ?? null;

  return (
    <div className={className ?? "grid grid-cols-2 gap-3"}>
      {([1, 2] as const).map((seatNumber) => {
        const seat = bySeat(seatNumber);
        // Issue #16: a seat's occupant identity is whichever of
        // profile_id/guest_id is actually set (the table's own XOR
        // constraint guarantees exactly one) — never assume profile.
        const identity = seat
          ? getParticipantIdentity(
              seat.profile_id ? { type: "profile", id: seat.profile_id } : { type: "guest", id: seat.guest_id! },
            )
          : null;
        return (
          <SpeakerTile
            key={seat?.id ?? `empty-${seatNumber}`}
            speaker={seat}
            participant={identity ? getParticipant(identity) : undefined}
            isLocal={identity === myIdentity}
            needsMediaActivation={needsMediaActivation}
            activateMedia={activateMedia}
            mediaError={mediaError}
          />
        );
      })}
    </div>
  );
}
