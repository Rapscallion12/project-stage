import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useReactionPreferences } from "./use-reaction-preferences";

describe("useReactionPreferences (pre-launch interaction pass, Sections 1/4)", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("defaults to ❤️, On speaker display, and reactions shown, when nothing is persisted yet", () => {
    const { result } = renderHook(() => useReactionPreferences());
    expect(result.current.selectedEmoji).toBe("❤️");
    expect(result.current.displayMode).toBe("on-speaker");
    expect(result.current.showReactions).toBe(true);
  });

  it("selecting an emoji updates the current selection and persists it — a later hook instance (e.g. a different room) reads it back", () => {
    const { result } = renderHook(() => useReactionPreferences());
    act(() => result.current.setSelectedEmoji("🔥"));
    expect(result.current.selectedEmoji).toBe("🔥");

    const { result: second } = renderHook(() => useReactionPreferences());
    expect(second.current.selectedEmoji).toBe("🔥");
  });

  it("changing the display mode persists across a fresh hook instance", () => {
    const { result } = renderHook(() => useReactionPreferences());
    act(() => result.current.setDisplayMode("side"));
    expect(result.current.displayMode).toBe("side");

    const { result: second } = renderHook(() => useReactionPreferences());
    expect(second.current.displayMode).toBe("side");
  });

  it("hiding reactions persists across a fresh hook instance", () => {
    const { result } = renderHook(() => useReactionPreferences());
    act(() => result.current.setShowReactions(false));
    expect(result.current.showReactions).toBe(false);

    const { result: second } = renderHook(() => useReactionPreferences());
    expect(second.current.showReactions).toBe(false);
  });

  it("ignores a corrupted/invalid persisted emoji and falls back to the default rather than crashing", () => {
    localStorage.setItem("vs.reactions.selectedEmoji", "not-a-real-emoji");
    const { result } = renderHook(() => useReactionPreferences());
    expect(result.current.selectedEmoji).toBe("❤️");
  });
});
