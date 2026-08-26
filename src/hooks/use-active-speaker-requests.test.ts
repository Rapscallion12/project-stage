import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { applyPendingRequestChange, useActiveSpeakerRequests } from "./use-active-speaker-requests";
import type { SpeakerRequest } from "@/lib/repositories/speaker-requests";

function request(overrides: Partial<SpeakerRequest> = {}): SpeakerRequest {
  return {
    id: "r1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    message_id: "m1",
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    ...overrides,
  };
}

describe("applyPendingRequestChange", () => {
  it("adds a newly pending request", () => {
    const result = applyPendingRequestChange({}, request({ id: "r1" }));
    expect(result.r1).toBeDefined();
  });

  it("removes a request once it's granted", () => {
    const pending = request({ id: "r1", status: "pending" });
    const granted = { ...pending, status: "granted" as const, resolved_at: new Date().toISOString() };
    const afterAdd = applyPendingRequestChange({}, pending);
    const afterGrant = applyPendingRequestChange(afterAdd, granted);
    expect(afterGrant.r1).toBeUndefined();
  });

  it("removes a request once it's withdrawn", () => {
    const pending = request({ id: "r1", status: "pending" });
    const withdrawn = { ...pending, status: "withdrawn" as const, resolved_at: new Date().toISOString() };
    const afterAdd = applyPendingRequestChange({}, pending);
    const afterWithdraw = applyPendingRequestChange(afterAdd, withdrawn);
    expect(afterWithdraw.r1).toBeUndefined();
  });

  it("leaves other requests untouched", () => {
    const r1 = request({ id: "r1" });
    const r2 = request({ id: "r2" });
    let state = applyPendingRequestChange({}, r1);
    state = applyPendingRequestChange(state, r2);
    expect(Object.keys(state).sort()).toEqual(["r1", "r2"]);
  });
});

/** Same fake-Supabase-with-triggerable-SUBSCRIBED pattern as use-active-speakers-resync.test.ts, adapted for this hook's two-.eq()-then-.order() query chain. */
function makeFakeSupabase(pendingRows: SpeakerRequest[]) {
  let subscribeCallback: ((status: string) => void) | null = null;
  const fromCalls: string[] = [];

  const channel = {
    on: vi.fn().mockReturnThis(),
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
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(async () => ({ data: pendingRows })),
            })),
          })),
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
  };
}

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient }));

describe("useActiveSpeakerRequests", () => {
  it("starts from initialPendingRequests", () => {
    const fake = makeFakeSupabase([]);
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() =>
      useActiveSpeakerRequests("e1", [request({ id: "r1" })]),
    );
    expect(result.current.pendingRequests).toHaveLength(1);
  });

  it("resyncs on the initial SUBSCRIBED callback — the same missed-delta protection useActiveSpeakers has", async () => {
    const fresh = [request({ id: "fresh" })];
    const fake = makeFakeSupabase(fresh);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakerRequests("e1", []));
    expect(result.current.pendingRequests).toHaveLength(0);

    fake.triggerSubscribed();

    await waitFor(() => {
      expect(result.current.pendingRequests).toHaveLength(1);
    });
    expect(result.current.pendingRequests[0]?.id).toBe("fresh");
    expect(fake.fromCalls).toContain("speaker_requests");
  });

  it("orders pending requests oldest first (documented temporary FIFO ordering)", () => {
    const fake = makeFakeSupabase([]);
    createClient.mockReturnValue(fake.client);
    const older = request({ id: "older", created_at: "2026-01-01T00:00:00.000Z" });
    const newer = request({ id: "newer", created_at: "2026-01-01T00:00:05.000Z" });
    const { result } = renderHook(() => useActiveSpeakerRequests("e1", [newer, older]));
    expect(result.current.pendingRequests.map((r) => r.id)).toEqual(["older", "newer"]);
  });
});
