import { describe, expect, it } from "vitest";
import { shouldPublish } from "./use-live-room-connection";

describe("shouldPublish", () => {
  it("is false when there are no permissions yet (not connected)", () => {
    expect(shouldPublish(undefined)).toBe(false);
  });

  it("is false when canPublish is explicitly false", () => {
    expect(shouldPublish({ canPublish: false })).toBe(false);
  });

  it("is true only when canPublish is explicitly true", () => {
    expect(shouldPublish({ canPublish: true })).toBe(true);
  });
});
