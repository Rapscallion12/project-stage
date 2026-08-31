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

/**
 * Removes one deleted speaker_requests row — `applyPendingRequestChange`
 * only reacts to a *changed* row (an UPDATE to a non-pending status), so
 * it never fires for a row that's simply gone. Ordinary product usage
 * never hard-deletes a request (it transitions status via UPDATE
 * instead); the Session Simulator's Reset Session is the one real
 * caller today (see migration 00000000000023 for why `speaker_requests`
 * needed `REPLICA IDENTITY FULL` for this DELETE's `event_id` filter to
 * evaluate correctly).
 */
export function removePendingRequest(
  current: Record<string, SpeakerRequest>,
  deletedId: string,
): Record<string, SpeakerRequest> {
  if (!(deletedId in current)) return current;
  const next = { ...current };
  delete next[deletedId];
  return next;
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
 * **Issue #21, thirteenth corrective pass: a bounded periodic resync,
 * for the one gap neither of the above closes.** Real-device debug
 * snapshots (two-phase T0/T1 capture, twelfth pass) caught the client's
 * own accumulated vote count for a request genuinely disagreeing with a
 * fresh authoritative count (under-counting by one), with the
 * authoritative read completing in ~500ms and confirming nothing else
 * was stale — the round, the seats, and the candidate ordering itself
 * all agreed. Traced (not guessed) before concluding anything: read
 * `cast_speaker_request_vote(_as_guest)` directly — a vote transfer is
 * a real `DELETE` then a real `INSERT` (never an `UPDATE`), which this
 * hook's own INSERT/DELETE handlers already handle correctly; no
 * mismatched event type, no wrong table/column. What neither the
 * on-SUBSCRIBED trigger nor the visibility/focus trigger below can ever
 * catch: a single WAL message silently dropped in transit (a real,
 * known failure mode of long-lived WebSocket connections on cellular
 * networks specifically — exactly the environment a real-device test
 * session runs in) *without* the underlying connection itself ever
 * closing or the tab ever backgrounding. Both existing mechanisms only
 * fire on an actual reconnect or an actual visibility change — neither
 * happens here, so a rare, single dropped delta during a long,
 * continuously-visible, continuously-connected session (precisely how
 * these captures were taken) would otherwise never self-correct. A
 * modest, bounded interval (not a tight poll, and never the *primary*
 * path — Realtime deltas still update the UI instantly; this only ever
 * corrects an already-wrong accumulated count) closes that specific
 * gap the same way this codebase already treats "Realtime for
 * responsiveness, an authoritative read for convergence" everywhere
 * else (`useAutomaticPromotion`'s own bounded backstop poll behind its
 * reactive fast path is the direct precedent).
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

    function resync() {
      void fetchPendingSpeakerRequests(supabase, eventId).then((fresh) => setRequestsById(toById(fresh)));
      void fetchSpeakerRequestVotes(supabase, eventId).then((fresh) => setVotesById(toById(fresh)));
    }

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
        // Session Simulator Reset Session follow-up — see
        // removePendingRequest's own doc comment for why this exists.
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "speaker_requests", filter: `event_id=eq.${eventId}` },
        (payload) => setRequestsById((prev) => removePendingRequest(prev, (payload.old as { id: string }).id)),
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
        if (status === "SUBSCRIBED") resync();
      });

    // Issue #21, eighth corrective pass, Sections 12-13: a real-device
    // report found "Selecting next speaker…" persisting on a phone for
    // an extended period despite an eligible candidate visibly present —
    // on-SUBSCRIBED resync alone assumes the Realtime client always
    // reports a fresh SUBSCRIBED promptly after a mobile tab is
    // backgrounded/foregrounded or hands off between wifi/cellular,
    // which isn't guaranteed on a real network. Same established pattern
    // `useSeatReconciliation` already uses for the identical class of
    // problem (a backgrounded tab is exactly where a Realtime socket can
    // silently degrade without the app being told) — an explicit,
    // event-driven resync the moment the tab is actually looked at
    // again, never a polling interval.
    function handleVisibilityRestored() {
      if (document.visibilityState === "visible") resync();
    }
    document.addEventListener("visibilitychange", handleVisibilityRestored);
    window.addEventListener("focus", handleVisibilityRestored);

    // Issue #21, thirteenth corrective pass: the bounded backstop itself
    // — see this hook's own doc comment above for why on-SUBSCRIBED and
    // visibility/focus resync both provably don't cover a single dropped
    // WAL message on an otherwise-healthy, continuously-visible
    // connection. 20s, not a tight poll: this only ever needs to catch a
    // rare per-message loss eventually, never to be the path anything
    // depends on for responsiveness (every real vote still lands
    // instantly via the Realtime handlers above).
    const backstopInterval = setInterval(resync, 20_000);

    return () => {
      supabase.removeChannel(channel);
      document.removeEventListener("visibilitychange", handleVisibilityRestored);
      window.removeEventListener("focus", handleVisibilityRestored);
      clearInterval(backstopInterval);
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
