// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clearSandbox,
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

  it("reset never deletes the permanent test room (migration 00000000000015) — the whole point of excluding it", async () => {
    const { data: sandboxBefore } = await client.from("events").select("id").eq("is_permanent_test", true).maybeSingle();
    expect(sandboxBefore).not.toBeNull();

    await resetHarness(client);

    const { data: sandboxAfter } = await client.from("events").select("id").eq("is_permanent_test", true).maybeSingle();
    expect(sandboxAfter?.id).toBe(sandboxBefore!.id);
  });

  describe("clear-sandbox (real-device report: stale artifacts from a previous failed run were visibly leaking into a real user's test session)", () => {
    let sandboxId: string;

    // Self-healing precondition, not just setup: this permanent room is
    // shared with real interactive use of the deployed preview (that's
    // the entire reason it exists — Browse Events must never be empty),
    // so it can and does carry leftover state between runs that has
    // nothing to do with this test. Clearing *before* asserting anything
    // means this test can never again be blocked by whatever state
    // happens to already exist — the exact bug this section fixes (the
    // previous version depended on the room already being clean enough
    // to accept a fresh seat-2 insert, which a real interactive session
    // having left an active seat-2 occupant behind could — and did —
    // violate).
    beforeAll(async () => {
      const { data: sandbox, error } = await client.from("events").select("id").eq("is_permanent_test", true).single();
      if (error || !sandbox) throw new Error(error?.message ?? "permanent test room not found");
      sandboxId = sandbox.id;
      await clearSandbox(client);
    }, 30_000);

    async function authoritativeCounts(eventId: string) {
      const [messages, speakers, rounds, heat, requests] = await Promise.all([
        client.from("event_chat_messages").select("id", { count: "exact", head: true }).eq("event_id", eventId),
        client.from("event_speakers").select("id", { count: "exact", head: true }).eq("event_id", eventId),
        client.from("stage_rounds").select("id", { count: "exact", head: true }).eq("event_id", eventId),
        client.from("stage_reaction_heat").select("event_id", { count: "exact", head: true }).eq("event_id", eventId),
        client.from("speaker_requests").select("id", { count: "exact", head: true }).eq("event_id", eventId),
      ]);
      return {
        messages: messages.count ?? 0,
        speakers: speakers.count ?? 0,
        rounds: rounds.count ?? 0,
        reactionHeat: heat.count ?? 0,
        requests: requests.count ?? 0,
      };
    }

    it("starts genuinely blank after the precondition clear — proves the fix, not just the happy path", async () => {
      expect(await authoritativeCounts(sandboxId)).toEqual({ messages: 0, speakers: 0, rounds: 0, reactionHeat: 0, requests: 0 });
    });

    it("removes every table this room's transient state actually spans — messages, reactions, requests, request votes, speakers, round votes, the shared round clock, and reaction heat — not just messages/speakers", async () => {
      // Deterministic fixtures across every table clearSandbox is
      // supposed to reach, wired together the same way real usage would
      // (a request tied to its own message, a vote tied to that request,
      // a round vote tied to the seat) — never depending on whatever
      // random state happens to already exist.
      const { data: message, error: messageError } = await client
        .from("event_chat_messages")
        .insert({
          event_id: sandboxId,
          author_guest_id: crypto.randomUUID(),
          author_display_name: "clear-sandbox test guest",
          body: "deliberately created by this test — clearSandbox must remove it",
          is_speaker_request: true,
        })
        .select("id")
        .single();
      if (messageError || !message) throw new Error(messageError?.message ?? "failed to insert test message");

      const { error: reactionError } = await client
        .from("event_chat_message_reactions")
        .insert({ message_id: message.id, reactor_guest_id: crypto.randomUUID() });
      if (reactionError) throw new Error(reactionError.message);

      const { data: request, error: requestError } = await client
        .from("speaker_requests")
        .insert({ event_id: sandboxId, guest_id: crypto.randomUUID(), message_id: message.id })
        .select("id")
        .single();
      if (requestError || !request) throw new Error(requestError?.message ?? "failed to insert test request");

      const { error: requestVoteError } = await client
        .from("speaker_request_votes")
        .insert({ event_id: sandboxId, voter_guest_id: crypto.randomUUID(), request_id: request.id });
      if (requestVoteError) throw new Error(requestVoteError.message);

      const { data: speaker, error: speakerError } = await client
        .from("event_speakers")
        .insert({ event_id: sandboxId, guest_id: crypto.randomUUID(), seat_number: 2, display_name: "clear-sandbox test guest" })
        .select("id")
        .single();
      if (speakerError || !speaker) throw new Error(speakerError?.message ?? "failed to insert test speaker");

      const { error: roundVoteError } = await client
        .from("speaker_round_votes")
        .insert({ event_speakers_id: speaker.id, voter_guest_id: crypto.randomUUID(), choice: "continue" });
      if (roundVoteError) throw new Error(roundVoteError.message);

      const { error: roundError } = await client
        .from("stage_rounds")
        .insert({ event_id: sandboxId, round_number: 99, phase: "awaiting_pairing" });
      if (roundError) throw new Error(roundError.message);

      const { error: heatError } = await client
        .from("stage_reaction_heat")
        .insert({ event_id: sandboxId, guest_id: crypto.randomUUID(), heat: 80, in_cooldown: false });
      if (heatError) throw new Error(heatError.message);

      // Every table actually has a row now — otherwise this test would
      // prove nothing (a no-op clear "succeeding" against an already-
      // empty room is not the same claim).
      expect(await authoritativeCounts(sandboxId)).toEqual({ messages: 1, speakers: 1, rounds: 1, reactionHeat: 1, requests: 1 });

      const result = await clearSandbox(client);
      expect(result.eventId).toBe(sandboxId);
      expect(result.messagesDeleted).toBeGreaterThan(0);
      expect(result.reactionsDeleted).toBeGreaterThan(0);
      expect(result.requestsDeleted).toBeGreaterThan(0);
      expect(result.requestVotesDeleted).toBeGreaterThan(0);
      expect(result.speakersDeleted).toBeGreaterThan(0);
      expect(result.roundVotesDeleted).toBeGreaterThan(0);
      expect(result.roundsDeleted).toBeGreaterThan(0);
      expect(result.reactionHeatDeleted).toBeGreaterThan(0);

      // Authoritative re-query, not just trusting the returned counts.
      expect(await authoritativeCounts(sandboxId)).toEqual({ messages: 0, speakers: 0, rounds: 0, reactionHeat: 0, requests: 0 });

      // The room itself must still exist — that's the entire point.
      const { data: sandboxStillThere } = await client.from("events").select("id").eq("id", sandboxId).maybeSingle();
      expect(sandboxStillThere?.id).toBe(sandboxId);
    }, 20_000); // ~10 sequential real round trips (seed one fixture per table, clear, re-verify) — comfortably past the 5s default under full-suite contention against the shared project, same reasoning as this file's own beforeAll/afterAll timeouts elsewhere.

    it("running it again against an already-blank room is a safe no-op — never errors, never goes negative", async () => {
      const result = await clearSandbox(client);
      expect(result.eventId).toBe(sandboxId);
      expect(result.messagesDeleted).toBe(0);
      expect(result.speakersDeleted).toBe(0);
      expect(result.roundsDeleted).toBe(0);
      expect(result.reactionHeatDeleted).toBe(0);
    }, 15_000);
  });
});
