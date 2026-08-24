import { describe, expect, it } from "vitest";
import { deriveParticipantRole, findMySeatNumber } from "./participant-role";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie Rivera",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    ...overrides,
  };
}

describe("findMySeatNumber", () => {
  it("returns null when the identity holds no seat", () => {
    expect(findMySeatNumber([speaker({ seat_number: 1, profile_id: "p1" })], { type: "profile", id: "someone-else" })).toBeNull();
  });

  it("finds a profile identity in seat 1", () => {
    expect(findMySeatNumber([speaker({ seat_number: 1, profile_id: "p1" })], { type: "profile", id: "p1" })).toBe(1);
  });

  it("finds a profile identity in seat 2 — no seat-number asymmetry", () => {
    expect(
      findMySeatNumber([speaker({ seat_number: 2, profile_id: "p1", id: "s2" })], { type: "profile", id: "p1" }),
    ).toBe(2);
  });

  it("matches a guest identity by guest_id, never profile_id", () => {
    const guestSeat = speaker({ seat_number: 1, profile_id: null, guest_id: "g1" });
    expect(findMySeatNumber([guestSeat], { type: "guest", id: "g1" })).toBe(1);
    expect(findMySeatNumber([guestSeat], { type: "profile", id: "g1" })).toBeNull();
  });

  it("does not confuse a profile viewer with a guest seat sharing the same raw id, or vice versa", () => {
    const guestSeat = speaker({ seat_number: 1, profile_id: null, guest_id: "shared-id" });
    expect(findMySeatNumber([guestSeat], { type: "profile", id: "shared-id" })).toBeNull();
  });

  it("returns the correct seat when both seats are occupied by different identities", () => {
    const seats = [
      speaker({ id: "s1", seat_number: 1, profile_id: "p1" }),
      speaker({ id: "s2", seat_number: 2, profile_id: "p2" }),
    ];
    expect(findMySeatNumber(seats, { type: "profile", id: "p1" })).toBe(1);
    expect(findMySeatNumber(seats, { type: "profile", id: "p2" })).toBe(2);
  });
});

describe("deriveParticipantRole", () => {
  it("is 'speaker' whenever isSpeaker is true, regardless of hasPendingRequest", () => {
    expect(deriveParticipantRole({ isSpeaker: true, hasPendingRequest: false })).toBe("speaker");
    expect(deriveParticipantRole({ isSpeaker: true, hasPendingRequest: true })).toBe("speaker");
  });

  it("is 'candidate' when not speaking but a request is pending", () => {
    expect(deriveParticipantRole({ isSpeaker: false, hasPendingRequest: true })).toBe("candidate");
  });

  it("is 'audience' when neither speaking nor pending", () => {
    expect(deriveParticipantRole({ isSpeaker: false, hasPendingRequest: false })).toBe("audience");
  });
});
