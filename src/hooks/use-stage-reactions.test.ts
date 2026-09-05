import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReactionsController } from "./use-stage-reactions";

const { createClient, sendStageReaction } = vi.hoisted(() => ({
  createClient: vi.fn(),
  sendStageReaction: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient }));
vi.mock("@/app/events/[id]/room/actions", () => ({ sendStageReaction }));

/** Same fake-channel technique as use-lobby-realtime.test.ts's own doc comment — captures the registered broadcast callback so a test can fire it directly, without a live websocket. */
function makeFakeSupabase() {
  let broadcastHandler: ((message: { payload: unknown }) => void) | null = null;
  const channel = {
    on: vi.fn((_type: string, _config: { event: string }, callback: (message: { payload: unknown }) => void) => {
      broadcastHandler = callback;
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };
  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };
  return {
    client,
    fireReaction: (payload: unknown) => broadcastHandler?.({ payload }),
  };
}

describe("useReactionsController / useStageReactions (pre-launch interaction pass)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it("starts with no incoming reactions", () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useReactionsController("e1"));
    expect(result.current.incoming).toEqual([]);
  });

  it("adds an incoming reaction when the broadcast channel fires", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useReactionsController("e1"));

    act(() => {
      fake.fireReaction({
        id: "r1",
        targetIdentity: "profile:alice",
        emoji: "❤️",
        x: 0.5,
        y: 0.5,
        senderIdentity: "guest:g1",
        ts: Date.now(),
      });
    });

    await waitFor(() => expect(result.current.incoming).toHaveLength(1));
    expect(result.current.incoming[0].targetIdentity).toBe("profile:alice");
  });

  it("subscribes to a per-event channel name", () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    renderHook(() => useReactionsController("event-123"));
    expect(fake.client.channel).toHaveBeenCalledWith("event-reactions:event-123");
  });

  it("send() calls the sendStageReaction server action with the target identity, emoji, and coordinates", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    sendStageReaction.mockResolvedValue({ ok: true, heatAfter: 12, inCooldownAfter: false });
    const { result } = renderHook(() => useReactionsController("e1"));

    await act(async () => {
      await result.current.send("profile:bob", "🔥", 0.2, 0.8);
    });

    expect(sendStageReaction).toHaveBeenCalledWith("e1", "profile:bob", "🔥", 0.2, 0.8);
  });

  it("send() optimistically bumps heat immediately, before the server responds", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    let resolveSend: (value: unknown) => void = () => {};
    sendStageReaction.mockReturnValue(new Promise((resolve) => (resolveSend = resolve)));
    const { result } = renderHook(() => useReactionsController("e1"));

    let sendPromise: Promise<unknown>;
    act(() => {
      sendPromise = result.current.send("profile:bob", "🔥", 0.5, 0.5);
    });
    expect(result.current.heat).toBeGreaterThan(0);

    await act(async () => {
      resolveSend({ ok: true, heatAfter: 12, inCooldownAfter: false });
      await sendPromise;
    });
  });

  it("send() reconciles heat with the server's authoritative response once it resolves", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    sendStageReaction.mockResolvedValue({ ok: false, reason: "cooling-down", heatAfter: 100, inCooldownAfter: true });
    const { result } = renderHook(() => useReactionsController("e1"));

    await act(async () => {
      await result.current.send("profile:bob", "🔥", 0.5, 0.5);
    });

    expect(result.current.heat).toBe(100);
    expect(result.current.inCooldown).toBe(true);
    expect(result.current.canSend).toBe(false);
  });

  it("bundles local reaction preferences alongside the delivery/heat state — one controller, one shared instance", () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useReactionsController("e1"));
    expect(result.current.selectedEmoji).toBe("❤️");
    expect(result.current.displayMode).toBe("on-speaker");
    expect(result.current.showReactions).toBe(true);
    act(() => result.current.setSelectedEmoji("😮"));
    expect(result.current.selectedEmoji).toBe("😮");
  });

  it("unsubscribes and clears incoming reactions on unmount", () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { unmount } = renderHook(() => useReactionsController("e1"));
    unmount();
    expect(fake.client.removeChannel).toHaveBeenCalledTimes(1);
  });
});
