import { RoomServiceClient } from "livekit-server-sdk";
import { getParticipantIdentity, getRoomName } from "./token";

/**
 * RoomServiceClient needs an http(s) host; NEXT_PUBLIC_LIVEKIT_URL is the
 * client-facing `wss://` URL used for the actual media connection.
 * LiveKit's REST API and its realtime signaling are served from the same
 * host, just a different scheme.
 */
function getServiceUrl(): string {
  const wsUrl = process.env.NEXT_PUBLIC_LIVEKIT_URL;
  if (!wsUrl) {
    throw new Error("NEXT_PUBLIC_LIVEKIT_URL is not configured.");
  }
  return wsUrl.replace(/^ws/, "http");
}

function getClient(): RoomServiceClient {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not configured.");
  }
  return new RoomServiceClient(getServiceUrl(), apiKey, apiSecret);
}

/**
 * Pushes a `canPublish` change to an already-connected participant, so a
 * newly-seated or newly-replaced speaker's publish rights change
 * immediately instead of waiting for their next token request.
 *
 * Best effort, deliberately not authoritative: by the time this is called,
 * `event_speakers` (via lib/repositories/event-speakers.ts's write
 * functions) is already durably updated, and `mintLiveKitToken` (issue #2)
 * re-derives the correct `canPublish` from that table on every token
 * request regardless. So if this call fails — participant not currently
 * connected, LiveKit unreachable — the participant simply catches up on
 * their next token request rather than being stuck wrong forever. Errors
 * are logged, never thrown: a permission-sync hiccup must never fail (or
 * roll back) the DB write that triggered it. See ARCHITECTURE.md's LiveKit
 * authorization model for the full reasoning.
 */
export async function syncPublishPermission(params: {
  eventId: string;
  profileId: string;
  canPublish: boolean;
}): Promise<void> {
  try {
    const client = getClient();
    await client.updateParticipant(
      getRoomName(params.eventId),
      getParticipantIdentity({ type: "profile", id: params.profileId }),
      {
        // Permissions are replaced atomically by LiveKit, not merged — every
        // field that matters has to be set on every call, mirroring the
        // grant mintLiveKitToken issues.
        permission: {
          canSubscribe: true,
          canPublish: params.canPublish,
          canPublishData: false,
        },
      },
    );
  } catch (error) {
    console.error("syncPublishPermission: live permission push failed; next token request will self-correct", {
      eventId: params.eventId,
      profileId: params.profileId,
      canPublish: params.canPublish,
      error,
    });
  }
}
