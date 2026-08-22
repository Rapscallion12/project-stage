import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { computeDragProgress, useCommentsFocus } from "./use-comments-focus";

describe("computeDragProgress (issue #21's dead-zone/commit math, pure — no simulated pointer events needed)", () => {
  it("produces zero effective change for any movement within the dead zone, in either direction", () => {
    expect(computeDragProgress(0, false)).toBe(0);
    expect(computeDragProgress(10, false)).toBe(0);
    expect(computeDragProgress(-12, false)).toBe(0);
    expect(computeDragProgress(14, true)).toBe(1);
  });

  it("opens progressively as the finger moves down past the dead zone, from closed — the 'pull down to reveal' direction", () => {
    expect(computeDragProgress(15, false)).toBe(0); // exactly at the edge, still dead zone
    expect(computeDragProgress(85, false)).toBeCloseTo((85 - 15) / 140, 5);
    expect(computeDragProgress(160, false)).toBe(1); // clamped at fully open
  });

  it("closes progressively as the finger moves up past the dead zone, from open", () => {
    expect(computeDragProgress(-85, true)).toBeCloseTo(1 - (85 - 15) / 140, 5);
    expect(computeDragProgress(-160, true)).toBe(0); // clamped at fully closed
  });

  it("never goes below 0 or above 1 regardless of how far the drag travels", () => {
    expect(computeDragProgress(10_000, false)).toBe(1);
    expect(computeDragProgress(-10_000, true)).toBe(0);
  });
});

describe("useCommentsFocus", () => {
  function fakeElement(options: { matchesInteractive?: boolean } = {}) {
    return {
      closest: () => (options.matchesInteractive ? {} : null),
    } as unknown as Element;
  }

  function makePointerEvent(
    pointerId: number,
    clientY: number,
    options: { target?: Element; pointerType?: string; button?: number } = {},
  ) {
    return {
      pointerId,
      clientY,
      pointerType: options.pointerType ?? "touch",
      button: options.button ?? 0,
      target: options.target ?? fakeElement(),
      currentTarget: { setPointerCapture: vi.fn() },
      preventDefault: vi.fn(),
    } as unknown as React.PointerEvent<HTMLElement>;
  }

  it("starts closed, at rest, not mid-drag", () => {
    const { result } = renderHook(() => useCommentsFocus());
    expect(result.current.open).toBe(false);
    expect(result.current.progress).toBe(0);
    expect(result.current.dragging).toBe(false);
  });

  it("openComments/closeComments set the state directly, no gesture involved — the explicit, always-reliable trigger", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.openComments());
    expect(result.current.open).toBe(true);
    act(() => result.current.closeComments());
    expect(result.current.open).toBe(false);
  });

  it("a downward drag past the commit threshold opens it, live, from a plain (non-interactive) surface", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.surfaceProps.onPointerDown(makePointerEvent(1, 100)));
    act(() => result.current.surfaceProps.onPointerMove(makePointerEvent(1, 200))); // moved down 100px
    expect(result.current.dragging).toBe(true);
    expect(result.current.progress).toBeGreaterThan(0);
    act(() => result.current.surfaceProps.onPointerUp(makePointerEvent(1, 200)));
    expect(result.current.dragging).toBe(false);
    expect(result.current.open).toBe(true);
  });

  it("a drag that doesn't cross the commit threshold springs back closed on release", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.surfaceProps.onPointerDown(makePointerEvent(1, 100)));
    act(() => result.current.surfaceProps.onPointerMove(makePointerEvent(1, 140))); // moved down 40px — past dead zone, short of commit
    act(() => result.current.surfaceProps.onPointerUp(makePointerEvent(1, 140)));
    expect(result.current.open).toBe(false);
  });

  it("small movement within the dead zone produces no visible change at all", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.surfaceProps.onPointerDown(makePointerEvent(1, 100)));
    act(() => result.current.surfaceProps.onPointerMove(makePointerEvent(1, 108))); // 8px, inside the dead zone
    expect(result.current.progress).toBe(0);
    act(() => result.current.surfaceProps.onPointerUp(makePointerEvent(1, 108)));
    expect(result.current.open).toBe(false);
  });

  it("an upward drag from the open state can close it back", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.openComments());
    act(() => result.current.surfaceProps.onPointerDown(makePointerEvent(1, 200)));
    act(() => result.current.surfaceProps.onPointerMove(makePointerEvent(1, 100))); // moved up 100px
    act(() => result.current.surfaceProps.onPointerUp(makePointerEvent(1, 100)));
    expect(result.current.open).toBe(false);
  });

  it("ignores pointer events from a second, unrelated pointer while one drag is already in progress", () => {
    const { result } = renderHook(() => useCommentsFocus());
    act(() => result.current.surfaceProps.onPointerDown(makePointerEvent(1, 100)));
    act(() => result.current.surfaceProps.onPointerMove(makePointerEvent(2, 250))); // different pointerId
    expect(result.current.dragging).toBe(true);
    expect(result.current.progress).toBe(0); // the real pointer (1) hasn't moved
  });

  describe("interactive-descendant exclusion (real-device correction: the surface must never steal a tap from a real control)", () => {
    it("never starts tracking a drag when the touch began on an interactive element", () => {
      const { result } = renderHook(() => useCommentsFocus());
      const interactiveTarget = fakeElement({ matchesInteractive: true });
      act(() =>
        result.current.surfaceProps.onPointerDown(makePointerEvent(1, 100, { target: interactiveTarget })),
      );
      expect(result.current.dragging).toBe(false);

      // A subsequent move for the same pointer is also ignored, since no drag ever started.
      act(() => result.current.surfaceProps.onPointerMove(makePointerEvent(1, 200, { target: interactiveTarget })));
      expect(result.current.dragging).toBe(false);
      expect(result.current.progress).toBe(0);
    });

    it("never calls setPointerCapture for a touch that started on an interactive element — the element handles its own gesture untouched", () => {
      const { result } = renderHook(() => useCommentsFocus());
      const target = fakeElement({ matchesInteractive: true });
      const event = makePointerEvent(1, 100, { target });
      act(() => result.current.surfaceProps.onPointerDown(event));
      expect(event.currentTarget.setPointerCapture).not.toHaveBeenCalled();
    });

    it("does call setPointerCapture and preventDefault for a genuine surface drag", () => {
      const { result } = renderHook(() => useCommentsFocus());
      const downEvent = makePointerEvent(1, 100);
      act(() => result.current.surfaceProps.onPointerDown(downEvent));
      expect(downEvent.currentTarget.setPointerCapture).toHaveBeenCalledWith(1);

      const moveEvent = makePointerEvent(1, 200);
      act(() => result.current.surfaceProps.onPointerMove(moveEvent));
      expect(moveEvent.preventDefault).toHaveBeenCalled();
    });
  });
});
