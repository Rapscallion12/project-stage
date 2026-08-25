import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reconnectDiagnostics, remainingGraceSeconds, useReconnectCountdown } from "./use-reconnect-countdown";
import { SPEAKER_DISCONNECT_GRACE_MS, SPEAKER_DISCONNECT_GRACE_SECONDS } from "@/lib/speaker-reconnect";

describe("remainingGraceSeconds (issue #18 reconnect-countdown finding)", () => {
  it("is null when disconnectedAt is null", () => {
    expect(remainingGraceSeconds(null, Date.now())).toBeNull();
  });

  it("is the full grace period right at the moment of disconnect", () => {
    const now = Date.now();
    expect(remainingGraceSeconds(new Date(now).toISOString(), now)).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS);
  });

  it("computes remaining time from the real deadline, not a fresh countdown — reopening midway shows the correct remainder", () => {
    const now = Date.now();
    const disconnectedAt = new Date(now - 8000).toISOString();
    expect(remainingGraceSeconds(disconnectedAt, now)).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS - 8);
  });

  it("clamps at 0 once past the deadline — never negative", () => {
    const now = Date.now();
    const disconnectedAt = new Date(now - (SPEAKER_DISCONNECT_GRACE_MS + 30_000)).toISOString();
    expect(remainingGraceSeconds(disconnectedAt, now)).toBe(0);
  });

  it("rounds up to the next whole second, so it never reads 0 a moment before the deadline actually passes", () => {
    const now = Date.now();
    const disconnectedAt = new Date(now - (SPEAKER_DISCONNECT_GRACE_MS - 500)).toISOString(); // 500ms left
    expect(remainingGraceSeconds(disconnectedAt, now)).toBe(1);
  });
});

describe("reconnectDiagnostics (issue #18 real-device finding, 2026-08-25)", () => {
  it("reports inactive/null for every field when there's no disconnect", () => {
    expect(reconnectDiagnostics(null, null)).toEqual({
      raw: "null",
      parsed: "n/a",
      deadline: "n/a",
      remainingSeconds: null,
      active: false,
    });
  });

  it("reports the raw value verbatim, a parsed ISO timestamp, and a deadline exactly GRACE_MS later", () => {
    const now = Date.now();
    const disconnectedAt = new Date(now - 4000).toISOString();
    const diag = reconnectDiagnostics(disconnectedAt, SPEAKER_DISCONNECT_GRACE_SECONDS - 4);
    expect(diag.raw).toBe(disconnectedAt);
    expect(diag.parsed).toBe(new Date(disconnectedAt).toISOString());
    expect(diag.deadline).toBe(new Date(new Date(disconnectedAt).getTime() + SPEAKER_DISCONNECT_GRACE_MS).toISOString());
    expect(diag.remainingSeconds).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS - 4);
    expect(diag.active).toBe(true);
  });

  it("passes the caller's remainingSeconds through verbatim — never recomputed from a second, independently-clocked now that could disagree with what's on screen", () => {
    const disconnectedAt = new Date(Date.now() - 4000).toISOString();
    expect(reconnectDiagnostics(disconnectedAt, 999).remainingSeconds).toBe(999);
  });

  it("marks an unparseable raw value as invalid instead of throwing or silently showing a wrong deadline", () => {
    const diag = reconnectDiagnostics("not-a-real-timestamp", null);
    expect(diag.raw).toBe("not-a-real-timestamp");
    expect(diag.parsed).toBe("invalid");
    expect(diag.deadline).toBe("invalid");
  });
});

describe("useReconnectCountdown", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns null when there's nothing to count down", () => {
    const { result } = renderHook(() => useReconnectCountdown(null));
    expect(result.current).toBeNull();
  });

  it("returns the correct remaining time derived from the real deadline immediately on mount — no arbitrary fresh-11 restart", () => {
    const disconnectedAt = new Date(Date.now() - 8000).toISOString();
    const { result } = renderHook(() => useReconnectCountdown(disconnectedAt));
    expect(result.current).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS - 8);
  });

  it("ticks down by one roughly every second", async () => {
    vi.useFakeTimers();
    const disconnectedAt = new Date().toISOString();
    const { result } = renderHook(() => useReconnectCountdown(disconnectedAt));
    expect(result.current).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS - 1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS - 2);
  });

  it("stops ticking and returns null the instant disconnectedAt clears (reconnect) — no stale interval survives", async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ disconnectedAt }: { disconnectedAt: string | null }) => useReconnectCountdown(disconnectedAt), {
      initialProps: { disconnectedAt: new Date().toISOString() as string | null },
    });
    expect(result.current).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS);

    rerender({ disconnectedAt: null });
    expect(result.current).toBeNull();

    // Advancing well past the original deadline must never revive a
    // countdown — the interval was genuinely cleared, not just ignored.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(result.current).toBeNull();
  });

  it("a fresh disconnectedAt after a reconnect (a new disconnect) starts counting from the new deadline, not the old one", async () => {
    vi.useFakeTimers();
    const first = new Date().toISOString();
    const { result, rerender } = renderHook(({ disconnectedAt }: { disconnectedAt: string | null }) => useReconnectCountdown(disconnectedAt), {
      initialProps: { disconnectedAt: first as string | null },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(result.current).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS - 5);

    rerender({ disconnectedAt: null }); // reconnected
    const second = new Date().toISOString(); // disconnected again, fresh deadline
    rerender({ disconnectedAt: second });
    expect(result.current).toBe(SPEAKER_DISCONNECT_GRACE_SECONDS);
  });

  it("never goes negative once real time passes the deadline", async () => {
    vi.useFakeTimers();
    const disconnectedAt = new Date().toISOString();
    const { result } = renderHook(() => useReconnectCountdown(disconnectedAt));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SPEAKER_DISCONNECT_GRACE_MS + 30_000);
    });
    expect(result.current).toBe(0);
  });
});
