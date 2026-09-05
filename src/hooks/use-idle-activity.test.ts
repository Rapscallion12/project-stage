import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIdleActivity } from "./use-idle-activity";

describe("useIdleActivity (pre-launch interaction pass, Section 8)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("goes idle after the delay with no activity", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIdleActivity(2500));
    expect(result.current.idle).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.idle).toBe(true);
  });

  it("registerActivity resets the idle timer — stays active while activity keeps happening", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIdleActivity(2500));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    act(() => result.current.registerActivity());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.idle).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.idle).toBe(true);
  });

  it("holdActive keeps the UI active indefinitely until released — a focused composer never fades while focused", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIdleActivity(2500));
    act(() => result.current.holdActive());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.idle).toBe(false);
  });

  it("releasing the hold restarts the idle countdown from zero", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIdleActivity(2500));
    act(() => result.current.holdActive());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    act(() => result.current.releaseActive());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(result.current.idle).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });
    expect(result.current.idle).toBe(true);
  });

  it("multiple concurrent holds (e.g. a panel open while also focused) only resume the idle countdown once every hold has released", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIdleActivity(2500));
    act(() => {
      result.current.holdActive();
      result.current.holdActive();
    });
    act(() => result.current.releaseActive());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    // One hold remains — still active despite exceeding the idle delay.
    expect(result.current.idle).toBe(false);

    act(() => result.current.releaseActive());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.idle).toBe(true);
  });

  it("registerActivity immediately clears an already-idle state", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useIdleActivity(2500));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(result.current.idle).toBe(true);
    act(() => result.current.registerActivity());
    expect(result.current.idle).toBe(false);
  });
});
