import { renderHook, waitFor } from "@testing-library/react";
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
 * Issue #18 real-device finding (2026-08-27): a fake Supabase client
 * exercising the exact chain `useActiveSpeakers` calls
 * (`.channel().on().on().subscribe(callback)` for Realtime,
 * `.from().select().eq()` for the resync read) — there was no existing
 * mock for a Realtime channel's subscribe-status callback anywhere in
 * this codebase, since nothing needed one before this fix.
 * `triggerSubscribed()` lets a test simulate the channel reaching
 * `SUBSCRIBED` (the initial subscription, or an automatic reconnect)
 * whenever it chooses, independent of the mocked query's own resolve
 * timing — matching how the real client's callback firing and the
 * resulting fetch's completion are two genuinely separate moments.
 */
function makeFakeSupabase(activeRows: EventSpeaker[]) {
  let subscribeCallback: ((status: string) => void) | null = null;
  const fromCalls: string[] = [];
  const handlers: Record<string, (payload: unknown) => void> = {};

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
          eq: vi.fn(async () => ({ data: activeRows })),
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
    // Session Simulator Reset Session follow-up — fires the registered
    // DELETE handler directly, without a live websocket.
    fireSpeakerDelete: (deleted: EventSpeaker) => handlers["DELETE:event_speakers"]?.({ old: deleted }),
  };
}

const { createClient } = vi.hoisted(() => ({
  createClient: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient }));

describe("useActiveSpeakers — resync on (re)subscribe (issue #18 real-device finding, 2026-08-27)", () => {
  it("resyncs from event_speakers_active on the initial SUBSCRIBED callback, replacing whatever initialSpeakers had", async () => {
    const fresh = [speaker({ id: "fresh", profile_id: "p2", seat_number: 1, display_name: "Fresh From Server" })];
    const fake = makeFakeSupabase(fresh);
    createClient.mockReturnValue(fake.client);

    const stale = [speaker({ id: "stale", profile_id: "p-stale", seat_number: 1, display_name: "Stale Initial" })];
    const { result } = renderHook(() => useActiveSpeakers("e1", stale));
    expect(result.current.speakers[0]?.display_name).toBe("Stale Initial");

    fake.triggerSubscribed();

    await waitFor(() => {
      expect(result.current.speakers[0]?.display_name).toBe("Fresh From Server");
    });
    expect(fake.fromCalls).toContain("event_speakers_active");
  });

  it("this is exactly the mechanism that closes the real-device gap: a genuinely-active seat the client's accumulated state never had (a missed Realtime delta) appears after a resync", async () => {
    const missedSeat = speaker({ id: "missed", profile_id: "p-missed", seat_number: 2, display_name: "Missed Delta" });
    const fake = makeFakeSupabase([missedSeat]);
    createClient.mockReturnValue(fake.client);

    // Started with nothing for seat 2 — as if the original INSERT was
    // never delivered to this tab (a dropped/reconnected websocket).
    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    expect(result.current.speakers).toHaveLength(0);

    fake.triggerSubscribed();

    await waitFor(() => {
      expect(result.current.speakers).toHaveLength(1);
    });
    expect(result.current.speakers[0]?.profile_id).toBe("p-missed");
  });

  it("exposes a refetch() that performs the same resync on demand — the trigger EventRoom uses on a proven ownership contradiction", async () => {
    const fake = makeFakeSupabase([speaker({ id: "s1", profile_id: "p1", display_name: "Reconciled" })]);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    expect(result.current.speakers).toHaveLength(0);

    await result.current.refetch();

    await waitFor(() => {
      expect(result.current.speakers[0]?.display_name).toBe("Reconciled");
    });
  });

  it("a non-SUBSCRIBED status (e.g. a transient CHANNEL_ERROR) does not trigger a resync by itself", async () => {
    const fake = makeFakeSupabase([speaker({ id: "s1", profile_id: "p1", display_name: "Should Not Appear" })]);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", []));
    const subscribeCall = fake.client.channel.mock.results[0]?.value.subscribe.mock.calls[0]?.[0];
    subscribeCall?.("CHANNEL_ERROR");

    // Give any accidental async resync a chance to land, then assert it didn't.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.speakers).toHaveLength(0);
  });

  it("Session Simulator Reset Session follow-up: a hard-deleted simulated seat empties without a page reload, leaving a real occupied seat untouched", async () => {
    const simSeat = speaker({ id: "sim-seat", seat_number: 1, profile_id: null, display_name: "Fake Fox" });
    const realSeat = speaker({ id: "real-seat", seat_number: 2, profile_id: "p-real", display_name: "Real Person" });
    const fake = makeFakeSupabase([]);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakers("e1", [simSeat, realSeat]));
    expect(result.current.speakers).toHaveLength(2);

    fake.fireSpeakerDelete(simSeat);

    await waitFor(() => {
      expect(result.current.speakers).toHaveLength(1);
    });
    expect(result.current.speakers[0]?.display_name).toBe("Real Person");
  });
});
