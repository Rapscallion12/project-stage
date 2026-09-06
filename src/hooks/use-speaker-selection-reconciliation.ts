"use client";

import { useCallback, useEffect, useRef } from "react";
import { reconcileSpeakerSelectionAction } from "@/app/events/[id]/room/actions";
import { createClient } from "@/lib/supabase/client";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

/** One reservation, as this hook's own before/after snapshot records it — issue #21, nineteenth corrective pass. Deliberately minimal (just enough to see whether the reservation *set* changed), not a full request row. */
export type ReservationSnapshotEntry = { requestId: string; seatNumber: 1 | 2; identity: string };

/**
 * Issue #21, nineteenth corrective pass: preview/dev-only diagnostics for
 * this hook's own reconciliation trigger — the same
 * `SpeakerSyncDiagnostics` shape `useActiveSpeakers` already established
 * for the analogous speaker-state question, applied here to selection
 * reservations. Surfaced by the Session Simulator's debug snapshot's new
 * "SELECTION RECONCILIATION" section so a real-device/real-database
 * capture can show directly whether the *last* reconcile trigger this
 * tab fired actually changed anything, not just that reconciliation
 * exists as a mechanism.
 */
export type SelectionReconcileDiagnostics = {
  lastReconcileAt: string | null;
  reservationsBefore: ReservationSnapshotEntry[] | null;
  reservationsAfter: ReservationSnapshotEntry[] | null;
};

/**
 * Issue #21, fifth corrective pass, Section 6: the bounded-recovery
 * backstop for candidate selection — see `reconcileSpeakerSelectionAction`'s
 * own doc comment (room/actions.ts) for why event-driven selection alone
 * isn't always enough (it relies on *some* eligible candidate's own tab
 * polling). Any connected client — audience included, not just a
 * candidate — calls this whenever its own view of seat occupancy or the
 * pending-request pool changes, closing that gap without a blind timer.
 *
 * Keyed on the *set* of occupied seat ids and pending request ids
 * (sorted, joined), not the raw array references — both change on
 * unrelated field updates (a vote count, a mute toggle) that this
 * doesn't need to re-trigger on.
 */
export function useSpeakerSelectionReconciliation(
  eventId: string,
  speakers: EventSpeaker[],
  pendingRequests: RankedPendingRequest[],
): { getReconcileDiagnostics: () => SelectionReconcileDiagnostics } {
  const occupancyKey = speakers
    .map((s) => s.id)
    .sort()
    .join(",");
  const pendingKey = pendingRequests
    .map((r) => r.id)
    .sort()
    .join(",");

  // Issue #21, nineteenth corrective pass — plain refs, never trigger a
  // re-render on their own, read on demand via `getReconcileDiagnostics()`
  // the same way `useActiveSpeakers`' `getSyncDiagnostics` already works.
  const lastReconcileAtRef = useRef<string | null>(null);
  const reservationsBeforeRef = useRef<ReservationSnapshotEntry[] | null>(null);
  const reservationsAfterRef = useRef<ReservationSnapshotEntry[] | null>(null);

  function toSnapshot(rows: { id: string; reserved_seat_number: 1 | 2 | null; profile_id: string | null; guest_id: string | null }[]): ReservationSnapshotEntry[] {
    return rows
      .filter((r) => r.reserved_seat_number !== null)
      .map((r) => ({ requestId: r.id, seatNumber: r.reserved_seat_number!, identity: (r.profile_id ?? r.guest_id)! }));
  }

  useEffect(() => {
    // "Before" comes from this tab's own already-live `pendingRequests`
    // prop, read directly from this effect's own closure (effects run
    // after render, never during it, so this isn't the same
    // during-render ref access `react-hooks/refs` flags) — a fresh read
    // here would just be racing the very Realtime delta that's about to
    // update it. "After" is a real, direct, authoritative read (the same
    // public-select tier every other client-side `speaker_requests` read
    // already uses), taken once the reconcile call itself has resolved,
    // so it reflects what the reconcile actually did — not what this
    // tab's own Realtime subscription happens to have received by then.
    reservationsBeforeRef.current = pendingRequests
      .filter((r) => r.is_current_candidate && r.reserved_seat_number !== null)
      .map((r) => ({ requestId: r.id, seatNumber: r.reserved_seat_number!, identity: (r.profile_id ?? r.guest_id)! }));

    // `await`, not `.then()` — tolerates a test mock that returns
    // `undefined` instead of a real Promise (`vi.fn()` with no
    // implementation), unlike calling `.then()` directly on the result.
    async function reconcileAndCaptureAfter() {
      await reconcileSpeakerSelectionAction(eventId);
      lastReconcileAtRef.current = new Date().toISOString();
      const supabase = createClient();
      const { data } = await supabase
        .from("speaker_requests")
        .select("id, reserved_seat_number, profile_id, guest_id")
        .eq("event_id", eventId)
        .eq("status", "pending")
        .eq("is_current_candidate", true);
      reservationsAfterRef.current = toSnapshot((data ?? []) as { id: string; reserved_seat_number: 1 | 2 | null; profile_id: string | null; guest_id: string | null }[]);
    }
    void reconcileAndCaptureAfter();
    // occupancyKey/pendingKey are the intentional dependencies — see this
    // hook's own doc comment for why the raw array references aren't
    // used directly. `pendingRequests` itself is read inside (for the
    // "before" diagnostics snapshot only, issue #21 nineteenth
    // corrective pass) but deliberately isn't a dependency — it's read
    // fresh from the closure at whatever moment `pendingKey` last
    // changed, which is exactly "before this reconcile," the value this
    // diagnostic is supposed to capture; adding it as a dependency would
    // re-trigger the effect (and a real reconcile RPC call) on every
    // vote-count/mute-toggle-style field change the key deliberately
    // filters out.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, occupancyKey, pendingKey]);

  const getReconcileDiagnostics = useCallback(
    (): SelectionReconcileDiagnostics => ({
      lastReconcileAt: lastReconcileAtRef.current,
      reservationsBefore: reservationsBeforeRef.current,
      reservationsAfter: reservationsAfterRef.current,
    }),
    [],
  );

  return { getReconcileDiagnostics };
}
