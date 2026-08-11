import type { Participant } from "livekit-client";
import type { ConnectionStatus } from "@/hooks/use-live-room-connection";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RoomStatus } from "@/lib/room-status";

/**
 * Shared props for the portrait/landscape presentation components —
 * both receive exactly this, and arrange it differently. Neither owns any
 * live state itself; see LiveRoom, the one component above this split
 * that calls useLiveRoomConnection/useActiveSpeakers/useLobbyRealtime.
 */
export type RoomLayoutProps = {
  event: Event;
  roomStatus: RoomStatus;
  speakers: EventSpeaker[];
  myIdentity: string;
  isSpeaker: boolean;
  getParticipant: (identity: string) => Participant | undefined;
  participantCount: number;
  connectionStatus: ConnectionStatus;
  messages: LobbyMessage[];
  reactions: Record<string, ReactionState>;
};
