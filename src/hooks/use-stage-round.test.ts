import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyStageRoundChange, useStageRound } from "./use-stage-round";
import type { StageRound } from "@/lib/repositories/stage-rounds";

function stageRound(overrides: Partial<StageRound> = {}): StageRound {
  return {
    id: "sr1",
    event_id: "e1",
    round_number: 1,
    started_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 60_000).toISOString(),
    phase: "active",
    updated_at: new Date().toISOString(),
    fallback_excluded_profile_ids: [],
    fallback_excluded_guest_ids: [],
    ...overrides,
  };
}

/**
 * Issue #21, seventh corrective pass, Sections 16-19: a real-device pass
 * found "Round 1 · awaiting pairing" staying on screen indefinitely after
 * Session Simulator's Reset deleted the `stage_rounds` row — traced to
 * this exact reducer silently discarding every DELETE event. These tests
 * pin the fix directly, independent of the hook's own Realtime wiring
 * (untestable in jsdom) — same "pure reducer, tested in isolation" shape
 * `applySpeakerChange`/`removeSpeaker` already established.
 */
describe("applyStageRoundChange", () => {
  it("adopts the new row on INSERT", () => {
    const row = stageRound();
    expect(applyStageRoundChange({ eventType: "INSERT", new: row })).toEqual(row);
  });

  it("adopts the new row on UPDATE", () => {
    const row = stageRound({ round_number: 2 });
    expect(applyStageRoundChange({ eventType: "UPDATE", new: row })).toEqual(row);
  });

  it("clears to null on DELETE — the exact bug that left a stale round display after Session Simulator Reset", () => {
    // `new` is genuinely empty on a real DELETE payload — the fix must
    // not depend on it carrying anything.
    expect(applyStageRoundChange({ eventType: "DELETE", new: {} })).toBeNull();
  });
});

/**
 * Issue #21, eighth corrective pass, Sections 12-13: reproduced live
 * against a real dev server, not just theorized — a tab whose Realtime
 * connection went stale kept showing a round from *before* the stage was
 * established ("Round 0 · awaiting pairing") indefinitely, long after
 * the authoritative round had actually advanced and gone active; a fresh
 * page load immediately showed the correct state. Same fake-Supabase
 * pattern `use-active-speakers-resync.test.ts` established.
 */
function makeFakeSupabase(row: StageRound | null) {
  let subscribeCallback: ((status: string) => void) | null = null;
  const channel = {
    on: vi.fn(() => channel),
    subscribe: vi.fn((callback: (status: string) => void) => {
      subscribeCallback = callback;
      return channel;
    }),
  };
  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({ data: row })),
        })),
      })),
    })),
  };
  return {
    client,
    triggerSubscribed: () => subscribeCallback?.("SUBSCRIBED"),
  };
}

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient }));

describe("useStageRound — visibility/focus resync (issue #21, eighth corrective pass)", () => {
  it("resyncs to the authoritative row when the tab becomes visible again — not just on the initial SUBSCRIBED callback", async () => {
    const fresh = stageRound({ round_number: 2, phase: "active" });
    const fake = makeFakeSupabase(fresh);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useStageRound("e1"));
    expect(result.current).toBeNull();

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(result.current?.round_number).toBe(2));
    expect(result.current?.phase).toBe("active");
  });

  it("resyncs to the authoritative row when the window regains focus", async () => {
    const fresh = stageRound({ round_number: 3, phase: "active" });
    const fake = makeFakeSupabase(fresh);
    createClient.mockReturnValue(fake.client);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const { result } = renderHook(() => useStageRound("e1"));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(result.current?.round_number).toBe(3));
  });

  it("still resyncs on the initial SUBSCRIBED callback (unchanged behavior)", async () => {
    const fresh = stageRound({ round_number: 1, phase: "awaiting_pairing" });
    const fake = makeFakeSupabase(fresh);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useStageRound("e1"));
    fake.triggerSubscribed();

    await waitFor(() => expect(result.current?.round_number).toBe(1));
  });
});

/**
 * Issue #21, seventeenth corrective pass: while this pass's own incident
 * was traced to a real server-side bug (migration 00000000000041), the
 * investigation's own Section 3 asked for an audit of the round
 * lifecycle for the analogous stale-observation class already fixed for
 * `useActiveSpeakers`. This hook had on-SUBSCRIBED and visibility/focus
 * resync but no bounded backstop — the one trigger that can catch a
 * single WAL message silently dropped on an otherwise-healthy,
 * continuously-visible connection, matching the exact precedent
 * `useActiveSpeakerRequests`/`useActiveSpeakers` already established.
 */
describe("useStageRound — bounded backstop (issue #21, seventeenth corrective pass)", () => {
  it("resyncs via the bounded 20s backstop with no SUBSCRIBED/visibility/focus trigger firing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fresh = stageRound({ round_number: 4, phase: "active" });
      const fake = makeFakeSupabase(fresh);
      createClient.mockReturnValue(fake.client);

      const { result } = renderHook(() => useStageRound("e1"));
      expect(result.current).toBeNull();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(result.current?.round_number).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
