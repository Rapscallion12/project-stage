import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useActiveSpeakers } from "./use-active-speakers";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

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
    round_phase: "active" as const,
    closing_ends_at: null,
    ...overrides,
  };
}

/**
 * Issue #21, sixteenth corrective pass: a real-device snapshot showed
 * simulator bootstrap's own authoritative confirmation ("Seat 1/2 =
 * ...") coexisting with `useActiveSpeakers`' own canonical client state
 * still reporting both seats vacant, 13+ seconds later. This file proves
 * the fix directly against this hook — the actual canonical stage
 * speaker state — rather than only at the component level: every race
 * shape the investigation was explicitly asked to test, plus the
 * sequence-number guard this pass added to close a *new* race the
 * investigation surfaced while building the fix (an older, slower
 * reconcile completing after — and clobbering — a newer one).
 *
 * `deferred()` lets a test control exactly when a given `.eq()` query
 * resolves, independent of when it was *called* — necessary to construct
 * "the older read finishes after the newer one" deterministically,
 * rather than hoping a real timing difference reproduces it.
 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeFakeSupabase(queryImpl?: () => Promise<{ data: EventSpeaker[] }>) {
  let subscribeCallback: ((status: string) => void) | null = null;
  const fromCalls: string[] = [];
  const handlers: Record<string, (payload: unknown) => void> = {};
  const defaultImpl = async () => ({ data: [] as EventSpeaker[] });

  const channel = {
    on: vi.fn((_type: string, config: { event: string; table: string }, callback: (payload: unknown) => void) => {
      handlers[`${config.event}:${config.table}`] = callback;
      return channel;
    }),
    subscribe: vi.fn((callback: (status: string) => void) => {
      subscribeCallback = callback;
      return channel;
    }),
  };

  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
    from: vi.fn((table: string) => {
      fromCalls.push(table);
      return {
        select: vi.fn(() => ({
          eq: vi.fn(queryImpl ?? defaultImpl),
        })),
      };
    }),
  };

  return {
    client,
    fromCalls,
    triggerSubscribed: () => {
      subscribeCallback?.("SUBSCRIBED");
    },
    triggerStatus: (status: string) => {
      subscribeCallback?.(status);
    },
    fireInsert: (row: EventSpeaker) => handlers["INSERT:event_speakers"]?.({ new: row }),
    fireUpdate: (row: EventSpeaker) => handlers["UPDATE:event_speakers"]?.({ new: row }),
  };
}

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient }));

describe("useActiveSpeakers — synchronization races (issue #21, sixteenth corrective pass)", () => {
  it("1. bootstrap-before-SUBSCRIBED: refetch('bootstrap') converges immediately, with no SUBSCRIBED callback ever having fired", async () => {
    const fresh = [speaker({ id: "boot-1", seat_number: 1, profile_id: null, guest_id: "g1", display_name: "Nimble Lynx" })];
    const fake = makeFakeSupabase(async () => ({ data: fresh }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    expect(result.current.speakers).toHaveLength(0);

    // No triggerSubscribed() call anywhere in this test — the channel
    // never reaches SUBSCRIBED. Bootstrap calls refetch directly anyway.
    let returned: EventSpeaker[] = [];
    await act(async () => {
      returned = await result.current.refetch("bootstrap");
    });

    expect(returned).toEqual(fresh);
    expect(result.current.speakers).toHaveLength(1);
    expect(result.current.speakers[0]?.display_name).toBe("Nimble Lynx");
  });

  it("2. missed both bootstrap INSERT events: neither Realtime INSERT ever fires, but an authoritative reconcile still populates both seats", async () => {
    const fresh = [
      speaker({ id: "s1", seat_number: 1, guest_id: "g1", profile_id: null, display_name: "Nimble Lynx" }),
      speaker({ id: "s2", seat_number: 2, guest_id: "g2", profile_id: null, display_name: "Dapper Deer" }),
    ];
    const fake = makeFakeSupabase(async () => ({ data: fresh }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    // Never call fake.fireInsert(...) for either seat — simulates both
    // Realtime deltas being silently dropped.
    await act(async () => {
      await result.current.refetch("bootstrap");
    });

    expect(result.current.speakers).toHaveLength(2);
    expect(result.current.speakers.map((s) => s.display_name).sort()).toEqual(["Dapper Deer", "Nimble Lynx"]);
  });

  it("3. stale initial fetch race: an older, slower-to-resolve reconcile completing after a newer one must not clobber it — the sequence guard closes this", async () => {
    const older = deferred<{ data: EventSpeaker[] }>();
    const newer = deferred<{ data: EventSpeaker[] }>();
    let call = 0;
    const fake = makeFakeSupabase(() => {
      call++;
      return call === 1 ? older.promise : newer.promise;
    });
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));

    // Two reconciles started back-to-back — the first (older) starts,
    // then the second (newer) starts before the first has resolved.
    let olderResult: EventSpeaker[] | undefined;
    let newerResult: EventSpeaker[] | undefined;
    const olderCall = result.current.refetch("subscribed").then((r) => (olderResult = r));
    const newerCall = result.current.refetch("bootstrap").then((r) => (newerResult = r));

    // The *newer* call's own fetch resolves first (its own real read
    // simply happened to land faster) — with correct occupancy.
    await act(async () => {
      newer.resolve({ data: [speaker({ id: "correct", seat_number: 1, display_name: "Correct Occupant" })] });
      await newerCall;
    });
    expect(result.current.speakers[0]?.display_name).toBe("Correct Occupant");

    // The *older* call's own fetch finally resolves — with stale, empty
    // data (as if it read the database before the bootstrap claim landed).
    // It must NOT overwrite the newer, correct state above.
    await act(async () => {
      older.resolve({ data: [] });
      await olderCall;
    });

    // The hook's own state still reflects the newer reconcile.
    expect(result.current.speakers).toHaveLength(1);
    expect(result.current.speakers[0]?.display_name).toBe("Correct Occupant");
    // Both calls still returned what they actually fetched — a caller
    // verifying convergence from either one sees the truth it read, even
    // though only the newer one's result was applied to shared state.
    expect(newerResult).toHaveLength(1);
    expect(olderResult).toHaveLength(0);
  });

  it("4. partial Realtime delivery: seat 1's INSERT is received, seat 2's is missed — a reconcile still results in both seats correct", async () => {
    const seat1 = speaker({ id: "s1", seat_number: 1, guest_id: "g1", profile_id: null, display_name: "Nimble Lynx" });
    const seat2 = speaker({ id: "s2", seat_number: 2, guest_id: "g2", profile_id: null, display_name: "Dapper Deer" });
    const fake = makeFakeSupabase(async () => ({ data: [seat1, seat2] }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));

    act(() => {
      fake.fireInsert(seat1); // seat 2's own INSERT is never fired
    });
    await waitFor(() => expect(result.current.speakers).toHaveLength(1));

    await act(async () => {
      await result.current.refetch("bootstrap");
    });

    expect(result.current.speakers).toHaveLength(2);
    expect(result.current.speakers.map((s) => s.seat_number).sort()).toEqual([1, 2]);
  });

  it("5. normal Realtime fast path: a plain INSERT updates state immediately, with no reconcile involved at all", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    expect(result.current.speakers).toHaveLength(0);

    act(() => {
      fake.fireInsert(speaker({ id: "fast", seat_number: 1, display_name: "Fast Path" }));
    });

    // No reconcile call anywhere — the Realtime handler alone applied it.
    expect(result.current.speakers).toHaveLength(1);
    expect(result.current.speakers[0]?.display_name).toBe("Fast Path");
    expect(result.current.getSyncDiagnostics().lastMutationSource).toBe("realtime");
    expect(result.current.getSyncDiagnostics().lastReconcileStartedAt).toBeNull();
  });

  it("6a. removal/replacement reconciliation: a replaced identity on the same seat is correct after reconcile — the old occupant is never resurrected", async () => {
    const original = speaker({ id: "original", seat_number: 2, guest_id: "g-old", profile_id: null, display_name: "Curious Heron" });
    const replacement = speaker({ id: "replacement", seat_number: 2, guest_id: "g-new", profile_id: null, display_name: "Gentle Heron" });
    const fake = makeFakeSupabase(async () => ({ data: [replacement] }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", [original]));
    expect(result.current.speakers[0]?.display_name).toBe("Curious Heron");

    await act(async () => {
      await result.current.refetch("manual");
    });

    expect(result.current.speakers).toHaveLength(1);
    expect(result.current.speakers[0]?.display_name).toBe("Gentle Heron");
  });

  it("6b. removal/replacement reconciliation: a vacated seat disappears after reconcile — never left stale", async () => {
    const occupant = speaker({ id: "s1", seat_number: 1, display_name: "Leaving Speaker" });
    const fake = makeFakeSupabase(async () => ({ data: [] }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", [occupant]));
    expect(result.current.speakers).toHaveLength(1);

    await act(async () => {
      await result.current.refetch("manual");
    });

    expect(result.current.speakers).toHaveLength(0);
  });

  it("6c. removal/replacement reconciliation: both seats occupied and one occupied are both reported correctly, distinctly", async () => {
    const bothOccupied = [
      speaker({ id: "a", seat_number: 1, display_name: "Seat One" }),
      speaker({ id: "b", seat_number: 2, display_name: "Seat Two" }),
    ];
    const fake = makeFakeSupabase(async () => ({ data: bothOccupied }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    await act(async () => {
      await result.current.refetch("manual");
    });
    expect(result.current.speakers).toHaveLength(2);

    fake.client.from.mockImplementation(() => ({
      select: vi.fn(() => ({ eq: vi.fn(async () => ({ data: [bothOccupied[0]] })) })),
    }));
    await act(async () => {
      await result.current.refetch("manual");
    });
    expect(result.current.speakers).toHaveLength(1);
    expect(result.current.speakers[0]?.display_name).toBe("Seat One");
  });

  it("sync diagnostics: channel status, subscribed/reconcile timestamps, reason, and result are all populated and legible", async () => {
    const fake = makeFakeSupabase(async () => ({ data: [speaker({ id: "s1", seat_number: 1, display_name: "Diag Speaker" })] }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    expect(result.current.getSyncDiagnostics().channelStatus).toBeNull();
    expect(result.current.getSyncDiagnostics().lastSubscribedAt).toBeNull();

    fake.triggerSubscribed();
    await waitFor(() => expect(result.current.speakers).toHaveLength(1));

    const diag = result.current.getSyncDiagnostics();
    expect(diag.channelStatus).toBe("SUBSCRIBED");
    expect(diag.lastSubscribedAt).not.toBeNull();
    expect(diag.lastReconcileStartedAt).not.toBeNull();
    expect(diag.lastReconcileCompletedAt).not.toBeNull();
    expect(diag.lastReconcileReason).toBe("subscribed");
    expect(diag.lastReconcileResult).toBe("changed"); // empty -> 1 occupant
    expect(diag.lastMutationSource).toBe("reconcile");
  });

  it("visibility restoration triggers a reconcile tagged 'visibility'", async () => {
    const fake = makeFakeSupabase(async () => ({ data: [speaker({ id: "s1", seat_number: 1, display_name: "Visibility Speaker" })] }));
    createClient.mockReturnValue(fake.client);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const { result } = renderHook(() => useActiveSpeakers("e1", []));

    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(result.current.speakers).toHaveLength(1));

    expect(result.current.getSyncDiagnostics().lastReconcileReason).toBe("visibility");
  });

  it("window focus triggers a reconcile tagged 'focus'", async () => {
    const fake = makeFakeSupabase(async () => ({ data: [speaker({ id: "s1", seat_number: 1, display_name: "Focus Speaker" })] }));
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));

    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(result.current.speakers).toHaveLength(1));

    expect(result.current.getSyncDiagnostics().lastReconcileReason).toBe("focus");
  });

  it("the bounded 20s backstop reconciles even with no SUBSCRIBED/visibility/focus/manual trigger firing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fake = makeFakeSupabase(async () => ({ data: [speaker({ id: "s1", seat_number: 1, display_name: "Backstop Speaker" })] }));
      createClient.mockReturnValue(fake.client);

      const { result } = renderHook(() => useActiveSpeakers("e1", []));
      expect(result.current.speakers).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });

      expect(result.current.speakers).toHaveLength(1);
      expect(result.current.getSyncDiagnostics().lastReconcileReason).toBe("backstop");
    } finally {
      vi.useRealTimers();
    }
  });
});
