import { describe, expect, it } from "vitest";
import { speakerRoundDisplay } from "./use-speaker-round-countdown";

const NOW = Date.now();

describe("speakerRoundDisplay (issue #21 corrective pass — closing-phase only; the ordinary shared countdown moved to useStageRoundCountdown)", () => {
  it("returns null for no speaker", () => {
    expect(speakerRoundDisplay(null, NOW, true)).toBeNull();
  });

  it("returns null while the seat is in its ordinary active phase — the shared badge shows that now, not this per-seat one", () => {
    const speaker = { round_phase: "active" as const, closing_ends_at: null };
    expect(speakerRoundDisplay(speaker, NOW, true)).toBeNull();
    expect(speakerRoundDisplay(speaker, NOW, false)).toBeNull();
  });

  it("preview build: shows the full remaining closing time, even far from the deadline", () => {
    const speaker = { round_phase: "closing" as const, closing_ends_at: new Date(NOW + 25_000).toISOString() };
    const result = speakerRoundDisplay(speaker, NOW, true);
    expect(result).toEqual({ remainingSeconds: 25, phase: "closing" });
  });

  it("production build: hidden more than 10s from the closing deadline", () => {
    const speaker = { round_phase: "closing" as const, closing_ends_at: new Date(NOW + 25_000).toISOString() };
    expect(speakerRoundDisplay(speaker, NOW, false)).toBeNull();
  });

  it("production build: revealed within the final 10 seconds", () => {
    const speaker = { round_phase: "closing" as const, closing_ends_at: new Date(NOW + 9_000).toISOString() };
    const result = speakerRoundDisplay(speaker, NOW, false);
    expect(result).toEqual({ remainingSeconds: 9, phase: "closing" });
  });

  it("clamps to 0, never negative", () => {
    const speaker = { round_phase: "closing" as const, closing_ends_at: new Date(NOW - 3_000).toISOString() };
    const result = speakerRoundDisplay(speaker, NOW, true);
    expect(result?.remainingSeconds).toBe(0);
  });

  it("returns null when phase is 'closing' but closing_ends_at is somehow missing — defensive, should not happen given the DB's own check constraint", () => {
    const speaker = { round_phase: "closing" as const, closing_ends_at: null };
    expect(speakerRoundDisplay(speaker, NOW, true)).toBeNull();
  });
});
