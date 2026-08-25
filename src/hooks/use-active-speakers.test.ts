import { describe, expect, it } from "vitest";
import { applySpeakerChange } from "./use-active-speakers";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    event_id: "00000000-0000-0000-0000-0000000000ee",
    profile_id: "00000000-0000-0000-0000-000000000aaa",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    media_inactive_since: null,
    ...overrides,
  };
}

describe("applySpeakerChange", () => {
  it("adds a newly active speaker to their seat", () => {
    const result = applySpeakerChange({}, speaker());
    expect(result[1]?.display_name).toBe("Jamie");
  });

  it("replaces whoever was in a seat when a new occupant claims it", () => {
    const alice = speaker({ id: "a", profile_id: "p-a", display_name: "Alice" });
    const bob = speaker({ id: "b", profile_id: "p-b", display_name: "Bob" });

    const afterAlice = applySpeakerChange({}, alice);
    const afterBob = applySpeakerChange(afterAlice, bob);

    expect(afterBob[1]?.display_name).toBe("Bob");
  });

  it("removes a speaker from their seat when their row is ended", () => {
    const active = speaker({ id: "a" });
    const ended = { ...active, left_at: new Date().toISOString(), left_reason: "voluntary" as const };

    const afterJoin = applySpeakerChange({}, active);
    const afterLeave = applySpeakerChange(afterJoin, ended);

    expect(afterLeave[1]).toBeUndefined();
  });

  it("does not let an ended row for a superseded occupant clobber the current one", () => {
    const alice = speaker({ id: "a", profile_id: "p-a", display_name: "Alice" });
    const bob = speaker({ id: "b", profile_id: "p-b", display_name: "Bob" });
    const aliceEndedLate = { ...alice, left_at: new Date().toISOString(), left_reason: "replaced" as const };

    let state = applySpeakerChange({}, alice);
    state = applySpeakerChange(state, bob);
    // Alice's own "ended" event arrives after Bob's replacement — a
    // realistic ordering hazard with two realtime events referencing the
    // same seat in flight.
    state = applySpeakerChange(state, aliceEndedLate);

    expect(state[1]?.display_name).toBe("Bob");
  });

  it("leaves other seats untouched", () => {
    const seat1 = speaker({ id: "a", seat_number: 1, display_name: "Alice" });
    const seat2 = speaker({ id: "b", seat_number: 2, display_name: "Bob" });

    let state = applySpeakerChange({}, seat1);
    state = applySpeakerChange(state, seat2);

    expect(state[1]?.display_name).toBe("Alice");
    expect(state[2]?.display_name).toBe("Bob");
  });
});
