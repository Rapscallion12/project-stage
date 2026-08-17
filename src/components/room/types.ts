import type { Participant } from "livekit-client";
import type { ConnectionStatus, MediaError } from "@/hooks/use-live-room-connection";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";
import type { EventPhase } from "@/lib/events";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RoomStatus } from "@/lib/room-status";

/**
 * Shared props for the portrait/landscape presentation components —
 * both receive exactly this, and arrange it differently. Neither owns any
 * live state itself; see EventRoom, the one component above this split
 * that calls useLiveRoomConnection/useActiveSpeakers/useLobbyRealtime.
 */
export type RoomLayoutProps = {
  event: Event;
  /** Issue #17: upcoming/lobby_open/ready — same room layout renders all three, differing only in countdownText and whether claiming a seat is allowed. */
  phase: EventPhase;
  /** Human-readable "Live in 2h 15m" text, or null once phase is "ready" — see RoomHeader. */
  countdownText: string | null;
  roomStatus: RoomStatus;
  speakers: EventSpeaker[];
  /** LiveKit-format identity string (`profile:<id>`/`guest:<id>`), for matching against connected participants — see SpeakerStage. */
  myIdentity: string;
  /** The caller's actual identity — used for RoomControls' guest/account branching, distinct from `myIdentity` above. */
  identity: Identity;
  isSpeaker: boolean;
  /** Issue #14: whether the caller currently has a pending speaker request — seeds RoomControls' local state. */
  hasPendingRequest: boolean;
  getParticipant: (identity: string) => Participant | undefined;
  participantCount: number;
  connectionStatus: ConnectionStatus;
  /** Whether the server currently grants this participant canPublish — distinct from whether media has been activated in this tab yet. */
  canPublish: boolean;
  /** True once canPublish but camera/mic hasn't been activated in this tab — RoomControls shows an explicit tap-to-enable affordance for this (see activateMedia's own doc comment for why it can't just happen automatically). */
  needsMediaActivation: boolean;
  /** Must be invoked directly from a click handler — see useLiveRoomConnection's activateMedia. */
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  messages: LobbyMessage[];
  reactions: Record<string, ReactionState>;
};
