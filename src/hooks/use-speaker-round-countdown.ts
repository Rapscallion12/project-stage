"use client";

import { useEffect, useState } from "react";
import { ROUND_TIMER_REVEAL_SECONDS } from "@/lib/speaker-round";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

export type SpeakerRoundDisplay = { remainingSeconds: number; phase: "closing" };

/**
 * Issue #21 corrective pass: what an *individual* seat's own round badge
 * should show right now — narrowed to the narrow-loss closing window
 * only (Part 4: "the other speaker should not be forced into that
 * final-30 state," i.e. this per-seat badge must never show the
 * ordinary shared countdown — that's `useStageRoundCountdown`'s job
 * now, rendered once at the stage level). Pure, so the reveal-window
 * boundary is unit-testable without a ticking clock, same reasoning as
 * `remainingGraceSeconds`/`useReconnectCountdown`.
 *
 * Always computed from the row's own authoritative `closing_ends_at`
 * (never a client-invented timer) — `isPreviewBuild` only controls
 * *whether* the result is surfaced this early, not what the number
 * itself is, same reveal-window discipline the shared badge uses.
 */
export function speakerRoundDisplay(
  speaker: Pick<EventSpeaker, "round_phase" | "closing_ends_at"> | null,
  now: number,
  isPreviewBuild: boolean,
): SpeakerRoundDisplay | null {
  if (!speaker || speaker.round_phase !== "closing" || !speaker.closing_ends_at) return null;

  const remainingSeconds = Math.max(0, Math.ceil((new Date(speaker.closing_ends_at).getTime() - now) / 1000));
  if (!isPreviewBuild && remainingSeconds > ROUND_TIMER_REVEAL_SECONDS) return null;

  return { remainingSeconds, phase: "closing" };
}

/**
 * Ticks the display once a second while a seat is in its own closing
 * window — same "never restart the underlying deadline" discipline
 * `useReconnectCountdown` already established.
 */
export function useSpeakerRoundCountdown(
  speaker: Pick<EventSpeaker, "round_phase" | "closing_ends_at"> | null,
  isPreviewBuild: boolean,
): SpeakerRoundDisplay | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!speaker || speaker.round_phase !== "closing") return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
    // Deliberately keyed on the primitive deadline/phase values, never
    // the `speaker` object reference — a fresh object with unchanged
    // field values (a routine Realtime re-render) must not restart this
    // interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker?.closing_ends_at, speaker?.round_phase]);

  return speakerRoundDisplay(speaker, now, isPreviewBuild);
}
