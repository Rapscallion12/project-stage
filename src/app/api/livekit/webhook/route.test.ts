// @vitest-environment node
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { getParticipantIdentity, getRoomName } from "@/lib/livekit/token";
import { claimSpeakerSeat } from "@/lib/repositories/event-speakers";
import { POST } from "./route";

// Only real Supabase fixtures are required — LiveKit credentials are
// stubbed with fake test values below. Signature signing/verification
// (WebhookReceiver's TokenVerifier) is a local HMAC/JWT check, same as
// token.test.ts's JWT minting: it never calls LiveKit's API, so a real
// LiveKit project isn't needed to exercise it for real, only *some*
// key/secret pair the signer and the route handler agree on.
const hasCredentials = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

/**
 * Signs a webhook body exactly the way LiveKit's server does, so this
 * exercises the route's real signature-verification path rather than
 * bypassing it — see `livekit-server-sdk`'s WebhookReceiver/TokenVerifier
 * source for the scheme this mirrors: an HS256 JWT (issuer = API key,
 * secret = API secret) carrying a `sha256` claim, which is the base64 of
 * the request body's SHA-256 digest. `jose` isn't a direct dependency of
 * this project, but it's what livekit-server-sdk itself uses for exactly
 * this — same precedent as token.test.ts relying on it transitively.
 */
async function signWebhookBody(body: string): Promise<string> {
  const apiKey = process.env.LIVEKIT_API_KEY!;
  const apiSecret = process.env.LIVEKIT_API_SECRET!;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const sha256 = Buffer.from(digest).toString("base64");

  return new SignJWT({ sha256 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(apiKey)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(new TextEncoder().encode(apiSecret));
}

function webhookRequest(body: string, authHeader?: string): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (authHeader) headers.set("Authorize", authHeader);
  return new Request("http://localhost/api/livekit/webhook", { method: "POST", body, headers });
}

describe.skipIf(!hasCredentials)("LiveKit webhook route (issue #13)", () => {
  // Lazily constructed in beforeAll — see the equivalent comment in
  // event-speakers-transitions.test.ts for why this can't be module/
  // describe-body-level.
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;
  let profileId: string;

  beforeAll(async () => {
    // Fake but consistent — the signer (this test) and the route handler
    // both read these at call time, and verification never leaves the
    // process. Real LiveKit credentials would work identically here; this
    // is what lets the test run without depending on a live project.
    vi.stubEnv("LIVEKIT_API_KEY", "test-webhook-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-webhook-secret-at-least-32-bytes-long");

    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #13 webhook test fixture event",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;

    const { data: user, error: userError } = await service.auth.admin.createUser({
      email: `test-webhook-${crypto.randomUUID()}@example.invalid`,
      password: `Test-Passw0rd-${crypto.randomUUID()}`,
      email_confirm: true,
      user_metadata: { display_name: "Test Webhook Speaker" },
    });
    if (userError || !user.user) throw new Error(userError?.message ?? "failed to create test profile");
    profileId = user.user.id;
  }, 30_000);

  afterAll(async () => {
    if (profileId) await service.auth.admin.deleteUser(profileId);
    if (eventId) await service.from("events").delete().eq("id", eventId);
    vi.unstubAllEnvs();
  }, 30_000);

  it("rejects a request with an invalid signature and makes no DB change", async () => {
    await claimSpeakerSeat(eventId, { type: "profile", id: profileId }, 1);

    const body = JSON.stringify({
      event: "participant_left",
      room: { name: getRoomName(eventId) },
      participant: { identity: getParticipantIdentity({ type: "profile", id: profileId }) },
    });
    const response = await POST(webhookRequest(body, "not-a-real-token"));
    expect(response.status).toBe(401);

    const { data } = await service
      .from("event_speakers")
      .select("left_at")
      .eq("event_id", eventId)
      .eq("profile_id", profileId)
      .single();
    expect(data?.left_at).toBeNull();
  });

  it("starts the disconnect grace-period clock on a validly-signed participant_left event, without releasing the seat (issue #18 UX finding)", async () => {
    const body = JSON.stringify({
      event: "participant_left",
      room: { name: getRoomName(eventId) },
      participant: { identity: getParticipantIdentity({ type: "profile", id: profileId }) },
    });
    const authHeader = await signWebhookBody(body);

    const response = await POST(webhookRequest(body, authHeader));
    expect(response.status).toBe(200);

    const { data } = await service
      .from("event_speakers")
      .select("left_at, left_reason, disconnected_at")
      .eq("event_id", eventId)
      .eq("profile_id", profileId)
      .single();
    // The seat is deliberately NOT released here — only the grace-period
    // clock starts. See release_expired_disconnected_speaker (migration
    // 00000000000016) for the actual, later expiration.
    expect(data?.left_at).toBeNull();
    expect(data?.left_reason).toBeNull();
    expect(data?.disconnected_at).not.toBeNull();
  });

  it("is a safe no-op for a guest identity with no active seat (e.g. an audience guest disconnecting)", async () => {
    const body = JSON.stringify({
      event: "participant_left",
      room: { name: getRoomName(eventId) },
      participant: { identity: getParticipantIdentity({ type: "guest", id: crypto.randomUUID() }) },
    });
    const authHeader = await signWebhookBody(body);

    const response = await POST(webhookRequest(body, authHeader));
    expect(response.status).toBe(200);
  });

  it("marks a genuinely seated guest's disconnect too (issue #16 — guests can hold a seat now, this is the regression the migration comment specifically flags)", async () => {
    const guestId = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 2, "Test Webhook Guest");

    const body = JSON.stringify({
      event: "participant_left",
      room: { name: getRoomName(eventId) },
      participant: { identity: getParticipantIdentity({ type: "guest", id: guestId }) },
    });
    const authHeader = await signWebhookBody(body);

    const response = await POST(webhookRequest(body, authHeader));
    expect(response.status).toBe(200);

    const { data } = await service
      .from("event_speakers")
      .select("left_at, disconnected_at")
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .single();
    expect(data?.left_at).toBeNull();
    expect(data?.disconnected_at).not.toBeNull();
  });

  it("participant_joined clears a seated speaker's disconnect grace-period clock (issue #18 UX finding — the authoritative 'they're back' signal)", async () => {
    const guestId = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, 1, "Test Webhook Reconnect Guest");

    const leftBody = JSON.stringify({
      event: "participant_left",
      room: { name: getRoomName(eventId) },
      participant: { identity: getParticipantIdentity({ type: "guest", id: guestId }) },
    });
    await POST(webhookRequest(leftBody, await signWebhookBody(leftBody)));

    const { data: disconnected } = await service
      .from("event_speakers")
      .select("disconnected_at")
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .single();
    expect(disconnected?.disconnected_at).not.toBeNull();

    const joinedBody = JSON.stringify({
      event: "participant_joined",
      room: { name: getRoomName(eventId) },
      participant: { identity: getParticipantIdentity({ type: "guest", id: guestId }) },
    });
    const response = await POST(webhookRequest(joinedBody, await signWebhookBody(joinedBody)));
    expect(response.status).toBe(200);

    const { data: reconnected } = await service
      .from("event_speakers")
      .select("left_at, disconnected_at")
      .eq("event_id", eventId)
      .eq("guest_id", guestId)
      .single();
    expect(reconnected?.left_at).toBeNull();
    expect(reconnected?.disconnected_at).toBeNull();
  });

  it("participant_joined is a safe no-op for an ordinary audience member with no active seat", async () => {
    const body = JSON.stringify({
      event: "participant_joined",
      room: { name: getRoomName(eventId) },
      participant: { identity: getParticipantIdentity({ type: "guest", id: crypto.randomUUID() }) },
    });
    const authHeader = await signWebhookBody(body);

    const response = await POST(webhookRequest(body, authHeader));
    expect(response.status).toBe(200);
  });

  it("ignores webhook events other than participant_left/participant_joined", async () => {
    const body = JSON.stringify({ event: "room_started", room: { name: getRoomName(eventId) } });
    const authHeader = await signWebhookBody(body);

    const response = await POST(webhookRequest(body, authHeader));
    expect(response.status).toBe(200);
  });
});
