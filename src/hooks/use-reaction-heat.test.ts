import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReactionHeat } from "./use-reaction-heat";
import {
  REACTION_HEAT_COOLDOWN_EXIT,
  REACTION_HEAT_INCREMENT,
  REACTION_HEAT_MAX,
} from "@/lib/reactions/constants";

describe("useReactionHeat (pre-launch interaction pass, Section 5): client-visible heat meter — UX only, mirrors the server's own decay math", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts at zero heat, not in cooldown, sendable", () => {
    const { result } = renderHook(() => useReactionHeat());
    expect(result.current.heat).toBe(0);
    expect(result.current.inCooldown).toBe(false);
    expect(result.current.canSend).toBe(true);
  });

  it("recordOptimisticSend immediately bumps heat by the configured increment — instant feedback, no round trip needed", () => {
    const { result } = renderHook(() => useReactionHeat());
    act(() => result.current.recordOptimisticSend());
    expect(result.current.heat).toBeCloseTo(REACTION_HEAT_INCREMENT, 5);
  });

  it("a few moderate sends stay well under the max — occasional use is barely inconvenienced", () => {
    const { result } = renderHook(() => useReactionHeat());
    act(() => {
      result.current.recordOptimisticSend();
      result.current.recordOptimisticSend();
      result.current.recordOptimisticSend();
    });
    expect(result.current.heat).toBeLessThan(REACTION_HEAT_MAX);
    expect(result.current.canSend).toBe(true);
  });

  it("heat at 99, not yet in cooldown, still allows sending — only hitting the cap itself blocks", () => {
    const { result } = renderHook(() => useReactionHeat());
    act(() => result.current.reconcileWithServer(99, false));
    expect(result.current.canSend).toBe(true);
  });

  it("enough rapid sends fill the meter and enter cooldown, blocking further sends", () => {
    const { result } = renderHook(() => useReactionHeat());
    const sendsNeeded = Math.ceil(REACTION_HEAT_MAX / REACTION_HEAT_INCREMENT);
    act(() => {
      for (let i = 0; i < sendsNeeded; i++) result.current.recordOptimisticSend();
    });
    expect(result.current.heat).toBe(REACTION_HEAT_MAX);
    expect(result.current.inCooldown).toBe(true);
    expect(result.current.canSend).toBe(false);
  });

  it("reconcileWithServer overwrites the local estimate with the authoritative value — corrects optimistic drift on both accept and reject", () => {
    const { result } = renderHook(() => useReactionHeat());
    act(() => result.current.recordOptimisticSend());
    act(() => result.current.reconcileWithServer(37, false));
    expect(result.current.heat).toBe(37);
    expect(result.current.inCooldown).toBe(false);
  });

  it("heat drains continuously over real time once ticking", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReactionHeat());
    act(() => result.current.recordOptimisticSend());
    const afterSend = result.current.heat;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current.heat).toBeLessThan(afterSend);
  });

  describe("cooldown-exit rule (real-device correction): blocked for the entire drain, only exits at genuinely zero", () => {
    it("REACTION_HEAT_COOLDOWN_EXIT is 0 — no partial-drain unlock", () => {
      expect(REACTION_HEAT_COOLDOWN_EXIT).toBe(0);
    });

    it("a tiny amount of drain leaves cooldown active — nowhere close to zero yet", async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useReactionHeat());
      act(() => result.current.reconcileWithServer(REACTION_HEAT_MAX, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(500);
      });
      expect(result.current.inCooldown).toBe(true);
      expect(result.current.canSend).toBe(false);
      expect(result.current.heat).toBeGreaterThan(0);
    });

    it("even at heat=1 — one drain tick away from empty — sending remains blocked", async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useReactionHeat());
      act(() => result.current.reconcileWithServer(REACTION_HEAT_MAX, true));
      // 100 -> 1 at 4/sec drain takes 24.75s.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(24_750);
      });
      expect(result.current.heat).toBeCloseTo(1, 0);
      expect(result.current.inCooldown).toBe(true);
      expect(result.current.canSend).toBe(false);
    });

    it("exits cooldown only once heat has drained all the way to genuinely zero", async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useReactionHeat());
      act(() => result.current.reconcileWithServer(REACTION_HEAT_MAX, true));
      await act(async () => {
        // Long enough for real decay to reach zero (100/4 = 25s) and settle.
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(result.current.heat).toBe(0);
      expect(result.current.inCooldown).toBe(false);
      expect(result.current.canSend).toBe(true);
    });
  });
});
