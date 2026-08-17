"use client";

import { useActiveSpeakers } from "@/hooks/use-active-speakers";
import { useLiveRoomConnection } from "@/hooks/use-live-room-connection";
import { useLobbyRealtime, type LobbyMessage, type ReactionState } from "@/hooks/use-lobby-realtime";
import { useNow } from "@/hooks/use-now";
import { useOrientation } from "@/hooks/use-orientation";
import { PortraitRoom } from "@/components/room/portrait-room";
import { LandscapeRoom } from "@/components/room/landscape-room";
import { RoomDiagnostics } from "@/components/room/room-diagnostics";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { getParticipantIdentity } from "@/lib/livekit/token";
import { formatCountdown, getEventPhase, type EventPhase } from "@/lib/events";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL || null;

/**
 * The one persistent event experience (issue #17) — replaces the old
 * three-route event→lobby→room split. This is the single place
 * useActiveSpeakers, useLiveRoomConnection, useLobbyRealtime,
 * useOrientation, and (new in #17) the event-phase clock are called.
 * Everything below it (the pre-lobby countdown view, and
 * PortraitRoom/LandscapeRoom for lobby_open/ready) is presentation only,
 * reading from this component's state. This is what makes the
 * lobby→live transition genuine — not a redirect that tears down and
 * rebuilds chat/speakers/LiveKit, but the same mounted hooks simply
 * being fed a new `phase` value, the same way rotation already worked:
 * see ARCHITECTURE.md's mobile orientation implementation notes for the
 * precedent this follows (hooks live above the branch, never inside it).
 */
export function EventRoom({
  event,
  identity,
  initialPhase,
  initialToken,
  initialSpeakers,
  initialMessages,
  initialReactions,
  initialHasPendingRequest,
}: {
  event: Event;
  identity: Identity;
  /** Computed server-side at request time — used until the client clock (useNow) ticks past hydration, so first paint is never wrong (e.g. someone opening an already-live link lands live immediately, not on a placeholder). */
  initialPhase: EventPhase;
  initialToken: string | null;
  initialSpeakers: EventSpeaker[];
  initialMessages: LobbyMessage[];
  initialReactions: Record<string, ReactionState>;
  /** Issue #14: whether the caller already has a pending speaker request, fetched server-side. */
  initialHasPendingRequest: boolean;
}) {
  const { messages, reactions } = useLobbyRealtime(event.id, identity, initialMessages, initialReactions);
  const { speakers, roomStatus } = useActiveSpeakers(event.id, initialSpeakers);

  const nowMs = useNow();
  const phase = nowMs === null ? initialPhase : getEventPhase(event, new Date(nowMs));

  // LiveKit only connects once genuinely live — canConnect flipping from
  // false to true while this component stays mounted is what lets the
  // room go live in place: useLiveRoomConnection was already designed to
  // handle a null-to-real params transition (see its own doc comment),
  // so this doesn't remount or refetch anything, it just starts using
  // the token already fetched at initial page load.
  const canConnect = Boolean(LIVEKIT_URL && initialToken && phase === "ready");
  const connection = useLiveRoomConnection(canConnect ? { livekitUrl: LIVEKIT_URL!, token: initialToken! } : null);

  const orientation = useOrientation();

  const myIdentity = getParticipantIdentity(
    identity.type === "profile" ? { type: "profile", id: identity.id } : { type: "guest", id: identity.id },
  );
  // Issue #16: a guest can hold a seat too (prototype-testing exception —
  // see PRODUCT.md/DECISIONS.md), so this matches whichever identity
  // column is actually set on the seat row, not just profile_id.
  const isSpeaker = speakers.some((s) =>
    identity.type === "profile" ? s.profile_id === identity.id : s.guest_id === identity.id,
  );

  if (phase === "upcoming") {
    const now = nowMs === null ? null : new Date(nowMs);
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <h1 className="text-xl font-semibold">{event.title}</h1>
        {event.description && <p className="max-w-md text-sm text-muted">{event.description}</p>}
        <p className="text-sm text-muted">
          {now ? (
            <>
              Lobby opens in{" "}
              <span className="font-medium text-foreground">{formatCountdown(event.lobby_opens_at, now)}</span>
            </>
          ) : (
            "…"
          )}
        </p>
        {identity.type === "guest" && <GuestNameEditor initialName={identity.displayName} />}
      </div>
    );
  }

  const countdownText =
    phase === "lobby_open" && nowMs !== null ? `Live in ${formatCountdown(event.scheduled_start, new Date(nowMs))}` : null;

  const layoutProps = {
    event,
    phase,
    countdownText,
    roomStatus,
    speakers,
    myIdentity,
    identity,
    isSpeaker,
    hasPendingRequest: initialHasPendingRequest,
    getParticipant: connection.getParticipant,
    participantCount: connection.participantCount,
    connectionStatus: connection.status,
    canPublish: connection.canPublish,
    needsMediaActivation: connection.needsMediaActivation,
    activateMedia: connection.activateMedia,
    mediaError: connection.mediaError,
    messages,
    reactions,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1">
        {orientation === "landscape" ? <LandscapeRoom {...layoutProps} /> : <PortraitRoom {...layoutProps} />}
      </div>
      {/* TEMPORARY — issue #15 real-device diagnosis, see DECISIONS.md. Remove once root cause is confirmed fixed. */}
      <RoomDiagnostics
        identityType={identity.type}
        isSpeaker={isSpeaker}
        hasServerToken={initialToken !== null}
        liveKitUrlConfigured={Boolean(LIVEKIT_URL)}
        connectionStatus={connection.status}
        canPublish={connection.canPublish}
        needsMediaActivation={connection.needsMediaActivation}
        mediaError={connection.mediaError}
        participantCount={connection.participantCount}
      />
    </div>
  );
}
