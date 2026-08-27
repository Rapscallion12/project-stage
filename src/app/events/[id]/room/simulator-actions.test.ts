// @vitest-environment node
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceRoundDeadline,
  resetSimulatorSession,
} from "./simulator-actions";
import { createServiceClient } from "@/lib/supabase/service";
import { requestToSpeakAsGuest, castSpeakerRequestVoteAsGuest } from "@/lib/repositories/speaker-requests";
import { claimSpeakerSeat, castSpeakerRoundVoteAsGuest, endSpeakerSeat } from "@/lib/repositories/event-speakers";

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

  it("forceRoundDeadline throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(forceRoundDeadline("s1")).rejects.toThrow(/not available/);
  });

  it("resetSimulatorSession throws on production, even with a non-empty guest id list", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(resetSimulatorSession("e1", ["g1", "g2"])).rejects.toThrow(/not available/);
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
});
