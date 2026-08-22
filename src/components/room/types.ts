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
  /**
   * Issue #14, lifted to EventRoom by issue #27 (was RoomControls' own
   * local state) — both RoomControls (Claim your seat/Withdraw for the
   * contested-queue path) and the composer (sets this true on a
   * successful mic-request submission) need to read/drive the same
   * value, so it can no longer live inside either one alone.
   */
  hasPendingRequest: boolean;
  onHasPendingRequestChange: (value: boolean) => void;
  /** Issue #27: whether the composer is in speaker-request mode — set directly by its own 🎤 toggle, or by tapping an empty seat that turns out to have a queue (see onTapEmptySeat). */
  micRequestMode: boolean;
  onMicRequestModeChange: (value: boolean) => void;
  /**
   * Issue #27: tapping a visibly empty seat tile. Takes no seat number —
   * `speaker_requests` is event-scoped, not per-seat, so either empty
   * tile triggers the identical server-side attempt (join whichever seat
   * is actually open, refuse if a queue exists for the event at all).
   * Fire-and-forget from the tile's perspective; the result surfaces via
   * `isJoiningSeat`/`joinSeatMessage`/`micRequestMode` flowing back down,
   * the same "state flows back down as props" pattern `activateMedia`
   * already uses.
   */
  onTapEmptySeat: () => void;
  /** True while a `onTapEmptySeat` attempt is in flight — disables both empty-seat tiles so a double-tap can't fire two attempts. */
  isJoiningSeat: boolean;
  /** Set when `onTapEmptySeat` fails for a real reason (not a queue — that switches to mic-request mode instead) — e.g. the guest account-prompt. Cleared on the next attempt. */
  joinSeatMessage: string | null;
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
