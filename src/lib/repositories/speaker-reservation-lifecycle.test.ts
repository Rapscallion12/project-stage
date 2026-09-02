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
  releaseFailedSpeakerClaim,
} from "./speaker-requests";
import { ensureActiveSelectionRound } from "@/app/events/[id]/room/actions";

const hasServiceCredentials = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY &&
    process.env.SUPABASE_SERVICE_ROLE_KEY,
);

/**
 * Issue #21, nineteenth corrective pass: this pass's own investigation
 * asked "can a stale RTS reservation blocking a real vacancy happen
 * through normal production flows, or only through unusually rapid
 * simulator force actions?" — answered here directly, against the real
 * linked database, using ONLY real production RPCs (`claimSpeakerSeat`,
 * `endSpeakerSeat`, `requestToSpeakAsGuest`, `castSpeakerRequestVoteAsGuest`,
 * `ensureActiveSelectionRound`, `markSpeakerRequestGranted`,
 * `resetSpeakerCandidatePool`) — never the Session Simulator's own
 * bypass-claim adapters. See DECISIONS.md for the full root-cause trace;
 * summarized here: `is_current_candidate = true` is supposed to mean "a
 * still-live reservation," but a winning candidate's own row kept that
 * flag `true` forever after their claim succeeded — `resetSpeakerCandidatePool`
 * excludes the winner's own row from its bulk wipe, and defers entirely
 * (does nothing) whenever the *other* seat's own reservation is still
 * pending (the ordinary dual-replacement case). If that winner's seat
 * then becomes vacant *again* before the other seat's candidate ever
 * claims, the still-`active` (deferred) round gets reused for the new
 * vacancy, and the stale flag makes `reserve_speaker_candidates_for_seats`
 * believe that seat already has a live reservation — silently blocking
 * real selection for it. This is a genuine production sequence: two
 * different candidates' own promotion countdowns simply finishing at
 * different real times is entirely ordinary, not a race that requires
 * artificial pressure.
 */
describe.skipIf(!hasServiceCredentials)("RTS reservation lifecycle — stale-reservation-blocks-reuse (issue #21, nineteenth corrective pass)", () => {
  let service: ReturnType<typeof createServiceClient>;
  let eventId: string;

  async function activeSeats(): Promise<EventSpeaker[]> {
    const { data } = await service.from("event_speakers").select("*").eq("event_id", eventId).is("left_at", null).order("seat_number");
    return (data ?? []) as EventSpeaker[];
  }

  async function requestRow(guestId: string) {
    const { data } = await service.from("speaker_requests").select("*").eq("event_id", eventId).eq("guest_id", guestId).maybeSingle();
    return data;
  }

  async function roundStatus() {
    const { data } = await service
      .from("speaker_selection_rounds")
      .select("id, status")
      .eq("event_id", eventId)
      .order("frozen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
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
        title: "Issue #21 nineteenth corrective pass — reservation lifecycle test fixture event",
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

  /**
   * THE reproduction (Section 3) and the primary production-reachability
   * proof (Section 4.G: "one reservation completes while another vacancy
   * is still resolving") — no simulator involved anywhere in this test.
   */
  it(
    "REPRODUCTION: a winner's stale reservation must not block a later, different vacancy of the same seat while a dual-replacement round is still deferred",
    async () => {
      // Dual vacancy: both seats open at once.
      const seedA = crypto.randomUUID();
      const seedB = crypto.randomUUID();
      await claimSpeakerSeat(eventId, { type: "guest", id: seedA }, 1, "Seed A", true);
      await claimSpeakerSeat(eventId, { type: "guest", id: seedB }, 2, "Seed B", true);
      await endSpeakerSeat(eventId, { type: "guest", id: seedA }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: seedB }, "moderator_removed");
      expect(await activeSeats()).toHaveLength(0);

      // Three eligible candidates, frozen together — X and Y are the
      // top two (reserved for seat 1 and seat 2 respectively), Z is the
      // ranked-but-unreserved third — the one who must be able to
      // advance into seat 1's *second* vacancy later in this test.
      const candidateX = crypto.randomUUID();
      const { messageId: msgX, requestId: reqXId } = await requestToSpeakAsGuest(eventId, candidateX, "Candidate X", "pick me");
      const candidateY = crypto.randomUUID();
      const { messageId: msgY } = await requestToSpeakAsGuest(eventId, candidateY, "Candidate Y", "pick me too");
      const candidateZ = crypto.randomUUID();
      await requestToSpeakAsGuest(eventId, candidateZ, "Candidate Z", "pick me three");
      await castSpeakerRequestVoteAsGuest(eventId, msgX, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, msgX, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, msgX, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, msgY, crypto.randomUUID());
      await castSpeakerRequestVoteAsGuest(eventId, msgY, crypto.randomUUID());
      // Z gets zero votes — ranked third, never reserved on the first pass.

      await ensureActiveSelectionRound(eventId, await activeSeats());
      const { data: initialReservations } = await service
        .from("speaker_requests")
        .select("guest_id, reserved_seat_number")
        .eq("event_id", eventId)
        .eq("status", "pending")
        .eq("is_current_candidate", true)
        .order("reserved_seat_number");
      const bySeat = new Map(initialReservations!.map((r) => [r.reserved_seat_number, r.guest_id]));
      expect(bySeat.get(1)).toBe(candidateX);
      expect(bySeat.get(2)).toBe(candidateY);

      // X claims first — their own promotion countdown simply finished
      // before Y's. resetSpeakerCandidatePool must DEFER: Y still has a
      // live, pending reservation for the other seat.
      await claimAsAuthorizedCandidate(candidateX, 1, "Candidate X", reqXId);
      expect((await activeSeats()).find((s) => s.seat_number === 1)?.guest_id).toBe(candidateX);

      const roundAfterXClaims = await roundStatus();
      expect(roundAfterXClaims?.status).toBe("active"); // deferred, not resolved — Y is still pending

      // The actual bug, pinned directly: X's own row must not still look
      // like a live reservation once their claim has been granted.
      const xRowAfterClaim = await requestRow(candidateX);
      expect(xRowAfterClaim?.status).toBe("granted");
      expect(xRowAfterClaim?.is_current_candidate).toBe(false); // THE FIX — this was `true` before it

      // Y's own reservation must be completely untouched throughout —
      // the explicit "don't accidentally release another still-valid
      // reservation during dual replacement" caution.
      const yRowAfterXClaims = await requestRow(candidateY);
      expect(yRowAfterXClaims?.status).toBe("pending");
      expect(yRowAfterXClaims?.is_current_candidate).toBe(true);
      expect(yRowAfterXClaims?.reserved_seat_number).toBe(2);

      // Seat 1 becomes vacant AGAIN — a completely ordinary reason
      // (voluntary leave stands in for any of: disconnect, a fast
      // subsequent narrow-loss, moderator removal) — *before* Y ever
      // claims seat 2. This is the exact "one reservation completes
      // while another vacancy is still resolving" shape.
      await endSpeakerSeat(eventId, { type: "guest", id: candidateX }, "moderator_removed");
      expect(await activeSeats()).toHaveLength(0);

      // The same round is still active (still deferred, waiting on Y) —
      // freeze_speaker_candidates will return it unchanged, exactly as
      // production behaves; nothing here artificially forces a fresh
      // round.
      expect((await roundStatus())?.id).toBe(roundAfterXClaims!.id);

      // THE assertion this whole test exists for: a fresh reconciliation
      // call for the newly-reopened seat 1 must reserve Z — the next
      // eligible, still-pending, not-yet-reserved candidate — not sit
      // blocked by X's own long-consumed reservation.
      await ensureActiveSelectionRound(eventId, await activeSeats());
      const { data: reservationsAfterReopen } = await service
        .from("speaker_requests")
        .select("guest_id, reserved_seat_number")
        .eq("event_id", eventId)
        .eq("status", "pending")
        .eq("is_current_candidate", true)
        .order("reserved_seat_number");
      const bySeatAfterReopen = new Map(reservationsAfterReopen!.map((r) => [r.reserved_seat_number, r.guest_id]));
      expect(bySeatAfterReopen.get(1)).toBe(candidateZ); // THE core fix, proven end to end
      expect(bySeatAfterReopen.get(2)).toBe(candidateY); // Y's own reservation survived, completely undisturbed

      // Clean up — complete both remaining reservations.
      const zRow = await requestRow(candidateZ);
      await claimAsAuthorizedCandidate(candidateZ, 1, "Candidate Z", zRow!.id);
      const yRow = await requestRow(candidateY);
      await claimAsAuthorizedCandidate(candidateY, 2, "Candidate Y", yRow!.id);
      await endSpeakerSeat(eventId, { type: "guest", id: candidateZ }, "moderator_removed");
      await endSpeakerSeat(eventId, { type: "guest", id: candidateY }, "moderator_removed");
    },
    30_000,
  );

  /** Section 4.B/C, Section 11.2/11.3: withdrawal and Cancel/Not Now are the same server RPC (`withdraw_speaker_request(_as_guest)`) — already correctly seat-scoped; pinned here specifically alongside the consumption fix to prove the two don't interact badly. Seat 2 stays stably occupied throughout so exactly one seat (seat 1) is genuinely open — a dual-open-seat setup would legitimately reserve *both* candidates at once (proven separately above), which isn't what this test is about. */
  it("a reserved candidate withdrawing (Cancel / Not Now) advances the next-ranked candidate into the same seat, and a subsequently-granted claim still consumes its own reservation correctly", async () => {
    const seedA = crypto.randomUUID();
    const stableSeat2 = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: seedA }, 1, "Seed A", true);
    await claimSpeakerSeat(eventId, { type: "guest", id: stableSeat2 }, 2, "Stable Seat 2", true);
    await endSpeakerSeat(eventId, { type: "guest", id: seedA }, "moderator_removed");

    const candidateA = crypto.randomUUID();
    const { messageId: msgA } = await requestToSpeakAsGuest(eventId, candidateA, "Withdraw Candidate A", "pick me");
    const candidateB = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, candidateB, "Withdraw Candidate B", "pick me too");
    await castSpeakerRequestVoteAsGuest(eventId, msgA, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, msgA, crypto.randomUUID());

    await ensureActiveSelectionRound(eventId, await activeSeats());
    const reservedA = await requestRow(candidateA);
    expect(reservedA?.is_current_candidate).toBe(true);
    expect(reservedA?.reserved_seat_number).toBe(1);

    // Cancel / Not Now — the guest withdrawal RPC, same call
    // `useAutomaticPromotion`'s `cancel()` makes for a real account
    // holder's own equivalent.
    await service.rpc("withdraw_speaker_request_as_guest", { p_event_id: eventId, p_guest_id: candidateA });

    const reservedB = await requestRow(candidateB);
    expect(reservedB?.is_current_candidate).toBe(true);
    expect(reservedB?.reserved_seat_number).toBe(1); // advanced into the SAME seat A was reserved for

    await claimAsAuthorizedCandidate(candidateB, 1, "Withdraw Candidate B", reservedB!.id);
    const bAfterClaim = await requestRow(candidateB);
    expect(bAfterClaim?.is_current_candidate).toBe(false); // consumption fix applies here too

    await endSpeakerSeat(eventId, { type: "guest", id: candidateB }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: stableSeat2 }, "moderator_removed");
  });

  /** Section 4.H, Section 11: a claim that fails after authorization (a genuine race) must not leave a stale blocker either — pins `releaseFailedSpeakerClaim`'s own interaction with the fix. Seat 2 stays stably occupied so only seat 1 is genuinely open — same reasoning as the withdrawal test above. */
  it("a candidate whose authorized claim fails (release_failed_speaker_claim) does not leave a stale reservation, and the next candidate can still be reserved afterward", async () => {
    const seedA = crypto.randomUUID();
    const stableSeat2 = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: seedA }, 1, "Seed A", true);
    await claimSpeakerSeat(eventId, { type: "guest", id: stableSeat2 }, 2, "Stable Seat 2", true);
    await endSpeakerSeat(eventId, { type: "guest", id: seedA }, "moderator_removed");

    const candidateA = crypto.randomUUID();
    const { messageId: msgA } = await requestToSpeakAsGuest(eventId, candidateA, "Fail Candidate A", "pick me");
    const candidateB = crypto.randomUUID();
    await requestToSpeakAsGuest(eventId, candidateB, "Fail Candidate B", "pick me too");
    await castSpeakerRequestVoteAsGuest(eventId, msgA, crypto.randomUUID());
    await castSpeakerRequestVoteAsGuest(eventId, msgA, crypto.randomUUID());

    await ensureActiveSelectionRound(eventId, await activeSeats());
    const reservedA = await requestRow(candidateA);
    expect(reservedA?.reserved_seat_number).toBe(1);

    // Simulate the genuine race release_failed_speaker_claim exists for
    // — authorized, but the seat claim itself fails (e.g. taken by
    // something else in between). Never actually mutates event_speakers
    // here — the point is the reservation-release path alone.
    await releaseFailedSpeakerClaim(reservedA!.id);

    const aAfterFailure = await requestRow(candidateA);
    expect(aAfterFailure?.is_current_candidate).toBe(false);
    expect(aAfterFailure?.reserved_seat_number).toBeNull();

    const reservedB = await requestRow(candidateB);
    expect(reservedB?.is_current_candidate).toBe(true);
    expect(reservedB?.reserved_seat_number).toBe(1);

    await claimAsAuthorizedCandidate(candidateB, 1, "Fail Candidate B", reservedB!.id);
    await endSpeakerSeat(eventId, { type: "guest", id: candidateB }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: stableSeat2 }, "moderator_removed");
  });

  /** Section 4.I: production's own authorization gate must still reject a third party trying to claim a seat that already has a live reservation for someone else — the fix must never weaken this. */
  it("a third party cannot claim a seat that already has a live reservation for a different candidate", async () => {
    const seedA = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: seedA }, 1, "Seed A", true);
    await endSpeakerSeat(eventId, { type: "guest", id: seedA }, "moderator_removed");

    const candidateA = crypto.randomUUID();
    const { messageId: msgA } = await requestToSpeakAsGuest(eventId, candidateA, "Guard Candidate A", "pick me");
    await castSpeakerRequestVoteAsGuest(eventId, msgA, crypto.randomUUID());
    await ensureActiveSelectionRound(eventId, await activeSeats());

    const intruder = crypto.randomUUID();
    await expect(claimSpeakerSeat(eventId, { type: "guest", id: intruder }, 1, "Intruder")).rejects.toThrow(/selection authorization/);

    const reservedA = await requestRow(candidateA);
    await claimAsAuthorizedCandidate(candidateA, 1, "Guard Candidate A", reservedA!.id);
    await endSpeakerSeat(eventId, { type: "guest", id: candidateA }, "moderator_removed");
  });

  /** Section 11.7: a request can only ever be reserved for one seat at a time — a structural, not merely observed, guarantee (`reserved_seat_number` is a single scalar column). */
  it("a single request row is never simultaneously reserved for both seats", async () => {
    const seedA = crypto.randomUUID();
    const seedB = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: seedA }, 1, "Seed A", true);
    await claimSpeakerSeat(eventId, { type: "guest", id: seedB }, 2, "Seed B", true);
    await endSpeakerSeat(eventId, { type: "guest", id: seedA }, "moderator_removed");
    await endSpeakerSeat(eventId, { type: "guest", id: seedB }, "moderator_removed");

    const candidate = crypto.randomUUID();
    const { messageId } = await requestToSpeakAsGuest(eventId, candidate, "Solo Candidate", "pick me");
    await castSpeakerRequestVoteAsGuest(eventId, messageId, crypto.randomUUID());

    // Both seats open, only one eligible candidate — reserved for
    // exactly one of them, never both.
    await ensureActiveSelectionRound(eventId, await activeSeats());
    const row = await requestRow(candidate);
    expect(row?.is_current_candidate).toBe(true);
    expect([1, 2]).toContain(row?.reserved_seat_number);

    const { data: allReservationsForThisRequest } = await service
      .from("speaker_requests")
      .select("reserved_seat_number")
      .eq("id", row!.id);
    expect(allReservationsForThisRequest).toHaveLength(1); // one row, one reserved_seat_number value — structurally impossible to be both

    await claimAsAuthorizedCandidate(candidate, row!.reserved_seat_number as 1 | 2, "Solo Candidate", row!.id);
    await endSpeakerSeat(eventId, { type: "guest", id: candidate }, "moderator_removed");
    // The other seat never got a reservation — clean up its own leftover none.
  });

  /** Section 11.8: calling ensureActiveSelectionRound again immediately, with no state change in between, is a true no-op — idempotent, safe to call from every connected client's own reconciliation poll. */
  it("duplicate reconciliation calls (no state change in between) are idempotent", async () => {
    const seedA = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: seedA }, 1, "Seed A", true);
    await endSpeakerSeat(eventId, { type: "guest", id: seedA }, "moderator_removed");

    const candidate = crypto.randomUUID();
    const { messageId } = await requestToSpeakAsGuest(eventId, candidate, "Idempotent Candidate", "pick me");
    await castSpeakerRequestVoteAsGuest(eventId, messageId, crypto.randomUUID());

    await ensureActiveSelectionRound(eventId, await activeSeats());
    const first = await requestRow(candidate);

    await ensureActiveSelectionRound(eventId, await activeSeats());
    await ensureActiveSelectionRound(eventId, await activeSeats());
    const afterRepeats = await requestRow(candidate);

    expect(afterRepeats).toEqual(first); // byte-for-byte unchanged across repeated calls

    await claimAsAuthorizedCandidate(candidate, 1, "Idempotent Candidate", first!.id);
    await endSpeakerSeat(eventId, { type: "guest", id: candidate }, "moderator_removed");
  });

  /** Section 11.9, Section 4.J: several genuinely concurrent reconciliation calls racing a real claim must never cost the legitimate claimant their own already-successful reservation. */
  it("concurrent reconciliation calls racing a real claim never undo the claimant's own successful reservation", async () => {
    const seedA = crypto.randomUUID();
    await claimSpeakerSeat(eventId, { type: "guest", id: seedA }, 1, "Seed A", true);
    await endSpeakerSeat(eventId, { type: "guest", id: seedA }, "moderator_removed");

    const candidate = crypto.randomUUID();
    const { messageId } = await requestToSpeakAsGuest(eventId, candidate, "Concurrent Candidate", "pick me");
    await castSpeakerRequestVoteAsGuest(eventId, messageId, crypto.randomUUID());
    await ensureActiveSelectionRound(eventId, await activeSeats());
    const reserved = await requestRow(candidate);

    // The claim itself, racing several concurrent reconciliation calls —
    // none of which should observe or create a second, competing
    // reservation for the same now-occupied seat.
    await Promise.all([
      claimAsAuthorizedCandidate(candidate, 1, "Concurrent Candidate", reserved!.id),
      ensureActiveSelectionRound(eventId, await activeSeats()),
      ensureActiveSelectionRound(eventId, await activeSeats()),
    ]);

    const finalSeats = await activeSeats();
    expect(finalSeats.find((s) => s.seat_number === 1)?.guest_id).toBe(candidate);
    const finalRow = await requestRow(candidate);
    expect(finalRow?.status).toBe("granted");

    await endSpeakerSeat(eventId, { type: "guest", id: candidate }, "moderator_removed");
  });
});
