import { describe, expect, it } from "vitest";
import { decideClaimEligibility, findOpenSeat, findOpenSeats } from "./speaker-queue";

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

describe("findOpenSeats (issue #21, fifth corrective pass) — every open seat, not just the first", () => {
  it("is [1, 2] when nothing is occupied", () => {
    expect(findOpenSeats([])).toEqual([1, 2]);
  });

  it("is [2] when only seat 1 is occupied", () => {
    expect(findOpenSeats([{ seat_number: 1 }])).toEqual([2]);
  });

  it("is [1] when only seat 2 is occupied", () => {
    expect(findOpenSeats([{ seat_number: 2 }])).toEqual([1]);
  });

  it("is [] when both seats are occupied", () => {
    expect(findOpenSeats([{ seat_number: 1 }, { seat_number: 2 }])).toEqual([]);
  });
});

describe("decideClaimEligibility (issue #21, fifth corrective pass) — reads the caller's own reserved_seat_number, not a re-derived 'the' open seat", () => {
  it("rejects a caller with no pending request", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: null,
      activeSpeakers: [{ seat_number: 1 }],
    });
    expect(decision).toEqual({ eligible: false, reason: "no-request" });
  });

  it("rejects a pending requester who is not the round's current candidate for any seat", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: false, reserved_seat_number: null },
      activeSpeakers: [{ seat_number: 1 }],
    });
    expect(decision).toEqual({ eligible: false, reason: "not-eligible" });
  });

  it("rejects a candidate marked current but with no reserved seat (defensive — shouldn't happen, but never trusted blindly)", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: true, reserved_seat_number: null },
      activeSpeakers: [],
    });
    expect(decision).toEqual({ eligible: false, reason: "not-eligible" });
  });

  it("allows the currently-selected candidate to claim their own reserved seat", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: true, reserved_seat_number: 2 },
      activeSpeakers: [{ seat_number: 1 }],
    });
    expect(decision).toEqual({ eligible: true, seatNumber: 2 });
  });

  it("targets the exact reserved seat, never 'the' lowest-numbered open one — the seat-aware fix for the two-simultaneous-candidates race", () => {
    // Both seats are open, but this candidate is specifically reserved
    // for seat 2 — the old findOpenSeat-based logic would have picked
    // seat 1 regardless, racing whichever candidate was actually
    // reserved for it.
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: true, reserved_seat_number: 2 },
      activeSpeakers: [],
    });
    expect(decision).toEqual({ eligible: true, seatNumber: 2 });
  });

  it("rejects when the caller's own reserved seat isn't actually open anymore (stale read)", () => {
    const decision = decideClaimEligibility({
      myPendingRequest: { is_current_candidate: true, reserved_seat_number: 1 },
      activeSpeakers: [{ seat_number: 1 }],
    });
    expect(decision).toEqual({ eligible: false, reason: "no-open-seat" });
  });
});
