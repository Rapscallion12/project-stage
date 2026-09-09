// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateWithdrawRequest,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceStageRoundDeadline,
  forceSeatClosingDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
  clearTestRoomSandbox,
} from "./simulator-actions";
import { createServiceClient } from "@/lib/supabase/service";
import { requestToSpeakAsGuest, castSpeakerRequestVoteAsGuest } from "@/lib/repositories/speaker-requests";
import { claimSpeakerSeat, castSpeakerRoundVoteAsGuest, endSpeakerSeat } from "@/lib/repositories/event-speakers";
import { recordStageReactionAttempt } from "@/lib/repositories/stage-reactions";

/**
 * Issue #21, Part 5: the gate itself — every simulator action must
 * refuse before touching the database when `VERCEL_ENV === "production"`.
 * This is testable with no real Supabase credentials at all: the check
 * throws synchronously before any repository/RPC call is even reached.
 */
describe("simulator-actions (issue #21, Part 5) — refuse to run on production", () => {
  const original = process.env.VERCEL_ENV;

  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = original;
    vi.restoreAllMocks();
  });

  it("simulateComment throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateComment("e1", "g1", "Fake Fox", "hi")).rejects.toThrow(/not available/);
  });

  it("simulateLike throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateLike("m1", "g1")).rejects.toThrow(/not available/);
  });

  it("simulateRequestToSpeak throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateRequestToSpeak("e1", "g1", "Fake Fox", "let me speak")).rejects.toThrow(/not available/);
  });

  it("simulateRequestVote throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateRequestVote("e1", "m1", "g1")).rejects.toThrow(/not available/);
  });

  it("simulateWithdrawRequest throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateWithdrawRequest("e1", "g1")).rejects.toThrow(/not available/);
  });

  it("simulateRoundVote throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateRoundVote("s1", "continue", "g1")).rejects.toThrow(/not available/);
  });

  it("simulateSeedSpeaker throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateSeedSpeaker("e1", "g1", "Fake Fox", 1)).rejects.toThrow(/not available/);
  });

  it("simulateOpenSeat throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateOpenSeat("e1", "g1")).rejects.toThrow(/not available/);
  });

  it("forceStageRoundDeadline throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(forceStageRoundDeadline("e1")).rejects.toThrow(/not available/);
  });

  it("forceSeatClosingDeadline throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(forceSeatClosingDeadline("s1")).rejects.toThrow(/not available/);
  });

  it("simulateAdvanceSelection throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateAdvanceSelection("e1", ["g1"], { g1: "Fake Fox" })).rejects.toThrow(/not available/);
  });

  it("resetSimulatorSession throws on production, even with a non-empty guest id list", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(resetSimulatorSession("e1", ["g1", "g2"])).rejects.toThrow(/not available/);
  });

  it("clearTestRoomSandbox throws on production, before ever checking is_permanent_test", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(clearTestRoomSandbox("e1")).rejects.toThrow(/not available/);
  });

  it("is available (does not throw the gate error) on a preview deployment — reaches real I/O, which then fails without credentials, proving the gate itself passed", async () => {
    process.env.VERCEL_ENV = "preview";
    // No Supabase credentials configured for this bare node test, so the
    // underlying call fails downstream — the point is that it's *not*
    // the "not available" gate error, proving the gate itself let it
    // through.
    await expect(simulateComment("e1", "g1", "Fake Fox", "hi")).rejects.not.toThrow(/not available/);
  });

  it("resetSimulatorSession on preview with an empty guest id list returns zero counts without touching the database at all", async () => {
    process.env.VERCEL_ENV = "preview";
    // No Supabase credentials configured for this bare node test — if this
    // reached real I/O it would throw. It doesn't, because the empty-list
    // early return happens before any Supabase call, proving that path.
    await expect(resetSimulatorSession("e1", [])).resolves.toEqual({
      messagesDeleted: 0,
      reactionsDeleted: 0,
      speakersDeleted: 0,
      requestVotesDeleted: 0,
      roundVotesDeleted: 0,
      stageReactionHeatDeleted: 0,
    });
  });
});

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Real-database safety tests — this is the actual load-bearing claim of
 * the whole feature ("do not delete real user-generated room activity"),
 * so it gets full-path coverage against the real linked Supabase project
 * rather than resting entirely on component mocks, matching this
 * project's stated preference for reset behavior specifically. Every
 * test pairs a "simulated" guest id (passed to resetSimulatorSession)
 * with a "real" one (not passed) — deliberately the same *shape* (both
 * bare crypto.randomUUID() guest ids), since that's the whole point:
 * the safety guarantee comes from the exact id list, not from any
 * property that would let you tell them apart structurally.
 */
describe.skipIf(!hasServiceCredentials)("resetSimulatorSession (real database) — deletes only simulator-owned rows", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;
  const originalVercelEnv = process.env.VERCEL_ENV;

  beforeAll(async () => {
    process.env.VERCEL_ENV = "preview";
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Session Simulator reset test fixture event",
        scheduled_start: new Date(Date.now() - 60_000).toISOString(),
        lobby_opens_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;
  }, 30_000);

  afterAll(async () => {
    if (eventId) {
      await service.from("events").delete().eq("id", eventId);
    }
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }, 30_000);

  // Fixture setup only — `insertMessage`/`insertReaction` (lib/repositories/chat.ts)
  // use the request-scoped `createClient()` (calls Next's `cookies()`),
  // which has no meaning in a bare Vitest node test. Inserted directly via
  // the service client instead, same as every other fixture row in this
  // describe block.
  async function insertTestMessage(guestId: string, displayName: string, body: string): Promise<string> {
    const { data, error } = await service
      .from("event_chat_messages")
      .insert({ event_id: eventId, author_guest_id: guestId, author_display_name: displayName, body })
      .select("id")
      .single();
    if (error || !data) throw new Error(error?.message ?? "failed to insert test message");
    return data.id;
  }

  async function insertTestReaction(messageId: string, guestId: string): Promise<void> {
    const { error } = await service
      .from("event_chat_message_reactions")
      .insert({ message_id: messageId, reactor_guest_id: guestId, emoji: "👍" });
    if (error) throw new Error(error.message);
  }

  it("deletes a simulated comment, keeps a real one, and reports an accurate count", async () => {
    const simGuestId = crypto.randomUUID();
    const realGuestId = crypto.randomUUID();
    await insertTestMessage(simGuestId, "Fake Fox", "simulated comment");
    await insertTestMessage(realGuestId, "Real Person", "real comment");

    const result = await resetSimulatorSession(eventId, [simGuestId]);
    expect(result.messagesDeleted).toBe(1);

    const { data: messages } = await service.from("event_chat_messages").select("author_guest_id, body").eq("event_id", eventId);
    const bodies = messages!.map((m) => m.body);
    expect(bodies).not.toContain("simulated comment");
    expect(bodies).toContain("real comment");
  });

  it("deletes a simulated like on a real comment, keeps a real like on that same comment", async () => {
    const realAuthorGuestId = crypto.randomUUID();
    const messageId = await insertTestMessage(realAuthorGuestId, "Real Person", "likeable");

    const simLikerGuestId = crypto.randomUUID();
    const realLikerGuestId = crypto.randomUUID();
    await insertTestReaction(messageId, simLikerGuestId);
    await insertTestReaction(messageId, realLikerGuestId);

    const result = await resetSimulatorSession(eventId, [simLikerGuestId]);
    expect(result.reactionsDeleted).toBe(1);

    const { data: reactions } = await service.from("event_chat_message_reactions").select("reactor_guest_id").eq("message_id", messageId);
    const reactorIds = reactions!.map((r) => r.reactor_guest_id);
    expect(reactorIds).not.toContain(simLikerGuestId);
    expect(reactorIds).toContain(realLikerGuestId);
  });

  it("deleting a simulated comment cascades away even a real user's like on it — the content itself is gone", async () => {
    const simAuthorGuestId = crypto.randomUUID();
    const realLikerGuestId = crypto.randomUUID();
    const messageId = await insertTestMessage(simAuthorGuestId, "Fake Fox", "simulated, will cascade");
    await insertTestReaction(messageId, realLikerGuestId);

    await resetSimulatorSession(eventId, [simAuthorGuestId]);

    const { data: remainingMessage } = await service.from("event_chat_messages").select("id").eq("id", messageId).maybeSingle();
    expect(remainingMessage).toBeNull();
    const { data: remainingReactions } = await service.from("event_chat_message_reactions").select("id").eq("message_id", messageId);
    expect(remainingReactions).toEqual([]);
  });

  it("deletes a simulated identity's stage-reaction heat row, keeps a real identity's row (pre-launch interaction pass)", async () => {
    const simGuestId = crypto.randomUUID();
    const realGuestId = crypto.randomUUID();
    await recordStageReactionAttempt(eventId, { type: "guest", id: simGuestId });
    await recordStageReactionAttempt(eventId, { type: "guest", id: realGuestId });

    const result = await resetSimulatorSession(eventId, [simGuestId]);
    expect(result.stageReactionHeatDeleted).toBe(1);

    const { data: remainingSim } = await service.from("stage_reaction_heat").select("guest_id").eq("event_id", eventId).eq("guest_id", simGuestId).maybeSingle();
    expect(remainingSim).toBeNull();
    const { data: remainingReal } = await service.from("stage_reaction_heat").select("guest_id").eq("event_id", eventId).eq("guest_id", realGuestId).maybeSingle();
    expect(remainingReal).not.toBeNull();

    await service.from("stage_reaction_heat").delete().eq("event_id", eventId).eq("guest_id", realGuestId);
  });

  it("deletes a simulated speaker seat and cascades its round votes, keeps a real seat and real votes on it untouched", async () => {
    const simSeatGuestId = crypto.randomUUID();
    const realSeatGuestId = crypto.randomUUID();
    const simSeat = await claimSpeakerSeat(eventId, { type: "guest", id: simSeatGuestId }, 1, "Fake Fox");
    const realSeat = await claimSpeakerSeat(eventId, { type: "guest", id: realSeatGuestId }, 2, "Real Person");

    // A real voter's vote on the FAKE seat's round — meaningless once that
    // round is gone, expected to cascade away with the seat.
    const realVoterOnSimSeat = crypto.randomUUID();
    await castSpeakerRoundVoteAsGuest(simSeat.id, "continue", realVoterOnSimSeat);
    // A simulated voter's vote on the REAL seat's round — must be removed
    // explicitly (nothing about the real seat itself is being deleted).
    const simVoterOnRealSeat = crypto.randomUUID();
    await castSpeakerRoundVoteAsGuest(realSeat.id, "replace", simVoterOnRealSeat);

    try {
      const result = await resetSimulatorSession(eventId, [simSeatGuestId, simVoterOnRealSeat]);
      expect(result.speakersDeleted).toBe(1);
      expect(result.roundVotesDeleted).toBeGreaterThanOrEqual(1);

      const { data: remainingSimSeat } = await service.from("event_speakers").select("id").eq("id", simSeat.id).maybeSingle();
      expect(remainingSimSeat).toBeNull();

      const { data: remainingRealSeat } = await service.from("event_speakers").select("id").eq("id", realSeat.id).maybeSingle();
      expect(remainingRealSeat).not.toBeNull();

      const { data: remainingVotesOnReal } = await service
        .from("speaker_round_votes")
        .select("voter_guest_id")
        .eq("event_speakers_id", realSeat.id);
      expect((remainingVotesOnReal ?? []).map((v) => v.voter_guest_id)).not.toContain(simVoterOnRealSeat);
    } finally {
      // Free both seats so later tests in this file don't collide with them.
      await endSpeakerSeat(eventId, { type: "guest", id: realSeatGuestId }, "moderator_removed");
    }
  });

  it("deletes a simulated speaker request (message + votes) via cascade, keeps a real pending request and real votes on it", async () => {
    const simRequesterGuestId = crypto.randomUUID();
    const realRequesterGuestId = crypto.randomUUID();
    const { requestId: simRequestId, messageId: simMessageId } = await requestToSpeakAsGuest(
      eventId,
      simRequesterGuestId,
      "Fake Fox",
      "let me speak (sim)",
    );
    const { requestId: realRequestId, messageId: realMessageId } = await requestToSpeakAsGuest(
      eventId,
      realRequesterGuestId,
      "Real Person",
      "let me speak (real)",
    );

    // A real voter's vote on the simulated request — cascades away with it.
    const realVoterOnSimRequest = crypto.randomUUID();
    await castSpeakerRequestVoteAsGuest(eventId, simMessageId, realVoterOnSimRequest);
    // A simulated voter's vote on the real request — removed explicitly.
    const simVoterOnRealRequest = crypto.randomUUID();
    await castSpeakerRequestVoteAsGuest(eventId, realMessageId, simVoterOnRealRequest);

    try {
      const result = await resetSimulatorSession(eventId, [simRequesterGuestId, simVoterOnRealRequest]);
      expect(result.messagesDeleted).toBe(1);
      expect(result.requestVotesDeleted).toBeGreaterThanOrEqual(1);

      const { data: remainingSimRequest } = await service.from("speaker_requests").select("id").eq("id", simRequestId).maybeSingle();
      expect(remainingSimRequest).toBeNull();

      const { data: remainingRealRequest } = await service.from("speaker_requests").select("id").eq("id", realRequestId).maybeSingle();
      expect(remainingRealRequest).not.toBeNull();

      const { data: remainingVotesOnReal } = await service
        .from("speaker_request_votes")
        .select("voter_guest_id")
        .eq("request_id", realRequestId);
      expect((remainingVotesOnReal ?? []).map((v) => v.voter_guest_id)).not.toContain(simVoterOnRealRequest);
    } finally {
      await service
        .from("speaker_requests")
        .update({ status: "withdrawn", resolved_at: new Date().toISOString() })
        .eq("id", realRequestId);
    }
  });

  it("issue #21 second corrective pass: deletes the shared stage_rounds row when Reset leaves zero seats occupied, so the next pairing starts fresh at Round 1", async () => {
    const simGuestA = crypto.randomUUID();
    const simGuestB = crypto.randomUUID();
    const seatA = await claimSpeakerSeat(eventId, { type: "guest", id: simGuestA }, 1, "Sim A");
    const seatB = await claimSpeakerSeat(eventId, { type: "guest", id: simGuestB }, 2, "Sim B");

    const { data: roundBefore } = await service.from("stage_rounds").select("*").eq("event_id", eventId).maybeSingle();
    expect(roundBefore?.phase).toBe("active");

    await resetSimulatorSession(eventId, [simGuestA, simGuestB]);

    const { data: roundAfter } = await service.from("stage_rounds").select("*").eq("event_id", eventId).maybeSingle();
    expect(roundAfter).toBeNull();

    const { data: remainingSeats } = await service.from("event_speakers").select("id").in("id", [seatA.id, seatB.id]).is("left_at", null);
    expect(remainingSeats).toEqual([]);

    // The next pairing genuinely starts fresh — round_number 1, not a
    // stale counter continuing from before the reset.
    const freshA = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Fresh A");
    const freshB = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Fresh B");
    try {
      const { data: freshRound } = await service.from("stage_rounds").select("round_number, phase").eq("event_id", eventId).single();
      expect(freshRound!.round_number).toBe(1);
      expect(freshRound!.phase).toBe("active");
    } finally {
      await endSpeakerSeat(eventId, { type: "guest", id: freshA.guest_id! }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: freshB.guest_id! }, "moderator_removed");
    }
  });

  it("resyncs (never deletes) the shared stage_rounds row when a real speaker is still seated after Reset — real state is untouched, never destroyed", async () => {
    const realGuestId = crypto.randomUUID();
    const simGuestId = crypto.randomUUID();
    // Bypasses selection authorization (issue #21, third corrective
    // pass) — this shared event may already be "established" from an
    // earlier test in this file, which is irrelevant to what's under
    // test here (Reset's own stage_rounds handling).
    const realSeat = await claimSpeakerSeat(eventId, { type: "guest", id: realGuestId }, 1, "Real Speaker", true);
    await claimSpeakerSeat(eventId, { type: "guest", id: simGuestId }, 2, "Sim Speaker", true);

    try {
      await resetSimulatorSession(eventId, [simGuestId]);

      const { data: roundAfter } = await service.from("stage_rounds").select("*").eq("event_id", eventId).maybeSingle();
      expect(roundAfter).not.toBeNull();
      expect(roundAfter!.phase).toBe("awaiting_pairing"); // one real seat alone can't sustain an active shared round

      const { data: realSeatAfter } = await service.from("event_speakers").select("id, left_at").eq("id", realSeat.id).single();
      expect(realSeatAfter!.left_at).toBeNull(); // completely untouched
    } finally {
      await endSpeakerSeat(eventId, { type: "guest", id: realGuestId }, "moderator_removed");
    }
  });

  /**
   * Issue #21, fourteenth corrective pass: "Can the delayed Reset cleanup
   * sweep delete state belonging to a newly started simulation?" — the
   * guest-scoped deletes above were always exact (a fresh run's guest
   * ids are freshly random UUIDs, provably unable to collide with an old
   * run's captured list), but `resetSimulatorSession`'s own
   * `stage_rounds` reconciliation decided purely from the event's
   * *current, global* occupancy at the instant it ran — with no
   * guest-id scoping at all. `reconcileStageRound: false` is what the
   * panel's own delayed follow-up sweep now passes, specifically so it
   * can never make that shared-state decision a second time. These two
   * tests reproduce the exact mechanism directly against the real
   * database — not a hypothetical — proving both that the danger was
   * real and that the fix closes it.
   */
  describe("reconcileStageRound (the delayed follow-up sweep's own fix)", () => {
    // Both tests below insert a `stage_rounds` row *directly* — standing
    // in for one that legitimately exists at zero occupancy (e.g. the
    // brief instant `ensure_stage_round` creates it as part of a claim
    // that's still completing, or between a new run's first and second
    // seat claims where a transient failure mid-retry has momentarily
    // dropped occupancy back to zero — see `establishSeat`'s own
    // leftover-seat self-heal). Deterministic and instant, rather than
    // racing real claim timing, because the actual mechanism under test
    // is `resetSimulatorSession`'s own *unscoped* stage_rounds decision,
    // not any specific sequence that produces zero occupancy.
    it("reconcileStageRound: false never touches an existing stage_rounds row, even when occupancy happens to be zero at that instant", async () => {
      const oldGuestA = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: oldGuestA }, 1, "Old A", true);
      await resetSimulatorSession(eventId, [oldGuestA]); // primary pass: occupancy 0, real deletion (unchanged, correct)

      const { error: insertError } = await service
        .from("stage_rounds")
        .insert({ event_id: eventId, round_number: 1, phase: "awaiting_pairing" });
      if (insertError) throw new Error(insertError.message);

      await resetSimulatorSession(eventId, [oldGuestA], false);

      const { data: roundAfter } = await service.from("stage_rounds").select("round_number, phase").eq("event_id", eventId).maybeSingle();
      expect(roundAfter).not.toBeNull();
      expect(roundAfter!.round_number).toBe(1);
      expect(roundAfter!.phase).toBe("awaiting_pairing");
    });

    it("proves the danger was real: reconcileStageRound: true deletes an existing stage_rounds row purely because occupancy is zero at that instant — regardless of whose row it is or when it was created", async () => {
      const oldGuestA = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: oldGuestA }, 1, "Old A", true);
      await resetSimulatorSession(eventId, [oldGuestA]);

      const { error: insertError } = await service
        .from("stage_rounds")
        .insert({ event_id: eventId, round_number: 1, phase: "awaiting_pairing" });
      if (insertError) throw new Error(insertError.message);

      // The pre-fix shape: the follow-up sweep reconciling stage_rounds
      // (default true) purely from current global occupancy, with no
      // idea this row belongs to something entirely unrelated to
      // `oldGuestA`.
      await resetSimulatorSession(eventId, [oldGuestA], true);

      const { data: roundAfter } = await service.from("stage_rounds").select("id").eq("event_id", eventId).maybeSingle();
      expect(roundAfter).toBeNull(); // the bug this pass fixed
    });
  });
});

/**
 * Real-database coverage for the "closing the loop" requirement: after a
 * simulated speaker is replaced, the existing Phase 1 candidate-selection
 * system must run and a new simulated speaker must visibly occupy the
 * seat — but production's own `claimOpenSeat`/`checkPromotionEligibility`
 * can't promote a session-less simulated identity (see
 * `simulateAdvanceSelection`'s own doc comment). These tests prove both
 * halves of that adapter's contract: it correctly completes a promotion
 * for a known-simulated winner, and it never touches a real candidate's
 * own pending request, even when that real request is the only — and
 * therefore winning — candidate in the pool.
 */
describe.skipIf(!hasServiceCredentials)("simulateAdvanceSelection (real database)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;
  const originalVercelEnv = process.env.VERCEL_ENV;

  beforeAll(async () => {
    process.env.VERCEL_ENV = "preview";
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Session Simulator advance-selection test fixture event",
        scheduled_start: new Date(Date.now() - 60_000).toISOString(),
        lobby_opens_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;
  }, 30_000);

  afterAll(async () => {
    if (eventId) {
      await service.from("events").delete().eq("id", eventId);
    }
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  }, 30_000);

  it("does nothing when both seats are already occupied", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: a }, 1, "A");
    await claimSpeakerSeat(eventId, { type: "guest", id: b }, 2, "B");
    try {
      const result = await simulateAdvanceSelection(eventId, [a, b], { [a]: "A", [b]: "B" });
      expect(result.claimed).toBe(false);
    } finally {
      await endSpeakerSeat(eventId, { type: "guest", id: a }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: b }, "moderator_removed");
    }
  });

  it("does nothing when a seat is open but there is no pending request at all (Part 5's empty-pool case)", async () => {
    const result = await simulateAdvanceSelection(eventId, [], {});
    expect(result.claimed).toBe(false);
  });

  it("claims the seat for a simulated winner — real freeze/deterministic-select/claim/grant/pool-reset, new speaker gets a fresh real round", async () => {
    const candidateGuestId = crypto.randomUUID();
    const { requestId, messageId } = await requestToSpeakAsGuest(eventId, candidateGuestId, "Fake Fox", "let me speak");
    const voterGuestId = crypto.randomUUID();
    await castSpeakerRequestVoteAsGuest(eventId, messageId, voterGuestId);

    try {
      const result = await simulateAdvanceSelection(eventId, [candidateGuestId], { [candidateGuestId]: "Fake Fox" });
      expect(result).toEqual({ claimed: true, guestId: candidateGuestId, seatNumber: expect.any(Number) });

      const { data: request } = await service.from("speaker_requests").select("status").eq("id", requestId).single();
      expect(request!.status).toBe("granted");

      const { data: seat } = await service
        .from("event_speakers")
        .select("*")
        .eq("event_id", eventId)
        .eq("guest_id", candidateGuestId)
        .is("left_at", null)
        .single();
      expect(seat).toBeTruthy();
      expect(seat!.round_number).toBe(1);
      expect(seat!.round_phase).toBe("active");
      const remainingMs = new Date(seat!.round_ends_at).getTime() - Date.now();
      expect(remainingMs).toBeGreaterThan(55_000);
      expect(remainingMs).toBeLessThanOrEqual(60_000);
    } finally {
      await endSpeakerSeat(eventId, { type: "guest", id: candidateGuestId }, "moderator_removed");
    }
  });

  it("never claims on behalf of a real (non-simulated) winning candidate, even when it's the only candidate in the pool", async () => {
    const realGuestId = crypto.randomUUID();
    const { requestId } = await requestToSpeakAsGuest(eventId, realGuestId, "Real Person", "let me speak");

    try {
      // Empty simulatedGuestIds — this real requester's id is deliberately
      // never included, exactly the scenario a mixed real+simulated pool
      // produces.
      const result = await simulateAdvanceSelection(eventId, [], {});
      expect(result.claimed).toBe(false);

      const { data: request } = await service.from("speaker_requests").select("status").eq("id", requestId).single();
      expect(request!.status).toBe("pending"); // untouched — not granted, not expired

      const { data: seat } = await service
        .from("event_speakers")
        .select("id")
        .eq("event_id", eventId)
        .eq("guest_id", realGuestId)
        .maybeSingle();
      expect(seat).toBeNull(); // never claimed
    } finally {
      await service
        .from("speaker_requests")
        .update({ status: "withdrawn", resolved_at: new Date().toISOString() })
        .eq("id", requestId);
    }
  });
});

describe.skipIf(!hasServiceCredentials)("clearTestRoomSandbox (real database) — real-device report: comprehensive, but only against the actual sandbox", () => {
  let service: ReturnType<typeof createServiceClient>;
  const originalVercelEnv = process.env.VERCEL_ENV;

  beforeAll(() => {
    process.env.VERCEL_ENV = "preview";
    service = createServiceClient();
  });

  afterAll(() => {
    if (originalVercelEnv === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = originalVercelEnv;
  });

  it("refuses an ordinary event that isn't the designated permanent test room — the actual safety guarantee, not just the preview/dev gate", async () => {
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "clearTestRoomSandbox safety-boundary test fixture — must survive untouched",
        scheduled_start: new Date(Date.now() + 60_000).toISOString(),
        lobby_opens_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");

    try {
      await expect(clearTestRoomSandbox(event.id)).rejects.toThrow(/not the designated permanent test room/);

      // Confirm nothing was touched — the refusal happens before any delete.
      const { data: stillThere } = await service.from("events").select("id").eq("id", event.id).maybeSingle();
      expect(stillThere?.id).toBe(event.id);
    } finally {
      await service.from("events").delete().eq("id", event.id);
    }
  });

  it("refuses a nonexistent event id the same way — never assumes 'not found' means 'safe to proceed'", async () => {
    await expect(clearTestRoomSandbox(crypto.randomUUID())).rejects.toThrow(/not the designated permanent test room/);
  });

  // The real permanent test room is a genuine, enforced singleton
  // (migration 00000000000015's partial unique index on
  // is_permanent_test) — there is no way to create a second, isolated
  // fixture for this test to target, so this deliberately exercises the
  // *real* shared sandbox, the same one `scripts/dev-harness.test.ts`'s
  // own clear-sandbox suite already proves the comprehensive per-table
  // clearing logic against. This test's own job is narrower: prove the
  // *action wrapper* (its own independent implementation, not imported
  // from the CLI script — see clearTestRoomSandbox's own doc comment)
  // correctly reaches and clears the real sandbox, not the underlying
  // per-table SQL semantics already proven elsewhere.
  it("clears deliberately-seeded state from the real permanent test room, and leaves the room itself intact", async () => {
    const { data: sandbox, error: sandboxError } = await service
      .from("events")
      .select("id")
      .eq("is_permanent_test", true)
      .single();
    if (sandboxError || !sandbox) throw new Error(sandboxError?.message ?? "permanent test room not found");

    const { data: message, error: messageError } = await service
      .from("event_chat_messages")
      .insert({
        event_id: sandbox.id,
        author_guest_id: crypto.randomUUID(),
        author_display_name: "clearTestRoomSandbox test guest",
        body: "deliberately created by this test — clearTestRoomSandbox must remove it",
      })
      .select("id")
      .single();
    if (messageError || !message) throw new Error(messageError?.message ?? "failed to insert test message");

    const { error: speakerError } = await service
      .from("event_speakers")
      .insert({ event_id: sandbox.id, guest_id: crypto.randomUUID(), seat_number: 2, display_name: "clearTestRoomSandbox test guest" });
    if (speakerError) throw new Error(speakerError.message);

    const result = await clearTestRoomSandbox(sandbox.id);
    expect(result.eventId).toBe(sandbox.id);
    expect(result.messagesDeleted).toBeGreaterThan(0);
    expect(result.speakersDeleted).toBeGreaterThan(0);

    const { data: messagesAfter } = await service.from("event_chat_messages").select("id").eq("event_id", sandbox.id);
    expect(messagesAfter).toEqual([]);
    const { data: speakersAfter } = await service.from("event_speakers").select("id").eq("event_id", sandbox.id);
    expect(speakersAfter).toEqual([]);

    const { data: sandboxStillThere } = await service.from("events").select("id").eq("id", sandbox.id).maybeSingle();
    expect(sandboxStillThere?.id).toBe(sandbox.id);
  });

  /**
   * Real-device report (reset/reseed race, issue #21): `protectedGuestIds`
   * is what makes a delayed follow-up sweep generation-safe — see
   * `clearTestRoomSandbox`'s own doc comment for the full incident and
   * design. These tests exercise the real sandbox room directly (the
   * same one every other test in this describe block already does),
   * simulating the exact Reset → immediate Seed 2 Speakers race by hand:
   * seed "old" rows, run an unprotected sweep (the primary Reset pass),
   * seed "new" rows under fresh guest ids (the immediate reseed), then
   * run a *protected* sweep (the delayed follow-up) and confirm the new
   * generation survives while anything genuinely unprotected does not.
   */
  describe("protectedGuestIds — generation-safe follow-up sweep (reset/reseed race)", () => {
    async function getSandboxId(): Promise<string> {
      const { data: sandbox, error } = await service.from("events").select("id").eq("is_permanent_test", true).single();
      if (error || !sandbox) throw new Error(error?.message ?? "permanent test room not found");
      return sandbox.id;
    }

    it("excludes a protected guest's occupied seat and its backing round from the sweep, while an unprotected stray speaker and message are still removed", async () => {
      const eventId = await getSandboxId();
      const strayGuestId = crypto.randomUUID();
      const protectedGuestId = crypto.randomUUID();

      const { error: strayMessageError } = await service.from("event_chat_messages").insert({
        event_id: eventId,
        author_guest_id: strayGuestId,
        author_display_name: "stray (unprotected) guest",
        body: "an old-generation straggler — must be removed",
      });
      if (strayMessageError) throw new Error(strayMessageError.message);

      const { error: straySpeakerError } = await service
        .from("event_speakers")
        .insert({ event_id: eventId, guest_id: strayGuestId, seat_number: 2, display_name: "stray (unprotected) guest" });
      if (straySpeakerError) throw new Error(straySpeakerError.message);

      const { error: protectedSpeakerError } = await service
        .from("event_speakers")
        .insert({ event_id: eventId, guest_id: protectedGuestId, seat_number: 1, display_name: "protected (new-generation) guest" });
      if (protectedSpeakerError) throw new Error(protectedSpeakerError.message);

      const { error: roundError } = await service.from("stage_rounds").insert({ event_id: eventId });
      if (roundError) throw new Error(roundError.message);

      try {
        const result = await clearTestRoomSandbox(eventId, { protectedGuestIds: new Set([protectedGuestId]) });

        expect(result.messagesDeleted).toBeGreaterThan(0); // the stray message was removed
        expect(result.speakersDeleted).toBe(1); // only the stray speaker, never the protected one
        expect(result.roundsDeleted).toBe(0); // never blind-deleted while a protected seat is still occupied

        const { data: messagesAfter } = await service
          .from("event_chat_messages")
          .select("id")
          .eq("event_id", eventId)
          .eq("author_guest_id", strayGuestId);
        expect(messagesAfter).toEqual([]);

        const { data: straySpeakerAfter } = await service
          .from("event_speakers")
          .select("id")
          .eq("event_id", eventId)
          .eq("guest_id", strayGuestId);
        expect(straySpeakerAfter).toEqual([]);

        const { data: protectedSpeakerAfter } = await service
          .from("event_speakers")
          .select("id, guest_id")
          .eq("event_id", eventId)
          .eq("guest_id", protectedGuestId)
          .maybeSingle();
        expect(protectedSpeakerAfter?.guest_id).toBe(protectedGuestId);

        const { data: roundAfter } = await service.from("stage_rounds").select("id").eq("event_id", eventId);
        expect(roundAfter?.length).toBeGreaterThan(0);
      } finally {
        await service.from("event_speakers").delete().eq("event_id", eventId);
        await service.from("stage_rounds").delete().eq("event_id", eventId);
        await service.from("event_chat_messages").delete().eq("event_id", eventId);
      }
    });

    it("still deletes the round when nothing is protected — the primary Reset pass's own unconditional behavior is unchanged", async () => {
      const eventId = await getSandboxId();
      // Defensive: `stage_rounds` has a UNIQUE(event_id) constraint, and
      // this describe block shares the one real permanent test room with
      // every other test/live-verification session that's ever touched
      // it — clear any pre-existing round first so this test's own
      // fixture setup is never blocked by something unrelated left
      // behind.
      await service.from("stage_rounds").delete().eq("event_id", eventId);
      const guestId = crypto.randomUUID();
      const { error: speakerError } = await service
        .from("event_speakers")
        .insert({ event_id: eventId, guest_id: guestId, seat_number: 1, display_name: "unprotected guest" });
      if (speakerError) throw new Error(speakerError.message);
      const { error: roundError } = await service.from("stage_rounds").insert({ event_id: eventId });
      if (roundError) throw new Error(roundError.message);

      const result = await clearTestRoomSandbox(eventId);
      expect(result.speakersDeleted).toBeGreaterThan(0);
      expect(result.roundsDeleted).toBeGreaterThan(0);

      const { data: roundAfter } = await service.from("stage_rounds").select("id").eq("event_id", eventId);
      expect(roundAfter).toEqual([]);
    });

    it("end-to-end: Reset (unprotected) then an immediate reseed under new guest ids survives a subsequent protected follow-up sweep, while a genuinely-late old-generation straggler is still caught", async () => {
      const eventId = await getSandboxId();
      const oldGuestId = crypto.randomUUID();
      const newGuestIdSeat1 = crypto.randomUUID();
      const newGuestIdSeat2 = crypto.randomUUID();

      // Defensive: see the previous test's own comment on why this is
      // cleared first.
      await service.from("stage_rounds").delete().eq("event_id", eventId);

      // "Old" generation: a speaker + round already sitting in the room.
      const { error: oldSpeakerError } = await service
        .from("event_speakers")
        .insert({ event_id: eventId, guest_id: oldGuestId, seat_number: 1, display_name: "old generation" });
      if (oldSpeakerError) throw new Error(oldSpeakerError.message);
      const { error: oldRoundError } = await service.from("stage_rounds").insert({ event_id: eventId });
      if (oldRoundError) throw new Error(oldRoundError.message);

      try {
        // Reset's own primary pass — unconditional, exactly as the real button fires it.
        const primary = await clearTestRoomSandbox(eventId);
        expect(primary.speakersDeleted).toBeGreaterThan(0);
        expect(primary.roundsDeleted).toBeGreaterThan(0);

        // Immediately reseed under a brand-new generation's own guest ids —
        // the exact "Reset → immediately Seed 2 Speakers" sequence.
        const { error: newSpeaker1Error } = await service
          .from("event_speakers")
          .insert({ event_id: eventId, guest_id: newGuestIdSeat1, seat_number: 1, display_name: "new generation seat 1" });
        if (newSpeaker1Error) throw new Error(newSpeaker1Error.message);
        const { error: newSpeaker2Error } = await service
          .from("event_speakers")
          .insert({ event_id: eventId, guest_id: newGuestIdSeat2, seat_number: 2, display_name: "new generation seat 2" });
        if (newSpeaker2Error) throw new Error(newSpeaker2Error.message);
        // Defensive re-clear immediately before this insert — see the
        // sibling test's own comment on why (a UNIQUE(event_id)
        // constraint on this table, sharing the one real permanent test
        // room with everything else that's ever touched it).
        await service.from("stage_rounds").delete().eq("event_id", eventId);
        const { error: newRoundError } = await service.from("stage_rounds").insert({ event_id: eventId });
        if (newRoundError) throw new Error(newRoundError.message);

        // A genuinely late straggler from the OLD generation, landing only
        // now — exactly the write-still-in-flight-when-Reset-ran case the
        // follow-up sweep exists to catch.
        const { error: lateMessageError } = await service.from("event_chat_messages").insert({
          event_id: eventId,
          author_guest_id: oldGuestId,
          author_display_name: "old generation",
          body: "a write that was still in flight when Reset ran",
        });
        if (lateMessageError) throw new Error(lateMessageError.message);

        // The delayed follow-up sweep, protecting the new generation's own
        // guest ids — exactly what the panel's real `setTimeout` callback
        // now does.
        const followUp = await clearTestRoomSandbox(eventId, {
          protectedGuestIds: new Set([newGuestIdSeat1, newGuestIdSeat2]),
        });
        expect(followUp.messagesDeleted).toBeGreaterThan(0); // the old straggler
        expect(followUp.speakersDeleted).toBe(0); // never the new generation
        expect(followUp.roundsDeleted).toBe(0); // never the new generation's own round

        const { data: speakersAfter } = await service
          .from("event_speakers")
          .select("guest_id")
          .eq("event_id", eventId)
          .order("seat_number", { ascending: true });
        expect((speakersAfter ?? []).map((s) => s.guest_id)).toEqual([newGuestIdSeat1, newGuestIdSeat2]);

        const { data: roundsAfter } = await service.from("stage_rounds").select("id").eq("event_id", eventId);
        expect(roundsAfter?.length).toBe(1);

        const { data: staleMessageAfter } = await service
          .from("event_chat_messages")
          .select("id")
          .eq("event_id", eventId)
          .eq("author_guest_id", oldGuestId);
        expect(staleMessageAfter).toEqual([]);
      } finally {
        await service.from("event_speakers").delete().eq("event_id", eventId);
        await service.from("stage_rounds").delete().eq("event_id", eventId);
        await service.from("event_chat_messages").delete().eq("event_id", eventId);
      }
    });
  });
});
