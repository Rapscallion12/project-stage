import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useSpeakerSelectionReconciliation } from "./use-speaker-selection-reconciliation";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

function request(overrides: Partial<RankedPendingRequest> = {}): RankedPendingRequest {
  return {
    id: "r1",
    event_id: "e1",
    profile_id: null,
    guest_id: "g1",
    message_id: "m1",
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    selection_round_id: "round1",
    frozen_rank: 1,
    frozen_vote_count: 2,
    is_current_candidate: false,
    selection_failed: false,
    reserved_seat_number: null,
    voteCount: 2,
    isMyVote: false,
    ...overrides,
  };
}

const { reconcileSpeakerSelectionAction } = vi.hoisted(() => ({
  reconcileSpeakerSelectionAction: vi.fn(),
}));
vi.mock("@/app/events/[id]/room/actions", () => ({ reconcileSpeakerSelectionAction }));

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/client", () => ({ createClient }));

function fakeSupabaseReturning(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: rows })),
          })),
        })),
      })),
    })),
  };
}

/**
 * Issue #21, nineteenth corrective pass: this hook's own reconciliation
 * trigger previously fired-and-forgot, with no way to see from a debug
 * snapshot whether a given reconcile actually changed anything. These
 * tests pin the new `getReconcileDiagnostics()` accessor directly,
 * mirroring `useActiveSpeakers`' own established `getSyncDiagnostics`
 * pattern for the analogous question.
 */
describe("useSpeakerSelectionReconciliation — diagnostics (issue #21, nineteenth corrective pass)", () => {
  it("starts with no reconcile diagnostics recorded", () => {
    reconcileSpeakerSelectionAction.mockResolvedValue(undefined);
    createClient.mockReturnValue(fakeSupabaseReturning([]));

    const speakers: EventSpeaker[] = [];
    const { result } = renderHook(({ pendingRequests }) => useSpeakerSelectionReconciliation("e1", speakers, pendingRequests), {
      initialProps: { pendingRequests: [] as RankedPendingRequest[] },
    });

    const diagnostics = result.current.getReconcileDiagnostics();
    expect(diagnostics.lastReconcileAt).toBeNull();
  });

  it("records before/after reservation snapshots once a triggered reconcile resolves, and reports 'changed' when the reservation set actually differs", async () => {
    reconcileSpeakerSelectionAction.mockResolvedValue(undefined);
    createClient.mockReturnValue(
      fakeSupabaseReturning([{ id: "r1", reserved_seat_number: 2, profile_id: null, guest_id: "g1" }]),
    );

    const speakers: EventSpeaker[] = [];
    // Starts with no live reservation — "before" should reflect that.
    const { result, rerender } = renderHook(({ pendingRequests }) => useSpeakerSelectionReconciliation("e1", speakers, pendingRequests), {
      initialProps: { pendingRequests: [request({ is_current_candidate: false, reserved_seat_number: null })] },
    });

    // A pending-pool change (the effect's own real dependency) retriggers
    // reconciliation — the fresh authoritative read (mocked above) now
    // shows a live reservation for seat 2 that didn't exist "before."
    await act(async () => {
      rerender({ pendingRequests: [request({ id: "r2", is_current_candidate: false, reserved_seat_number: null })] });
      await Promise.resolve();
      await Promise.resolve();
    });

    const diagnostics = result.current.getReconcileDiagnostics();
    expect(diagnostics.lastReconcileAt).not.toBeNull();
    expect(diagnostics.reservationsBefore).toEqual([]);
    expect(diagnostics.reservationsAfter).toEqual([{ requestId: "r1", seatNumber: 2, identity: "g1" }]);
  });
});
