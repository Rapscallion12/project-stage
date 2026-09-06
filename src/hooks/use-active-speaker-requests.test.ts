import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  applyPendingRequestChange,
  applyVoteDelete,
  applyVoteInsert,
  removePendingRequest,
  useActiveSpeakerRequests,
} from "./use-active-speaker-requests";
import type { SpeakerRequest, SpeakerRequestVote } from "@/lib/repositories/speaker-requests";
import type { Identity } from "@/lib/identity";

const profileIdentity: Identity = { type: "profile", id: "viewer-1", displayName: "Viewer", username: null };

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
    selection_round_id: null,
    frozen_rank: null,
    frozen_vote_count: null,
    is_current_candidate: false,
    selection_failed: false,
    reserved_seat_number: null,
    ...overrides,
  };
}

function vote(overrides: Partial<SpeakerRequestVote> = {}): SpeakerRequestVote {
  return {
    id: "v1",
    event_id: "e1",
    voter_profile_id: "voter-1",
    voter_guest_id: null,
    request_id: "r1",
    created_at: new Date().toISOString(),
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

describe("removePendingRequest (Session Simulator Reset Session follow-up — a hard DELETE, not a status UPDATE)", () => {
  it("removes a request by id, e.g. a Reset Session hard-deleting a simulated Top Speaker Request", () => {
    const state = applyPendingRequestChange({}, request({ id: "sim-1" }));
    expect(removePendingRequest(state, "sim-1").sim1).toBeUndefined();
    expect("sim-1" in removePendingRequest(state, "sim-1")).toBe(false);
  });

  it("leaves other requests untouched, e.g. a real pending request surviving a simulator reset", () => {
    let state = applyPendingRequestChange({}, request({ id: "sim-1" }));
    state = applyPendingRequestChange(state, request({ id: "real-1" }));
    const next = removePendingRequest(state, "sim-1");
    expect("sim-1" in next).toBe(false);
    expect("real-1" in next).toBe(true);
  });

  it("deleting an unknown id is a no-op, same identity-preserving shape as applyVoteDelete", () => {
    const state = applyPendingRequestChange({}, request({ id: "r1" }));
    expect(removePendingRequest(state, "unknown")).toBe(state);
  });
});

describe("applyVoteInsert / applyVoteDelete", () => {
  it("adds a new vote", () => {
    const result = applyVoteInsert({}, vote({ id: "v1" }));
    expect(result.v1).toBeDefined();
  });

  it("removes a vote by id on delete", () => {
    const afterAdd = applyVoteInsert({}, vote({ id: "v1" }));
    const afterDelete = applyVoteDelete(afterAdd, "v1");
    expect(afterDelete.v1).toBeUndefined();
  });

  it("deleting an unknown id is a no-op", () => {
    const state = applyVoteInsert({}, vote({ id: "v1" }));
    expect(applyVoteDelete(state, "unknown")).toBe(state);
  });
});

/**
 * Same fake-Supabase-with-triggerable-SUBSCRIBED pattern as
 * use-active-speakers-resync.test.ts, adapted for this hook's two
 * queries (requests: two .eq()s then .order(); votes: one .eq()). Also
 * captures each registered `.on(event, config, callback)` by
 * `event:table`, so a test can fire a specific DELETE handler directly
 * (Session Simulator Reset Session follow-up), and exposes a mutable
 * `voteRowsRef`/`setVoteRows` — issue #21, thirteenth corrective pass —
 * so a test can simulate the server-side vote state changing (a "missed
 * Realtime delta") and then prove a later resync (SUBSCRIBED,
 * visibility/focus, or the bounded backstop interval) converges the
 * client back to it, not just what the very first fetch returned.
 */
function makeFakeSupabase(pendingRows: SpeakerRequest[], initialVoteRows: SpeakerRequestVote[] = []) {
  let subscribeCallback: ((status: string) => void) | null = null;
  const fromCalls: string[] = [];
  const handlers: Record<string, (payload: unknown) => void> = {};
  const voteRowsRef = { current: initialVoteRows };

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
      if (table === "speaker_request_votes") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: voteRowsRef.current })),
          })),
        };
      }
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
    fireRequestDelete: (id: string) => handlers["DELETE:speaker_requests"]?.({ old: { id } }),
    fireVoteInsert: (row: SpeakerRequestVote) => handlers["INSERT:speaker_request_votes"]?.({ new: row }),
    fireVoteDelete: (id: string) => handlers["DELETE:speaker_request_votes"]?.({ old: { id } }),
    setVoteRows: (rows: SpeakerRequestVote[]) => {
      voteRowsRef.current = rows;
    },
  };
}

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient }));

describe("useActiveSpeakerRequests", () => {
  it("starts from initialPendingRequests, with a zero vote count", () => {
    const fake = makeFakeSupabase([]);
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() =>
      useActiveSpeakerRequests("e1", profileIdentity, [request({ id: "r1" })]),
    );
    expect(result.current.pendingRequests).toHaveLength(1);
    expect(result.current.pendingRequests[0].voteCount).toBe(0);
    expect(result.current.pendingRequests[0].isMyVote).toBe(false);
  });

  // Issue #21, eighth corrective pass, Sections 12-13: a real-device
  // report found "Selecting next speaker…" persisting on a phone despite
  // an eligible candidate visibly present — on-SUBSCRIBED resync alone
  // assumes Realtime always reports a fresh SUBSCRIBED promptly after a
  // mobile tab backgrounds/foregrounds, which isn't guaranteed on a real
  // network. Same pattern useSeatReconciliation already established for
  // the identical class of problem.
  it("resyncs both requests and votes when the tab becomes visible again — not just on the initial SUBSCRIBED callback", async () => {
    const fresh = [request({ id: "fresh" })];
    const fake = makeFakeSupabase(fresh, [vote({ id: "v1", request_id: "fresh" })]);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, []));
    expect(result.current.pendingRequests).toHaveLength(0);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(result.current.pendingRequests).toHaveLength(1));
    expect(result.current.pendingRequests[0]?.id).toBe("fresh");
    expect(result.current.pendingRequests[0]?.voteCount).toBe(1);
  });

  it("does not resync when the visibilitychange fires while the tab is still hidden", async () => {
    const fake = makeFakeSupabase([request({ id: "fresh" })]);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, []));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      // Nothing to await — asserting the *absence* of an update; a short
      // microtask flush is enough to prove a resync was never scheduled.
      await Promise.resolve();
      expect(result.current.pendingRequests).toHaveLength(0);
    } finally {
      // jsdom's `document` is shared across every test in this file —
      // restore the default so later tests aren't left believing the
      // tab is still hidden.
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    }
  });

  it("resyncs both requests and votes when the window regains focus", async () => {
    const fresh = [request({ id: "fresh" })];
    const fake = makeFakeSupabase(fresh, [vote({ id: "v1", request_id: "fresh" })]);
    createClient.mockReturnValue(fake.client);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, []));
    window.dispatchEvent(new Event("focus"));

    await waitFor(() => expect(result.current.pendingRequests).toHaveLength(1));
  });

  it("resyncs requests and votes on the initial SUBSCRIBED callback — the same missed-delta protection useActiveSpeakers has", async () => {
    const fresh = [request({ id: "fresh" })];
    const fake = makeFakeSupabase(fresh, [vote({ id: "v1", request_id: "fresh" })]);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, []));
    expect(result.current.pendingRequests).toHaveLength(0);

    fake.triggerSubscribed();

    await waitFor(() => {
      expect(result.current.pendingRequests).toHaveLength(1);
    });
    expect(result.current.pendingRequests[0]?.id).toBe("fresh");
    expect(result.current.pendingRequests[0]?.voteCount).toBe(1);
    expect(fake.fromCalls).toContain("speaker_requests");
    expect(fake.fromCalls).toContain("speaker_request_votes");
  });

  it("issue #21 Phase 1, Section B: orders pending requests by live vote count descending, not FIFO", async () => {
    const fewerVotes = request({ id: "fewer-votes", created_at: "2026-01-01T00:00:00.000Z" });
    const moreVotes = request({ id: "more-votes", created_at: "2026-01-01T00:00:05.000Z" });
    const fake = makeFakeSupabase([fewerVotes, moreVotes], [
      vote({ id: "v1", request_id: "fewer-votes", voter_profile_id: "voter-a" }),
      vote({ id: "v2", request_id: "more-votes", voter_profile_id: "voter-b" }),
      vote({ id: "v3", request_id: "more-votes", voter_profile_id: "voter-c" }),
    ]);
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() =>
      useActiveSpeakerRequests("e1", profileIdentity, [fewerVotes, moreVotes]),
    );
    // Votes populate via the SUBSCRIBED resync, same as the "resyncs
    // requests and votes" test above — not synchronously on first render.
    fake.triggerSubscribed();
    await waitFor(() => {
      expect(result.current.pendingRequests[0]?.voteCount).toBe(2);
    });
    expect(result.current.pendingRequests.map((r) => r.id)).toEqual(["more-votes", "fewer-votes"]);
    expect(result.current.pendingRequests[1].voteCount).toBe(1);
  });

  it("ties in vote count fall back to created_at ascending, matching freeze_speaker_candidates' SQL tiebreak", () => {
    const older = request({ id: "older", created_at: "2026-01-01T00:00:00.000Z" });
    const newer = request({ id: "newer", created_at: "2026-01-01T00:00:05.000Z" });
    const fake = makeFakeSupabase([older, newer], []);
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, [newer, older]));
    expect(result.current.pendingRequests.map((r) => r.id)).toEqual(["older", "newer"]);
  });

  it("marks isMyVote true only for the request the current identity voted for", async () => {
    const requestA = request({ id: "a" });
    const requestB = request({ id: "b" });
    const fake = makeFakeSupabase([requestA, requestB], [
      vote({ id: "v1", request_id: "a", voter_profile_id: profileIdentity.id }),
      vote({ id: "v2", request_id: "b", voter_profile_id: "someone-else" }),
    ]);
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() =>
      useActiveSpeakerRequests("e1", profileIdentity, [requestA, requestB]),
    );
    fake.triggerSubscribed();
    await waitFor(() => {
      const byId = Object.fromEntries(result.current.pendingRequests.map((r) => [r.id, r]));
      expect(byId.a.isMyVote).toBe(true);
      expect(byId.b.isMyVote).toBe(false);
    });
  });

  it("matches a guest identity's vote by voter_guest_id, never voter_profile_id", async () => {
    const guestIdentity: Identity = { type: "guest", id: "guest-1", displayName: "Guest" };
    const requestA = request({ id: "a" });
    const fake = makeFakeSupabase([requestA], [vote({ id: "v1", request_id: "a", voter_profile_id: null, voter_guest_id: "guest-1" })]);
    createClient.mockReturnValue(fake.client);
    const { result } = renderHook(() => useActiveSpeakerRequests("e1", guestIdentity, [requestA]));
    fake.triggerSubscribed();
    await waitFor(() => {
      expect(result.current.pendingRequests[0].isMyVote).toBe(true);
    });
  });

  it("Session Simulator Reset Session follow-up: a hard-deleted request disappears from Top Speaker Requests without a page reload, leaving a real request untouched", async () => {
    const simRequest = request({ id: "sim-1" });
    const realRequest = request({ id: "real-1" });
    const fake = makeFakeSupabase([simRequest, realRequest]);
    createClient.mockReturnValue(fake.client);

    const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, [simRequest, realRequest]));
    expect(result.current.pendingRequests.map((r) => r.id).sort()).toEqual(["real-1", "sim-1"]);

    fake.fireRequestDelete("sim-1");

    await waitFor(() => {
      expect(result.current.pendingRequests.map((r) => r.id)).toEqual(["real-1"]);
    });
  });

  // Issue #21, thirteenth corrective pass: a real-device debug snapshot
  // (two-phase T0/T1 capture) caught the client's own accumulated RTS
  // vote count disagreeing with a fresh authoritative count. Traced to
  // the real `cast_speaker_request_vote(_as_guest)` RPC (a transfer is a
  // real DELETE then a real INSERT, never an UPDATE — matching this
  // hook's own handlers) rather than a logic bug; these tests prove the
  // delta-handling side is correct, and the backstop-resync tests below
  // prove convergence even when a delta is genuinely missed.
  describe("vote transfer, toggle-off, and multi-viewer concurrency (issue #21, thirteenth corrective pass)", () => {
    it("a vote transfer (A → B) decrements A and increments B — both sides, not just the newly-voted candidate", async () => {
      const requestA = request({ id: "a" });
      const requestB = request({ id: "b" });
      const fake = makeFakeSupabase([requestA, requestB], [vote({ id: "v1", request_id: "a", voter_profile_id: "voter-1" })]);
      createClient.mockReturnValue(fake.client);

      const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, [requestA, requestB]));
      fake.triggerSubscribed();
      await waitFor(() => {
        const byId = Object.fromEntries(result.current.pendingRequests.map((r) => [r.id, r]));
        expect(byId.a.voteCount).toBe(1);
        expect(byId.b.voteCount).toBe(0);
      });

      // The real RPC's own order: DELETE the old vote row, then INSERT
      // the new one — two separate Realtime events, not an UPDATE.
      fake.fireVoteDelete("v1");
      fake.fireVoteInsert(vote({ id: "v2", request_id: "b", voter_profile_id: "voter-1" }));

      await waitFor(() => {
        const byId = Object.fromEntries(result.current.pendingRequests.map((r) => [r.id, r]));
        expect(byId.a.voteCount).toBe(0);
        expect(byId.b.voteCount).toBe(1);
      });
    });

    it("toggling a vote off decrements the request with no stale remainder", async () => {
      const requestA = request({ id: "a" });
      const fake = makeFakeSupabase([requestA], [vote({ id: "v1", request_id: "a", voter_profile_id: "voter-1" })]);
      createClient.mockReturnValue(fake.client);

      const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, [requestA]));
      fake.triggerSubscribed();
      await waitFor(() => expect(result.current.pendingRequests[0].voteCount).toBe(1));

      fake.fireVoteDelete("v1");

      await waitFor(() => expect(result.current.pendingRequests[0].voteCount).toBe(0));
    });

    it("multi-viewer concurrency: interleaved transfers and a removal across three distinct voters land on the exact final numeric count, not just a plausible ordering", async () => {
      // A=2, B=2 to start (voter-1 → A, voter-2 → B).
      // Viewer 1 moves A→B. Viewer 2 moves B→A. Viewer 3 removes their A vote.
      // Starting: A: voter-1, voter-3 (2). B: voter-2, voter-4 (2).
      const requestA = request({ id: "a" });
      const requestB = request({ id: "b" });
      const fake = makeFakeSupabase(
        [requestA, requestB],
        [
          vote({ id: "v1", request_id: "a", voter_profile_id: "voter-1" }),
          vote({ id: "v3", request_id: "a", voter_profile_id: "voter-3" }),
          vote({ id: "v2", request_id: "b", voter_profile_id: "voter-2" }),
          vote({ id: "v4", request_id: "b", voter_profile_id: "voter-4" }),
        ],
      );
      createClient.mockReturnValue(fake.client);

      const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, [requestA, requestB]));
      fake.triggerSubscribed();
      await waitFor(() => {
        const byId = Object.fromEntries(result.current.pendingRequests.map((r) => [r.id, r]));
        expect(byId.a.voteCount).toBe(2);
        expect(byId.b.voteCount).toBe(2);
      });

      // Viewer 1 (voter-1): A → B.
      fake.fireVoteDelete("v1");
      fake.fireVoteInsert(vote({ id: "v1b", request_id: "b", voter_profile_id: "voter-1" }));
      // Viewer 2 (voter-2): B → A.
      fake.fireVoteDelete("v2");
      fake.fireVoteInsert(vote({ id: "v2a", request_id: "a", voter_profile_id: "voter-2" }));
      // Viewer 3 (voter-3): removes their A vote entirely.
      fake.fireVoteDelete("v3");

      // Expected final: A has voter-2 only (1). B has voter-4, voter-1 (2).
      await waitFor(() => {
        const byId = Object.fromEntries(result.current.pendingRequests.map((r) => [r.id, r]));
        expect(byId.a.voteCount).toBe(1);
        expect(byId.b.voteCount).toBe(2);
      });
      // Numeric equality, not just relative ordering.
      expect(result.current.pendingRequests.find((r) => r.id === "b")?.voteCount).toBe(2);
      expect(result.current.pendingRequests.find((r) => r.id === "a")?.voteCount).toBe(1);
    });
  });

  describe("bounded backstop resync — convergence when a Realtime delta is genuinely missed (issue #21, thirteenth corrective pass)", () => {
    it("a vote count that drifted because a delta was missed converges back to the authoritative count via the bounded backstop interval, with no visibility/focus/SUBSCRIBED event firing", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const requestA = request({ id: "a" });
      const fake = makeFakeSupabase([requestA], [vote({ id: "v1", request_id: "a", voter_profile_id: "voter-1" })]);
      createClient.mockReturnValue(fake.client);

      const { result } = renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, [requestA]));
      fake.triggerSubscribed();
      await vi.waitFor(() => expect(result.current.pendingRequests[0].voteCount).toBe(1));

      // Simulate a genuinely missed Realtime INSERT: the server-side
      // vote count is now 2, but no INSERT event is ever fired for it —
      // exactly what a single dropped WAL message on an otherwise-
      // healthy, continuously-connected session looks like from the
      // client's own vantage point.
      fake.setVoteRows([
        vote({ id: "v1", request_id: "a", voter_profile_id: "voter-1" }),
        vote({ id: "v2", request_id: "a", voter_profile_id: "voter-2" }),
      ]);
      expect(result.current.pendingRequests[0].voteCount).toBe(1); // still stale — no delta, no resync yet

      // No SUBSCRIBED, no visibilitychange, no focus — only time passing.
      await vi.advanceTimersByTimeAsync(20_000);

      await vi.waitFor(() => expect(result.current.pendingRequests[0].voteCount).toBe(2));
    });

    it("the backstop interval is bounded, not a tight poll — it does not resync before its own interval elapses", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const requestA = request({ id: "a" });
      const fake = makeFakeSupabase([requestA], []);
      createClient.mockReturnValue(fake.client);

      renderHook(() => useActiveSpeakerRequests("e1", profileIdentity, [requestA]));
      fake.triggerSubscribed();
      await vi.waitFor(() => expect(fake.fromCalls.filter((t) => t === "speaker_requests").length).toBeGreaterThan(0));
      const callsAfterSubscribe = fake.fromCalls.length;

      await vi.advanceTimersByTimeAsync(5_000);
      expect(fake.fromCalls.length).toBe(callsAfterSubscribe); // no resync yet — well under the 20s interval
    });
  });
});
