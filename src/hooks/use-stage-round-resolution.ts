"use client";

import { useEffect, useRef } from "react";
import { resolveStageRoundAction, resolveSeatClosingAction } from "@/app/events/[id]/room/actions";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { StageRound } from "@/lib/repositories/stage-rounds";

/**
 * Issue #21 corrective pass: schedules the deadline trigger for the
 * *shared* round (one timer, for the whole stage pairing) and,
 * separately, for each individually-closing seat (Part 4's per-speaker
 * Final 30s — the one case the shared clock deliberately does not
 * govern). Same "one deferred call per genuine deadline, server
 * re-derives the real decision" shape `useSpeakerReconnectGrace`/the
 * superseded `useSpeakerRoundResolution` already established. Runs for
 * *every* connected client in the room — audience and either speaker —
 * so resolution never depends on any single browser staying open. A
 * page refresh just re-reads the current `stageRound`/`speakers`
 * snapshot and re-schedules from the same authoritative timestamps — it
 * can't restart anything, because nothing about either deadline lives in
 * this hook.
 */
export function useStageRoundResolution(eventId: string, stageRound: StageRound | null, speakers: EventSpeaker[]): void {
  const stageTimerRef = useRef<{ timer: ReturnType<typeof setTimeout>; deadline: string; roundId: string } | null>(null);
  // Tracks both the timer handle and which deadline it was scheduled
  // for — a "narrow-loss" outcome sets closing_ends_at on a *new* round
  // for the same event_speakers.id only after a fresh claim, so id-only
  // tracking would be sufficient here, but matching the deadline value
  // too costs nothing and stays consistent with the stage timer's own
  // guard above.
  const seatTimersRef = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; deadline: string }>());

  useEffect(() => {
    const existing = stageTimerRef.current;
    if (!stageRound || stageRound.phase !== "active") {
      if (existing) {
        clearTimeout(existing.timer);
        stageTimerRef.current = null;
      }
      return;
    }
    if (existing && existing.roundId === stageRound.id && existing.deadline === stageRound.ends_at) return;
    if (existing) clearTimeout(existing.timer);

    const remainingMs = Math.max(0, new Date(stageRound.ends_at).getTime() - Date.now());
    const timer = setTimeout(() => {
      stageTimerRef.current = null;
      void resolveStageRoundAction(eventId);
    }, remainingMs);
    stageTimerRef.current = { timer, deadline: stageRound.ends_at, roundId: stageRound.id };
  }, [eventId, stageRound]);

  useEffect(() => {
    const timers = seatTimersRef.current;
    const closingSeats = speakers.filter((s) => s.round_phase === "closing" && s.closing_ends_at);
    const activeIds = new Set(closingSeats.map((s) => s.id));

    for (const [id, entry] of timers) {
      if (!activeIds.has(id)) {
        clearTimeout(entry.timer);
        timers.delete(id);
      }
    }

    for (const seat of closingSeats) {
      const deadline = seat.closing_ends_at!;
      const existing = timers.get(seat.id);
      if (existing && existing.deadline === deadline) continue;
      if (existing) clearTimeout(existing.timer);

      const remainingMs = Math.max(0, new Date(deadline).getTime() - Date.now());
      const timer = setTimeout(() => {
        timers.delete(seat.id);
        void resolveSeatClosingAction(seat.id);
      }, remainingMs);
      timers.set(seat.id, { timer, deadline });
    }
  }, [speakers]);

  useEffect(() => {
    const seatTimers = seatTimersRef.current;
    return () => {
      const stageTimer = stageTimerRef.current;
      if (stageTimer) clearTimeout(stageTimer.timer);
      for (const entry of seatTimers.values()) clearTimeout(entry.timer);
      seatTimers.clear();
    };
  }, []);
}
