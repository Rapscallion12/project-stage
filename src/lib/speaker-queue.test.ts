import { describe, expect, it } from "vitest";
import { decideClaimEligibility, findOpenSeat, isEligibleToClaim, TOP_ELIGIBLE_COUNT } from "./speaker-queue";

describe("findOpenSeat", () => {
  it("is seat 1 when nothing is occupied", () => {
    expect(findOpenSeat([])).toBe(1);
  });

  it("is seat 2 when only seat 1 is occupied", () => {
    expect(findOpenSeat([{ seat_number: 1 }])).toBe(2);
  });

  it("is seat 1 when only seat 2 is occupied", () => {
    expect(findOpenSeat([{ seat_number: 2 }])).toBe(1);
  });

  it("is null when both seats are occupied", () => {
    expect(findOpenSeat([{ seat_number: 1 }, { seat_number: 2 }])).toBeNull();
  });
});

describe("isEligibleToClaim", () => {
  it("is eligible at and inside the top-N boundary", () => {
    for (let rank = 1; rank <= TOP_ELIGIBLE_COUNT; rank++) {
      expect(isEligibleToClaim(rank)).toBe(true);
    }
  });

  it("is not eligible just past the boundary", () => {
    expect(isEligibleToClaim(TOP_ELIGIBLE_COUNT + 1)).toBe(false);
  });
});

describe("decideClaimEligibility — the actual authorization gate claimOpenSeat relies on", () => {
  const baseParams = {
    identity: { type: "profile" as const, id: "p1" },
    hasPendingRequest: true,
    activeSpeakers: [{ seat_number: 1 as const }], // seat 2 open
    rankedRequests: [{ profile_id: "p1", guest_id: null, rank: 1 }],
  };

  it("rejects a caller with no pending request, even if they'd otherwise be eligible", () => {
    const decision = decideClaimEligibility({ ...baseParams, hasPendingRequest: false });
    expect(decision).toEqual({ eligible: false, reason: "no-request" });
  });

  it("rejects when both seats are full", () => {
    const decision = decideClaimEligibility({
      ...baseParams,
      activeSpeakers: [{ seat_number: 1 as const }, { seat_number: 2 as const }],
    });
    expect(decision).toEqual({ eligible: false, reason: "no-open-seat" });
  });

  it("rejects a caller ranked outside the top eligible requests", () => {
    const decision = decideClaimEligibility({
      ...baseParams,
      rankedRequests: [
        { profile_id: "a", guest_id: null, rank: 1 },
        { profile_id: "b", guest_id: null, rank: 2 },
        { profile_id: "c", guest_id: null, rank: 3 },
        { profile_id: "p1", guest_id: null, rank: 4 },
      ],
    });
    expect(decision).toEqual({ eligible: false, reason: "not-eligible" });
  });

  it("rejects a caller who isn't in the ranking at all (a data inconsistency, not just low rank)", () => {
    const decision = decideClaimEligibility({
      ...baseParams,
      rankedRequests: [{ profile_id: "someone-else", guest_id: null, rank: 1 }],
    });
    expect(decision).toEqual({ eligible: false, reason: "not-eligible" });
  });

  it("allows a caller ranked within the top eligible requests, for the open seat", () => {
    const decision = decideClaimEligibility({
      ...baseParams,
      rankedRequests: [
        { profile_id: "a", guest_id: null, rank: 1 },
        { profile_id: "p1", guest_id: null, rank: 2 },
      ],
    });
    expect(decision).toEqual({ eligible: true, seatNumber: 2 });
  });

  it("picks the lowest-numbered open seat when both are free", () => {
    const decision = decideClaimEligibility({ ...baseParams, activeSpeakers: [] });
    expect(decision).toEqual({ eligible: true, seatNumber: 1 });
  });

  describe("guest identities (issue #16)", () => {
    const guestBaseParams = {
      identity: { type: "guest" as const, id: "g1" },
      hasPendingRequest: true,
      activeSpeakers: [{ seat_number: 1 as const }], // seat 2 open
    };

    it("matches a guest's own ranked entry by guest_id, never profile_id", () => {
      const decision = decideClaimEligibility({
        ...guestBaseParams,
        rankedRequests: [
          { profile_id: "a", guest_id: null, rank: 1 },
          { profile_id: null, guest_id: "g1", rank: 2 },
        ],
      });
      expect(decision).toEqual({ eligible: true, seatNumber: 2 });
    });

    it("rejects a guest whose id doesn't appear in the ranking, even if some profile shares the same rank position", () => {
      const decision = decideClaimEligibility({
        ...guestBaseParams,
        rankedRequests: [{ profile_id: "g1", guest_id: null, rank: 1 }], // same string value, wrong column — must not match
      });
      expect(decision).toEqual({ eligible: false, reason: "not-eligible" });
    });
  });
});
