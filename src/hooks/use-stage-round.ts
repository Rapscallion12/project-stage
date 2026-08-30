"use client";

import { useEffect, useState } from "react";
// Realtime subscription calls the Supabase client directly, same
// documented exception as useLobbyRealtime/useActiveSpeakers — see
// ARCHITECTURE.md's Vendor portability section.
import { createClient } from "@/lib/supabase/client";
import type { StageRound } from "@/lib/repositories/stage-rounds";

async function fetchStageRound(supabase: ReturnType<typeof createClient>, eventId: string): Promise<StageRound | null> {
  const { data } = await supabase.from("stage_rounds").select("*").eq("event_id", eventId).maybeSingle();
  return (data as StageRound | null) ?? null;
}

/**
 * Pure — what this hook's client state should become in response to one
 * Realtime `postgres_changes` payload on `stage_rounds`. Extracted so the
 * DELETE-handling fix (Sections 16-19) is directly unit-testable, the
 * same "pure reducer, tested in isolation" shape `applySpeakerChange`/
 * `removeSpeaker` (use-active-speakers.ts) already established for the
 * identical class of Realtime-payload-to-state problem.
 */
export function applyStageRoundChange(
  payload: { eventType: "INSERT" | "UPDATE" | "DELETE"; new: unknown },
): StageRound | null {
  // A DELETE means "no row for this event anymore," full stop — see this
  // hook's own doc comment for the real bug this closes (a stale round
  // display surviving Session Simulator's Reset indefinitely).
  if (payload.eventType === "DELETE") return null;
  return payload.new as StageRound;
}

/**
 * Issue #21 corrective pass: the shared round clock's live client
 * state — same "resync a full, fresh read on every SUBSCRIBED, not just
 * apply incremental deltas" discipline `useActiveSpeakers` already
 * established (issue #18 real-device finding): a missed INSERT/UPDATE
 * during a connection drop must not leave this hook silently wrong for
 * the rest of the mounted session. No `initial` prop/SSR seed —
 * unlike `useActiveSpeakers`/`useActiveSpeakerRequests`, this hook
 * fetches its own first read on mount (the very first render briefly
 * shows "no round yet," resolved within one round trip) — a deliberate
 * scope simplification for this pass rather than threading a new
 * server-fetched prop through `page.tsx`/`EventRoom`.
 */
export function useStageRound(eventId: string): StageRound | null {
  const [stageRound, setStageRound] = useState<StageRound | null>(null);

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`stage-round:${eventId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "stage_rounds", filter: `event_id=eq.${eventId}` },
        (payload) => setStageRound(applyStageRoundChange(payload)),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void fetchStageRound(supabase, eventId).then(setStageRound);
        }
      });

    // Issue #21, eighth corrective pass, Sections 12-13: reproduced live
    // (not just theorized) — a tab whose Realtime connection genuinely
    // went stale kept showing a round from *before* the stage was even
    // established ("Round 0 · awaiting pairing") indefinitely, long
    // after the authoritative round had actually advanced to round 2
    // and gone active; a fresh page load immediately showed the correct
    // state, proving this was stale client state, not a server bug.
    // `on-SUBSCRIBED` resync alone assumes the Realtime client always
    // promptly reports a fresh SUBSCRIBED after a dropped connection,
    // which isn't guaranteed. Same established pattern
    // `useSeatReconciliation` already uses for the identical class of
    // problem — an explicit, event-driven resync the moment the tab is
    // actually looked at again, never a polling interval.
    function handleVisibilityRestored() {
      if (document.visibilityState === "visible") {
        void fetchStageRound(supabase, eventId).then(setStageRound);
      }
    }
    document.addEventListener("visibilitychange", handleVisibilityRestored);
    window.addEventListener("focus", handleVisibilityRestored);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", handleVisibilityRestored);
      window.removeEventListener("focus", handleVisibilityRestored);
    };
  }, [eventId]);

  return stageRound;
}
