// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat } from "./event-speakers";
import type { EventSpeaker } from "./event-speakers";
import {
  requestToSpeakAsGuest,
  castSpeakerRequestVoteAsGuest,
  markSpeakerRequestGranted,
  resetSpeakerCandidatePool,
  freezeSpeakerCandidates,
  reserveSpeakerCandidatesForSeats,
} from "./speaker-requests";
import { ensureActiveSelectionRound } from "@/app/events/[id]/room/actions";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, fifth corrective pass — real-device finding: both seats
 * empty, Expanded Comments showing two eligible already-voted-for
 * Request-to-Speak candidates, and the stage stuck showing "Selecting
 * next speaker…" on both seats for far too long. Traced to the old
 * event-wide "one current candidate per round" model (see migration
 * 00000000000032's own doc comment) — with two seats open at once, only
 * one candidate could ever be reserved, and claiming a seat wiped the
 * other seat's own legitimate candidate. This file proves the fix, and
 * the accompanying small-room fallback (Sections 8-15, migration
 * 00000000000033), directly against the real linked project.
 */
describe.skipIf(!hasServiceCredentials)("two simultaneous open seats reserve distinct candidates (issue #21, fifth corrective pass, Section 17)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeSeats(): Promise<EventSpeaker[]> {
    const { data } = await service.from("event_speakers").select("*").eq("event_id", eventId).is("left_at", null).order("seat_number");
    return (data ?? []) as EventSpeaker[];
  }

  async function stageRoundRow() {
    const { data } = await service.from("stage_rounds").select("round_number, phase").eq("event_id", eventId).maybeSingle();
    return data;
  }

  async function claimAsAuthorizedCandidate(guestId: string, seatNumber: 1 | 2, displayName: string, requestId: string) {
    const row = await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, seatNumber, displayName);
    await markSpeakerRequestGranted(requestId);
    await resetSpeakerCandidatePool(eventId, requestId);
    return row;
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 fifth corrective pass — two-seat selection test fixture event",
        scheduled_start: new Date(Date.now() - 60_000).toISOString(),
        lobby_opens_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;
  }, 30_000);

  afterAll(async () => {
    if (eventId) await service.from("events").delete().eq("id", eventId);
  }, 30_000);

  it(
    "reserves the highest-ranked candidate for seat 1, the next-highest for seat 2, never the same one for both, and starts exactly one round once both are seated",
    async () => {
      // Establish the stage, then remove both speakers — the exact
      // real-device scenario: an already-established stage with both
      // seats freshly empty.
      const seed1 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Seed A", true);
      const seed2 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Seed B", true);
      await endSpeakerSeat(eventId, { type: "guest", id: seed1.guest_id! }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: seed2.guest_id! }, "moderator_removed");
      expect(await activeSeats()).toHaveLength(0);
      expect((await stageRoundRow())?.phase).toBe("awaiting_pairing");

      // Two eligible candidates, both already voted for — candidate 1
      // has more votes and must win seat 1; candidate 2 must not be
      // wiped out and must land on seat 2.
      const candidate1 = crypto.randomUUID();
      const { messageId: message1Id, requestId: request1Id } = await requestToSpeakAsGuest(eventId, candidate1, "Candidate One", "pick me");
      const candidate2 = crypto.randomUUID();
      const { messageId: message2Id, requestId: request2Id } = await requestToSpeakAsGuest(eventId, candidate2, "Candidate Two", "pick me too");
      await castSpeakerRequestVoteAsGuest(eventId, message1Id, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, message1Id, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, message1Id, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, message2Id, crypto.randomUUID());

      // Selection proceeds immediately — one call, no waiting period.
      await ensureActiveSelectionRound(eventId, await activeSeats());

      const { data: reservations } = await service
        .from("speaker_requests")
        .select("guest_id, reserved_seat_number, is_current_candidate")
        .eq("event_id", eventId)
        .eq("status", "pending")
        .eq("is_current_candidate", true)
        .order("reserved_seat_number");

      expect(reservations).toHaveLength(2);
      const bySeat = new Map(reservations!.map((r) => [r.reserved_seat_number, r.guest_id]));
      expect(bySeat.get(1)).toBe(candidate1); // highest votes → seat 1
      expect(bySeat.get(2)).toBe(candidate2); // next-highest → seat 2
      // Never the same candidate reserved for both seats.
      expect(bySeat.get(1)).not.toBe(bySeat.get(2));

      // At no point is there an active normal round while both seats
      // are still selecting — this is the exact invariant the
      // real-device report caught being violated.
      expect((await stageRoundRow())?.phase).toBe("awaiting_pairing");

      // Both candidates complete their own authorized claim, targeting
      // their own reserved seat.
      await claimAsAuthorizedCandidate(candidate1, 1, "Candidate One", request1Id);
      expect((await stageRoundRow())?.phase).toBe("awaiting_pairing"); // still only one seat occupied

      await claimAsAuthorizedCandidate(candidate2, 2, "Candidate Two", request2Id);

      const finalSeats = await activeSeats();
      expect(finalSeats.map((s) => s.guest_id).sort()).toEqual([candidate1, candidate2].sort());
      const finalRound = await stageRoundRow();
      expect(finalRound?.phase).toBe("active");
      expect(finalRound?.round_number).toBe(2); // exactly one new round after the initial pairing

      await endSpeakerSeat(eventId, { type: "guest", id: candidate1 }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: candidate2 }, "moderator_removed");
    },
    20_000,
  );

  it("an unauthorized direct claim for either seat is still rejected while both candidates are mid-selection — the seat-aware fix never weakens authorization", async () => {
    const seed1 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Seed C", true);
    const seed2 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Seed D", true);
    await endSpeakerSeat(eventId, { type: "guest", id: seed1.guest_id! }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: seed2.guest_id! }, "moderator_removed");

    const candidate1 = crypto.randomUUID();
    const { messageId: message1Id } = await requestToSpeakAsGuest(eventId, candidate1, "Legit One", "a");
    const candidate2 = crypto.randomUUID();
    const { messageId: message2Id } = await requestToSpeakAsGuest(eventId, candidate2, "Legit Two", "b");
    await castSpeakerRequestVoteAsGuest(eventId, message1Id, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, message2Id, crypto.randomUUID());
    await ensureActiveSelectionRound(eventId, await activeSeats());

    const intruder = crypto.randomUUID();
    await expect(claimSpeakerSeat(eventId, { type: "guest", id: intruder }, 1, "Intruder")).rejects.toThrow(/selection authorization/);
    await expect(claimSpeakerSeat(eventId, { type: "guest", id: intruder }, 2, "Intruder")).rejects.toThrow(/selection authorization/);

    expect(await activeSeats()).toHaveLength(0);

    // Clean up — withdraw both, and resolve the now-orphaned selection
    // round explicitly (a raw status update, not withdraw_speaker_request,
    // never leaves the round itself 'active' the way a real
    // resetSpeakerCandidatePool call would) — otherwise the next test's
    // own freezeSpeakerCandidates call would find this stale round still
    // "active" and reuse its (now-withdrawn) membership instead of
    // freezing its own fresh candidates.
    await service.from("speaker_requests").update({ status: "withdrawn", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "pending");
    await service.from("speaker_selection_rounds").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "active");
  });

  it(
    "Race A/E (Section 36): two truly concurrent reservation calls — one per seat — never reserve the same candidate for both seats",
    async () => {
      const seed1 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Seed E", true);
      const seed2 = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Seed F", true);
      await endSpeakerSeat(eventId, { type: "guest", id: seed1.guest_id! }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: seed2.guest_id! }, "moderator_removed");

      const candidate1 = crypto.randomUUID();
      const { messageId: message1Id } = await requestToSpeakAsGuest(eventId, candidate1, "Race Candidate One", "a");
      const candidate2 = crypto.randomUUID();
      const { messageId: message2Id } = await requestToSpeakAsGuest(eventId, candidate2, "Race Candidate Two", "b");
      await castSpeakerRequestVoteAsGuest(eventId, message1Id, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, message1Id, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, message2Id, crypto.randomUUID());

      // Freeze once (idempotent), then race two genuinely concurrent
      // reservation calls — one per seat, exactly the "Seat A selector
      // picks Candidate X while Seat B selector also sees Candidate X as
      // top-ranked" scenario Section 36 names explicitly. Both calls see
      // the *same* frozen pool; the atomic, locked reservation RPC
      // (migration 00000000000036) is what has to keep them from
      // colliding, not application-level luck.
      await freezeSpeakerCandidates(eventId);
      await Promise.all([
        reserveSpeakerCandidatesForSeats(eventId, [1]),
        reserveSpeakerCandidatesForSeats(eventId, [2]),
      ]);

      const { data: reservations } = await service
        .from("speaker_requests")
        .select("guest_id, reserved_seat_number")
        .eq("event_id", eventId)
        .eq("status", "pending")
        .eq("is_current_candidate", true)
        .order("reserved_seat_number");

      expect(reservations).toHaveLength(2);
      const bySeat = new Map(reservations!.map((r) => [r.reserved_seat_number, r.guest_id]));
      expect(bySeat.get(1)).not.toBeUndefined();
      expect(bySeat.get(2)).not.toBeUndefined();
      // The actual invariant this race threatens: never the same
      // candidate reserved for both seats, regardless of which
      // concurrent call "won."
      expect(bySeat.get(1)).not.toBe(bySeat.get(2));
      expect(new Set([bySeat.get(1), bySeat.get(2)])).toEqual(new Set([candidate1, candidate2]));

      await service.from("speaker_requests").update({ status: "withdrawn", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "pending");
      await service.from("speaker_selection_rounds").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "active");
    },
    20_000,
  );
});

describe.skipIf(!hasServiceCredentials)("small-room direct-join fallback (issue #21, fifth corrective pass, Sections 8-15, 18)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeSeats(): Promise<EventSpeaker[]> {
    const { data } = await service.from("event_speakers").select("*").eq("event_id", eventId).is("left_at", null).order("seat_number");
    return (data ?? []) as EventSpeaker[];
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 fifth corrective pass — small-room fallback test fixture event",
        scheduled_start: new Date(Date.now() - 60_000).toISOString(),
        lobby_opens_at: new Date(Date.now() - 5 * 60_000).toISOString(),
      })
      .select("id")
      .single();
    if (error || !event) throw new Error(error?.message ?? "failed to create test event");
    eventId = event.id;
  }, 30_000);

  afterAll(async () => {
    if (eventId) await service.from("events").delete().eq("id", eventId);
  }, 30_000);

  it(
    "A-D: both seats empty + zero requests opens the fallback; the two just-removed speakers are excluded, an unrelated viewer succeeds",
    async () => {
      const speakerA = crypto.randomUUID();
      const speakerB = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: speakerA }, 1, "Speaker A", true);
      await claimSpeakerSeat(eventId, { type: "guest", id: speakerB }, 2, "Speaker B", true);
      await endSpeakerSeat(eventId, { type: "guest", id: speakerA }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: speakerB }, "moderator_removed");
      expect(await activeSeats()).toHaveLength(0);

      // B: Speaker A cannot immediately reclaim.
      await expect(
        claimSpeakerSeat(eventId, { type: "guest", id: speakerA }, 1, "Speaker A"),
      ).rejects.toThrow(/recently removed/);

      // C: Speaker B cannot immediately reclaim either.
      await expect(
        claimSpeakerSeat(eventId, { type: "guest", id: speakerB }, 2, "Speaker B"),
      ).rejects.toThrow(/recently removed/);

      // D: an unrelated viewer succeeds — the fallback is genuinely open,
      // just not to the two who were just removed.
      const viewerC = crypto.randomUUID();
      const claimed = await claimSpeakerSeat(eventId, { type: "guest", id: viewerC }, 1, "Viewer C");
      expect(claimed.guest_id).toBe(viewerC);

      // E: second seat, still zero requests — another eligible,
      // non-excluded viewer can still fill it via the same fallback.
      const viewerD = crypto.randomUUID();
      const claimedSecond = await claimSpeakerSeat(eventId, { type: "guest", id: viewerD }, 2, "Viewer D");
      expect(claimedSecond.guest_id).toBe(viewerD);

      const { data: round } = await service.from("stage_rounds").select("phase, round_number").eq("event_id", eventId).single();
      expect(round!.phase).toBe("active");

      await endSpeakerSeat(eventId, { type: "guest", id: viewerC }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: viewerD }, "moderator_removed");
    },
    20_000,
  );

  it("F: an eligible Request-to-Speak arriving before the second fallback seat is claimed takes priority over continued fallback for that seat", async () => {
    // Both seats empty again, zero requests — fallback window open.
    expect(await activeSeats()).toHaveLength(0);

    const viewerE = crypto.randomUUID();
    const claimed = await claimSpeakerSeat(eventId, { type: "guest", id: viewerE }, 1, "Viewer E");
    expect(claimed.guest_id).toBe(viewerE);

    // Before anyone claims the second seat, a real Request-to-Speak
    // arrives — this must close the fallback window for the remaining
    // seat, even though it's still empty.
    const candidate = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, candidate, "Candidate F", "let me speak");

    const bystander = crypto.randomUUID();
    await expect(
      claimSpeakerSeat(eventId, { type: "guest", id: bystander }, 2, "Bystander"),
    ).rejects.toThrow(/selection authorization/);

    // Clean up.
    await service.from("speaker_requests").update({ status: "withdrawn", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "pending");
    await endSpeakerSeat(eventId, { type: "guest", id: viewerE }, "moderator_removed");
  });

  it("G: one seat still occupied + the other empty + zero requests: fallback does NOT activate — Request-to-Speak still governs the empty seat", async () => {
    const staying = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: staying }, 1, "Staying Speaker", true);
    expect(await activeSeats()).toHaveLength(1);

    const bystander = crypto.randomUUID();
    await expect(
      claimSpeakerSeat(eventId, { type: "guest", id: bystander }, 2, "Bystander"),
    ).rejects.toThrow(/selection authorization/);

    await endSpeakerSeat(eventId, { type: "guest", id: staying }, "moderator_removed");
  });
});
