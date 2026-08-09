import { AccessToken } from "livekit-server-sdk";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * LiveKit is used directly here, not behind a repository — same
 * documented exception as Auth and Realtime in ARCHITECTURE.md's Vendor
 * portability section. Video/audio transport is inherently
 * provider-specific; a generic wrapper over LiveKit's API would just be
 * LiveKit's API with extra steps.
 */

/** One room per event for now — see ARCHITECTURE.md's multi-room note on why the ":main" suffix is there. */
export function getRoomName(eventId: string): string {
  return `event:${eventId}:main`;
}

export function getParticipantIdentity(identity: { type: "profile" | "guest"; id: string }): string {
  return `${identity.type}:${identity.id}`;
}

/**
 * Pure decision function, deliberately separated from the DB lookup that
 * feeds it — this is what issue #2's tests exercise directly, without
 * needing a live `event_speakers` fixture (which can't be seeded through
 * the app's own anon/authenticated client, since that table has no write
 * grant yet — see DECISIONS.md). The lookup itself is already covered by
 * issue #1's repository tests.
 */
export function determineCanPublish(activeSeat: EventSpeaker | null): boolean {
  return activeSeat !== null;
}

/**
 * Generous TTL (a few hours — long enough to cover a normal session
 * without mid-conversation interruption) because token expiry is
 * deliberately *not* the mechanism that revokes publish rights here. Live
 * permission changes (issue #13) push `canPublish` updates to already-
 * connected participants immediately; the token only needs to be valid
 * long enough to cover the connection/reconnection lifecycle, not to
 * "run out" as a way of enforcing anything.
 */
const TOKEN_TTL_SECONDS = 4 * 60 * 60;

export async function mintLiveKitToken(params: {
  eventId: string;
  identity: { type: "profile" | "guest"; id: string; displayName: string };
  activeSeat: EventSpeaker | null;
}): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not configured.");
  }

  const canPublish = determineCanPublish(params.activeSeat);

  const token = new AccessToken(apiKey, apiSecret, {
    identity: getParticipantIdentity(params.identity),
    name: params.identity.displayName,
    ttl: TOKEN_TTL_SECONDS,
  });

  token.addGrant({
    room: getRoomName(params.eventId),
    roomJoin: true,
    canPublish,
    canSubscribe: true,
    // Chat/reactions already go through Supabase Realtime (see
    // hooks/use-lobby-realtime.ts) — LiveKit's data channel is unused, so
    // it's explicitly off rather than left to default true.
    canPublishData: false,
  });

  return token.toJwt();
}
