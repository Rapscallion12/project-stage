import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSpeakerInvariantRecovery } from "./use-speaker-invariant-recovery";
import type { StageRound } from "@/lib/repositories/stage-rounds";

function round(overrides: Partial<StageRound> = {}): StageRound {
  return {
    id: "r1",
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
 * Issue #21, sixteenth corrective pass, TEST 5 ("ACTIVE ROUND / EMPTY
 * LOCAL SEATS"): the "impossible client state" invariant — an active
 * shared round can only ever exist once the two-speaker pairing is
 * authoritatively established (fourth corrective pass), so a client
 * reporting an active round alongside fewer than two local speakers is
 * a real, provable contradiction. This is the exact combination the
 * triggering real-device snapshot showed (client round #7 active,
 * client seats occupied: none) with nothing watching for it.
 */
describe("useSpeakerInvariantRecovery (issue #21, sixteenth corrective pass)", () => {
  it("triggers exactly one bounded reconcile when an active round coexists with fewer than two local speakers", () => {
    const refetchSpeakers = vi.fn().mockResolvedValue([]);
    renderHook(() => useSpeakerInvariantRecovery(round({ round_number: 7, phase: "active" }), 0, refetchSpeakers));

    expect(refetchSpeakers).toHaveBeenCalledTimes(1);
    expect(refetchSpeakers).toHaveBeenCalledWith("invariant");
  });

  it("does not fire again for the same round number even if the violation persists across re-renders — never a retry loop", () => {
    const refetchSpeakers = vi.fn().mockResolvedValue([]);
    const { rerender } = renderHook(
      ({ speakerCount }: { speakerCount: number }) => useSpeakerInvariantRecovery(round({ round_number: 7, phase: "active" }), speakerCount, refetchSpeakers),
      { initialProps: { speakerCount: 0 } },
    );
    expect(refetchSpeakers).toHaveBeenCalledTimes(1);

    // The reconcile "fixed" nothing (still 0 locally) and the component
    // re-renders again for an unrelated reason — must not fire a second
    // time for the same round.
    rerender({ speakerCount: 0 });
    rerender({ speakerCount: 1 }); // still short of 2, still same round
    expect(refetchSpeakers).toHaveBeenCalledTimes(1);
  });

  it("fires again for a genuinely new round number if the same violation recurs", () => {
    const refetchSpeakers = vi.fn().mockResolvedValue([]);
    const { rerender } = renderHook(
      ({ stageRound }: { stageRound: StageRound }) => useSpeakerInvariantRecovery(stageRound, 0, refetchSpeakers),
      { initialProps: { stageRound: round({ round_number: 7, phase: "active" }) } },
    );
    expect(refetchSpeakers).toHaveBeenCalledTimes(1);

    rerender({ stageRound: round({ round_number: 8, phase: "active" }) });
    expect(refetchSpeakers).toHaveBeenCalledTimes(2);
    expect(refetchSpeakers).toHaveBeenLastCalledWith("invariant");
  });

  it("never fires when the round is not active (awaiting_pairing) even with fewer than two local speakers — that combination is normal, not a violation", () => {
    const refetchSpeakers = vi.fn().mockResolvedValue([]);
    renderHook(() => useSpeakerInvariantRecovery(round({ phase: "awaiting_pairing" }), 0, refetchSpeakers));
    expect(refetchSpeakers).not.toHaveBeenCalled();
  });

  it("never fires when there is no stage round at all", () => {
    const refetchSpeakers = vi.fn().mockResolvedValue([]);
    renderHook(() => useSpeakerInvariantRecovery(null, 0, refetchSpeakers));
    expect(refetchSpeakers).not.toHaveBeenCalled();
  });

  it("never fires when local speaker count already satisfies the invariant (2 occupied)", () => {
    const refetchSpeakers = vi.fn().mockResolvedValue([]);
    renderHook(() => useSpeakerInvariantRecovery(round({ phase: "active" }), 2, refetchSpeakers));
    expect(refetchSpeakers).not.toHaveBeenCalled();
  });
});
