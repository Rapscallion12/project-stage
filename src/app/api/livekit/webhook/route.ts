import { WebhookReceiver, authorizeHeader } from "livekit-server-sdk";
import { NextResponse } from "next/server";
import { parseParticipantIdentity, parseRoomName } from "@/lib/livekit/token";
import { endSpeakerSeat } from "@/lib/repositories/event-speakers";

/**
 * LiveKit webhook receiver — issue #13's disconnect-cleanup path. LiveKit
 * calls this server-to-server, with no Supabase session at all, so
 * authorization here is entirely the webhook signature check below, never
 * `auth.uid()`. That's why this is the one route in the app that calls
 * `endSpeakerSeat` (backed by the service-client-only `end_speaker_seat`
 * function, migration 00000000000006) — the signature check *is* the
 * authorization; `end_speaker_seat` just trusts whatever already-verified
 * server code calls it. See DECISIONS.md's authorization-model entry for
 * issue #13.
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

  if (event.event !== "participant_left") {
    // Only the disconnect path is issue #13's concern — moderator_removed
    // and event_ended have no trigger yet (see the migration comment), and
    // every other webhook event this project doesn't act on.
    return NextResponse.json({ ok: true });
  }

  const eventId = event.room?.name ? parseRoomName(event.room.name) : null;
  const identity = event.participant?.identity ? parseParticipantIdentity(event.participant.identity) : null;

  if (!eventId || !identity || identity.type !== "profile") {
    // Not one of this app's rooms, or a guest — guests can never hold a
    // seat (event_speakers is account-only), so there's nothing to clean
    // up either way.
    return NextResponse.json({ ok: true });
  }

  // No live LiveKit permission push here, unlike the leave/claim paths —
  // the participant is already gone, so there's no connected participant
  // left to push a permission change to. The DB write alone is the fix for
  // "stuck seat"; the next person who requests a token for this seat will
  // correctly see it as open.
  await endSpeakerSeat(eventId, identity.id, "disconnected");

  return NextResponse.json({ ok: true });
}
