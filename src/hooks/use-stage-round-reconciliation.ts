"use client";

import { useEffect } from "react";
import { reconcileStageRoundAction } from "@/app/events/[id]/room/actions";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * Issue #21, fourth corrective pass: the client-side reactive backstop
 * for the shared-round invariant — "a normal shared round may exist and
 * count down only while the stage's two-speaker pairing is actually
 * established" — that a real-device pass found violated (both seats
 * showing "Selecting next speaker…" while a shared round kept counting
 * down). Every production seat-claim/seat-vacate RPC already triggers
 * `ensure_stage_round` server-side as a side effect
 * (`claim_speaker_seat`, `leave_speaker_seat(_as_guest)`, inactivity
 * eviction) — this hook exists for any client whose own view of
 * occupancy just changed to independently re-verify the invariant too,
 * rather than trusting that whichever path changed it already
 * reconciled the round on its own. Idempotent from every connected
 * client simultaneously, same as `reconcileStageRoundAction` itself.
 *
 * Keyed on the *set of currently-occupied seat ids* (sorted, joined into
 * one string), not the `speakers` array reference — that reference
 * changes on every unrelated Realtime update (a mute toggle, a round
 * vote), which would otherwise re-run this far more often than the one
 * thing it actually needs to watch: a seat being claimed or vacated.
 */
export function useStageRoundReconciliation(eventId: string, speakers: EventSpeaker[]): void {
  const occupancyKey = speakers
    .map((speaker) => speaker.id)
    .sort()
    .join(",");

  useEffect(() => {
    void reconcileStageRoundAction(eventId);
    // occupancyKey is the intentional dependency — see this hook's own
    // doc comment for why the `speakers` array reference itself isn't
    // used directly.
  }, [eventId, occupancyKey]);
}
