import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpeakerRoundResolution } from "./use-speaker-round-resolution";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const { resolveSpeakerRoundAction } = vi.hoisted(() => ({
  resolveSpeakerRoundAction: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({ resolveSpeakerRoundAction }));

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    media_inactive_since: null,
    round_number: 1,
    round_started_at: new Date().toISOString(),
    round_ends_at: new Date(Date.now() + 60_000).toISOString(),
    round_phase: "active",
    closing_ends_at: null,
    ...overrides,
  };
}

describe("useSpeakerRoundResolution (issue #21, Part 1/15 — authoritative deadline trigger, per speaker)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("schedules nothing for an empty speaker list", () => {
    vi.useFakeTimers();
    renderHook(() => useSpeakerRoundResolution([]));
    act(() => {
      vi.advanceTimersByTime(120_000);
    });
    expect(resolveSpeakerRoundAction).not.toHaveBeenCalled();
  });

  it("calls resolveSpeakerRoundAction exactly at the round's own deadline, not before", () => {
    vi.useFakeTimers();
    const s = speaker({ id: "s1", round_ends_at: new Date(Date.now() + 60_000).toISOString() });
    renderHook(() => useSpeakerRoundResolution([s]));

    act(() => {
      vi.advanceTimersByTime(59_000);
    });
    expect(resolveSpeakerRoundAction).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(resolveSpeakerRoundAction).toHaveBeenCalledWith("s1");
  });

  it("two occupied seats get two independent timers — per-speaker, not per-pairing", () => {
    vi.useFakeTimers();
    const a = speaker({ id: "a", round_ends_at: new Date(Date.now() + 20_000).toISOString() });
    const b = speaker({ id: "b", round_ends_at: new Date(Date.now() + 60_000).toISOString() });
    renderHook(() => useSpeakerRoundResolution([a, b]));

    act(() => {
      vi.advanceTimersByTime(21_000);
    });
    expect(resolveSpeakerRoundAction).toHaveBeenCalledWith("a");
    expect(resolveSpeakerRoundAction).not.toHaveBeenCalledWith("b");

    act(() => {
      vi.advanceTimersByTime(40_000);
    });
    expect(resolveSpeakerRoundAction).toHaveBeenCalledWith("b");
  });

  it("watches closing_ends_at instead of round_ends_at once the round is in its closing phase", () => {
    vi.useFakeTimers();
    const s = speaker({
      id: "s1",
      round_phase: "closing",
      round_ends_at: new Date(Date.now() - 1000).toISOString(), // already passed — should be ignored
      closing_ends_at: new Date(Date.now() + 30_000).toISOString(),
    });
    renderHook(() => useSpeakerRoundResolution([s]));

    act(() => {
      vi.advanceTimersByTime(29_000);
    });
    expect(resolveSpeakerRoundAction).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(resolveSpeakerRoundAction).toHaveBeenCalledWith("s1");
  });

  it("reschedules when the same occupancy row's deadline moves forward (a continue outcome bumping round_ends_at)", () => {
    vi.useFakeTimers();
    const initial = speaker({ id: "s1", round_ends_at: new Date(Date.now() + 10_000).toISOString() });
    const { rerender } = renderHook(({ speakers }) => useSpeakerRoundResolution(speakers), {
      initialProps: { speakers: [initial] },
    });

    // Before the original deadline, the row "continues" — same id, new
    // round_ends_at pushed further out (simulating a fresh Realtime
    // snapshot after resolution).
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    const advanced = speaker({ id: "s1", round_ends_at: new Date(Date.now() + 60_000).toISOString() });
    rerender({ speakers: [advanced] });

    // The original (now-stale) 10s deadline must not fire.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });
    expect(resolveSpeakerRoundAction).not.toHaveBeenCalled();

    // The new deadline does fire.
    act(() => {
      vi.advanceTimersByTime(55_000);
    });
    expect(resolveSpeakerRoundAction).toHaveBeenCalledTimes(1);
    expect(resolveSpeakerRoundAction).toHaveBeenCalledWith("s1");
  });

  it("clears a scheduled timer when a speaker leaves the list (seat vacated) — no stale call afterward", () => {
    vi.useFakeTimers();
    const s = speaker({ id: "s1", round_ends_at: new Date(Date.now() + 10_000).toISOString() });
    const { rerender } = renderHook(({ speakers }) => useSpeakerRoundResolution(speakers), {
      initialProps: { speakers: [s] },
    });

    rerender({ speakers: [] });

    act(() => {
      vi.advanceTimersByTime(20_000);
    });
    expect(resolveSpeakerRoundAction).not.toHaveBeenCalled();
  });
});
