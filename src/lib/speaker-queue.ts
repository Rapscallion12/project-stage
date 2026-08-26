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
 * **Replaces the earlier "top-3 self-claim race" model outright**
 * (see this file's git history and DECISIONS.md): that design's own doc
 * comment already called it a placeholder — "not meant to make this a
 * click-speed competition by product intent... may evolve into
 * something more deliberately audience-driven." It now reads one
 * already-computed fact instead of re-deriving eligibility from a
 * ranking: whether the caller's own pending request is the *currently
 * selected* candidate of an active weighted-random selection round (see
 * `lib/speaker-selection.ts` for how that pick is made, and
 * `resolveClaimDecision` in room/actions.ts for how the round itself
 * gets created/ensured before this runs). No identity-matching against a
 * ranked list is needed here anymore — the caller already fetched their
 * *own* request row.
 */
export function decideClaimEligibility(params: {
  /** The caller's own pending request row, or null if they have none. Only `is_current_candidate` is read — the caller already scoped this to their own identity. */
  myPendingRequest: { is_current_candidate: boolean } | null;
  activeSpeakers: Pick<EventSpeaker, "seat_number">[];
}): ClaimDecision {
  if (!params.myPendingRequest) {
    return { eligible: false, reason: "no-request" };
  }

  const seatNumber = findOpenSeat(params.activeSpeakers);
  if (seatNumber === null) {
    return { eligible: false, reason: "no-open-seat" };
  }

  if (!params.myPendingRequest.is_current_candidate) {
    return { eligible: false, reason: "not-eligible" };
  }

  return { eligible: true, seatNumber };
}
