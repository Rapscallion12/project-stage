import type { EventSpeaker, SeatIdentity } from "@/lib/repositories/event-speakers";
import type { RankedSpeakerRequest } from "@/lib/repositories/speaker-requests";

/**
 * How many top-ranked pending requests are eligible to self-claim an open
 * seat — not strictly rank 1. This is an explicit **MVP selection
 * policy, not a permanent product rule**.
 *
 * A strict "only rank 1 may claim" rule has a real failure mode: an
 * absent top-ranked requester would block the seat forever — there's no
 * background-job infrastructure in this serverless setup to expire or
 * skip them. Widening eligibility to the top few, with
 * `claim_speaker_seat`'s own existing race-safety (issue #13) as the
 * tiebreak if more than one eligible requester claims at once, solves
 * that without adding any new infrastructure (no expiry timers, no
 * presence tracking).
 *
 * This is not meant to make "who becomes the next speaker" a
 * click-speed competition by product intent — only by current
 * implementation. The durable concepts this stands in for: audience
 * support determines which requests rise (already true — ranking is
 * reaction-count-driven, see `rank_pending_speaker_requests`), only
 * sufficiently elevated requests become eligible (already true — this
 * constant), and the final promotion mechanism among eligible requests
 * may evolve into something more deliberately audience-driven than
 * "first click wins." See DECISIONS.md.
 */
export const TOP_ELIGIBLE_COUNT = 3;

export function isEligibleToClaim(rank: number): boolean {
  return rank <= TOP_ELIGIBLE_COUNT;
}

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
 * The actual authorization decision behind `claimOpenSeat` (the Server
 * Action in room/actions.ts) — extracted as a pure function, over
 * already-fetched data, so it's unit-testable without a live LiveKit/DB
 * fixture or a Next.js request context (the action itself can't be
 * called directly in a test the way this can, since `resolveIdentity()`
 * needs `next/headers`' `cookies()`). Same reasoning as
 * `determineCanPublish`/`shouldPublish`/`applySpeakerChange` elsewhere in
 * this codebase: keep the decision pure, keep the I/O in a thin wrapper.
 */
export function decideClaimEligibility(params: {
  /** Issue #16: either identity shape — a guest's own requests are matched by guest_id, never profile_id. */
  identity: SeatIdentity;
  hasPendingRequest: boolean;
  activeSpeakers: Pick<EventSpeaker, "seat_number">[];
  rankedRequests: Pick<RankedSpeakerRequest, "profile_id" | "guest_id" | "rank">[];
}): ClaimDecision {
  if (!params.hasPendingRequest) {
    return { eligible: false, reason: "no-request" };
  }

  const seatNumber = findOpenSeat(params.activeSpeakers);
  if (seatNumber === null) {
    return { eligible: false, reason: "no-open-seat" };
  }

  const myEntry = params.rankedRequests.find((r) =>
    params.identity.type === "profile" ? r.profile_id === params.identity.id : r.guest_id === params.identity.id,
  );
  if (!myEntry || !isEligibleToClaim(myEntry.rank)) {
    return { eligible: false, reason: "not-eligible" };
  }

  return { eligible: true, seatNumber };
}
