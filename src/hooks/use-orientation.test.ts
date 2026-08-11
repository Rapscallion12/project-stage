import { renderHook, act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOrientation } from "./use-orientation";

/**
 * jsdom doesn't implement matchMedia at all — every test here installs its
 * own minimal fake rather than relying on a global polyfill, so the
 * "change" listener path (rotation while mounted) is actually exercised,
 * not just the initial read.
 */
function installMatchMedia(initialMatches: boolean) {
  let changeHandler: ((event: MediaQueryListEvent) => void) | null = null;
  const mql = {
    matches: initialMatches,
    media: "(orientation: portrait)",
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

describe("useOrientation", () => {
  it("reads the initial orientation from matchMedia after mount", () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useOrientation());
    expect(result.current).toBe("portrait");
  });

  it("reflects landscape when the query doesn't match", () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useOrientation());
    expect(result.current).toBe("landscape");
  });

  it("updates when the media query change event fires, without remounting", () => {
    const { fireChange } = installMatchMedia(true);
    const { result } = renderHook(() => useOrientation());
    expect(result.current).toBe("portrait");

    act(() => fireChange(false));
    expect(result.current).toBe("landscape");

    act(() => fireChange(true));
    expect(result.current).toBe("portrait");
  });

  it("removes its listener on unmount", () => {
    const { mql } = installMatchMedia(true);
    const { unmount } = renderHook(() => useOrientation());
    unmount();
    expect(mql.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });
});
