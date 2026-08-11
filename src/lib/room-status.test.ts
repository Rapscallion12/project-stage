import { describe, expect, it } from "vitest";
import { getRoomStatus, ROOM_STATUS_LABEL } from "./room-status";

describe("getRoomStatus", () => {
  it("is 'waiting' with no active speakers", () => {
    expect(getRoomStatus(0)).toBe("waiting");
  });

  it("is 'selecting' with exactly one active speaker", () => {
    expect(getRoomStatus(1)).toBe("selecting");
  });

  it("is 'live' with two active speakers", () => {
    expect(getRoomStatus(2)).toBe("live");
  });

  it("treats more than two as still 'live' rather than throwing", () => {
    expect(getRoomStatus(3)).toBe("live");
  });
});

describe("ROOM_STATUS_LABEL", () => {
  it("has a human-readable label for every status", () => {
    expect(ROOM_STATUS_LABEL.waiting).toBe("Waiting for speakers");
    expect(ROOM_STATUS_LABEL.selecting).toBe("Selecting next speaker");
    expect(ROOM_STATUS_LABEL.live).toBe("Live");
  });
});
