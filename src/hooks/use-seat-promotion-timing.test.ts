import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSeatPromotionTiming } from "./use-seat-promotion-timing";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie Rivera",
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

function pendingRequest(overrides: Partial<RankedPendingRequest> = {}): RankedPendingRequest {
  return {
    id: "r1",
    event_id: "e1",
    profile_id: null,
    guest_id: "g1",
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
    voteCount: 0,
    isMyVote: false,
    ...overrides,
  };
}

// Issue #21, sixth corrective pass, Sections 1-3, 20-21: this hook is the
// real-observed-timing backbone for the new SIM diagnostic timeline. These
// tests exercise its own transition logic directly (independent of the SIM
// display built on top of it), using real timestamps — never fabricated
// deltas — the same discipline the user's diagnostic brief required of the
// feature itself.
describe("useSeatPromotionTiming (issue #21, sixth corrective pass)", () => {
  it("starts both seats fully vacant with vacantAt set and every later field null, when nothing is occupied or requested yet", async () => {
    const { result } = renderHook(() => useSeatPromotionTiming([], []));
    await waitFor(() => expect(result.current[1].vacantAt).not.toBeNull());
    expect(result.current[1]).toMatchObject({ candidatesFoundAt: null, reservedAt: null, occupiedAt: null });
    expect(result.current[2]).toMatchObject({ candidatesFoundAt: null, reservedAt: null, occupiedAt: null });
  });

  it("records candidatesFoundAt the moment pendingRequests goes non-empty while a seat is vacant", async () => {
    const { result, rerender } = renderHook(
      (props: { pendingRequests: RankedPendingRequest[] }) => useSeatPromotionTiming([], props.pendingRequests),
      { initialProps: { pendingRequests: [] as RankedPendingRequest[] } },
    );
    await waitFor(() => expect(result.current[1].vacantAt).not.toBeNull());
    expect(result.current[1].candidatesFoundAt).toBeNull();

    rerender({ pendingRequests: [pendingRequest()] });
    await waitFor(() => expect(result.current[1].candidatesFoundAt).not.toBeNull());
    expect(result.current[1].candidatesFoundAt).toBeGreaterThanOrEqual(result.current[1].vacantAt!);
  });

  it("records reservedAt only for the seat a candidate is actually reserved for, not the other one", async () => {
    const { result, rerender } = renderHook(
      (props: { pendingRequests: RankedPendingRequest[] }) => useSeatPromotionTiming([], props.pendingRequests),
      { initialProps: { pendingRequests: [] as RankedPendingRequest[] } },
    );
    await waitFor(() => expect(result.current[1].vacantAt).not.toBeNull());

    rerender({ pendingRequests: [pendingRequest({ is_current_candidate: true, reserved_seat_number: 2 })] });
    await waitFor(() => expect(result.current[2].reservedAt).not.toBeNull());
    expect(result.current[1].reservedAt).toBeNull();
  });

  it("records occupiedAt once, and does not reset an earlier stage's timestamps once a seat is occupied", async () => {
    const { result, rerender } = renderHook(
      (props: { speakers: EventSpeaker[]; pendingRequests: RankedPendingRequest[] }) =>
        useSeatPromotionTiming(props.speakers, props.pendingRequests),
      { initialProps: { speakers: [] as EventSpeaker[], pendingRequests: [pendingRequest({ is_current_candidate: true, reserved_seat_number: 1 })] } },
    );
    await waitFor(() => expect(result.current[1].reservedAt).not.toBeNull());
    const reservedAt = result.current[1].reservedAt;

    rerender({ speakers: [speaker({ seat_number: 1 })], pendingRequests: [] });
    await waitFor(() => expect(result.current[1].occupiedAt).not.toBeNull());
    expect(result.current[1].reservedAt).toBe(reservedAt);
  });

  it("starts a fresh cycle — resetting candidatesFoundAt/reservedAt/occupiedAt to null — the next time a seat is seen vacant after being occupied", async () => {
    const { result, rerender } = renderHook(
      (props: { speakers: EventSpeaker[] }) => useSeatPromotionTiming(props.speakers, []),
      { initialProps: { speakers: [speaker({ seat_number: 1 })] } },
    );
    await waitFor(() => expect(result.current[1].occupiedAt).not.toBeNull());

    rerender({ speakers: [] });
    await waitFor(() => expect(result.current[1].occupiedAt).toBeNull());
    expect(result.current[1].candidatesFoundAt).toBeNull();
    expect(result.current[1].reservedAt).toBeNull();
    expect(result.current[1].vacantAt).not.toBeNull();
  });
});
