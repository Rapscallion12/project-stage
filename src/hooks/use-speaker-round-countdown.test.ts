import { describe, expect, it } from "vitest";
import { speakerRoundDisplay } from "./use-speaker-round-countdown";

const NOW = Date.now();

describe("speakerRoundDisplay", () => {
  it("returns null for no speaker", () => {
    expect(speakerRoundDisplay(null, NOW, true)).toBeNull();
  });

  it("preview build: shows the full remaining time, even far from the deadline", () => {
    const speaker = {
      round_phase: "active" as const,
      round_ends_at: new Date(NOW + 45_000).toISOString(),
      closing_ends_at: null,
      round_number: 1,
    };
    const result = speakerRoundDisplay(speaker, NOW, true);
    expect(result).toEqual({ remainingSeconds: 45, phase: "active", roundNumber: 1 });
  });

  it("production build: hidden more than 10s from the deadline", () => {
    const speaker = {
      round_phase: "active" as const,
      round_ends_at: new Date(NOW + 45_000).toISOString(),
      closing_ends_at: null,
      round_number: 1,
    };
    expect(speakerRoundDisplay(speaker, NOW, false)).toBeNull();
  });

  it("production build: revealed within the final 10 seconds", () => {
    const speaker = {
      round_phase: "active" as const,
      round_ends_at: new Date(NOW + 9_000).toISOString(),
      closing_ends_at: null,
      round_number: 1,
    };
    const result = speakerRoundDisplay(speaker, NOW, false);
    expect(result).toEqual({ remainingSeconds: 9, phase: "active", roundNumber: 1 });
  });

  it("watches closing_ends_at, not round_ends_at, while the round is in its closing phase", () => {
    const speaker = {
      round_phase: "closing" as const,
      round_ends_at: new Date(NOW - 5_000).toISOString(), // stale/passed — must be ignored
      closing_ends_at: new Date(NOW + 20_000).toISOString(),
      round_number: 2,
    };
    const result = speakerRoundDisplay(speaker, NOW, true);
    expect(result).toEqual({ remainingSeconds: 20, phase: "closing", roundNumber: 2 });
  });

  it("clamps to 0, never negative", () => {
    const speaker = {
      round_phase: "active" as const,
      round_ends_at: new Date(NOW - 3_000).toISOString(),
      closing_ends_at: null,
      round_number: 1,
    };
    const result = speakerRoundDisplay(speaker, NOW, true);
    expect(result?.remainingSeconds).toBe(0);
  });

  it("surfaces the round number as-is, for the 'Round N · Ns' badge format", () => {
    const speaker = {
      round_phase: "active" as const,
      round_ends_at: new Date(NOW + 12_000).toISOString(),
      closing_ends_at: null,
      round_number: 5,
    };
    const result = speakerRoundDisplay(speaker, NOW, true);
    expect(result?.roundNumber).toBe(5);
  });
});
