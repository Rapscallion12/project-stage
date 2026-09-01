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

/**
 * Issue #21, eighteenth corrective pass, Section 7/9C: "refresh during
 * Final 30 must preserve approximately the correct remaining time." This
 * function takes the authoritative `speaker` row and the current clock as
 * plain arguments — no local "when did I start counting" state at all —
 * so a browser refresh (a fresh mount, calling this with the *same*
 * `closing_ends_at` it already had, just a later `now`) is safe by
 * construction, not by any special remount-handling code. Pinned
 * explicitly here, framed as a remount, rather than only inferred from
 * the individual pure-function cases above.
 */
describe("speakerRoundDisplay — refresh/remount during Final 30 (issue #21, eighteenth corrective pass)", () => {
  it("a second call 12s later, simulating a page refresh with the same authoritative deadline, resumes from ~18s remaining rather than restarting at 30", () => {
    const closingEndsAt = new Date(NOW + 30_000).toISOString();
    const speaker = { round_phase: "closing" as const, closing_ends_at: closingEndsAt };

    // "First render," right as Final 30 begins.
    const first = speakerRoundDisplay(speaker, NOW, true);
    expect(first).toEqual({ remainingSeconds: 30, phase: "closing" });

    // "Refresh" — a brand-new call (standing in for a fresh mount after a
    // real browser reload), same authoritative speaker row, 12s later.
    const afterRefresh = speakerRoundDisplay(speaker, NOW + 12_000, true);
    expect(afterRefresh).toEqual({ remainingSeconds: 18, phase: "closing" });
  });
});
