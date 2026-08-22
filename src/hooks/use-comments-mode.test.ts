import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useCommentsMode } from "./use-comments-mode";

describe("useCommentsMode (issue #21, retired-gesture pass: a plain boolean, no drag tracking)", () => {
  it("starts in Watch Mode (comments closed)", () => {
    const { result } = renderHook(() => useCommentsMode());
    expect(result.current.open).toBe(false);
  });

  it("openComments switches to Comments Mode", () => {
    const { result } = renderHook(() => useCommentsMode());
    act(() => result.current.openComments());
    expect(result.current.open).toBe(true);
  });

  it("closeComments returns to Watch Mode", () => {
    const { result } = renderHook(() => useCommentsMode());
    act(() => result.current.openComments());
    act(() => result.current.closeComments());
    expect(result.current.open).toBe(false);
  });

  it("exposes no drag/progress/gesture surface at all — the gesture is retired, not hidden", () => {
    const { result } = renderHook(() => useCommentsMode());
    expect(result.current).not.toHaveProperty("progress");
    expect(result.current).not.toHaveProperty("dragging");
    expect(result.current).not.toHaveProperty("surfaceProps");
  });
});
