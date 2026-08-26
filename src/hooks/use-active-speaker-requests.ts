"use client";

import { useEffect, useMemo, useState } from "react";
// Realtime subscription calls the Supabase client directly, same
// documented exception as useLobbyRealtime/useActiveSpeakers — see
// ARCHITECTURE.md's Vendor portability section.
import { createClient } from "@/lib/supabase/client";
import type { SpeakerRequest, SpeakerRequestVote } from "@/lib/repositories/speaker-requests";
import type { Identity } from "@/lib/identity";

/**
 * Applies one `speaker_requests` row to the current pending-set — an
 * INSERT (always `status: "pending"` at creation) adds it; an UPDATE to
 * `"granted"`/`"withdrawn"`/`"expired"` removes it. `is_current_candidate`/
 * `frozen_rank`/etc. changes also arrive as UPDATEs and flow through
 * this same path, since the whole row is replaced either way. Pure
 * function, exported for the same testability-without-a-live-connection
 * reason `applySpeakerChange` in use-active-speakers.ts is.
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

/** Applies one speaker_request_votes INSERT — issue #21 Phase 1's vote-count tracking, same accumulate-then-resync shape as reactions. */
export function applyVoteInsert(
  current: Record<string, SpeakerRequestVote>,
  row: SpeakerRequestVote,
): Record<string, SpeakerRequestVote> {
  return { ...current, [row.id]: row };
}

/** Applies one speaker_request_votes DELETE (a transfer or toggle-off) — Realtime DELETE payloads only reliably carry the primary key, which is all removal needs. */
export function applyVoteDelete(
  current: Record<string, SpeakerRequestVote>,
  deletedId: string,
): Record<string, SpeakerRequestVote> {
  if (!(deletedId in current)) return current;
  const next = { ...current };
  delete next[deletedId];
  return next;
}

function toById<T extends { id: string }>(rows: T[]): Record<string, T> {
  const map: Record<string, T> = {};
  for (const row of rows) map[row.id] = row;
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

async function fetchSpeakerRequestVotes(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
): Promise<SpeakerRequestVote[]> {
  const { data } = await supabase.from("speaker_request_votes").select("*").eq("event_id", eventId);
  return (data ?? []) as SpeakerRequestVote[];
}

export type RankedPendingRequest = SpeakerRequest & {
  /** Live vote count (issue #21, Phase 1, Section A) — the audience-support signal Top Speaker Requests now ranks by, distinct from ordinary comment reaction counts. */
  voteCount: number;
  /** Whether the current viewer's one active vote (if any) points at this request. */
  isMyVote: boolean;
};

/**
 * Issue #21, Phase 1's "Top Speaker Requests" data source — the live set
 * of currently-pending requests for an event, each carrying a live vote
 * count and whether the caller voted for it, kept in sync via
 * `speaker_requests`' and `speaker_request_votes`' own Realtime deltas.
 * Deliberately a separate hook from `useLobbyRealtime` rather than
 * folded into it: `speaker_requests`/`speaker_request_votes` are a
 * distinct domain (the promotion queue) with their own repository file
 * already, and this project's established pattern is one hook per
 * concern (`useActiveSpeakers` for seats, `useLobbyRealtime` for chat/
 * reactions/presence) rather than one hook accumulating unrelated
 * tables.
 *
 * **Ranked by vote count, not FIFO** (Section B: "a real ranked Top 3,
 * not FIFO") — `pendingRequests` is sorted by `voteCount` descending,
 * tiebroken by `created_at` ascending, the same order
 * `freeze_speaker_candidates`' SQL uses so the live UI ranking and the
 * frozen selection ranking never visibly disagree.
 *
 * **On-SUBSCRIBED resync** (same issue #18 lesson `useActiveSpeakers`
 * already applies): a `postgres_changes` subscription doesn't replay
 * deltas missed during a connection drop. Every `SUBSCRIBED` status —
 * the initial subscribe *and* every automatic reconnect — triggers a
 * full resync of both requests and votes, not just whatever deltas
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
  identity: Identity,
  initialPendingRequests: SpeakerRequest[],
): { pendingRequests: RankedPendingRequest[] } {
  const [requestsById, setRequestsById] = useState<Record<string, SpeakerRequest>>(() =>
    toById(initialPendingRequests),
  );
  const [votesById, setVotesById] = useState<Record<string, SpeakerRequestVote>>({});

  useEffect(() => {
    const supabase = createClient();

    const channel = supabase
      .channel(`event-speaker-requests:${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "speaker_requests", filter: `event_id=eq.${eventId}` },
        (payload) => setRequestsById((prev) => applyPendingRequestChange(prev, payload.new as SpeakerRequest)),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "speaker_requests", filter: `event_id=eq.${eventId}` },
        (payload) => setRequestsById((prev) => applyPendingRequestChange(prev, payload.new as SpeakerRequest)),
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "speaker_request_votes", filter: `event_id=eq.${eventId}` },
        (payload) => setVotesById((prev) => applyVoteInsert(prev, payload.new as SpeakerRequestVote)),
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "speaker_request_votes", filter: `event_id=eq.${eventId}` },
        (payload) => setVotesById((prev) => applyVoteDelete(prev, (payload.old as { id: string }).id)),
      )
      .subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void fetchPendingSpeakerRequests(supabase, eventId).then((fresh) => setRequestsById(toById(fresh)));
          void fetchSpeakerRequestVotes(supabase, eventId).then((fresh) => setVotesById(toById(fresh)));
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  const pendingRequests = useMemo(() => {
    const votes = Object.values(votesById);
    const countByRequestId = new Map<string, number>();
    let myVoteRequestId: string | null = null;

    for (const vote of votes) {
      countByRequestId.set(vote.request_id, (countByRequestId.get(vote.request_id) ?? 0) + 1);
      const isMine =
        identity.type === "profile"
          ? vote.voter_profile_id === identity.id
          : vote.voter_guest_id === identity.id;
      if (isMine) myVoteRequestId = vote.request_id;
    }

    return Object.values(requestsById)
      .map((request) => ({
        ...request,
        voteCount: countByRequestId.get(request.id) ?? 0,
        isMyVote: request.id === myVoteRequestId,
      }))
      .sort((a, b) => b.voteCount - a.voteCount || a.created_at.localeCompare(b.created_at));
  }, [requestsById, votesById, identity]);

  return { pendingRequests };
}
