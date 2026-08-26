"use client";

import { useEffect, useMemo, useState } from "react";
// Realtime subscription calls the Supabase client directly, same
// documented exception as useLobbyRealtime/useActiveSpeakers — see
// ARCHITECTURE.md's Vendor portability section.
import { createClient } from "@/lib/supabase/client";
import type { SpeakerRequest } from "@/lib/repositories/speaker-requests";

/**
 * Applies one `speaker_requests` row to the current pending-set — an
 * INSERT (always `status: "pending"` at creation) adds it; an UPDATE to
 * `"granted"`/`"withdrawn"` removes it. Pure function, exported for the
 * same testability-without-a-live-connection reason
 * `applySpeakerChange` in use-active-speakers.ts is.
 */
export function applyPendingRequestChange(
  current: Record<string, SpeakerRequest>,
  row: SpeakerRequest,
): Record<string, SpeakerRequest> {
  if (row.status !== "pending") {
    if (!(row.id in current)) return current;
    const next = { ...current };
    delete next[row.id];
    return next;
  }
  return { ...current, [row.id]: row };
}

function toById(requests: SpeakerRequest[]): Record<string, SpeakerRequest> {
  const map: Record<string, SpeakerRequest> = {};
  for (const request of requests) map[request.id] = request;
  return map;
}

async function fetchPendingSpeakerRequests(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
): Promise<SpeakerRequest[]> {
  const { data } = await supabase
    .from("speaker_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  return (data ?? []) as SpeakerRequest[];
}

/**
 * Issue #21's "Top Speaker Requests" data source — the live set of
 * currently-pending requests for an event, kept in sync via
 * `speaker_requests`' own INSERT/UPDATE Realtime deltas. Deliberately a
 * separate hook from `useLobbyRealtime` rather than folded into it:
 * `speaker_requests` is a distinct domain (the promotion queue) with its
 * own repository file already, and this project's established pattern
 * is one hook per concern (`useActiveSpeakers` for seats,
 * `useLobbyRealtime` for chat/reactions/presence) rather than one hook
 * accumulating unrelated tables.
 *
 * **On-SUBSCRIBED resync** (same issue #18 lesson `useActiveSpeakers`
 * already applies): a `postgres_changes` subscription doesn't replay
 * deltas missed during a connection drop. Every `SUBSCRIBED` status —
 * the initial subscribe *and* every automatic reconnect — triggers a
 * full resync against the actual pending set, not just whatever deltas
 * happened to arrive.
 *
 * **Live, not frozen**: unlike Expanded Comments' Recent Comments
 * snapshot, this hook's output is never frozen — speaker requests
 * represent current stage candidates, not historical chat, so there's
 * no "reading in peace" concern for a list that's supposed to reflect
 * who could be promoted right now. See `ExpandedComments`' own doc
 * comment for where this choice is applied.
 */
export function useActiveSpeakerRequests(
  eventId: string,
  initialPendingRequests: SpeakerRequest[],
): { pendingRequests: SpeakerRequest[] } {
  const [byId, setById] = useState<Record<string, SpeakerRequest>>(() => toById(initialPendingRequests));

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`event-speaker-requests:${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "speaker_requests", filter: `event_id=eq.${eventId}` },
        (payload) => setById((prev) => applyPendingRequestChange(prev, payload.new as SpeakerRequest)),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "speaker_requests", filter: `event_id=eq.${eventId}` },
        (payload) => setById((prev) => applyPendingRequestChange(prev, payload.new as SpeakerRequest)),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void fetchPendingSpeakerRequests(supabase, eventId).then((fresh) => setById(toById(fresh)));
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  const pendingRequests = useMemo(
    () => Object.values(byId).sort((a, b) => a.created_at.localeCompare(b.created_at)),
    [byId],
  );

  return { pendingRequests };
}
