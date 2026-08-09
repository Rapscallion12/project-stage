"use server";

import { resolveIdentity } from "@/lib/identity";
import { getActiveSeatForProfile } from "@/lib/repositories/event-speakers";
import { mintLiveKitToken } from "@/lib/livekit/token";

export type GetLiveKitTokenResult = { token: string } | { error: string };

/**
 * Mints a LiveKit access token scoped to the caller's *current*
 * `event_speakers` occupancy — never trusts anything the client sends to
 * decide `canPublish`. Guests always come back `canPublish: false`
 * (structurally: `event_speakers` is account-only, so a guest can never
 * have an active seat — see migration 00000000000005). Changing an
 * already-connected participant's permissions in real time (so a
 * replaced speaker loses publish rights immediately, not just on their
 * next token request) is issue #13's concern, not this one — see
 * DECISIONS.md's authorization-model entry for the split and why.
 */
export async function getLiveKitToken(eventId: string): Promise<GetLiveKitTokenResult> {
  const identity = await resolveIdentity();

  const activeSeat = identity.type === "profile" ? await getActiveSeatForProfile(eventId, identity.id) : null;

  try {
    const token = await mintLiveKitToken({ eventId, identity, activeSeat });
    return { token };
  } catch {
    return { error: "Couldn't connect to the live room. Try again." };
  }
}
