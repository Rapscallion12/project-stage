"use client";

import { useEffect, useRef } from "react";
import type { StageRound } from "@/lib/repositories/stage-rounds";
import type { SpeakerReconcileReason } from "@/hooks/use-active-speakers";

/**
 * Issue #21, sixteenth corrective pass: the inverse of
 * `useStageRoundReconciliation` (that hook re-verifies the shared round
 * against this tab's own *speaker* occupancy whenever occupancy changes;
 * nothing previously checked the other direction). A real-device
 * snapshot caught exactly this combination — client round #7 active,
 * client seats occupied: none — for 13+ seconds: simulator bootstrap's
 * own authoritative confirmation and this tab's canonical `speakers`
 * state (`useActiveSpeakers`) had genuinely diverged, with nothing
 * watching for "an active shared round with fewer than two local
 * speakers," which should be structurally impossible for a normal round
 * (a shared round only ever becomes active once the two-speaker pairing
 * is authoritatively established — see the fourth corrective pass).
 *
 * **Deliberately a safety net, not the primary fix.** The actual fix is
 * event-driven reconciliation at the real mutation sites (simulator
 * bootstrap calling `refetchSpeakers("bootstrap")` directly after its
 * own authoritative seat confirmation — see `SessionSimulatorPanel`'s
 * own doc comment). This hook exists for whatever this invariant check
 * *doesn't* directly cover — a future mutation site that doesn't
 * reconcile explicitly, or any other cause of the same divergence.
 *
 * **Bounded — never a retry loop, never a time-based poll.** Fires at
 * most once per distinct `round_number` the invariant is observed
 * violated for (`attemptedForRoundRef`), regardless of whether that one
 * attempt actually fixes it — a genuinely stuck divergence for the same
 * round is not this hook's job to keep hammering; it gets one honest
 * shot, event-driven off the round/occupancy state actually changing,
 * never a `setInterval`.
 */
export function useSpeakerInvariantRecovery(
  stageRound: StageRound | null,
  speakerCount: number,
  refetchSpeakers: (reason: SpeakerReconcileReason) => Promise<unknown>,
): void {
  const attemptedForRoundRef = useRef<number | null>(null);

  useEffect(() => {
    if (!stageRound || stageRound.phase !== "active") return;
    if (speakerCount >= 2) return;
    if (attemptedForRoundRef.current === stageRound.round_number) return;
    attemptedForRoundRef.current = stageRound.round_number;
    void refetchSpeakers("invariant");
  }, [stageRound, speakerCount, refetchSpeakers]);
}
