import { describe, expect, it } from "vitest";
import { stageRoundDisplay } from "./use-stage-round-countdown";

const NOW = Date.now();

describe("stageRoundDisplay (issue #21 corrective pass — the one shared round timer for a stage pairing)", () => {
  it("returns null for no round yet", () => {
    expect(stageRoundDisplay(null, NOW, true)).toBeNull();
  });

  it("returns null while the stage is awaiting_pairing — not a countdown to render as ticking", () => {
    const round = { phase: "awaiting_pairing" as const, ends_at: new Date(NOW + 5_000).toISOString(), round_number: 2 };
    expect(stageRoundDisplay(round, NOW, true)).toBeNull();
  });

  it("preview build: shows the full remaining time, even far from the deadline", () => {
    const round = { phase: "active" as const, ends_at: new Date(NOW + 45_000).toISOString(), round_number: 1 };
    const result = stageRoundDisplay(round, NOW, true);
    expect(result).toEqual({ remainingSeconds: 45, roundNumber: 1 });
  });

  it("production build: hidden more than 10s from the deadline", () => {
    const round = { phase: "active" as const, ends_at: new Date(NOW + 45_000).toISOString(), round_number: 1 };
    expect(stageRoundDisplay(round, NOW, false)).toBeNull();
  });

  it("production build: revealed within the final 10 seconds", () => {
    const round = { phase: "active" as const, ends_at: new Date(NOW + 9_000).toISOString(), round_number: 1 };
    const result = stageRoundDisplay(round, NOW, false);
    expect(result).toEqual({ remainingSeconds: 9, roundNumber: 1 });
  });

  it("clamps to 0, never negative", () => {
    const round = { phase: "active" as const, ends_at: new Date(NOW - 3_000).toISOString(), round_number: 1 };
    expect(stageRoundDisplay(round, NOW, true)?.remainingSeconds).toBe(0);
  });

  it("surfaces the round number as-is, for the 'Round N · Ns' badge format", () => {
    const round = { phase: "active" as const, ends_at: new Date(NOW + 12_000).toISOString(), round_number: 7 };
    expect(stageRoundDisplay(round, NOW, true)?.roundNumber).toBe(7);
  });
});
