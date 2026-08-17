// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncPublishPermission } from "./permissions";

/**
 * `syncPublishPermission` is deliberately best-effort (see its own doc
 * comment and ARCHITECTURE.md's LiveKit authorization model) — a failed
 * push must never throw, since the DB write it follows has already
 * durably succeeded by the time it's called, and mintLiveKitToken is the
 * eventual-consistency fallback. What's under test here is that contract
 * holding under every failure mode this project can produce without a
 * live, connected LiveKit participant (which nothing in this repo can
 * create yet — issue #3 hasn't installed livekit-client).
 */
describe("syncPublishPermission", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("never throws when LiveKit credentials aren't configured", async () => {
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_LIVEKIT_URL", "");

    await expect(
      syncPublishPermission({ eventId: "event-1", identity: { type: "profile", id: "profile-1" }, canPublish: true }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("never throws when the target room/participant doesn't exist on a real LiveKit project", async () => {
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.NEXT_PUBLIC_LIVEKIT_URL) {
      return; // no real LiveKit project configured in this environment — nothing to verify against
    }

    await expect(
      syncPublishPermission({
        eventId: "nonexistent-event-does-not-exist",
        identity: { type: "profile", id: "nonexistent-profile" },
        canPublish: true,
      }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("never throws when the LiveKit host itself is unreachable", async () => {
    vi.stubEnv("NEXT_PUBLIC_LIVEKIT_URL", "wss://localhost:1");
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret-at-least-32-bytes-long");

    await expect(
      syncPublishPermission({ eventId: "event-1", identity: { type: "profile", id: "profile-1" }, canPublish: false }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
  });

  it("never throws for a guest identity either (issue #16) — the push mechanism is identity-agnostic", async () => {
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_LIVEKIT_URL", "");

    await expect(
      syncPublishPermission({ eventId: "event-1", identity: { type: "guest", id: "guest-1" }, canPublish: true }),
    ).resolves.toBeUndefined();
    expect(console.error).toHaveBeenCalledOnce();
  });
});
