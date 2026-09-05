import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReactionsController } from "./use-stage-reactions";

const { createClient, sendStageReaction } = vi.hoisted(() => ({
  createClient: vi.fn(),
  sendStageReaction: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({ createClient }));
vi.mock("@/app/events/[id]/room/actions", () => ({ sendStageReaction }));

const MY_IDENTITY = "profile:me";

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
    const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));
    expect(result.current.incoming).toEqual([]);
  });

  it("adds an incoming reaction when the broadcast channel fires", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

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
    renderHook(() => useReactionsController("event-123", MY_IDENTITY));
    expect(fake.client.channel).toHaveBeenCalledWith("event-reactions:event-123");
  });

  it("send() calls the sendStageReaction server action with the target identity, emoji, coordinates, and a generated reaction id", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    sendStageReaction.mockResolvedValue({ ok: true, heatAfter: 12, inCooldownAfter: false });
    const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

    await act(async () => {
      await result.current.send("profile:bob", "🔥", 0.2, 0.8);
    });

    expect(sendStageReaction).toHaveBeenCalledWith("e1", "profile:bob", "🔥", 0.2, 0.8, expect.any(String));
  });

  describe("instant local sender feedback (real-device follow-up)", () => {
    it("an allowed send renders a local reaction immediately, synchronously — before the server round trip resolves", () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      // Never resolves during this test — proves the local entry doesn't
      // wait on it.
      sendStageReaction.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

      act(() => {
        void result.current.send("profile:bob", "🔥", 0.25, 0.75);
      });

      expect(result.current.incoming).toHaveLength(1);
      expect(result.current.incoming[0]).toMatchObject({
        targetIdentity: "profile:bob",
        emoji: "🔥",
        x: 0.25,
        y: 0.75,
        senderIdentity: MY_IDENTITY,
      });
    });

    it("the authoritative send still occurs concurrently, using the same reaction id already rendered locally", () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      sendStageReaction.mockReturnValue(new Promise(() => {}));
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

      act(() => {
        void result.current.send("profile:bob", "🔥", 0.5, 0.5);
      });

      const localId = result.current.incoming[0].id;
      expect(sendStageReaction).toHaveBeenCalledWith("e1", "profile:bob", "🔥", 0.5, 0.5, localId);
    });

    it("does not render a local reaction at all when the client already knows sending is currently blocked (in cooldown)", async () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      // Drive the client's own heat state into cooldown first.
      sendStageReaction.mockResolvedValue({ ok: false, reason: "cooling-down", heatAfter: 100, inCooldownAfter: true });
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));
      await act(async () => {
        await result.current.send("profile:bob", "🔥", 0.5, 0.5);
      });
      expect(result.current.canSend).toBe(false);

      // The next tap: the client already knows it's blocked.
      sendStageReaction.mockReturnValue(new Promise(() => {}));
      act(() => {
        void result.current.send("profile:bob", "😮", 0.1, 0.1);
      });

      // No *new* local entry for this second, known-blocked attempt — only
      // whatever the first (accepted-at-the-hook-level, since canSend was
      // still true then) attempt already added, if anything. Confirms no
      // 😮 was rendered.
      expect(result.current.incoming.some((r) => r.emoji === "😮")).toBe(false);
      // The authoritative call still happens regardless — the server, not
      // this local guess, remains the real decision-maker.
      expect(sendStageReaction).toHaveBeenCalledWith("e1", "profile:bob", "😮", 0.1, 0.1, expect.any(String));
    });

    it("does not render a duplicate when the sender's own accepted reaction is later delivered back over the broadcast channel", async () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      sendStageReaction.mockResolvedValue({ ok: true, heatAfter: 12, inCooldownAfter: false });
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

      await act(async () => {
        await result.current.send("profile:bob", "🔥", 0.5, 0.5);
      });
      expect(result.current.incoming).toHaveLength(1);
      const localId = result.current.incoming[0].id;

      // The server's own broadcast, echoing the exact id sendStageReaction
      // was called with — this is what a real round trip delivers back to
      // the sender's own subscribed channel.
      act(() => {
        fake.fireReaction({
          id: localId,
          targetIdentity: "profile:bob",
          emoji: "🔥",
          x: 0.5,
          y: 0.5,
          senderIdentity: MY_IDENTITY,
          ts: Date.now(),
        });
      });

      expect(result.current.incoming).toHaveLength(1);
    });

    it("real-device regression: the dedup still works even after the optimistic burst has already been pruned from the screen — the original bug", async () => {
      // The actual root cause: the first dedup design compared the
      // broadcast's id against whatever was still in `incoming`, which
      // is pruned after REACTION_BURST_LIFETIME_MS (2200ms). A round
      // trip slower than that meant the id match had nothing left to
      // match against, so the "confirmation" got added as a brand-new
      // reaction. This test drives exactly that timing and proves the
      // fix (a separate, longer-lived sent-id memory) survives it.
      vi.useFakeTimers();
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      let resolveSend: (value: unknown) => void = () => {};
      sendStageReaction.mockReturnValue(new Promise((resolve) => (resolveSend = resolve)));
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

      act(() => {
        void result.current.send("profile:bob", "🔥", 0.5, 0.5);
      });
      const localId = result.current.incoming[0].id;
      expect(result.current.incoming).toHaveLength(1);

      // Let the on-screen burst's own prune timer fire — well past
      // REACTION_BURST_LIFETIME_MS — before the round trip "resolves".
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(result.current.incoming).toHaveLength(0); // the burst genuinely finished and was pruned

      // The slow round trip finally resolves, and the broadcast for the
      // exact same id arrives back over the channel.
      await act(async () => {
        resolveSend({ ok: true, heatAfter: 12, inCooldownAfter: false });
        fake.fireReaction({
          id: localId,
          targetIdentity: "profile:bob",
          emoji: "🔥",
          x: 0.5,
          y: 0.5,
          senderIdentity: MY_IDENTITY,
          ts: Date.now(),
        });
      });

      // Must NOT reappear — the sent-id memory (30s) outlives the burst's
      // own 2.2s on-screen lifetime, so this is still recognized as this
      // tab's own confirmed echo.
      expect(result.current.incoming).toHaveLength(0);
      vi.useRealTimers();
    });

    it("the sender's own confirmed echo never increments heat a second time", async () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      sendStageReaction.mockResolvedValue({ ok: true, heatAfter: 12, inCooldownAfter: false });
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

      await act(async () => {
        await result.current.send("profile:bob", "🔥", 0.5, 0.5);
      });
      const localId = result.current.incoming[0].id;
      const heatAfterSend = result.current.heat;
      expect(heatAfterSend).toBeCloseTo(12, 5);

      act(() => {
        fake.fireReaction({
          id: localId,
          targetIdentity: "profile:bob",
          emoji: "🔥",
          x: 0.5,
          y: 0.5,
          senderIdentity: MY_IDENTITY,
          ts: Date.now(),
        });
      });

      // Receiving the echo must not touch heat at all — only send() ever
      // does, and it wasn't called again.
      expect(result.current.heat).toBe(heatAfterSend);
    });

    it("incoming reactions from other viewers never affect my own outgoing heat", async () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));
      expect(result.current.heat).toBe(0);

      act(() => {
        fake.fireReaction({
          id: "someone-elses-reaction",
          targetIdentity: "profile:alice",
          emoji: "😂",
          x: 0.5,
          y: 0.5,
          senderIdentity: "guest:someone-else",
          ts: Date.now(),
        });
      });

      expect(result.current.heat).toBe(0);
      expect(result.current.canSend).toBe(true);
    });

    it("self-origin filtering only suppresses ids this exact tab actually sent — a same-identity reaction this tab never sent (e.g. from another tab/device) still renders on its first sighting", async () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

      // Same senderIdentity as this tab's own viewer, but an id this tab
      // never generated via send() — e.g. the same guest cookie open in
      // a second tab. Must NOT be suppressed merely for matching identity.
      act(() => {
        fake.fireReaction({
          id: "sent-from-a-different-tab",
          targetIdentity: "profile:bob",
          emoji: "👏",
          x: 0.3,
          y: 0.3,
          senderIdentity: MY_IDENTITY,
          ts: Date.now(),
        });
      });

      expect(result.current.incoming).toHaveLength(1);
      expect(result.current.heat).toBe(0); // still never affects outgoing heat
    });

    it("an unexpected authoritative rejection after an optimistic render is not undone — it just finishes on its own and reconciles heat", async () => {
      const fake = makeFakeSupabase();
      createClient.mockReturnValue(fake.client);
      sendStageReaction.mockResolvedValue({ ok: false, reason: "cooling-down", heatAfter: 97, inCooldownAfter: true });
      const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

      await act(async () => {
        await result.current.send("profile:bob", "🔥", 0.5, 0.5);
      });

      // The optimistic entry (canSend was true at the moment of the tap)
      // is still there — no awkward removal attempt — while heat/cooldown
      // are reconciled to the server's authoritative rejection.
      expect(result.current.incoming).toHaveLength(1);
      expect(result.current.heat).toBe(97);
      expect(result.current.inCooldown).toBe(true);
    });
  });

  it("send() optimistically bumps heat immediately, before the server responds", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    let resolveSend: (value: unknown) => void = () => {};
    sendStageReaction.mockReturnValue(new Promise((resolve) => (resolveSend = resolve)));
    const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

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
    const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));

    await act(async () => {
      await result.current.send("profile:bob", "🔥", 0.5, 0.5);
    });

    expect(result.current.heat).toBe(100);
    expect(result.current.inCooldown).toBe(true);
    expect(result.current.canSend).toBe(false);
  });

  it("bundles local reaction preferences and the viewer's own identity alongside the delivery/heat state — one controller, one shared instance", () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useReactionsController("e1", MY_IDENTITY));
    expect(result.current.selectedEmoji).toBe("❤️");
    expect(result.current.displayMode).toBe("on-speaker");
    expect(result.current.showReactions).toBe(true);
    expect(result.current.myIdentity).toBe(MY_IDENTITY);
    act(() => result.current.setSelectedEmoji("😮"));
    expect(result.current.selectedEmoji).toBe("😮");
  });

  it("unsubscribes and clears incoming reactions on unmount", () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { unmount } = renderHook(() => useReactionsController("e1", MY_IDENTITY));
    unmount();
    expect(fake.client.removeChannel).toHaveBeenCalledTimes(1);
  });
});
