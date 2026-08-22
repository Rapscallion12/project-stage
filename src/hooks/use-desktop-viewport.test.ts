import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useIsDesktopViewport } from "./use-desktop-viewport";

/** Same fake-matchMedia approach as use-orientation.test.ts — jsdom has no real matchMedia. */
function installMatchMedia(initialMatches: boolean) {
  let changeHandler: ((event: MediaQueryListEvent) => void) | null = null;
  const mql = {
    matches: initialMatches,
    media: "(min-width: 1024px)",
    addEventListener: vi.fn((event: string, handler: (e: MediaQueryListEvent) => void) => {
      if (event === "change") changeHandler = handler;
    }),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(mql));
  return {
    fireChange(matches: boolean) {
      mql.matches = matches;
      changeHandler?.({ matches } as MediaQueryListEvent);
    },
    mql,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useIsDesktopViewport", () => {
  it("is true once matchMedia reports at least the 1024px desktop threshold", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useIsDesktopViewport());
    expect(result.current).toBe(true);
  });

  it("is false below the threshold — includes a phone in landscape, not just portrait", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useIsDesktopViewport());
    expect(result.current).toBe(false);
  });

  it("updates live when the window crosses the threshold (resize), without remounting", () => {
    const { fireChange } = installMatchMedia(false);
    const { result } = renderHook(() => useIsDesktopViewport());
    expect(result.current).toBe(false);

    act(() => fireChange(true));
    expect(result.current).toBe(true);

    act(() => fireChange(false));
    expect(result.current).toBe(false);
  });

  it("removes its listener on unmount", () => {
    const { mql } = installMatchMedia(true);
    const { unmount } = renderHook(() => useIsDesktopViewport());
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
