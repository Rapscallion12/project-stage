"use client";

import { useEffect, useRef } from "react";
import { resolveSpeakerRoundAction } from "@/app/events/[id]/room/actions";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * Issue #21, Part 1/Part 15: schedules the deadline trigger for every
 * currently-occupied seat's Continue/Replace round, the same "one
 * deferred call per genuine deadline, server re-derives the real
 * decision" shape `useSpeakerReconnectGrace` already established for
 * the #18 inactivity clock. Runs for *every* connected client in the
 * room — audience and either speaker, including a speaker's own tab for
 * its own round — so resolution never depends on any single browser
 * staying open (Part 15's explicit requirement): whichever client's
 * timer happens to fire first triggers `resolveSpeakerRoundAction`,
 * which re-derives everything from Postgres's own clock and the real
 * vote tally. A page refresh just re-reads `round_ends_at`/
 * `closing_ends_at` from the next `speakers` snapshot and re-schedules
 * from the same authoritative timestamp — it can't restart anything,
 * because nothing about the deadline itself lives in this hook.
 *
 * Deliberately keyed by `event_speakers.id` (the occupancy row), not
 * identity — this is what makes per-speaker (not per-pairing) rounds
 * fall out for free: two occupied seats get two independent timers,
 * independently resolving to independent outcomes.
 */
export function useSpeakerRoundResolution(speakers: EventSpeaker[]): void {
  // Tracks both the timer handle and which deadline it was scheduled
  // for — a "continue" outcome bumps round_ends_at forward on the *same*
  // event_speakers row (same id), and a narrow-loss switches which
  // column governs (round_ends_at -> closing_ends_at); either has to
  // reschedule, not be mistaken for "already handled" just because the
  // id was seen before.
  const timersRef = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; deadline: string }>());

  useEffect(() => {
    const timers = timersRef.current;
    const activeIds = new Set(speakers.map((s) => s.id));

    for (const [id, entry] of timers) {
      if (!activeIds.has(id)) {
        clearTimeout(entry.timer);
        timers.delete(id);
      }
    }

    for (const speaker of speakers) {
      const deadline = speaker.round_phase === "closing" ? speaker.closing_ends_at : speaker.round_ends_at;
      if (!deadline) continue;

      const existing = timers.get(speaker.id);
      if (existing && existing.deadline === deadline) continue;
      if (existing) clearTimeout(existing.timer);

      const remainingMs = Math.max(0, new Date(deadline).getTime() - Date.now());
      const timer = setTimeout(() => {
        timers.delete(speaker.id);
        // The actual outcome is decided server-side, independent of this
        // timer having fired — see resolveSpeakerRoundAction's own doc
        // comment.
        void resolveSpeakerRoundAction(speaker.id);
      }, remainingMs);
      timers.set(speaker.id, { timer, deadline });
    }
  }, [speakers]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const entry of timers.values()) clearTimeout(entry.timer);
      timers.clear();
    };
  }, []);
}
