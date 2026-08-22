import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { computeDragProgress, useCommentsFocus } from "./use-comments-focus";

describe("computeDragProgress (issue #21's dead-zone/commit math, pure — no simulated pointer events needed)", () => {
  it("produces zero effective change for any movement within the dead zone, in either direction", () => {
    expect(computeDragProgress(0, false)).toBe(0);
    expect(computeDragProgress(5, false)).toBe(0);
    expect(computeDragProgress(-8, false)).toBe(0);
    expect(computeDragProgress(9, true)).toBe(1);
  });

  it("opens progressively as the finger moves up past the dead zone, from closed", () => {
    // deltaY = startY - currentY, positive = finger moved up (the Maps/Music-panel convention).
    expect(computeDragProgress(10, false)).toBe(0); // exactly at the edge, still dead zone
    expect(computeDragProgress(70, false)).toBeCloseTo((70 - 10) / 120, 5);
    expect(computeDragProgress(130, false)).toBe(1); // clamped at fully open
  });

  it("closes progressively as the finger moves down past the dead zone, from open", () => {
    expect(computeDragProgress(-70, true)).toBeCloseTo(1 - (70 - 10) / 120, 5);
    expect(computeDragProgress(-130, true)).toBe(0); // clamped at fully closed
  });

  it("never goes below 0 or above 1 regardless of how far the drag travels", () => {
    expect(computeDragProgress(10_000, false)).toBe(1);
    expect(computeDragProgress(-10_000, true)).toBe(0);
  });
});

describe("useCommentsFocus", () => {
  function makePointerEvent(pointerId: number, clientY: number) {
    return {
      pointerId,
      clientY,
      currentTarget: { setPointerCapture: () => {} },
    } as unknown as React.PointerEvent<HTMLElement>;
  }

  it("starts closed, at rest, not mid-drag", () => {
    const { result } = renderHook(() => useCommentsFocus());
    expect(result.current.open).toBe(false);
    expect(result.current.progress).toBe(0);
    expect(result.current.dragging).toBe(false);
  });

  it("a plain tap (click with no real pointer movement) toggles it open, then closed again", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.handleProps.onClick());
    expect(result.current.open).toBe(true);
    act(() => result.current.handleProps.onClick());
    expect(result.current.open).toBe(false);
  });

  it("a real drag past the commit threshold opens it, live, without needing a separate click", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.handleProps.onPointerDown(makePointerEvent(1, 200)));
    act(() => result.current.handleProps.onPointerMove(makePointerEvent(1, 100))); // moved up 100px
    expect(result.current.dragging).toBe(true);
    expect(result.current.progress).toBeGreaterThan(0);
    act(() => result.current.handleProps.onPointerUp(makePointerEvent(1, 100)));
    expect(result.current.dragging).toBe(false);
    expect(result.current.open).toBe(true);
  });

  it("a drag that doesn't cross the commit threshold springs back closed on release", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.handleProps.onPointerDown(makePointerEvent(1, 200)));
    act(() => result.current.handleProps.onPointerMove(makePointerEvent(1, 170))); // moved up 30px — past dead zone, short of commit
    act(() => result.current.handleProps.onPointerUp(makePointerEvent(1, 170)));
    expect(result.current.open).toBe(false);
  });

  it("a small movement within the dead zone during a drag still counts as a tap, not a drag decision, on release", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.handleProps.onPointerDown(makePointerEvent(1, 200)));
    act(() => result.current.handleProps.onPointerMove(makePointerEvent(1, 197))); // 3px, inside the dead zone
    act(() => result.current.handleProps.onPointerUp(makePointerEvent(1, 197)));
    // endDrag alone leaves it unchanged (progress never left 0); the synthetic click a real
    // browser fires after a negligible-movement tap is what actually opens it here.
    expect(result.current.open).toBe(false);
    act(() => result.current.handleProps.onClick());
    expect(result.current.open).toBe(true);
  });

  it("a genuine drag's own release outcome isn't overridden by the click event browsers fire alongside it", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.handleProps.onPointerDown(makePointerEvent(1, 200)));
    act(() => result.current.handleProps.onPointerMove(makePointerEvent(1, 90))); // well past commit
    act(() => result.current.handleProps.onPointerUp(makePointerEvent(1, 90)));
    expect(result.current.open).toBe(true);
    // Some browsers still fire a click after pointerup; this hook must not toggle again for it.
    act(() => result.current.handleProps.onClick());
    expect(result.current.open).toBe(true);
  });

  it("ignores pointer events from a second, unrelated pointer while one drag is already in progress", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.handleProps.onPointerDown(makePointerEvent(1, 200)));
    act(() => result.current.handleProps.onPointerMove(makePointerEvent(2, 50))); // different pointerId
    expect(result.current.dragging).toBe(true);
    expect(result.current.progress).toBe(0); // the real pointer (1) hasn't moved
  });
});
