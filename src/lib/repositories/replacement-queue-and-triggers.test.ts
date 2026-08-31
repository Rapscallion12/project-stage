// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, endSpeakerSeat, leaveSpeakerSeatAsGuest, listActiveSpeakersAuthoritative } from "./event-speakers";
import type { EventSpeaker } from "./event-speakers";
import {
  requestToSpeakAsGuest,
  castSpeakerRequestVoteAsGuest,
  withdrawSpeakerRequestAsGuest,
  markSpeakerRequestGranted,
  resetSpeakerCandidatePool,
  releaseFailedSpeakerClaim,
} from "./speaker-requests";
import { ensureActiveSelectionRound } from "@/app/events/[id]/room/actions";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, tenth corrective pass: a real-device report found a
 * currently-active session (two occupied seats, two eligible RTS
 * requesters, correctly ordered by vote count) whose selection
 * diagnostics showed no live replacement queue and "no candidate
 * selection in progress" — a real diagnostics-clarity gap (fixed in
 * `session-simulator-panel.tsx`), but the report also asked for a
 * broader audit: every state transition that can produce "vacant
 * fillable seat + eligible RTS + no valid reservation" should
 * authoritatively reconcile immediately, not just the round boundary
 * the ninth pass already fixed.
 *
 * This file proves the underlying mechanism each new trigger point
 * (`leaveSpeakerSeat`, `checkAndEvictInactiveSpeaker`, `requestToSpeak`,
 * `withdrawSpeakerRequest`, `claimOpenSeat`'s failed-claim path — all in
 * `room/actions.ts`) now calls: `ensureActiveSelectionRound` fed by the
 * service-client `listActiveSpeakersAuthoritative`, exactly what
 * `bestEffortReconcileSelection` (that file's own private helper) does
 * internally. The Server Actions themselves wrap `resolveIdentity()`
 * (real cookies, real Next.js request context) and so can't be called
 * directly from a bare test script — same constraint the ninth pass's
 * own test file worked around for `resolveStageRoundAction`, and the
 * same reason this file exercises the mechanism through its own
 * exported, service-client-safe building blocks instead. The Server
 * Action wiring itself (that each of those five functions actually
 * calls this mechanism at the right moment) is verified by direct code
 * reading and real-browser testing — see this pass's own handoff.
 */
describe.skipIf(!hasServiceCredentials)("replacement queue and selection-trigger matrix (issue #21, tenth corrective pass)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeSeats(): Promise<EventSpeaker[]> {
    return listActiveSpeakersAuthoritative(eventId);
  }

  async function reservedCandidate(seatNumber: 1 | 2): Promise<{ id: string; guest_id: string | null; selection_round_id: string | null } | null> {
    const { data } = await service
      .from("speaker_requests")
      .select("id, guest_id, selection_round_id")
      .eq("event_id", eventId)
      .eq("status", "pending")
      .eq("is_current_candidate", true)
      .eq("reserved_seat_number", seatNumber)
      .maybeSingle();
    return data;
  }

  async function pendingStatus(requestId: string): Promise<{ status: string; is_current_candidate: boolean; selection_failed: boolean } | null> {
    const { data } = await service.from("speaker_requests").select("status, is_current_candidate, selection_failed").eq("id", requestId).maybeSingle();
    return data;
  }

  async function reconcile(): Promise<void> {
    await ensureActiveSelectionRound(eventId, await activeSeats());
  }

  beforeAll(async () => {
    service = createServiceClient();
    const { data: event, error } = await service
      .from("events")
      .insert({
        title: "Issue #21 tenth corrective pass — replacement queue fixture event",
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

  // Defensive isolation: each test cleans up fully at its own end, but a
  // test that fails mid-way (an assertion, or a genuine bug) must never
  // leave stray occupied seats or pending requests to silently poison a
  // *later* test sharing this same event — this sweep makes every test
  // start from a guaranteed-clean slate regardless of how the previous
  // one ended.
  beforeEach(async () => {
    const seats = await activeSeats();
    for (const s of seats) {
      await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id! }, "moderator_removed");
    }
    await service.from("speaker_requests").update({ status: "withdrawn", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "pending");
    // A raw bulk status update (above) bypasses the withdraw RPC's own
    // "mark this round exhausted" check (migration 00000000000038) —
    // without also closing out a still-`active` round directly here,
    // `freeze_speaker_candidates`' own idempotent "reuse the existing
    // active round" branch would keep reusing a round whose every
    // candidate this sweep just withdrew out from under it, silently
    // reserving nothing for every later test in this file. Real product
    // code never needs this (it always withdraws through the real RPC,
    // one request at a time); this bulk sweep does.
    await service.from("speaker_selection_rounds").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "active");
  });

  it(
    "trigger-matrix B: a request arriving after a vacancy already exists is reserved by the same reconciliation call the real trigger point makes",
    async () => {
      const occupant = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Seed", true);
      // Seat 2 stays vacant — no request exists yet.
      const guestId = crypto.randomUUID();
      const { requestId } = await requestToSpeakAsGuest(eventId, guestId, "Late Arrival", "can I speak?");

      await reconcile();

      const reserved = await reservedCandidate(2);
      expect(reserved).not.toBeNull();
      expect(reserved!.id).toBe(requestId);
      expect(reserved!.guest_id).toBe(guestId);

      await endSpeakerSeat(eventId, { type: "guest", id: occupant.guest_id! }, "moderator_removed");
    },
    30_000,
  );

  it(
    "trigger-matrix C/D: a vacancy occurring after a request already exists is reserved once the vacancy-creating action's own reconciliation runs",
    async () => {
      const occupant = await claimSpeakerSeat(eventId, { type: "guest", id: crypto.randomUUID() }, 1, "Seed", true);
      const guestId = crypto.randomUUID();
      const { requestId } = await requestToSpeakAsGuest(eventId, guestId, "Early Bird", "waiting patiently");
      // Nothing to reserve them into yet — seat 1 is occupied, seat 2 was
      // never claimed this test.

      // Now the vacancy: exactly what `leaveSpeakerSeat`'s own
      // reconciliation call would run immediately after.
      await leaveSpeakerSeatAsGuest(eventId, occupant.guest_id!);
      await reconcile();

      const reserved = await reservedCandidate(1);
      expect(reserved).not.toBeNull();
      expect(reserved!.id).toBe(requestId);
    },
    30_000,
  );

  it(
    "trigger-matrix L (two empty seats + one candidate): reserved for one seat immediately; the other stays open, not blocked waiting for a second candidate",
    async () => {
      const guestId = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, guestId, "Solo Candidate", "just me");

      await reconcile();

      const seat1 = await reservedCandidate(1);
      const seat2 = await reservedCandidate(2);
      const reservedCount = [seat1, seat2].filter((r) => r !== null).length;
      expect(reservedCount).toBe(1);
      const winner = seat1 ?? seat2;
      expect(winner!.guest_id).toBe(guestId);
    },
    30_000,
  );

  it(
    "trigger-matrix I/J/K (two empty seats + three candidates): the top two are reserved for the two seats; the third remains an ordered fallback, not disturbed",
    async () => {
      const cGuest = crypto.randomUUID();
      const { messageId: cMsg, requestId: cReq } = await requestToSpeakAsGuest(eventId, cGuest, "Candidate C", "pick me");
      const dGuest = crypto.randomUUID();
      const { messageId: dMsg, requestId: dReq } = await requestToSpeakAsGuest(eventId, dGuest, "Candidate D", "and me");
      const eGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, eGuest, "Candidate E", "fallback");

      // C: 3 votes, D: 2 votes, E: 0 votes — deterministic, no ties.
      for (let i = 0; i < 3; i++) await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());
      for (let i = 0; i < 2; i++) await castSpeakerRequestVoteAsGuest(eventId, dMsg, crypto.randomUUID());

      await reconcile();

      const seat1 = await reservedCandidate(1);
      const seat2 = await reservedCandidate(2);
      const reservedIds = [seat1?.id, seat2?.id].filter(Boolean);
      expect(reservedIds).toContain(cReq);
      expect(reservedIds).toContain(dReq);

      const eStatus = await service
        .from("speaker_requests")
        .select("status, is_current_candidate, guest_id")
        .eq("event_id", eventId)
        .eq("guest_id", eGuest)
        .single();
      expect(eStatus.data?.status).toBe("pending");
      expect(eStatus.data?.is_current_candidate).toBe(false);

      // --- Section 11/12: the selected candidate for seat 1 cancels
      // (withdraws) — E should advance into their vacated reservation,
      // D's own valid reservation for seat 2 must be completely
      // undisturbed.
      const seat1RequestId = seat1!.id;
      const seat1WasGuest = seat1!.guest_id === cGuest ? cGuest : dGuest;
      const seat1SeatNumber: 1 | 2 = seat1!.id === (await reservedCandidate(1))!.id ? 1 : 2;
      void seat1RequestId;
      await withdrawSpeakerRequestAsGuest(eventId, seat1WasGuest);

      const otherSeatNumber = seat1SeatNumber === 1 ? 2 : 1;
      const otherStillReserved = await reservedCandidate(otherSeatNumber);
      expect(otherStillReserved).not.toBeNull();
      expect(otherStillReserved!.id).not.toBe(seat1RequestId);
      // The other seat's own occupant is whichever of C/D didn't cancel —
      // completely unaffected by seat1's cancellation.
      const remainingWinnerGuest = seat1WasGuest === cGuest ? dGuest : cGuest;
      expect(otherStillReserved!.guest_id).toBe(remainingWinnerGuest);

      const advanced = await reservedCandidate(seat1SeatNumber);
      expect(advanced).not.toBeNull();
      expect(advanced!.guest_id).toBe(eGuest);

      // Clean up: claim both remaining reservations so this event ends
      // in a clean, fully-occupied state for isolation from other tests.
      const finalSeat1 = await reservedCandidate(1);
      const finalSeat2 = await reservedCandidate(2);
      for (const [seatNumber, reserved] of [
        [1, finalSeat1],
        [2, finalSeat2],
      ] as const) {
        if (!reserved) continue;
        await claimSpeakerSeat(eventId, { type: "guest", id: reserved.guest_id! }, seatNumber, "cleanup", true);
        await markSpeakerRequestGranted(reserved.id);
        await resetSpeakerCandidatePool(eventId, reserved.id);
      }
      const remaining = await activeSeats();
      for (const s of remaining) {
        await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id! }, "moderator_removed");
      }
    },
    30_000,
  );

  it(
    "trigger-matrix H (failed claim): releases the reservation and advances the next-ranked candidate, without disturbing the other seat, and without permanently disqualifying the failed candidate from a later independent round",
    async () => {
      const cGuest = crypto.randomUUID();
      const { messageId: cMsg, requestId: cReq } = await requestToSpeakAsGuest(eventId, cGuest, "Will Fail", "pick me");
      const dGuest = crypto.randomUUID();
      const { messageId: dMsg } = await requestToSpeakAsGuest(eventId, dGuest, "Stays Valid", "and me");
      const eGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, eGuest, "Advances", "fallback");

      await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, dMsg, crypto.randomUUID());

      await reconcile();
      const cSeatReservation = (await reservedCandidate(1))?.id === cReq ? 1 : 2;
      const dSeatNumber = cSeatReservation === 1 ? 2 : 1;

      // The claim itself failing (a genuine race) — exactly what
      // `claimOpenSeat`'s catch block calls.
      await releaseFailedSpeakerClaim(cReq);

      const cStatus = await pendingStatus(cReq);
      expect(cStatus?.status).toBe("pending"); // never withdrawn — a claim failure is not a withdrawal
      expect(cStatus?.is_current_candidate).toBe(false);
      expect(cStatus?.selection_failed).toBe(false); // deliberately not permanently disqualified — see migration 00000000000039

      const advanced = await reservedCandidate(cSeatReservation);
      expect(advanced).not.toBeNull();
      expect(advanced!.guest_id).toBe(eGuest);

      const dStillReserved = await reservedCandidate(dSeatNumber);
      expect(dStillReserved).not.toBeNull();
      expect(dStillReserved!.guest_id).toBe(dGuest);

      // Clean up E's and D's seats *without* going through
      // `resetSpeakerCandidatePool` — that function's own bulk-expire is
      // deliberately event-wide, not round-scoped (a pre-existing, already
      // -flagged open question from the eighth pass's own DECISIONS.md
      // entry, unrelated to and not resolved by this pass) and would sweep
      // up C's still-`pending`, not-yet-re-eligible row as a side effect
      // of D's own claim completing — a real, demonstrated interaction,
      // but not what *this* assertion is about. Ending the round directly
      // (the same raw-cleanup pattern this file's own `beforeEach` already
      // uses) achieves the same "this round is over" state without that
      // side effect.
      for (const [seatNumber, reserved] of [
        [cSeatReservation, advanced],
        [dSeatNumber, dStillReserved],
      ] as const) {
        await claimSpeakerSeat(eventId, { type: "guest", id: reserved!.guest_id! }, seatNumber, "cleanup", true);
        await markSpeakerRequestGranted(reserved!.id);
      }
      await service.from("speaker_selection_rounds").update({ status: "resolved", resolved_at: new Date().toISOString() }).eq("event_id", eventId).eq("status", "active");

      const remaining = await activeSeats();
      for (const s of remaining) {
        await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id! }, "moderator_removed");
      }
      // cReq's own row is still 'pending' (never claimed, never
      // withdrawn) — give it more votes than anything else currently
      // pending so it would legitimately win a fresh round on the
      // merits, then prove it's actually allowed to.
      await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, cMsg, crypto.randomUUID());
      await reconcile();
      const wonAgain = (await reservedCandidate(1)) ?? (await reservedCandidate(2));
      expect(wonAgain).not.toBeNull();
      expect(wonAgain!.id).toBe(cReq);

      await claimSpeakerSeat(eventId, { type: "guest", id: cGuest }, 1, "cleanup", true);
      await markSpeakerRequestGranted(cReq);
      const finalSeats = await activeSeats();
      for (const s of finalSeats) {
        await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id! }, "moderator_removed");
      }
    },
    30_000,
  );

  it(
    "queue tie test (Section 43): multiple zero-vote candidates order by earliest still-active request, not insertion order or randomness",
    async () => {
      const aGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, aGuest, "Zero Vote A", "first");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const bGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, bGuest, "Zero Vote B", "second");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cGuest = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, cGuest, "Zero Vote C", "third");

      await reconcile();
      const winner = (await reservedCandidate(1)) ?? (await reservedCandidate(2));
      expect(winner).not.toBeNull();
      expect(winner!.guest_id).toBe(aGuest);

      await claimSpeakerSeat(eventId, { type: "guest", id: aGuest }, 1, "cleanup", true);
      await markSpeakerRequestGranted(winner!.id);
      await resetSpeakerCandidatePool(eventId, winner!.id);
      const remaining = await activeSeats();
      for (const s of remaining) {
        await endSpeakerSeat(eventId, { type: "guest", id: s.guest_id! }, "moderator_removed");
      }
    },
    30_000,
  );
});
