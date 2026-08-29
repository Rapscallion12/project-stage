import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { SeatIdentity } from "@/lib/repositories/event-speakers";

/**
 * `status` is a Postgres CHECK-constrained text column, not a native
 * enum — see migration 00000000000011 (widened by 00000000000019 to add
 * 'expired'). Kept in sync with that CHECK by hand, same discipline as
 * `LeftReason` in event-speakers.ts.
 *
 * 'expired' (issue #21, Phase 1): the bulk pool-reset outcome — every
 * other still-pending request when a new speaker successfully joins,
 * distinct from 'withdrawn' (the requester's own voluntary action).
 */
export type RequestStatus = "pending" | "granted" | "withdrawn" | "expired";

export type SpeakerRequest = {
  id: string;
  event_id: string;
  /** Exactly one of profile_id/guest_id — issue #16, same XOR pattern as EventSpeaker. */
  profile_id: string | null;
  guest_id: string | null;
  message_id: string;
  status: RequestStatus;
  created_at: string;
  resolved_at: string | null;
  /** Issue #21, Phase 1: which frozen selection round (if any) this request was captured into — see freeze_speaker_candidates. Null until frozen. */
  selection_round_id: string | null;
  /** 1-indexed rank within its frozen round at the moment of freezing (never recomputed against live votes mid-round) — null until frozen. */
  frozen_rank: number | null;
  /** Vote count snapshot at freeze time — null until frozen. */
  frozen_vote_count: number | null;
  /** True for exactly one request per active round — the current deterministic (highest-votes) pick, or the current runner-up after an advance. */
  is_current_candidate: boolean;
  /** True once this request was the current candidate and failed to claim the seat (withdrew) — excluded from future re-selection within the same round, per Section D. */
  selection_failed: boolean;
};

export type SpeakerRequestVote = {
  id: string;
  event_id: string;
  voter_profile_id: string | null;
  voter_guest_id: string | null;
  request_id: string;
  created_at: string;
};

export type FrozenCandidate = {
  round_id: string;
  request_id: string;
  profile_id: string | null;
  guest_id: string | null;
  message_id: string;
  rank: number;
  vote_count: number;
  /** Whether this candidate is already the round's committed current pick — lets the caller skip re-selecting when freeze_speaker_candidates returns an already-resolved round (its own idempotent-repeat-call path). */
  is_current: boolean;
};

export type RankedSpeakerRequest = {
  request_id: string;
  profile_id: string | null;
  guest_id: string | null;
  message_id: string;
  rank: number;
};

function identityColumn(identity: SeatIdentity) {
  return identity.type === "profile" ? "profile_id" : "guest_id";
}

/**
 * Whether — and which — active pending request an identity (account or
 * guest) currently holds for an event. Public read (speaker_requests has
 * no anon/authenticated write grant — see the migration), used to decide
 * what request-related controls to show a given viewer.
 */
export async function getPendingRequestForIdentity(
  eventId: string,
  identity: SeatIdentity,
): Promise<SpeakerRequest | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("speaker_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq(identityColumn(identity), identity.id)
    .eq("status", "pending")
    .maybeSingle();
  return (data as SpeakerRequest | null) ?? null;
}

/**
 * Every currently-pending request for an event, oldest first (FIFO) —
 * issue #21's "Top Speaker Requests" section. `speaker_requests` has a
 * public "publicly viewable" select policy (migration 00000000000011),
 * so this is a plain ordinary-client read, not a service-role query —
 * same tier as `listRecentMessages`/`listActiveSpeakers`.
 *
 * **Ordering, documented per explicit instruction**: this is FIFO by
 * `created_at`, a deliberately temporary signal — there is no vote/like/
 * score column on this table today, and the one real ranking signal
 * that exists (`rank_pending_speaker_requests`, reputation-weighted) is
 * a trusted-server-only RPC that reads `profiles.reputation_score`
 * directly, and was already explicitly decided *not* to be exposed as a
 * public leaderboard when issue #23 built it (see this file's own
 * `rankPendingSpeakerRequests` doc comment and DECISIONS.md) — reusing
 * it here would silently reverse that decision, not extend it. FIFO
 * order needs no new column and reverses cleanly once a real audience
 * signal (likes on the request's own chat message, e.g.) exists to
 * order by instead.
 */
export async function listPendingSpeakerRequests(eventId: string): Promise<SpeakerRequest[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("speaker_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  return (data as SpeakerRequest[] | null) ?? [];
}

/**
 * Atomically creates the request's chat message and its
 * speaker_requests row for an account holder (issue #14's explicit
 * atomicity requirement — see migration 00000000000011's
 * `request_to_speak`). Self-service: `auth.uid()`-gated in Postgres, so
 * the ordinary session-bound client is correct here, same tier as
 * `leaveSpeakerSeat`.
 */
export async function requestToSpeak(
  eventId: string,
  body: string,
): Promise<{ messageId: string; requestId: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_to_speak", { p_event_id: eventId, p_body: body });
  const row = data?.[0];
  if (error || !row) {
    throw new Error(error?.message ?? "request_to_speak returned no row");
  }
  return { messageId: row.message_id, requestId: row.request_id };
}

/**
 * Same atomic creation for a guest (issue #16). There's no `auth.uid()`
 * equivalent for guests, so this can't be safely self-service the way
 * `requestToSpeak` is — service-role-only, called with the guest id and
 * display name already resolved server-side from the httpOnly session
 * cookie, never accepted as client input. See migration
 * 00000000000012's `request_to_speak_as_guest`.
 */
export async function requestToSpeakAsGuest(
  eventId: string,
  guestId: string,
  displayName: string,
  body: string,
): Promise<{ messageId: string; requestId: string }> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("request_to_speak_as_guest", {
    p_event_id: eventId,
    p_guest_id: guestId,
    p_display_name: displayName,
    p_body: body,
  });
  const row = data?.[0];
  if (error || !row) {
    throw new Error(error?.message ?? "request_to_speak_as_guest returned no row");
  }
  return { messageId: row.message_id, requestId: row.request_id };
}

/**
 * Self-service withdrawal of an account holder's own pending request —
 * same shape as `leaveSpeakerSeat`. Returns `null` (not a thrown error)
 * when there's no matching *pending* row for this identity — the RPC
 * itself (migration 00000000000011) `raise exception`s
 * `'no pending request found for this caller in event %'` in that case,
 * which this catches specifically and converts to `null`.
 *
 * Real-device finding (2026-08-23): a request that's already been
 * granted (see `markSpeakerRequestGranted`) has no pending row left for
 * this RPC to find — that used to surface as a generic thrown error,
 * which the action layer turned into a UI error message and, critically,
 * never cleared the caller's stale `hasPendingRequest` flag, leaving a
 * "Withdraw" button that appeared to do nothing. "Nothing left to
 * withdraw" and "successfully withdrew" both mean the same thing from
 * the caller's perspective (no pending request remains either way), so
 * this is a `null` result, not a failure — see `room/actions.ts`'s
 * `withdrawSpeakerRequest` for how that distinction is used. Any *other*
 * error (a real RPC/connection failure) still throws normally.
 */
export async function withdrawSpeakerRequest(eventId: string): Promise<SpeakerRequest | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("withdraw_speaker_request", { p_event_id: eventId });
  if (error) {
    if (error.message.includes("no pending request found")) return null;
    throw new Error(error.message);
  }
  return (data as SpeakerRequest | null) ?? null;
}

/** A guest's own withdrawal (issue #16) — same service-role-only tier as `requestToSpeakAsGuest`, and the same `null`-means-nothing-to-withdraw contract as the account-holder version above (the guest RPC, migration 00000000000012, raises the equivalent `'no pending request found for this guest in event %'`). */
export async function withdrawSpeakerRequestAsGuest(eventId: string, guestId: string): Promise<SpeakerRequest | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("withdraw_speaker_request_as_guest", {
    p_event_id: eventId,
    p_guest_id: guestId,
  });
  if (error) {
    if (error.message.includes("no pending request found")) return null;
    throw new Error(error.message);
  }
  return (data as SpeakerRequest | null) ?? null;
}

/**
 * Ranks an event's pending requests by audience support — see migration
 * 00000000000011/00000000000012's `rank_pending_speaker_requests` for the
 * exact ordering (a guest's reputation tiebreak is the same neutral
 * baseline every current account already has). Trusted-server-only
 * (reads `profiles.reputation_score`, which anon/authenticated can't
 * select directly, and is the input to `claimOpenSeat`'s eligibility
 * decision) — service client only, no Server Action wrapper of its own.
 * Not exposed as a public "leaderboard" in this issue; see DECISIONS.md.
 */
export async function rankPendingSpeakerRequests(eventId: string): Promise<RankedSpeakerRequest[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("rank_pending_speaker_requests", { p_event_id: eventId });
  if (error) {
    throw new Error(error.message);
  }
  return data ?? [];
}

/**
 * Marks a request granted after `claimOpenSeat` has already verified
 * eligibility and successfully claimed the seat. Plain service-client
 * update, not a function — the sensitive decision (rank/eligibility) was
 * already made in TypeScript before this is ever called; this is just
 * recording the outcome. Identity-agnostic (operates on the request id,
 * not the identity that made it), so issue #16 needed no change here.
 */
export async function markSpeakerRequestGranted(requestId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("speaker_requests")
    .update({ status: "granted", resolved_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", "pending");
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Issue #21, Phase 1: casts/transfers/toggles the caller's one active
 * vote for an event onto the currently-pending request behind a given
 * message — see migration 00000000000019's `cast_speaker_request_vote`
 * for the actual transfer/toggle semantics (Section A: voting for B
 * removes the vote from A; re-voting for the same request removes it
 * entirely). Self-service, auth.uid()-derived, same tier as
 * `requestToSpeak`.
 */
export async function castSpeakerRequestVote(
  eventId: string,
  messageId: string,
): Promise<{ votedRequestId: string | null }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("cast_speaker_request_vote", {
    p_event_id: eventId,
    p_message_id: messageId,
  });
  if (error) {
    throw new Error(error.message);
  }
  return { votedRequestId: data?.[0]?.voted_request_id ?? null };
}

/** A guest's own vote (issue #16-style exception) — service-role-only, same tier as `requestToSpeakAsGuest`. */
export async function castSpeakerRequestVoteAsGuest(
  eventId: string,
  messageId: string,
  guestId: string,
): Promise<{ votedRequestId: string | null }> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("cast_speaker_request_vote_as_guest", {
    p_event_id: eventId,
    p_message_id: messageId,
    p_guest_id: guestId,
  });
  if (error) {
    throw new Error(error.message);
  }
  return { votedRequestId: data?.[0]?.voted_request_id ?? null };
}

/**
 * Issue #21, Phase 1: ranks currently-pending requests by vote count and
 * freezes the Top 3 into a new selection round — see migration
 * 00000000000019's `freeze_speaker_candidates`. Trusted-server-only
 * (writes selection state); returns an empty array when there are no
 * pending requests at all (Section C's "0 candidates" case — the caller
 * creates no round and leaves the seat open normally).
 */
export async function freezeSpeakerCandidates(eventId: string): Promise<FrozenCandidate[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("freeze_speaker_candidates", { p_event_id: eventId });
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? []).map((row) => ({
    round_id: row.round_id,
    request_id: row.request_id,
    profile_id: row.profile_id,
    guest_id: row.guest_id,
    message_id: row.message_id,
    rank: row.rank,
    vote_count: row.vote_count,
    is_current: row.is_current,
  }));
}

/** Commits the deterministic highest-votes pick (or a runner-up advancement) computed in application code — see actions.ts' `ensureActiveSelectionRound`. Trusted-server-only. */
export async function setCurrentSpeakerCandidate(roundId: string, requestId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("set_current_speaker_candidate", {
    p_round_id: roundId,
    p_request_id: requestId,
  });
  if (error) {
    throw new Error(error.message);
  }
}

/**
 * Issue #21, Phase 1, Section E: the authoritative, race-safe candidate-
 * pool reset — called once, immediately after a successful claim/grant.
 * See migration 00000000000019's `reset_speaker_candidate_pool` for the
 * exact bulk-expire + vote-clear behavior. Trusted-server-only.
 */
export async function resetSpeakerCandidatePool(eventId: string, winningRequestId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("reset_speaker_candidate_pool", {
    p_event_id: eventId,
    p_winning_request_id: winningRequestId,
  });
  if (error) {
    throw new Error(error.message);
  }
}
