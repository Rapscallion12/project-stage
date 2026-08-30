// @vitest-environment node
import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "@/types/database";
import { createServiceClient } from "@/lib/supabase/service";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Integration tests for issue #21 Phase 1's voting/selection write path,
 * against the real linked Supabase project — same discipline as
 * speaker-requests.test.ts. Tests run in sequence and build on shared
 * fixture state; see each test's comment for what it assumes going in.
 */
describe.skipIf(!hasServiceCredentials)("speaker request voting + selection (issue #21, Phase 1)", () => {
  let service: ReturnType<typeof createServiceClient>;
  const anonUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

  let eventId: string;
  const testUserIds: string[] = [];
  const profiles: Record<"a" | "b" | "c" | "d" | "e", { id: string; email: string; password: string }> =
    {} as never;

  async function createTestProfile(label: "a" | "b" | "c" | "d" | "e") {
    const email = `test-voter-${label}-${crypto.randomUUID()}@example.invalid`;
    const password = `Test-Passw0rd-${crypto.randomUUID()}`;
    const { data, error } = await service.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: `Test Voter ${label.toUpperCase()}` },
    });
    if (error || !data.user) throw new Error(error?.message ?? `failed to create test profile ${label}`);
    testUserIds.push(data.user.id);
    profiles[label] = { id: data.user.id, email, password };
  }

  async function signInAs(label: "a" | "b" | "c" | "d" | "e") {
    const { email, password } = profiles[label];
    const anon = createSupabaseClient(anonUrl, anonKey);
    const { data, error } = await anon.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw new Error(error?.message ?? `failed to sign in as ${label}`);
    return createSupabaseClient<Database>(anonUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${data.session.access_token}` } },
    });
  }

  async function requestFor(label: "a" | "b" | "c" | "d" | "e") {
    const { data } = await service
      .from("speaker_requests")
      .select("*")
      .eq("event_id", eventId)
      .eq("profile_id", profiles[label].id)
      .eq("status", "pending")
      .maybeSingle();
    return data;
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 Phase 1 voting test fixture event",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;

    await createTestProfile("a");
    await createTestProfile("b");
    await createTestProfile("c");
    await createTestProfile("d");
    await createTestProfile("e");
  }, 30_000);

  afterAll(async () => {
    for (const id of testUserIds) {
      await service.auth.admin.deleteUser(id);
    }
    if (eventId) {
      await service.from("events").delete().eq("id", eventId);
    }
  }, 30_000);

  describe("cast_speaker_request_vote — one vote per viewer, transferable, toggle-off", () => {
    let messageA: string;
    let messageB: string;

    beforeAll(async () => {
      const asA = await signInAs("a");
      const asB = await signInAs("b");
      const { data: reqA } = await asA.rpc("request_to_speak", { p_event_id: eventId, p_body: "a's pitch" });
      const { data: reqB } = await asB.rpc("request_to_speak", { p_event_id: eventId, p_body: "b's pitch" });
      messageA = reqA![0].message_id;
      messageB = reqB![0].message_id;
    });

    it("a viewer's vote is recorded and counted", async () => {
      const asC = await signInAs("c");
      const { data, error } = await asC.rpc("cast_speaker_request_vote", {
        p_event_id: eventId,
        p_message_id: messageA,
      });
      expect(error).toBeNull();
      const requestA = await requestFor("a");
      expect(data?.[0]?.voted_request_id).toBe(requestA!.id);

      const { count } = await service
        .from("speaker_request_votes")
        .select("*", { count: "exact", head: true })
        .eq("request_id", requestA!.id);
      expect(count).toBe(1);
    });

    it("voting for a different request transfers the vote — the previous one no longer counts", async () => {
      const asC = await signInAs("c");
      await asC.rpc("cast_speaker_request_vote", { p_event_id: eventId, p_message_id: messageB });

      const requestA = await requestFor("a");
      const requestB = await requestFor("b");
      const { count: countA } = await service
        .from("speaker_request_votes")
        .select("*", { count: "exact", head: true })
        .eq("request_id", requestA!.id);
      const { count: countB } = await service
        .from("speaker_request_votes")
        .select("*", { count: "exact", head: true })
        .eq("request_id", requestB!.id);
      expect(countA).toBe(0);
      expect(countB).toBe(1);
    });

    it("re-voting for the currently-selected request toggles the vote off entirely", async () => {
      const asC = await signInAs("c");
      const { data } = await asC.rpc("cast_speaker_request_vote", {
        p_event_id: eventId,
        p_message_id: messageB,
      });
      expect(data?.[0]?.voted_request_id).toBeNull();

      const requestB = await requestFor("b");
      const { count } = await service
        .from("speaker_request_votes")
        .select("*", { count: "exact", head: true })
        .eq("request_id", requestB!.id);
      expect(count).toBe(0);
    });

    it("ordinary comment likes (event_chat_message_reactions) remain completely independent of request votes", async () => {
      // An ordinary reaction on the SAME request message, via the
      // existing, untouched reactions mechanism.
      await service.from("event_chat_message_reactions").insert({
        message_id: messageA,
        reactor_profile_id: profiles.d.id,
        emoji: "👍",
      });
      // Casting a vote (a completely separate table/mechanism) still
      // works normally and doesn't collide with the reaction.
      const asC = await signInAs("c");
      const { error } = await asC.rpc("cast_speaker_request_vote", {
        p_event_id: eventId,
        p_message_id: messageA,
      });
      expect(error).toBeNull();

      const { count: reactionCount } = await service
        .from("event_chat_message_reactions")
        .select("*", { count: "exact", head: true })
        .eq("message_id", messageA);
      expect(reactionCount).toBe(1);
    });
  });

  describe("freeze_speaker_candidates + set_current_speaker_candidate", () => {
    it("ranks by vote count desc and freezes at most 3 into a new round", async () => {
      // From the previous describe block: a has 1 vote (from c), b has 0.
      // Add a third and fourth candidate so there are 4 pending total —
      // only the top 3 by vote count should freeze.
      const asE = await signInAs("e");
      await asE.rpc("request_to_speak", { p_event_id: eventId, p_body: "e's pitch, no votes" });

      const { data: candidates, error } = await service.rpc("freeze_speaker_candidates", {
        p_event_id: eventId,
      });
      expect(error).toBeNull();
      expect(candidates!.length).toBeLessThanOrEqual(3);

      const requestA = await requestFor("a");
      expect(candidates!.find((c) => c.request_id === requestA!.id)?.rank).toBe(1);
      expect(candidates!.find((c) => c.request_id === requestA!.id)?.vote_count).toBe(1);
    });

    it("calling it again while a round is already active is a safe no-op — returns the same round's candidates instead of erroring", async () => {
      const { data: firstCall } = await service.rpc("freeze_speaker_candidates", { p_event_id: eventId });
      const { data: secondCall, error } = await service.rpc("freeze_speaker_candidates", {
        p_event_id: eventId,
      });
      expect(error).toBeNull();
      expect(secondCall!.map((c) => c.request_id).sort()).toEqual(firstCall!.map((c) => c.request_id).sort());
      expect(secondCall![0]?.round_id).toBe(firstCall![0]?.round_id);

      const { data: activeRounds } = await service
        .from("speaker_selection_rounds")
        .select("*")
        .eq("event_id", eventId)
        .eq("status", "active");
      expect(activeRounds).toHaveLength(1);
    });

    it("commits a weighted-random pick as the current candidate", async () => {
      const { data: rounds } = await service
        .from("speaker_selection_rounds")
        .select("*")
        .eq("event_id", eventId)
        .eq("status", "active")
        .maybeSingle();
      expect(rounds).not.toBeNull();

      const requestA = await requestFor("a");
      const { error } = await service.rpc("set_current_speaker_candidate", {
        p_round_id: rounds!.id,
        p_request_id: requestA!.id,
        // Issue #21, fifth corrective pass: now seat-aware — no seat is
        // actually occupied in this test's own flow, so the specific
        // number is arbitrary; it only needs to be a valid seat.
        p_seat_number: 1,
      });
      expect(error).toBeNull();

      const { data: updated } = await service.from("speaker_requests").select("*").eq("id", requestA!.id).single();
      expect(updated?.is_current_candidate).toBe(true);
    });
  });

  describe("withdrawal of the current candidate advances to the next runner-up", () => {
    it("marks the withdrawn candidate failed and promotes the next-ranked candidate", async () => {
      const asA = await signInAs("a");
      const { error } = await asA.rpc("withdraw_speaker_request", { p_event_id: eventId });
      expect(error).toBeNull();

      const { data: withdrawn } = await service
        .from("speaker_requests")
        .select("*")
        .eq("event_id", eventId)
        .eq("profile_id", profiles.a.id)
        .eq("status", "withdrawn")
        .order("resolved_at", { ascending: false })
        .limit(1)
        .single();
      expect(withdrawn?.selection_failed).toBe(true);
      expect(withdrawn?.is_current_candidate).toBe(false);
      expect(withdrawn?.selection_round_id).not.toBeNull();

      const { data: newCurrent } = await service
        .from("speaker_requests")
        .select("*")
        .eq("selection_round_id", withdrawn!.selection_round_id!)
        .eq("is_current_candidate", true)
        .maybeSingle();
      expect(newCurrent).not.toBeNull();
      expect(newCurrent!.id).not.toBe(withdrawn!.id);
    });
  });

  describe("reset_speaker_candidate_pool — Section E's authoritative bulk reset", () => {
    it("expires every other pending request and clears all votes, leaving only the winner", async () => {
      const winning = await requestFor("b");
      // b should still be pending (never selected/withdrawn in this flow).
      expect(winning).not.toBeNull();

      // Mirrors claimOpenSeat's real sequence: markSpeakerRequestGranted
      // always runs before resetSpeakerCandidatePool — the winner's own
      // request is 'granted', not 'pending', by the time reset runs.
      await service
        .from("speaker_requests")
        .update({ status: "granted", resolved_at: new Date().toISOString() })
        .eq("id", winning!.id);

      const { error } = await service.rpc("reset_speaker_candidate_pool", {
        p_event_id: eventId,
        p_winning_request_id: winning!.id,
      });
      expect(error).toBeNull();

      const { data: stillPending } = await service
        .from("speaker_requests")
        .select("*")
        .eq("event_id", eventId)
        .eq("status", "pending");
      expect(stillPending).toEqual([]);

      const { data: winnerRow } = await service
        .from("speaker_requests")
        .select("*")
        .eq("id", winning!.id)
        .single();
      expect(winnerRow?.status).toBe("granted");

      const { data: expired } = await service
        .from("speaker_requests")
        .select("*")
        .eq("event_id", eventId)
        .eq("status", "expired");
      expect(expired!.length).toBeGreaterThan(0);
      expect(expired!.every((r) => r.id !== winning!.id)).toBe(true);

      const { count: remainingVotes } = await service
        .from("speaker_request_votes")
        .select("*", { count: "exact", head: true })
        .eq("event_id", eventId);
      expect(remainingVotes).toBe(0);

      const { data: activeRounds } = await service
        .from("speaker_selection_rounds")
        .select("*")
        .eq("event_id", eventId)
        .eq("status", "active");
      expect(activeRounds).toEqual([]);
    });

    it("the former winner can submit a new request immediately after reset (no cooldown)", async () => {
      const asB = await signInAs("b");
      const { error } = await asB.rpc("request_to_speak", { p_event_id: eventId, p_body: "b again, right away" });
      expect(error).toBeNull();
    });
  });

  it("cast_speaker_request_vote_as_guest and freeze_speaker_candidates are not callable by an ordinary authenticated user", async () => {
    const asC = await signInAs("c");
    const { error: guestVoteError } = await asC.rpc("cast_speaker_request_vote_as_guest", {
      p_event_id: eventId,
      p_message_id: "00000000-0000-0000-0000-000000000000",
      p_guest_id: "00000000-0000-0000-0000-000000000000",
    });
    expect(guestVoteError?.code).toBe("42501");

    const { error: freezeError } = await asC.rpc("freeze_speaker_candidates", { p_event_id: eventId });
    expect(freezeError?.code).toBe("42501");
  });
});
