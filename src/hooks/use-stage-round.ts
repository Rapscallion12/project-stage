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
        (payload) => {
          if (payload.eventType === "DELETE") return;
          setStageRound(payload.new as StageRound);
        },
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
