import { describe, expect, it } from "vitest";
import { decideClaimEligibility, findOpenSeat } from "./speaker-queue";

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

describe("decideClaimEligibility (issue #21, Phase 1) — reads is_current_candidate, not a re-derived rank", () => {
  it("rejects a caller with no pending request", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: null,
      activeSpeakers: [{ seat_number: 1 }],
    });
    expect(decision).toEqual({ eligible: false, reason: "no-request" });
  });

  it("rejects when both seats are full, even for the currently-selected candidate", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: true },
      activeSpeakers: [{ seat_number: 1 }, { seat_number: 2 }],
    });
    expect(decision).toEqual({ eligible: false, reason: "no-open-seat" });
  });

  it("rejects a pending requester who is not the round's current candidate", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: false },
      activeSpeakers: [{ seat_number: 1 }],
    });
    expect(decision).toEqual({ eligible: false, reason: "not-eligible" });
  });

  it("allows the currently-selected candidate to claim the open seat", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: true },
      activeSpeakers: [{ seat_number: 1 }],
    });
    expect(decision).toEqual({ eligible: true, seatNumber: 2 });
  });

  it("picks the lowest-numbered open seat when both are free", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: true },
      activeSpeakers: [],
    });
    expect(decision).toEqual({ eligible: true, seatNumber: 1 });
  });
});
