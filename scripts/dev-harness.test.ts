// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHarnessEvent,
  getServiceClient,
  HARNESS_EMAIL_DOMAIN,
  HARNESS_EVENT_PREFIX,
  isHarnessEventTitle,
  isHarnessTestEmail,
  listHarnessState,
  parseArgs,
  resetHarness,
  resolveEmail,
  resolveOrCreateProfile,
  seatSpeaker,
  timingForPhase,
} from "./dev-harness.mts";

describe("tagging — the actual mechanism reset's safety relies on", () => {
  it("isHarnessEventTitle only matches the harness prefix", () => {
    expect(isHarnessEventTitle("[dev-harness] ready")).toBe(true);
    expect(isHarnessEventTitle("Founders, Unfiltered")).toBe(false);
    // A real title that happens to contain the tag elsewhere must not match.
    expect(isHarnessEventTitle("Not [dev-harness] at the start")).toBe(false);
  });

  it("isHarnessTestEmail only matches the reserved harness domain", () => {
    expect(isHarnessTestEmail("alice@dev-harness.invalid")).toBe(true);
    expect(isHarnessTestEmail("ALICE@DEV-HARNESS.INVALID")).toBe(true);
    expect(isHarnessTestEmail("alice@example.com")).toBe(false);
    // A real address that merely contains the domain as a substring
    // (not a true suffix) must not match.
    expect(isHarnessTestEmail("alice@notdev-harness.invalid.evil.com")).toBe(false);
  });

  it("resolveEmail expands a bare label but passes a real email through unchanged", () => {
    expect(resolveEmail("alice")).toBe(`alice${HARNESS_EMAIL_DOMAIN}`);
    expect(resolveEmail("someone@example.com")).toBe("someone@example.com");
  });
});

describe("timingForPhase", () => {
  const now = new Date("2026-01-01T12:00:00.000Z");

  it("ready: scheduled_start and lobby_opens_at are both already in the past", () => {
    const { scheduled_start, lobby_opens_at } = timingForPhase("ready", now);
    expect(new Date(scheduled_start).getTime()).toBeLessThan(now.getTime());
    expect(new Date(lobby_opens_at).getTime()).toBeLessThan(new Date(scheduled_start).getTime());
  });

  it("lobby_open: lobby has opened but the event hasn't started", () => {
    const { scheduled_start, lobby_opens_at } = timingForPhase("lobby_open", now);
    expect(new Date(lobby_opens_at).getTime()).toBeLessThan(now.getTime());
    expect(new Date(scheduled_start).getTime()).toBeGreaterThan(now.getTime());
  });

  it("upcoming: both timestamps are in the future", () => {
    const { scheduled_start, lobby_opens_at } = timingForPhase("upcoming", now);
    expect(new Date(lobby_opens_at).getTime()).toBeGreaterThan(now.getTime());
    expect(new Date(scheduled_start).getTime()).toBeGreaterThan(now.getTime());
  });
});

describe("parseArgs", () => {
  it("splits flags from positional args", () => {
    expect(parseArgs(["--phase=ready", "my", "title"])).toEqual({
      positional: ["my", "title"],
      flags: { phase: "ready" },
    });
  });

  it("treats a flag with no value as boolean true", () => {
    expect(parseArgs(["--verbose"])).toEqual({ positional: [], flags: { verbose: "true" } });
  });
});

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Proves the actual safety guarantee end to end against the real linked
 * project — same discipline as the app's own integration tests — rather
 * than trusting the tag-matching unit tests above in isolation. Creates
 * one *untagged* "real" event and account alongside harness-tagged ones,
 * runs the real `resetHarness`, and asserts the untagged fixtures survive
 * untouched while the tagged ones are gone. Skips gracefully without
 * SUPABASE_SERVICE_ROLE_KEY, same as every other service-client test.
 */
describe.skipIf(!hasServiceCredentials)("dev harness — end-to-end safety boundary", () => {
  let client: ReturnType<typeof getServiceClient>;
  let realEventId: string;
  let realUserId: string;
  const realEmail = `not-a-harness-account-${crypto.randomUUID()}@example.invalid`;

  beforeAll(async () => {
    client = getServiceClient();

    // A fixture standing in for "real" (non-harness) content the harness
    // must never touch — deliberately NOT created via createHarnessEvent.
    const { data: event, error } = await client
      .from("events")
      .insert({
        title: "Not a dev-harness event — reset must never touch this",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create real-event fixture");
    realEventId = event.id;

    const { data: user, error: userError } = await client.auth.admin.createUser({
      email: realEmail,
      password: `Test-Passw0rd-${crypto.randomUUID()}`,
      email_confirm: true,
      user_metadata: { display_name: "Not a dev-harness account" },
    });
    if (userError || !user.user) throw new Error(userError?.message ?? "failed to create real-account fixture");
    realUserId = user.user.id;
  }, 30_000);

  afterAll(async () => {
    // resetHarness is expected to have left these alone — clean them up
    // ourselves, the same way the app's own tests clean up their fixtures.
    if (realUserId) await client.auth.admin.deleteUser(realUserId);
    if (realEventId) await client.from("events").delete().eq("id", realEventId);
  }, 30_000);

  it("creates a harness event whose title carries the tag", async () => {
    const event = await createHarnessEvent(client, "ready", "safety-boundary-test");
    expect(event.title.startsWith(HARNESS_EVENT_PREFIX)).toBe(true);
  });

  it("seat auto-creates a tagged account and claims the seat", async () => {
    const event = await createHarnessEvent(client, "ready", "seat-test");
    const result = await seatSpeaker(client, "safety-boundary-speaker", 1, event.id);
    expect(result.profile.created).toBe(true);
    expect(isHarnessTestEmail(result.profile.email)).toBe(true);
    expect(result.row.seat_number).toBe(1);
  });

  it("list only reports harness-tagged events", async () => {
    const state = await listHarnessState(client);
    expect(state.every(({ event }) => isHarnessEventTitle(event.title))).toBe(true);
    expect(state.some(({ event }) => event.id === realEventId)).toBe(false);
  });

  it("resolveOrCreateProfile reuses an existing real account instead of duplicating it, and never tags it", async () => {
    const result = await resolveOrCreateProfile(client, realEmail);
    expect(result.id).toBe(realUserId);
    expect(result.created).toBe(false);
  });

  it("reset deletes every harness-tagged event and account, and leaves the untagged fixtures completely untouched", async () => {
    const { eventsDeleted, usersDeleted } = await resetHarness(client);
    expect(eventsDeleted).toBeGreaterThan(0);
    expect(usersDeleted).toBeGreaterThan(0);

    const stateAfter = await listHarnessState(client);
    expect(stateAfter).toEqual([]);

    const { data: realEventStillThere } = await client.from("events").select("id").eq("id", realEventId).maybeSingle();
    expect(realEventStillThere?.id).toBe(realEventId);

    const { data: usersAfter } = await client.auth.admin.listUsers({ perPage: 1000 });
    expect(usersAfter.users.some((u) => u.id === realUserId)).toBe(true);
  });
});
