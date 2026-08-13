// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDemoEvent, resetDemoEvents, seatMe } from "./actions";

/**
 * Proves the production guard is actually wired into each action, not
 * just that `isDevToolsAvailable()` works in isolation (see
 * lib/dev-demo.test.ts for that). Each action checks the guard as its
 * very first statement, before touching `resolveIdentity()`/cookies() or
 * the database — so stubbing `NODE_ENV=production` and asserting a
 * synchronous rejection is a real test of the wiring, not something that
 * happens to pass because a later step failed first for an unrelated
 * reason (e.g. no request context in this test environment).
 */
describe("dev/actions — production guard", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("createDemoEvent rejects in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const formData = new FormData();
    formData.set("title", "should never be created");
    await expect(createDemoEvent(formData)).rejects.toThrow(/not available in production/);
  });

  it("seatMe rejects in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(seatMe("event-1", 1)).rejects.toThrow(/not available in production/);
  });

  it("resetDemoEvents rejects in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(resetDemoEvents()).rejects.toThrow(/not available in production/);
  });
});
