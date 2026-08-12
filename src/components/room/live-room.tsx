"use client";

import { useActiveSpeakers } from "@/hooks/use-active-speakers";
import { useLiveRoomConnection } from "@/hooks/use-live-room-connection";
import { useLobbyRealtime, type LobbyMessage, type ReactionState } from "@/hooks/use-lobby-realtime";
import { useOrientation } from "@/hooks/use-orientation";
import { PortraitRoom } from "@/components/room/portrait-room";
import { LandscapeRoom } from "@/components/room/landscape-room";
import { getParticipantIdentity } from "@/lib/livekit/token";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL || null;

/**
 * The top-level room orchestrator — the one place useActiveSpeakers,
 * useLiveRoomConnection, useLobbyRealtime, and useOrientation are called.
 * Everything below it (PortraitRoom/LandscapeRoom and their children) is
 * presentation only, reading from this component's state. This is what
 * makes rotation safe: those three hooks live in a component that renders
 * unconditionally, above the orientation branch, so React never unmounts
 * them on rotation — see ARCHITECTURE.md's mobile orientation
 * implementation notes.
 */
export function LiveRoom({
  event,
  identity,
  initialToken,
  initialSpeakers,
  initialMessages,
  initialReactions,
  initialHasPendingRequest,
}: {
  event: Event;
  identity: Identity;
  initialToken: string | null;
  initialSpeakers: EventSpeaker[];
  initialMessages: LobbyMessage[];
  initialReactions: Record<string, ReactionState>;
  /** Issue #14: whether the caller already has a pending speaker request, fetched server-side. */
  initialHasPendingRequest: boolean;
}) {
  const { messages, reactions } = useLobbyRealtime(event.id, identity, initialMessages, initialReactions);
  const { speakers, roomStatus } = useActiveSpeakers(event.id, initialSpeakers);

  const canConnect = Boolean(LIVEKIT_URL && initialToken);
  const connection = useLiveRoomConnection(canConnect ? { livekitUrl: LIVEKIT_URL!, token: initialToken! } : null);

  const orientation = useOrientation();

  const myIdentity = getParticipantIdentity(
    identity.type === "profile" ? { type: "profile", id: identity.id } : { type: "guest", id: identity.id },
  );
  const isSpeaker = identity.type === "profile" && speakers.some((s) => s.profile_id === identity.id);

  const layoutProps = {
    event,
    roomStatus,
    speakers,
    myIdentity,
    identity,
    isSpeaker,
    hasPendingRequest: initialHasPendingRequest,
    getParticipant: connection.getParticipant,
    participantCount: connection.participantCount,
    connectionStatus: connection.status,
    messages,
    reactions,
  };

  return orientation === "landscape" ? <LandscapeRoom {...layoutProps} /> : <PortraitRoom {...layoutProps} />;
}
