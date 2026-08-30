import { describe, expect, it } from "vitest";
import { applyStageRoundChange } from "./use-stage-round";
import type { StageRound } from "@/lib/repositories/stage-rounds";

function stageRound(overrides: Partial<StageRound> = {}): StageRound {
  return {
    id: "sr1",
    event_id: "e1",
    round_number: 1,
    started_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 60_000).toISOString(),
    phase: "active",
    updated_at: new Date().toISOString(),
    fallback_excluded_profile_ids: [],
    fallback_excluded_guest_ids: [],
    ...overrides,
  };
}

/**
 * Issue #21, seventh corrective pass, Sections 16-19: a real-device pass
 * found "Round 1 · awaiting pairing" staying on screen indefinitely after
 * Session Simulator's Reset deleted the `stage_rounds` row — traced to
 * this exact reducer silently discarding every DELETE event. These tests
 * pin the fix directly, independent of the hook's own Realtime wiring
 * (untestable in jsdom) — same "pure reducer, tested in isolation" shape
 * `applySpeakerChange`/`removeSpeaker` already established.
 */
describe("applyStageRoundChange", () => {
  it("adopts the new row on INSERT", () => {
    const row = stageRound();
    expect(applyStageRoundChange({ eventType: "INSERT", new: row })).toEqual(row);
  });

  it("adopts the new row on UPDATE", () => {
    const row = stageRound({ round_number: 2 });
    expect(applyStageRoundChange({ eventType: "UPDATE", new: row })).toEqual(row);
  });

  it("clears to null on DELETE — the exact bug that left a stale round display after Session Simulator Reset", () => {
    // `new` is genuinely empty on a real DELETE payload — the fix must
    // not depend on it carrying anything.
    expect(applyStageRoundChange({ eventType: "DELETE", new: {} })).toBeNull();
  });
});
