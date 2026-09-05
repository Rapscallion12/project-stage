import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useDoubleTap } from "./use-double-tap";

/** Minimal fake matching only what useDoubleTap actually reads off a PointerEvent. */
function fakeTap(opts: {
  x: number;
  y: number;
  target?: HTMLElement;
  currentTarget?: HTMLElement;
  pointerType?: string;
  button?: number;
}) {
  const el = opts.currentTarget ?? document.createElement("div");
  vi.spyOn(el, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
    right: 100,
    bottom: 100,
    x: 0,
    y: 0,
    toJSON: () => {},
  } as DOMRect);
  return {
    clientX: opts.x,
    clientY: opts.y,
    target: opts.target ?? el,
    currentTarget: el,
    pointerType: opts.pointerType ?? "touch",
    button: opts.button ?? 0,
  } as unknown as Parameters<ReturnType<typeof useDoubleTap>["onPointerUp"]>[0];
}

describe("useDoubleTap (pre-launch interaction pass, Section 2)", () => {
  it("does nothing on a single tap", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    result.current.onPointerUp(fakeTap({ x: 50, y: 50 }));
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("fires on two taps close together in time and space, with normalized 0-1 tile-relative coordinates", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const el = document.createElement("div");
    result.current.onPointerUp(fakeTap({ x: 64, y: 31, currentTarget: el }));
    result.current.onPointerUp(fakeTap({ x: 65, y: 32, currentTarget: el }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    const [x, y] = onDoubleTap.mock.calls[0];
    expect(x).toBeCloseTo(0.65, 1);
    expect(y).toBeCloseTo(0.32, 1);
  });

  it("does not fire when the two taps are too far apart in time", () => {
    vi.useFakeTimers();
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const el = document.createElement("div");
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, currentTarget: el }));
    vi.advanceTimersByTime(1000);
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, currentTarget: el }));
    expect(onDoubleTap).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not fire when the two taps land far apart on the same element", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const el = document.createElement("div");
    result.current.onPointerUp(fakeTap({ x: 10, y: 10, currentTarget: el }));
    result.current.onPointerUp(fakeTap({ x: 90, y: 90, currentTarget: el }));
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("never fires when either tap landed on a nested interactive element (button) — gesture-conflict safety, Section 2", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const container = document.createElement("div");
    const button = document.createElement("button");
    container.appendChild(button);
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, target: button, currentTarget: container }));
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, target: button, currentTarget: container }));
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("a tap on a button followed by a tap on the background does not count as a pair", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const container = document.createElement("div");
    const button = document.createElement("button");
    container.appendChild(button);
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, target: button, currentTarget: container }));
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, target: container, currentTarget: container }));
    expect(onDoubleTap).not.toHaveBeenCalled();
  });

  it("resets after firing — a third tap does not immediately re-trigger without a fresh pair", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const el = document.createElement("div");
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, currentTarget: el }));
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, currentTarget: el }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, currentTarget: el }));
    expect(onDoubleTap).toHaveBeenCalledTimes(1);
  });

  it("clamps normalized coordinates to 0-1 even for a tap right at the tile's edge", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const el = document.createElement("div");
    result.current.onPointerUp(fakeTap({ x: 0, y: 0, currentTarget: el }));
    result.current.onPointerUp(fakeTap({ x: 0, y: 0, currentTarget: el }));
    const [x, y] = onDoubleTap.mock.calls[0];
    expect(x).toBeGreaterThanOrEqual(0);
    expect(y).toBeGreaterThanOrEqual(0);
  });

  it("ignores a secondary mouse button", () => {
    const onDoubleTap = vi.fn();
    const { result } = renderHook(() => useDoubleTap(onDoubleTap));
    const el = document.createElement("div");
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, currentTarget: el, pointerType: "mouse", button: 2 }));
    result.current.onPointerUp(fakeTap({ x: 50, y: 50, currentTarget: el, pointerType: "mouse", button: 2 }));
    expect(onDoubleTap).not.toHaveBeenCalled();
  });
});
