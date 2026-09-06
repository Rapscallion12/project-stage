"use client";

import { useEffect, useState } from "react";
import { ROUND_TIMER_REVEAL_SECONDS } from "@/lib/speaker-round";
import type { StageRound } from "@/lib/repositories/stage-rounds";

export type StageRoundDisplay = { remainingSeconds: number; roundNumber: number };

/**
 * Issue #21 corrective pass: what the *shared* round badge should show
 * right now — the single authoritative timer for the whole stage
 * pairing (Part 3: "one shared visible 60-second timer," not one per
 * speaker). Pure, mirroring `use-speaker-round-countdown.ts`'s own
 * shape exactly. Returns null whenever there's nothing to show: no
 * round yet, or the stage is `awaiting_pairing` (a vacancy or an
 * individual closing period is still in progress — not a countdown to
 * render as ticking).
 *
 * Always computed from `stage_rounds.ends_at` (never a client-invented
 * timer) — `isPreviewBuild` only controls *whether* the result is
 * surfaced this early; the real product still reveals it only in the
 * final `ROUND_TIMER_REVEAL_SECONDS`.
 */
export function stageRoundDisplay(
  stageRound: Pick<StageRound, "phase" | "ends_at" | "round_number"> | null,
  now: number,
  isPreviewBuild: boolean,
): StageRoundDisplay | null {
  if (!stageRound || stageRound.phase !== "active") return null;

  const remainingSeconds = Math.max(0, Math.ceil((new Date(stageRound.ends_at).getTime() - now) / 1000));
  if (!isPreviewBuild && remainingSeconds > ROUND_TIMER_REVEAL_SECONDS) return null;

  return { remainingSeconds, roundNumber: stageRound.round_number };
}

/**
 * Ticks the display once a second while the shared round is active —
 * same "never restart the underlying deadline" discipline
 * `useReconnectCountdown`/`useSpeakerRoundCountdown` already established.
 */
export function useStageRoundCountdown(stageRound: StageRound | null, isPreviewBuild: boolean): StageRoundDisplay | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!stageRound || stageRound.phase !== "active") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRound?.ends_at, stageRound?.phase]);

  return stageRoundDisplay(stageRound, now, isPreviewBuild);
}
