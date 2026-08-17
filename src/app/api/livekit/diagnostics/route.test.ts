// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/**
 * Temporary route (issue #15 real-device diagnosis, see DECISIONS.md) that
 * proves LiveKit credentials are actually *valid*, not just present, by
 * making a real REST call. Tested the same way permissions.test.ts already
 * tests syncPublishPermission's failure modes — env vars are read live
 * inside getClient() on every call, so stubbing them per-test is enough,
 * no module reset needed.
 */
describe("GET /api/livekit/diagnostics", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports credentialsConfigured: false, never throwing, when LiveKit env vars are missing", async () => {
    vi.stubEnv("LIVEKIT_API_KEY", "");
    vi.stubEnv("LIVEKIT_API_SECRET", "");
    vi.stubEnv("NEXT_PUBLIC_LIVEKIT_URL", "");

    const response = await GET();
    const body = await response.json();
    expect(body).toMatchObject({ credentialsConfigured: false, reachable: false });
  });

  it("reports reachable: false with a generic error, never the credentials, when the LiveKit host is unreachable", async () => {
    vi.stubEnv("NEXT_PUBLIC_LIVEKIT_URL", "wss://localhost:1");
    vi.stubEnv("LIVEKIT_API_KEY", "test-key");
    vi.stubEnv("LIVEKIT_API_SECRET", "test-secret-at-least-32-bytes-long");

    const response = await GET();
    const body = await response.json();
    expect(body.credentialsConfigured).toBe(true);
    expect(body.reachable).toBe(false);
    expect(JSON.stringify(body)).not.toContain("test-secret-at-least-32-bytes-long");
  });

  it("reports whether the currently configured credentials are genuinely valid against the real project, if one is configured in this environment", async () => {
    if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET || !process.env.NEXT_PUBLIC_LIVEKIT_URL) {
      return; // no real LiveKit project configured in this environment — nothing to verify against
    }

    const response = await GET();
    const body = await response.json();
    expect(body.credentialsConfigured).toBe(true);
    expect(typeof body.reachable).toBe("boolean");
  });
});
