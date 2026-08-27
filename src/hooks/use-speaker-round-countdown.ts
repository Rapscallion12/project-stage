"use client";

import { useEffect, useState } from "react";
import { ROUND_TIMER_REVEAL_SECONDS } from "@/lib/speaker-round";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

export type SpeakerRoundDisplay = { remainingSeconds: number; phase: "active" | "closing"; roundNumber: number };

/**
 * Issue #21, Part 1: what a speaker's round-timer badge should show
 * right now — pure, so the reveal-window boundary is unit-testable
 * without a ticking clock, same reasoning as
 * `remainingGraceSeconds`/`useReconnectCountdown`.
 *
 * Always computed from the row's own authoritative `round_ends_at`/
 * `closing_ends_at` (never a client-invented timer) — `isPreviewBuild`
 * only controls *whether* the result is surfaced this early, not what
 * the number itself is: the real product still reveals it in the final
 * `ROUND_TIMER_REVEAL_SECONDS`, this just skips that suppression during
 * testing so the round's actual start/end is directly observable.
 */
export function speakerRoundDisplay(
  speaker: Pick<EventSpeaker, "round_phase" | "round_ends_at" | "closing_ends_at" | "round_number"> | null,
  now: number,
  isPreviewBuild: boolean,
): SpeakerRoundDisplay | null {
  if (!speaker) return null;
  const deadline = speaker.round_phase === "closing" ? speaker.closing_ends_at : speaker.round_ends_at;
  if (!deadline) return null;

  const remainingSeconds = Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000));
  if (!isPreviewBuild && remainingSeconds > ROUND_TIMER_REVEAL_SECONDS) return null;

  return { remainingSeconds, phase: speaker.round_phase, roundNumber: speaker.round_number };
}

/**
 * Ticks the display once a second while a speaker occupies the seat —
 * same "never restart the underlying deadline" discipline
 * `useReconnectCountdown` already established: a reopened tab partway
 * through a round shows the correct remaining time immediately, and a
 * deadline that moves (a continue outcome, or entering the closing
 * phase) is picked up the moment the caller's own `speaker` prop
 * updates (the effect's dependency array), not on a fixed re-render
 * schedule.
 */
export function useSpeakerRoundCountdown(
  speaker: Pick<EventSpeaker, "round_phase" | "round_ends_at" | "closing_ends_at" | "round_number"> | null,
  isPreviewBuild: boolean,
): SpeakerRoundDisplay | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!speaker) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
    // Deliberately keyed on the primitive deadline/phase values, never
    // the `speaker` object reference — a fresh object with unchanged
    // field values (a routine Realtime re-render) must not restart this
    // interval, the same reference-vs-value lesson
    // useSpeakerRoundResolution's own scheduling already applies.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speaker?.round_ends_at, speaker?.closing_ends_at, speaker?.round_phase]);

  return speakerRoundDisplay(speaker, now, isPreviewBuild);
}
