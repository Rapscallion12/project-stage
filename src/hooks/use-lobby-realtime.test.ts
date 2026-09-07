import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { removeMessage, removeReaction, useLobbyRealtime, type LobbyMessage, type ReactionState } from "./use-lobby-realtime";
import type { Identity } from "@/lib/identity";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@/app/events/[id]/lobby/actions", () => ({ sendMessage }));

function message(overrides: Partial<LobbyMessage> = {}): LobbyMessage {
  return {
    id: "m1",
    author_display_name: "Someone",
    author_profile_id: null,
    author_guest_id: "g1",
    body: "hello",
    created_at: new Date().toISOString(),
    is_speaker_request: false,
    ...overrides,
  };
}

describe("removeMessage (pure)", () => {
  it("removes the matching message, leaves everything else untouched", () => {
    const messages = [message({ id: "a" }), message({ id: "b" }), message({ id: "c" })];
    expect(removeMessage(messages, "b").map((m) => m.id)).toEqual(["a", "c"]);
  });

  it("is a no-op when the id isn't present", () => {
    const messages = [message({ id: "a" })];
    expect(removeMessage(messages, "not-there")).toEqual(messages);
  });
});

describe("removeReaction (pure)", () => {
  const identity: Identity = { type: "guest", id: "me", displayName: "Me" };

  it("decrements the count for the message and leaves other messages' aggregates alone", () => {
    const current: Record<string, ReactionState> = {
      m1: { count: 3, reactedByMe: false },
      m2: { count: 1, reactedByMe: false },
    };
    const next = removeReaction(current, { message_id: "m1", reactor_profile_id: null, reactor_guest_id: "someone-else" }, identity);
    expect(next.m1).toEqual({ count: 2, reactedByMe: false });
    expect(next.m2).toEqual({ count: 1, reactedByMe: false });
  });

  it("never goes below zero", () => {
    const current: Record<string, ReactionState> = { m1: { count: 0, reactedByMe: false } };
    const next = removeReaction(current, { message_id: "m1", reactor_profile_id: null, reactor_guest_id: "x" }, identity);
    expect(next.m1.count).toBe(0);
  });

  it("flips reactedByMe to false when the deleted reaction was the caller's own", () => {
    const current: Record<string, ReactionState> = { m1: { count: 2, reactedByMe: true } };
    const next = removeReaction(current, { message_id: "m1", reactor_profile_id: null, reactor_guest_id: "me" }, identity);
    expect(next.m1).toEqual({ count: 1, reactedByMe: false });
  });

  it("is a no-op when the message has no tracked aggregate at all", () => {
    const current: Record<string, ReactionState> = {};
    expect(removeReaction(current, { message_id: "m1", reactor_profile_id: null, reactor_guest_id: "x" }, identity)).toBe(current);
  });
});

/**
 * Session Simulator Reset Session follow-up: the real-device report was
 * "comments from the previous simulated run can remain visible in the
 * room" after Reset — traced to `useLobbyRealtime` never having a DELETE
 * handler at all (ordinary product usage never hard-deletes a message;
 * Reset Session is the first thing that does). This exercises the exact
 * narrative from that report against the hook itself: generate simulated
 * comments, confirm visible, delete them (what Reset actually does),
 * confirm they disappear without a page reload, confirm a real user's
 * comment survives, then confirm a fresh run's new comment appears
 * cleanly (not merged with anything from the deleted run).
 *
 * Same fake-Supabase-channel technique as
 * use-active-speakers-resync.test.ts — captures each registered
 * `.on(event, config, callback)` so the test can fire a specific
 * table/event's callback directly, without a live websocket.
 */
function makeFakeSupabase() {
  const handlers: Record<string, (payload: unknown) => void> = {};
  const channel = {
    on: vi.fn((_type: string, config: { event: string; table: string }, callback: (payload: unknown) => void) => {
      handlers[`${config.event}:${config.table}`] = callback;
      return channel;
    }),
    subscribe: vi.fn(() => channel),
    presenceState: vi.fn(() => ({})),
    track: vi.fn(async () => {}),
  };

  const client = {
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(),
  };

  return {
    client,
    fireMessageDelete: (id: string) => handlers["DELETE:event_chat_messages"]?.({ old: { id } }),
    fireMessageInsert: (msg: LobbyMessage) => handlers["INSERT:event_chat_messages"]?.({ new: msg }),
    fireReactionDelete: (deleted: { message_id: string; reactor_profile_id: string | null; reactor_guest_id: string | null }) =>
      handlers["DELETE:event_chat_message_reactions"]?.({ old: deleted }),
  };
}

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient }));

describe("useLobbyRealtime — Reset Session removes stale comments without a page reload", () => {
  const identity: Identity = { type: "guest", id: "viewer", displayName: "Viewer" };

  it("generate simulated comments → verify visible → Reset Session deletes them → they disappear immediately → real comment untouched → a fresh run's comment appears cleanly", async () => {
    const realComment = message({ id: "real-1", author_guest_id: "real-guest", body: "a genuine audience comment" });
    const simComment1 = message({ id: "sim-1", author_guest_id: "sim-guest-a", body: "simulated comment one" });
    const simComment2 = message({ id: "sim-2", author_guest_id: "sim-guest-b", body: "simulated comment two" });

    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() =>
      useLobbyRealtime("e1", identity, [realComment, simComment1, simComment2], {}),
    );

    // Verify visible before Reset — this is the "generate simulated
    // comments → verify visible" step; in the real app these arrived via
    // the simulator's real insertMessage calls, surfaced identically to
    // any other message.
    expect(result.current.messages.map((m) => m.id).sort()).toEqual(["real-1", "sim-1", "sim-2"]);

    // Reset Session, on the real database, hard-deletes each simulated
    // message by its exact guest id — this is what that DELETE looks
    // like arriving over Realtime.
    fake.fireMessageDelete("sim-1");
    fake.fireMessageDelete("sim-2");

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(["real-1"]);
    });
    // Real user's comment must survive untouched.
    expect(result.current.messages[0].body).toBe("a genuine audience comment");

    // Starting a new simulation run and generating a comment in it must
    // not resurrect anything from the reset run — only the new comment
    // appears, alongside the still-untouched real one.
    const freshRunComment = message({ id: "sim-fresh-1", author_guest_id: "sim-guest-fresh", body: "fresh run comment" });
    fake.fireMessageInsert(freshRunComment);

    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id).sort()).toEqual(["real-1", "sim-fresh-1"]);
    });
  });

  it("deleting a message also clears its reaction aggregate immediately, without waiting on a separate reaction-delete event", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() =>
      useLobbyRealtime("e1", identity, [message({ id: "sim-1" })], { "sim-1": { count: 3, reactedByMe: false } }),
    );
    expect(result.current.reactions["sim-1"]).toEqual({ count: 3, reactedByMe: false });

    fake.fireMessageDelete("sim-1");

    await waitFor(() => {
      expect(result.current.reactions["sim-1"]).toBeUndefined();
    });
  });

  it("deleting just a simulated like (message stays) decrements the count without removing the message", async () => {
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() =>
      useLobbyRealtime("e1", identity, [message({ id: "real-1" })], { "real-1": { count: 2, reactedByMe: false } }),
    );

    fake.fireReactionDelete({ message_id: "real-1", reactor_profile_id: null, reactor_guest_id: "sim-guest-a" });

    await waitFor(() => {
      expect(result.current.reactions["real-1"]).toEqual({ count: 1, reactedByMe: false });
    });
    expect(result.current.messages.map((m) => m.id)).toEqual(["real-1"]);
  });
});

/**
 * Real-device report (optimistic-send redesign): the core of this whole
 * pass — `submitComment` never waits on `sendMessage`, reconciliation is
 * exact (client-generated id, not a guess from body/name/timestamp), and
 * failure/retry never touches anything but the one message it's about.
 * `sendMessage` (the actual server call) is mocked throughout — these
 * tests exercise the hook's own state machine, not the real network path
 * (see actions.test.ts for `sendMessage` itself, and the live-backend
 * verification in this session's own handoff for the real round trip).
 */
describe("submitComment — optimistic insert, before any network activity at all (Sections 1-2, 8)", () => {
  const identity: Identity = { type: "guest", id: "me", displayName: "Cheerful Raven" };

  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockImplementation(() => new Promise(() => {})); // never resolves — isolates "before any network activity"
  });

  it("inserts an optimistic message synchronously, before sendMessage's own promise has any chance to settle", () => {
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));
    act(() => {
      result.current.submitComment("hello");
    });
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0]).toMatchObject({
      body: "hello",
      author_guest_id: "me",
      author_display_name: "Cheerful Raven",
      optimisticStatus: "sending",
    });
  });

  it("trims the body and never inserts anything (or calls sendMessage) for an empty/whitespace-only draft", () => {
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));
    act(() => {
      result.current.submitComment("   ");
    });
    expect(result.current.messages).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("each call gets its own stable, unique client-generated id — never reused across separate comments", () => {
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));
    act(() => {
      result.current.submitComment("first");
      result.current.submitComment("second");
    });
    const ids = result.current.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(2);
  });

  it("comments A, then B, then C sent in immediate succession are all visible immediately — never blocked on each other's own round trip (Section 5)", () => {
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));
    act(() => {
      result.current.submitComment("A");
      result.current.submitComment("B");
      result.current.submitComment("C");
    });
    expect(result.current.messages.map((m) => m.body)).toEqual(["A", "B", "C"]);
    expect(result.current.messages.every((m) => m.optimisticStatus === "sending")).toBe(true);
  });
});

describe("reconciliation — an optimistic insert and its eventual confirmation are always exactly one message (Sections 3, 13-15)", () => {
  const identity: Identity = { type: "guest", id: "me", displayName: "Viewer" };

  function confirmedRow(id: string, body: string): LobbyMessage {
    return {
      id,
      author_display_name: "Viewer",
      author_profile_id: null,
      author_guest_id: "me",
      body,
      created_at: new Date().toISOString(),
      is_speaker_request: false,
    };
  }

  beforeEach(() => {
    sendMessage.mockReset();
  });

  it("a successful sendMessage clears optimisticStatus on the exact same message — same id, same array length, no duplicate", async () => {
    sendMessage.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("hello");
    });
    const id = result.current.messages[0].id;
    expect(result.current.messages).toHaveLength(1);

    await waitFor(() => expect(result.current.messages[0].optimisticStatus).toBeUndefined());
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe(id);
  });

  it("a Realtime INSERT for the same client-generated id reconciles in place, even if it arrives before the action's own response ever resolves", async () => {
    let resolveSend!: (value: { ok: boolean }) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("hello");
    });
    const id = result.current.messages[0].id;

    // The authoritative row arrives over Realtime before the action's own
    // response ever settles.
    act(() => {
      fake.fireMessageInsert(confirmedRow(id, "hello"));
    });

    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe(id);
    expect(result.current.messages[0].optimisticStatus).toBeUndefined();

    // The action's own response finally resolves — must not re-add or
    // duplicate anything now that Realtime already reconciled it.
    resolveSend({ ok: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.messages).toHaveLength(1);
  });

  it("a Realtime INSERT for an id already confirmed (the action's own response reconciled first) is a safe no-op, never a duplicate", async () => {
    sendMessage.mockResolvedValue({ ok: true });
    const fake = makeFakeSupabase();
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("hello");
    });
    const id = result.current.messages[0].id;
    await waitFor(() => expect(result.current.messages[0].optimisticStatus).toBeUndefined());

    act(() => {
      fake.fireMessageInsert(confirmedRow(id, "hello"));
    });

    expect(result.current.messages).toHaveLength(1);
  });

  it("never renders the optimistic entry and the confirmed row as two separate messages, regardless of which reconciliation path wins", async () => {
    sendMessage.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("only one of me");
    });
    await waitFor(() => expect(result.current.messages[0].optimisticStatus).toBeUndefined());
    expect(result.current.messages.filter((m) => m.body === "only one of me")).toHaveLength(1);
  });
});

describe("failure / retry (Sections 4, 12-13)", () => {
  const identity: Identity = { type: "guest", id: "me", displayName: "Viewer" };

  beforeEach(() => {
    sendMessage.mockReset();
  });

  it("a failed send (ok:false) marks that exact message failed — never removed, never silently dropped", async () => {
    sendMessage.mockResolvedValue({ ok: false, error: "nope" });
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("this will fail");
    });
    const id = result.current.messages[0].id;
    await waitFor(() => expect(result.current.messages[0].optimisticStatus).toBe("failed"));
    expect(result.current.messages).toHaveLength(1);
    expect(result.current.messages[0].id).toBe(id);
  });

  it("sendMessage throwing is treated the same as an ok:false result — marked failed, never left stuck 'sending' forever", async () => {
    sendMessage.mockRejectedValue(new Error("network error"));
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("this will throw");
    });
    await waitFor(() => expect(result.current.messages[0].optimisticStatus).toBe("failed"));
  });

  it("retryComment re-marks the failed message 'sending' and resends it under its exact original id — never a new id, never touching the composer", async () => {
    // Fake timers: the retry's own dispatch is paced at least
    // MIN_SEND_INTERVAL_MS behind the first (failed) dispatch — real
    // timers would make this test genuinely wait out that pacing delay.
    vi.useFakeTimers();
    try {
      sendMessage.mockResolvedValueOnce({ ok: false, error: "nope" });
      const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

      act(() => {
        result.current.submitComment("retry me");
      });
      const id = result.current.messages[0].id;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.messages[0].optimisticStatus).toBe("failed");

      sendMessage.mockResolvedValueOnce({ ok: true });
      act(() => {
        result.current.retryComment(id);
      });
      expect(result.current.messages[0].optimisticStatus).toBe("sending");
      expect(result.current.messages).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2200); // past the pacing floor since the first dispatch
      });
      expect(result.current.messages[0].optimisticStatus).toBeUndefined();
      expect(result.current.messages[0].id).toBe(id);
      expect(sendMessage).toHaveBeenLastCalledWith("e1", "retry me", id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryComment on an id that's already confirmed (no longer tracked) does nothing", async () => {
    sendMessage.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("already fine");
    });
    const id = result.current.messages[0].id;
    await waitFor(() => expect(result.current.messages[0].optimisticStatus).toBeUndefined());

    const callsBefore = sendMessage.mock.calls.length;
    act(() => {
      result.current.retryComment(id);
    });
    expect(sendMessage.mock.calls.length).toBe(callsBefore);
    expect(result.current.messages[0].optimisticStatus).toBeUndefined();
  });

  it("a retry that ultimately succeeds ends in exactly one confirmed message, never a duplicate — insertMessage's own idempotent-replay handling is trusted, not re-guarded here", async () => {
    vi.useFakeTimers();
    try {
      sendMessage.mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
      const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

      act(() => {
        result.current.submitComment("idempotent retry");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.messages[0].optimisticStatus).toBe("failed");

      act(() => {
        result.current.retryComment(result.current.messages[0].id);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2200);
      });
      expect(result.current.messages[0].optimisticStatus).toBeUndefined();
      expect(result.current.messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("outgoing queue — order and pacing (Sections 5, 6, 18)", () => {
  const identity: Identity = { type: "guest", id: "me", displayName: "Viewer" };

  beforeEach(() => {
    sendMessage.mockReset();
    sendMessage.mockResolvedValue({ ok: true });
  });

  it("dispatches A, then B, then C to sendMessage in exactly that order — never reordered by which one's own promise happens to resolve first", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));
      act(() => {
        result.current.submitComment("A");
        result.current.submitComment("B");
        result.current.submitComment("C");
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(3 * 2200); // drain every pacing delay in the queue
      });

      expect(sendMessage.mock.calls.map((call) => call[1])).toEqual(["A", "B", "C"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("paces successive dispatches at least MIN_SEND_INTERVAL_MS apart, without ever delaying the optimistic UI insert itself", async () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

      act(() => {
        result.current.submitComment("A");
        result.current.submitComment("B");
      });
      // Both visible instantly, before any pacing delay has elapsed at all.
      expect(result.current.messages).toHaveLength(2);

      // A dispatches immediately — nothing to pace against yet.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);

      // B must not dispatch before the pacing floor elapses.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(sendMessage).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(sendMessage).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("clearOptimisticState — Reset Session clears local-only comment state (Section 19)", () => {
  const identity: Identity = { type: "guest", id: "me", displayName: "Viewer" };

  beforeEach(() => {
    sendMessage.mockReset();
  });

  it("removes every optimistic/failed message, leaves already-confirmed ones (including ones confirmed just before Reset) untouched", async () => {
    // Fake timers: the second submitComment's own dispatch is paced at
    // least MIN_SEND_INTERVAL_MS behind the first's — real timers would
    // make this test genuinely wait out that pacing delay.
    vi.useFakeTimers();
    try {
      sendMessage.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false });
      const confirmedReal = message({ id: "real-1", body: "a real confirmed comment" });
      const { result } = renderHook(() => useLobbyRealtime("e1", identity, [confirmedReal], {}));

      act(() => {
        result.current.submitComment("will confirm");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.messages.find((m) => m.body === "will confirm")?.optimisticStatus).toBeUndefined();

      act(() => {
        result.current.submitComment("will fail");
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2200);
      });
      expect(result.current.messages.find((m) => m.body === "will fail")?.optimisticStatus).toBe("failed");

      act(() => {
        result.current.clearOptimisticState();
      });

      const bodies = result.current.messages.map((m) => m.body);
      expect(bodies).toContain("a real confirmed comment");
      expect(bodies).toContain("will confirm"); // already confirmed before Reset — a real row now, untouched
      expect(bodies).not.toContain("will fail");
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops the outgoing queue too — a comment still mid-flight at Reset time never resurrects itself if its own send later settles", async () => {
    let resolveSend!: (value: { ok: boolean }) => void;
    sendMessage.mockImplementation(() => new Promise((resolve) => { resolveSend = resolve; }));
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));

    act(() => {
      result.current.submitComment("mid-flight at reset time");
    });
    expect(result.current.messages).toHaveLength(1);

    act(() => {
      result.current.clearOptimisticState();
    });
    expect(result.current.messages).toHaveLength(0);

    resolveSend({ ok: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.messages).toHaveLength(0);
  });

  it("never touches the composer's currently-typed draft — that state lives entirely in ChatPanel, not here", () => {
    // This hook has no draft state of its own at all — nothing to assert
    // against directly, but pinned here as an explicit doc/contract check
    // alongside the rest of this describe block: clearOptimisticState's
    // own implementation only ever touches outgoingQueueRef,
    // pendingBodiesRef, and messages — see its own doc comment.
    const { result } = renderHook(() => useLobbyRealtime("e1", identity, [], {}));
    expect(() => result.current.clearOptimisticState()).not.toThrow();
  });
});
