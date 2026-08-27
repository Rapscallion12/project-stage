import { describe, expect, it } from "vitest";
import { jitteredDelayMs, randomOrdinaryComment, randomSpeakerRequestComment } from "./content";

describe("simulator content generation (issue #21, Part 6/8 — benign, non-robotic)", () => {
  it("randomOrdinaryComment returns non-empty text", () => {
    expect(randomOrdinaryComment().length).toBeGreaterThan(0);
  });

  it("randomSpeakerRequestComment returns non-empty text", () => {
    expect(randomSpeakerRequestComment().length).toBeGreaterThan(0);
  });

  it("jitteredDelayMs stays within the requested bounds", () => {
    for (let i = 0; i < 50; i++) {
      const delay = jitteredDelayMs(1000, 2000);
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThan(2000);
    }
  });

  it("jitteredDelayMs is not always the same value — not perfectly periodic", () => {
    const samples = new Set(Array.from({ length: 10 }, () => jitteredDelayMs(0, 10000)));
    expect(samples.size).toBeGreaterThan(1);
  });
});
