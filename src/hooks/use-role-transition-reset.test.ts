import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useRoleTransitionReset } from "./use-role-transition-reset";

describe("useRoleTransitionReset (issue #18 consistency fix)", () => {
  it("does not call onReset on mount when isSpeaker starts false", () => {
    const onReset = vi.fn();
    renderHook(() => useRoleTransitionReset({ isSpeaker: false, onReset }));
    expect(onReset).not.toHaveBeenCalled();
  });

  it("does not call onReset on mount when isSpeaker starts true — no prior candidate state to invalidate", () => {
    const onReset = vi.fn();
    renderHook(() => useRoleTransitionReset({ isSpeaker: true, onReset }));
    expect(onReset).not.toHaveBeenCalled();
  });

  it("calls onReset exactly once on a false→true transition", () => {
    const onReset = vi.fn();
    const { rerender } = renderHook(({ isSpeaker }) => useRoleTransitionReset({ isSpeaker, onReset }), {
      initialProps: { isSpeaker: false },
    });
    rerender({ isSpeaker: true });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("does not call onReset again on subsequent re-renders while isSpeaker stays true", () => {
    const onReset = vi.fn();
    const { rerender } = renderHook(({ isSpeaker }) => useRoleTransitionReset({ isSpeaker, onReset }), {
      initialProps: { isSpeaker: false },
    });
    rerender({ isSpeaker: true });
    rerender({ isSpeaker: true });
    rerender({ isSpeaker: true });
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("is safe across repeated join/leave cycles — fires once per rising edge, never on the falling edge", () => {
    const onReset = vi.fn();
    const { rerender } = renderHook(({ isSpeaker }) => useRoleTransitionReset({ isSpeaker, onReset }), {
      initialProps: { isSpeaker: false },
    });
    rerender({ isSpeaker: true }); // join
    rerender({ isSpeaker: false }); // leave
    rerender({ isSpeaker: true }); // rejoin
    rerender({ isSpeaker: false }); // leave again
    rerender({ isSpeaker: true }); // rejoin again
    expect(onReset).toHaveBeenCalledTimes(3);
  });

  it("stays correct even if onReset's identity changes every render (inline closures are the normal caller pattern)", () => {
    const calls: number[] = [];
    let n = 0;
    const { rerender } = renderHook(
      ({ isSpeaker }) => useRoleTransitionReset({ isSpeaker, onReset: () => calls.push(++n) }),
      { initialProps: { isSpeaker: false } },
    );
    rerender({ isSpeaker: false });
    rerender({ isSpeaker: false });
    rerender({ isSpeaker: true });
    rerender({ isSpeaker: true });
    rerender({ isSpeaker: true });
    expect(calls).toHaveLength(1);
  });
});
