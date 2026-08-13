import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEV_EVENT_PREFIX,
  DEV_TEST_EMAIL_DOMAIN,
  devTimingForPhase,
  isDevEventTitle,
  isDevTestEmail,
  isDevToolsAvailable,
} from "./dev-demo";

describe("tagging — the actual mechanism both dev-demo.mts's `reset` and /dev's rely on", () => {
  it("isDevEventTitle only matches the tag prefix", () => {
    expect(isDevEventTitle(`${DEV_EVENT_PREFIX}ready`)).toBe(true);
    expect(isDevEventTitle("Founders, Unfiltered")).toBe(false);
    // A real title that happens to contain the tag elsewhere must not match.
    expect(isDevEventTitle(`Not ${DEV_EVENT_PREFIX}at the start`)).toBe(false);
  });

  it("isDevTestEmail only matches the reserved test domain", () => {
    expect(isDevTestEmail(`alice${DEV_TEST_EMAIL_DOMAIN}`)).toBe(true);
    expect(isDevTestEmail(`ALICE${DEV_TEST_EMAIL_DOMAIN}`.toUpperCase())).toBe(true);
    expect(isDevTestEmail("alice@example.com")).toBe(false);
    // A real address that merely contains the domain as a substring
    // (not a true suffix) must not match.
    expect(isDevTestEmail("alice@notdev-harness.invalid.evil.com")).toBe(false);
  });
});

describe("devTimingForPhase", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("ready: scheduled_start and lobby_opens_at are both already in the past", () => {
    const { scheduled_start, lobby_opens_at } = devTimingForPhase("ready", now);
    expect(new Date(scheduled_start).getTime()).toBeLessThan(now.getTime());
    expect(new Date(lobby_opens_at).getTime()).toBeLessThan(new Date(scheduled_start).getTime());
  });

  it("lobby_open: lobby has opened but the event hasn't started", () => {
    const { scheduled_start, lobby_opens_at } = devTimingForPhase("lobby_open", now);
    expect(new Date(lobby_opens_at).getTime()).toBeLessThan(now.getTime());
    expect(new Date(scheduled_start).getTime()).toBeGreaterThan(now.getTime());
  });

  it("upcoming: both timestamps are in the future", () => {
    const { scheduled_start, lobby_opens_at } = devTimingForPhase("upcoming", now);
    expect(new Date(lobby_opens_at).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(scheduled_start).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("isDevToolsAvailable — the production guard the /dev page and its Server Actions both depend on", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false when NODE_ENV is production — the /dev page must be inert here", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isDevToolsAvailable()).toBe(false);
  });

  it("is true in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isDevToolsAvailable()).toBe(true);
  });

  it("is true in test (this suite's own environment)", () => {
    vi.stubEnv("NODE_ENV", "test");
    expect(isDevToolsAvailable()).toBe(true);
  });
});
