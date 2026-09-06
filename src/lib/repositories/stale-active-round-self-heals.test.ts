// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat, listActiveSpeakersAuthoritative } from "./event-speakers";
import type { EventSpeaker } from "./event-speakers";
import { requestToSpeakAsGuest, castSpeakerRequestVoteAsGuest, markSpeakerRequestGranted, resetSpeakerCandidatePool } from "./speaker-requests";
import { ensureActiveSelectionRound } from "@/app/events/[id]/room/actions";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, twelfth corrective pass: a clean real-device capture (an
 * established room, one seat freshly vacated, two fresh eligible RTS
 * candidates, the simulator still running, a 591ms authoritative read
 * agreeing with the client) proved a genuine invariant violation —
 * established + fillable vacancy + eligible RTS + no reservation.
 *
 * Root cause, found by reading the real linked database directly (see
 * DECISIONS.md): the permanent test room this capture came from had a
 * `speaker_selection_rounds` row frozen two days earlier, still
 * `status = 'active'`, with zero `speaker_requests` rows still
 * referencing it. `freeze_speaker_candidates`'s own idempotency check —
 * "if an active round already exists, reuse it, never create a second
 * one" — had no corresponding liveness check, so it kept reusing that
 * dead round forever, on every call, regardless of how many fresh
 * requests/votes/vacancies happened afterward. Every vacancy path in
 * this codebase already funnels through this one function, so this gap
 * could silently defeat reconciliation regardless of which specific
 * vacancy-creating action ran — reproduced here directly against the
 * real database by manufacturing exactly that condition, rather than
 * guessing which trigger path the real device happened to use (that
 * detail was unrecoverable — see DECISIONS.md's own honest account).
 *
 * Migration 00000000000040 fixes `freeze_speaker_candidates` itself:
 * before reusing an "active" round, it now verifies the round actually
 * has a live reservation or a remaining viable candidate; if not, it
 * marks that round `exhausted` and falls through to create a genuinely
 * fresh round from the event's current live pool.
 */
describe.skipIf(!hasServiceCredentials)("a stale, genuinely dead 'active' selection round self-heals instead of blocking selection forever (issue #21, twelfth corrective pass)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeSeats(): Promise<EventSpeaker[]> {
    return listActiveSpeakersAuthoritative(eventId);
  }

  async function reservedCandidate(seatNumber: 1 | 2): Promise<{ id: string; guest_id: string | null } | null> {
    const { data } = await service
      .from("speaker_requests")
      .select("id, guest_id")
      .eq("event_id", eventId)
      .eq("status", "pending")
      .eq("is_current_candidate", true)
      .eq("reserved_seat_number", seatNumber)
      .maybeSingle();
    return data;
  }

  /**
   * Manufactures the exact bug condition: a `speaker_selection_rounds`
   * row that is `status = 'active'` but genuinely dead — frozen long
   * ago, with the one request that was ever part of it already
   * `expired` (no `is_current_candidate`, not `pending`) — exactly the
   * state the real permanent test room's own two-day-old stale round
   * was found in.
   */
  async function manufactureDeadActiveRound(): Promise<string> {
    const deadGuest = crypto.randomUUID();
    const { requestId: deadRequestId } = await requestToSpeakAsGuest(eventId, deadGuest, "Long Gone Candidate", "old request");
    const { data: deadRound } = await service
      .from("speaker_selection_rounds")
      .insert({ event_id: eventId, status: "active", frozen_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })
      .select("id")
      .single();
    await service
      .from("speaker_requests")
      .update({ status: "expired", selection_round_id: deadRound!.id, frozen_rank: 1, frozen_vote_count: 0, resolved_at: new Date().toISOString() })
      .eq("id", deadRequestId);
    return deadRound!.id as string;
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 twelfth corrective pass — stale active round fixture event",
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

  beforeEach(async () => {
    const seats = await activeSeats();
    for (const s of seats) {
      await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id! }, "moderator_removed");
    }
    await service.from("speaker_requests").update({ status: "withdrawn", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "pending");
    await service.from("speaker_selection_rounds").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "active");
  });

  it(
    "exact reproduction: an established room, one seat occupied, a stale dead round already in place, a fresh vacancy, and two fresh eligible RTS candidates — the #1 candidate is reserved for the vacant seat, not blocked",
    async () => {
      const staleRoundId = await manufactureDeadActiveRound();

      // Two occupied seats — established.
      const speakerA = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Speaker A", true);
      const speakerB = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Speaker B", true);

      // Two fresh eligible RTS candidates — C is deterministically #1.
      const cGuest = crypto.randomUUID();
      const { messageId: cMsg } = await requestToSpeakAsGuest(eventId, cGuest, "Candidate C", "pick me");
      const dGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, dGuest, "Candidate D", "and me");
      await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());

      // The vacancy — exactly what simulateOpenSeat (and every other
      // vacancy path) performs: end the seat, then trigger the
      // canonical reconciliation directly.
      await endSpeakerSeat(eventId, { type: "guest", id: speakerB.guest_id! }, "moderator_removed");
      const t0 = Date.now();
      await ensureActiveSelectionRound(eventId, await activeSeats());
      const reservationLatencyMs = Date.now() - t0;

      const reserved = await reservedCandidate(2);
      expect(reserved).not.toBeNull();
      expect(reserved!.guest_id).toBe(cGuest);
      expect(reservationLatencyMs).toBeLessThan(3000);

      const staleRoundAfter = await service.from("speaker_selection_rounds").select("status").eq("id", staleRoundId).single();
      expect(staleRoundAfter.data?.status).toBe("exhausted");

      // Clean up.
      await claimSpeakerSeat(eventId, { type: "guest", id: cGuest }, 2, "cleanup", true);
      await markSpeakerRequestGranted(reserved!.id);
      await resetSpeakerCandidatePool(eventId, reserved!.id);
      const remaining = await activeSeats();
      for (const s of remaining) {
        await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id! }, "moderator_removed");
      }
      void speakerA;
    },
    30_000,
  );

  it(
    "stress test: 20 consecutive vacancy cycles in one continuously-running event — every cycle's expected #1 candidate is reserved, no cycle is left in violation",
    async () => {
      const occupantA = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Seed A", true);
      let occupantB = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 2, "Seed B", true);

      const latencies: number[] = [];
      const CYCLES = 20;

      for (let cycle = 0; cycle < CYCLES; cycle++) {
        const winnerGuest = crypto.randomUUID();
        const { messageId: winnerMsg } = await requestToSpeakAsGuest(eventId, winnerGuest, `Cycle ${cycle} Winner`, "pick me");
        const loserGuest = crypto.randomUUID();
        await requestToSpeakAsGuest(eventId, loserGuest, `Cycle ${cycle} Runner-up`, "also me");
        await castSpeakerRequestVoteAsGuest(eventId, winnerMsg, crypto.randomUUID());
        await castSpeakerRequestVoteAsGuest(eventId, winnerMsg, crypto.randomUUID());

        await endSpeakerSeat(eventId, { type: "guest", id: occupantB.guest_id! }, "moderator_removed");
        const t0 = Date.now();
        await ensureActiveSelectionRound(eventId, await activeSeats());
        latencies.push(Date.now() - t0);

        const reserved = await reservedCandidate(2);
        expect(reserved, `cycle ${cycle}: expected ${winnerGuest} reserved for seat 2`).not.toBeNull();
        expect(reserved!.guest_id, `cycle ${cycle}`).toBe(winnerGuest);

        // Seat 1 (never part of this cycle) stays completely undisturbed.
        expect((await activeSeats()).find((s) => s.seat_number === 1)?.guest_id).toBe(occupantA.guest_id);

        await claimSpeakerSeat(eventId, { type: "guest", id: winnerGuest }, 2, `Cycle ${cycle} Winner`, true);
        await markSpeakerRequestGranted(reserved!.id);
        await resetSpeakerCandidatePool(eventId, reserved!.id);
        occupantB = { ...occupantB, guest_id: winnerGuest, id: (await activeSeats()).find((s) => s.seat_number === 2)!.id };
        void loserGuest;
      }

      const maxLatency = Math.max(...latencies);
      const avgLatency = latencies.reduce((a, b) => a + b, 0) / latencies.length;
      expect(maxLatency).toBeLessThan(3000);
      console.log(`[issue #21 twelfth pass stress test] ${CYCLES} cycles: avg ${avgLatency.toFixed(0)}ms, max ${maxLatency}ms`);

      await endSpeakerSeat(eventId, { type: "guest", id: occupantA.guest_id! }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: occupantB.guest_id! }, "moderator_removed");
    },
    120_000,
  );
});
