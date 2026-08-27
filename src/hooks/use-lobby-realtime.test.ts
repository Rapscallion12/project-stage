import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { removeMessage, removeReaction, useLobbyRealtime, type LobbyMessage, type ReactionState } from "./use-lobby-realtime";
import type { Identity } from "@/lib/identity";

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
