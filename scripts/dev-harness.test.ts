// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createHarnessEvent,
  getServiceClient,
  listHarnessState,
  parseArgs,
  resetHarness,
  resolveEmail,
  resolveOrCreateProfile,
  seatSpeaker,
} from "./dev-harness.mts";
// Tagging constants/helpers now live in src/lib/dev-demo.ts, shared with
// the /dev page — their own predicate tests live there
// (dev-demo.test.ts), not duplicated here; still imported below since
// the integration tests further down assert against them. resolveEmail
// stays script-specific (only the CLI auto-creates throwaway accounts;
// the /dev page seats the currently-logged-in user instead).
import {
  DEV_EVENT_PREFIX as HARNESS_EVENT_PREFIX,
  DEV_TEST_EMAIL_DOMAIN as HARNESS_EMAIL_DOMAIN,
  isDevEventTitle as isHarnessEventTitle,
  isDevTestEmail as isHarnessTestEmail,
} from "../src/lib/dev-demo.ts";

describe("resolveEmail", () => {
  it("expands a bare label but passes a real email through unchanged", () => {
    expect(resolveEmail("alice")).toBe(`alice${HARNESS_EMAIL_DOMAIN}`);
    expect(resolveEmail("someone@example.com")).toBe("someone@example.com");
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
