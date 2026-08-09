import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useNow } from "./use-now";

describe("useNow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not cause a 'Maximum update depth exceeded' render loop even when the clock advances between calls", () => {
    // Regression test for a real bug: useSyncExternalStore's getSnapshot
    // must return a value that's stable between calls unless the
    // external store actually changed via the subscribe callback.
    // Forcing Date.now() to increment on every single call simulates the
    // real-world race (enough time elapsing between React's pre-commit
    // and post-commit snapshot checks for the clock to tick) — a
    // getSnapshot that returns Date.now() directly fails this
    // deterministically; one backed by a value that only changes when
    // the subscribed interval fires does not.
    let counter = 0;
    vi.spyOn(Date, "now").mockImplementation(() => 1_700_000_000_000 + counter++);

    expect(() => renderHook(() => useNow())).not.toThrow();
  });
});
