import { WebhookReceiver, authorizeHeader } from "livekit-server-sdk";
import { NextResponse } from "next/server";
import { parseParticipantIdentity, parseRoomName } from "@/lib/livekit/token";
import { markSpeakerDisconnected, markSpeakerReconnected } from "@/lib/repositories/event-speakers";

/**
 * LiveKit webhook receiver — issue #13's disconnect-cleanup path, and
 * (issue #18 UX finding) the authoritative start/end of the speaker
 * disconnect grace period. LiveKit calls this server-to-server, with no
 * Supabase session at all, so authorization here is entirely the webhook
 * signature check below, never `auth.uid()`. That's why this is the one
 * route in the app that calls `markSpeakerDisconnected`/
 * `markSpeakerReconnected` (backed by the service-client-only functions
 * from migration 00000000000016) — the signature check *is* the
 * authorization; those functions just trust whatever already-verified
 * server code calls them. See DECISIONS.md's authorization-model entry
 * for issue #13 and the grace-period entry for issue #18.
 *
 * **No longer an immediate eviction**: `participant_left` used to call
 * `end_speaker_seat` directly here, releasing the seat the instant
 * LiveKit reported the disconnect — no grace period at all, so a speaker
 * who merely refreshed or blipped offline lost their seat outright, the
 * same as someone who genuinely left. It now only starts the clock
 * (`disconnected_at`); the actual release, after the grace period
 * genuinely elapses, is `release_expired_disconnected_speaker`'s job
 * (`checkAndEvictDisconnectedSpeaker`, room/actions.ts) — see
 * DECISIONS.md. `participant_joined` is the symmetric authoritative
 * "they're back" signal, clearing the clock — not anything the
 * reconnecting client asserts about itself.
 *
 * Requires a webhook configured in the LiveKit project dashboard pointing
 * at this route's public URL, using the same LIVEKIT_API_KEY/SECRET the
 * app already signs tokens with (LiveKit webhooks aren't a separate
 * credential) — see README.md's LiveKit setup. Not reachable from local
 * dev without a public tunnel (e.g. ngrok pointed at this route), so this
 * is verified by tests that construct real signed payloads via the same
 * `WebhookReceiver`/signing mechanism, not a live LiveKit round trip.
 */
function getReceiver(): WebhookReceiver {
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error("LIVEKIT_API_KEY / LIVEKIT_API_SECRET are not configured.");
  }
  return new WebhookReceiver(apiKey, apiSecret);
}

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const authHeader = request.headers.get(authorizeHeader) ?? undefined;

  let event: Awaited<ReturnType<WebhookReceiver["receive"]>>;
  try {
    event = await getReceiver().receive(body, authHeader);
  } catch {
    // Invalid/missing signature, or credentials not configured — never
    // trust an unverified payload enough to even inspect it.
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  if (event.event !== "participant_left" && event.event !== "participant_joined") {
    // Only the disconnect/reconnect grace-period path is this route's
    // concern — moderator_removed and event_ended have no trigger yet
    // (see the migration comment), and every other webhook event this
    // project doesn't act on.
    return NextResponse.json({ ok: true });
  }

  const eventId = event.room?.name ? parseRoomName(event.room.name) : null;
  const identity = event.participant?.identity ? parseParticipantIdentity(event.participant.identity) : null;

  if (!eventId || !identity) {
    // Not one of this app's rooms.
    return NextResponse.json({ ok: true });
  }

  // Issue #16: guests can now hold a seat too (a prototype-testing
  // exception, see PRODUCT.md/DECISIONS.md) — both functions below are a
  // safe no-op for any identity with no active seat, so this doesn't need
  // to check identity.type first; a disconnecting/reconnecting audience
  // guest just hits the no-op path, same as an audience account holder
  // always has.
  if (event.event === "participant_left") {
    // Starts the grace-period clock — does not release the seat itself.
    // See release_expired_disconnected_speaker (checkAndEvictDisconnectedSpeaker,
    // room/actions.ts) for the actual, server-authoritative expiration.
    await markSpeakerDisconnected(eventId, identity);
  } else {
    // participant_joined: the authoritative "they're back" signal —
    // clears the clock so no later, stale grace-period check can evict
    // them. Scoped to their own seat row only (see the migration's own
    // comment), so this can never affect a *different* occupant.
    await markSpeakerReconnected(eventId, identity);
  }

  return NextResponse.json({ ok: true });
}
