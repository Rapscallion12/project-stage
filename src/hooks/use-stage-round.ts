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

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  return stageRound;
}
