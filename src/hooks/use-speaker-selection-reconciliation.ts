"use client";

import { useEffect } from "react";
import { reconcileSpeakerSelectionAction } from "@/app/events/[id]/room/actions";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

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
): void {
  const occupancyKey = speakers
    .map((s) => s.id)
    .sort()
    .join(",");
  const pendingKey = pendingRequests
    .map((r) => r.id)
    .sort()
    .join(",");

  useEffect(() => {
    void reconcileSpeakerSelectionAction(eventId);
    // occupancyKey/pendingKey are the intentional dependencies — see this
    // hook's own doc comment for why the raw array references aren't
    // used directly.
  }, [eventId, occupancyKey, pendingKey]);
}
