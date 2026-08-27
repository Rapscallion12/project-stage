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

const profileIdentity: Identity = { type: "profile", id: "viewer-1", displayName: "Viewer" };

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

/** Same fake-Supabase-with-triggerable-SUBSCRIBED pattern as use-active-speakers-resync.test.ts, adapted for this hook's two queries (requests: two .eq()s then .order(); votes: one .eq()). Also captures each registered `.on(event, config, callback)` by `event:table`, so a test can fire a specific DELETE handler directly (Session Simulator Reset Session follow-up). */
function makeFakeSupabase(pendingRows: SpeakerRequest[], voteRows: SpeakerRequestVote[] = []) {
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
      if (table === "speaker_request_votes") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: voteRows })),
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
});
