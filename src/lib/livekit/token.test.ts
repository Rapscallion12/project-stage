// @vitest-environment node
//
// jose (which livekit-server-sdk uses to sign JWTs) needs real Node
// WebCrypto — jsdom's shimmed crypto isn't compatible and produces
// "payload must be an instance of Uint8Array" when signing. This file is
// pure server-side logic anyway, no DOM needed, so node is also just the
// correct environment on its own merits.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { determineCanPublish, getParticipantIdentity, getRoomName, mintLiveKitToken } from "./token";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const fakeActiveSeat: EventSpeaker = {
  id: "00000000-0000-0000-0000-0000000000aa",
  event_id: "00000000-0000-0000-0000-0000000000bb",
  profile_id: "00000000-0000-0000-0000-0000000000cc",
  seat_number: 1,
  joined_at: new Date().toISOString(),
  left_at: null,
  left_reason: null,
};

describe("determineCanPublish", () => {
  it("is false with no active seat (audience — guest or account holder)", () => {
    expect(determineCanPublish(null)).toBe(false);
  });

  it("is true with an active seat", () => {
    expect(determineCanPublish(fakeActiveSeat)).toBe(true);
  });
});

describe("room and identity naming", () => {
  it("scopes the room to the event with a :main suffix, ready for future rooms", () => {
    expect(getRoomName("abc-123")).toBe("event:abc-123:main");
  });

  it("namespaces guest and account identities so they can never collide", () => {
    expect(getParticipantIdentity({ type: "guest", id: "g1" })).toBe("guest:g1");
    expect(getParticipantIdentity({ type: "profile", id: "p1" })).toBe("profile:p1");
  });
});

/**
 * Minting a token signs a JWT locally — it never calls LiveKit's actual
 * API — so this is testable with any key/secret pair, not just the real
 * project's (which may not be configured in every environment; see
 * README.md's LiveKit setup). What's under test is the *content* of the
 * grant our server decided on, not connectivity to LiveKit itself.
 */
function decodeJwtPayload(token: string): Record<string, unknown> {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

describe("mintLiveKitToken", () => {
  beforeEach(() => {
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret-at-least-32-bytes-long");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("mints a subscribe-only token for a guest with no active seat", async () => {
    const token = await mintLiveKitToken({
      eventId: "event-1",
      identity: { type: "guest", id: "guest-1", displayName: "Curious Fox" },
      activeSeat: null,
    });

    const payload = decodeJwtPayload(token);
    expect(payload.sub).toBe("guest:guest-1");
    expect(payload.video).toMatchObject({
      room: "event:event-1:main",
      roomJoin: true,
      canPublish: false,
      canSubscribe: true,
      canPublishData: false,
    });
  });

  it("mints a publish-enabled token for an active speaker", async () => {
    const token = await mintLiveKitToken({
      eventId: "event-1",
      identity: { type: "profile", id: "profile-1", displayName: "Jamie" },
      activeSeat: fakeActiveSeat,
    });

    const payload = decodeJwtPayload(token);
    expect(payload.sub).toBe("profile:profile-1");
    expect(payload.video).toMatchObject({
      canPublish: true,
      canSubscribe: true,
    });
  });

  it("throws a clear error if LiveKit credentials aren't configured", async () => {
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");

    await expect(
      mintLiveKitToken({
        eventId: "event-1",
        identity: { type: "guest", id: "guest-1", displayName: "Curious Fox" },
        activeSeat: null,
      }),
    ).rejects.toThrow(/not configured/);
  });
});
