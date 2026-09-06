import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * The lowest-numbered currently-unoccupied seat, or `null` if both are
 * taken. Pure function over already-fetched occupancy, same reasoning as
 * `determineCanPublish` — testable without a live fixture.
 */
export function findOpenSeat(activeSpeakers: Pick<EventSpeaker, "seat_number">[]): 1 | 2 | null {
  const occupied = new Set(activeSpeakers.map((s) => s.seat_number));
  if (!occupied.has(1)) return 1;
  if (!occupied.has(2)) return 2;
  return null;
}

/**
 * Issue #21, fifth corrective pass: every currently-open seat, not just
 * the lowest-numbered one — the seat-aware selection model
 * (`ensureActiveSelectionRound`, room/actions.ts) needs to reserve a
 * distinct candidate for *each* open seat, not just the first. Returns
 * `[]` when both are occupied, `[1]`/`[2]` when exactly one is open,
 * `[1, 2]` when both are.
 */
export function findOpenSeats(activeSpeakers: Pick<EventSpeaker, "seat_number">[]): Array<1 | 2> {
  const occupied = new Set(activeSpeakers.map((s) => s.seat_number));
  const open: Array<1 | 2> = [];
  if (!occupied.has(1)) open.push(1);
  if (!occupied.has(2)) open.push(2);
  return open;
}

export type ClaimDecision =
  | { eligible: true; seatNumber: 1 | 2 }
  | { eligible: false; reason: "no-request" | "no-open-seat" | "not-eligible" };

/**
 * Issue #21, Phase 1: the actual authorization decision behind
 * `claimOpenSeat` — extracted as a pure function, same reasoning as
 * `determineCanPublish`/`shouldPublish`/`applySpeakerChange` elsewhere in
 * this codebase (keep the decision pure, keep the I/O in a thin
 * wrapper). Testable without a live DB fixture or Next.js request
 * context.
 *
 * **Issue #21, fifth corrective pass: seat-aware, not "whichever seat
 * `findOpenSeat` currently reports."** With two seats able to open
 * simultaneously, each candidate is now reserved for a *specific* seat
 * server-side (`speaker_requests.reserved_seat_number` — see migration
 * 00000000000032) at selection time. Reading `myPendingRequest`'s own
 * `reserved_seat_number` instead of re-deriving "the" open seat from
 * current occupancy is what closes the exact race two simultaneously-
 * eligible candidates used to hit: both independently calling
 * `findOpenSeat` against the same occupancy snapshot would always agree
 * on the *same* lowest-numbered seat, regardless of which of them was
 * actually authorized for which — one would win, the other would fail
 * and have to retry. Each candidate now goes straight for their own
 * authoritatively-assigned seat, no retry needed, and `claim_speaker_seat`
 * itself re-verifies the match (never trusted from this decision alone).
 */
export function decideClaimEligibility(params: {
  /** The caller's own pending request row, or null if they have none. */
  myPendingRequest: { is_current_candidate: boolean; reserved_seat_number: 1 | 2 | null } | null;
  activeSpeakers: Pick<EventSpeaker, "seat_number">[];
}): ClaimDecision {
  if (!params.myPendingRequest) {
    return { eligible: false, reason: "no-request" };
  }

  if (!params.myPendingRequest.is_current_candidate || params.myPendingRequest.reserved_seat_number === null) {
    return { eligible: false, reason: "not-eligible" };
  }

  const seatNumber = params.myPendingRequest.reserved_seat_number;
  const occupied = new Set(params.activeSpeakers.map((s) => s.seat_number));
  if (occupied.has(seatNumber)) {
    // The reserved seat isn't actually open anymore (stale read, or a
    // narrow window before withdrawal/reset catches up) — never blindly
    // hand out a seat number occupancy itself contradicts.
    return { eligible: false, reason: "no-open-seat" };
  }

  return { eligible: true, seatNumber };
}
