"use server";

/**
 * Issue #21, Part 5: Session Simulator Server Actions. Every one of
 * these re-checks `isPreviewOrDevBuild()` itself, first — this is the
 * actual security boundary (not the simulator panel simply failing to
 * render in production), matching the same discipline
 * `isDevToolsAvailable()` already established for `/dev`.
 *
 * **Governing principle applied here: "fake the people, not the
 * systems."** Every action below except `forceRoundDeadline` calls the
 * *exact same* repository function or RPC a real guest's own action
 * would — `requestToSpeakAsGuest`, `castSpeakerRequestVoteAsGuest`,
 * `castSpeakerRoundVoteAsGuest`, `claimSpeakerSeat`, `endSpeakerSeat`,
 * `insertMessage`, `insertReaction` are all pre-existing, already-real
 * functions this codebase's own guest-participation architecture
 * (issue #16) provides — a simulated identity is simply a generated
 * UUID passed into them instead of one resolved from a session cookie.
 * Nothing here writes to a table or bypasses a check a real guest
 * couldn't already trigger through the genuine UI.
 *
 * **Three deliberate adapters, all isolated and reported**:
 * - `forceStageRoundDeadline`/`forceSeatClosingDeadline` backdate
 *   `stage_rounds.ends_at`/an individual seat's own `closing_ends_at`
 *   directly via the service client — there is no real user pathway
 *   that skips time, and there never should be one. They exist solely
 *   so the deterministic test-panel buttons ("Resolve Round Now,"
 *   "Force Replace Now") don't require literally waiting out a real
 *   60/30 second window. After backdating, they still call the *real*
 *   `resolveStageRoundAction`/`resolveSeatClosingAction` — the actual
 *   outcome decision (tally votes, compare thresholds, transition
 *   phase/evict) is never short-circuited, only the clock is.
 * - `resetSimulatorSession` bulk-deletes rows by an exact guest-id list —
 *   there is no real user pathway that bulk-deletes another identity's
 *   data either. See its own doc comment for why an exact in-memory id
 *   list (not a new `simulation_run_id` schema column) is the safe,
 *   sufficient ownership mechanism here.
 * - `simulateAdvanceSelection` claims an open seat on a *specific target
 *   identity's* behalf — see its own doc comment for why production's
 *   `claimOpenSeat`/`checkPromotionEligibility` can't be reused as-is
 *   (they always resolve "who" from the caller's own session, and a
 *   simulated identity has no session to resolve), and for the one
 *   safety property that makes this adapter non-negotiable: it refuses
 *   to act unless the round's actual, authoritatively-selected winner is
 *   already a known simulated guest id — it never claims on behalf of a
 *   real user, even when a real user's request happens to be in the same
 *   frozen pool as simulated ones.
 */

import { createServiceClient } from "@/lib/supabase/service";
import { isPreviewOrDevBuild } from "@/lib/preview-mode";
import { insertMessage, insertReaction } from "@/lib/repositories/chat";
import {
  requestToSpeakAsGuest,
  castSpeakerRequestVoteAsGuest,
  withdrawSpeakerRequestAsGuest,
  freezeSpeakerCandidates,
  markSpeakerRequestGranted,
  resetSpeakerCandidatePool,
  releaseFailedSpeakerClaim,
} from "@/lib/repositories/speaker-requests";
import { claimSpeakerSeat, endSpeakerSeat, castSpeakerRoundVoteAsGuest } from "@/lib/repositories/event-speakers";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import { ensureStageRound } from "@/lib/repositories/stage-rounds";
import type { SeatResolutionOutcome } from "@/lib/repositories/stage-rounds";
import { findOpenSeats } from "@/lib/speaker-queue";
import { resolveStageRoundAction, resolveSeatClosingAction, ensureActiveSelectionRound } from "./actions";

function assertSimulatorAvailable(): void {
  if (!isPreviewOrDevBuild()) {
    throw new Error("The Session Simulator is not available on this deployment.");
  }
}

/**
 * The same `event_speakers_active` view `listActiveSpeakers`
 * (`lib/repositories/event-speakers.ts`) reads, via the service client
 * instead of the request-scoped one that function uses — every other
 * read/write in this file already goes through the service client (this
 * is preview-tooling gated by `assertSimulatorAvailable`, not tied to
 * any particular caller's session), and `simulateAdvanceSelection` is no
 * different. Kept local rather than exported from the repository file:
 * this exact "service client, no session" shape is specific to this
 * file's own trust model, not a general-purpose alternative worth
 * offering callers that *do* have a real session.
 */
async function listActiveSpeakersForSimulator(eventId: string): Promise<EventSpeaker[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("event_speakers_active")
    .select("*")
    .eq("event_id", eventId)
    .order("seat_number", { ascending: true });
  return (data ?? []) as EventSpeaker[];
}

export async function simulateComment(eventId: string, guestId: string, displayName: string, body: string) {
  assertSimulatorAvailable();
  await insertMessage({ eventId, identity: { type: "guest", id: guestId }, displayName, body });
}

export async function simulateLike(messageId: string, guestId: string) {
  assertSimulatorAvailable();
  // Same "already reacted" idempotency the real addReaction action
  // relies on (insertReaction's own unique-constraint handling) — a
  // simulated identity re-liking the same message is a harmless no-op,
  // not an error, matching real behavior exactly.
  await insertReaction({ messageId, identity: { type: "guest", id: guestId }, emoji: "👍" });
}

/**
 * Issue #21, twelfth corrective pass: matches production `requestToSpeak`'s
 * own tenth-pass fix — a simulated request arriving after a vacancy
 * already exists must reconcile immediately, the same as a real one,
 * not depend solely on the reactive client hook. Best-effort: a
 * genuinely successful request must never be reported as failed merely
 * because this follow-up reconciliation hit a transient problem.
 */
export async function simulateRequestToSpeak(eventId: string, guestId: string, displayName: string, body: string) {
  assertSimulatorAvailable();
  await requestToSpeakAsGuest(eventId, guestId, displayName, body);
  try {
    await ensureActiveSelectionRound(eventId, await listActiveSpeakersForSimulator(eventId));
  } catch {
    // Swallow — see this function's own doc comment.
  }
}

export async function simulateRequestVote(eventId: string, messageId: string, guestId: string) {
  assertSimulatorAvailable();
  await castSpeakerRequestVoteAsGuest(eventId, messageId, guestId);
}

/**
 * Issue #21, third corrective pass, item 18: natural simulated audience
 * behavior occasionally changes its mind, same as real people — a
 * pending Request-to-Speak candidate withdrawing before selection ever
 * happens, exercising the exact same "next-highest-voted candidate wins"
 * re-ranking (`withdraw_speaker_request_as_guest`, migration 19) a real
 * user's own withdrawal would. Calls the exact real RPC a real guest's
 * own "Cancel Request" tap would — no simulator-specific withdrawal
 * logic. Already a safe no-op (returns `null`, never throws) if the
 * request was already granted/withdrawn/expired by the time this fires —
 * see `withdrawSpeakerRequestAsGuest`'s own doc comment.
 *
 * **Issue #21, twelfth corrective pass**: matches production
 * `withdrawSpeakerRequest`'s own tenth-pass fix — the RPC itself
 * already advances the next-ranked candidate within the same round
 * when the withdrawer was reserved (migration 00000000000038); this is
 * the backstop for the round ending up exhausted (needing a fresh
 * freeze from the current live pool), same reasoning as the production
 * action.
 */
export async function simulateWithdrawRequest(eventId: string, guestId: string) {
  assertSimulatorAvailable();
  await withdrawSpeakerRequestAsGuest(eventId, guestId);
  try {
    await ensureActiveSelectionRound(eventId, await listActiveSpeakersForSimulator(eventId));
  } catch {
    // Swallow — see this function's own doc comment.
  }
}

export async function simulateRoundVote(eventSpeakersId: string, choice: "continue" | "replace", guestId: string) {
  assertSimulatorAvailable();
  await castSpeakerRoundVoteAsGuest(eventSpeakersId, choice, guestId);
}

/**
 * Bootstraps the initial "2 speakers, where appropriate" seed (Part 5) —
 * skips the request/selection preamble purely for quick setup
 * convenience, but still goes through the exact real `claim_speaker_seat`
 * RPC (its own uniqueness/race-safety included), not a raw insert. Every
 * subsequent speaker change from this point on flows through the real
 * round-resolution -> Phase 1 selection pipeline, same as any other seat.
 *
 * The one caller in this file that passes `bypassSelectionAuthorization:
 * true` (issue #21, third corrective pass, migration 00000000000029) —
 * this is a manual, operator-triggered re-seed tool ("Seed 2 Speakers"),
 * used for deterministic test setup even after the stage has already
 * been established once, when the real Request-to-Speak authorization
 * check would otherwise correctly refuse it (nobody is the currently
 * selected candidate at that moment). Still cannot steal an
 * already-occupied seat — migration 00000000000024's guard applies
 * unconditionally regardless of this flag. `simulateAdvanceSelection`
 * below deliberately does *not* use this bypass: it claims on behalf of
 * a real, frozen, authorized winner, so it exercises the exact same
 * authorization check a real user's claim would.
 */
export async function simulateSeedSpeaker(
  eventId: string,
  guestId: string,
  displayName: string,
  seatNumber: 1 | 2,
) {
  assertSimulatorAvailable();
  await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, seatNumber, displayName, true);
}

/**
 * "Open Speaker Seat" deterministic test-panel action — ends whichever
 * seat is asked for, the same `end_speaker_seat` RPC a moderator-removal
 * would use. Real eviction, not a display trick.
 *
 * **Issue #21, twelfth corrective pass**: also directly reconciles
 * selection for the vacancy this just created, the same fix the ninth/
 * tenth passes already made to every *production* vacancy path
 * (`resolveStageRoundAction`, `resolveSeatClosingAction`,
 * `leaveSpeakerSeat`, `checkAndEvictInactiveSpeaker`) — this simulator
 * action was the one vacancy-creating path left depending entirely on
 * the reactive `useSpeakerSelectionReconciliation` client hook. A real-
 * device capture (established room, this seat freshly vacant, two
 * eligible RTS candidates, simulator still running, a 591ms
 * authoritative read agreeing with the client) traced to a *different*,
 * deeper root cause this pass also fixed (migration 00000000000040 —
 * `freeze_speaker_candidates` reusing a long-dead "active" round
 * forever) — but this gap was real regardless and is closed the same
 * way as every other path, for the same "one coherent architecture, not
 * an expanding set of special cases" reasoning. Best-effort: a genuine,
 * successful Open Seat must never be reported as failed merely because
 * this *follow-up* reconciliation hit a transient problem — the
 * reactive hook remains the backstop for exactly that case.
 */
export async function simulateOpenSeat(eventId: string, guestId: string) {
  assertSimulatorAvailable();
  await endSpeakerSeat(eventId, { type: "guest", id: guestId }, "moderator_removed");
  try {
    await ensureActiveSelectionRound(eventId, await listActiveSpeakersForSimulator(eventId));
  } catch {
    // Swallow — see this function's own doc comment.
  }
}

/**
 * The one clock-skipping adapter for the *shared* round — see this
 * file's own doc comment. Backdates `stage_rounds.ends_at` for the
 * event (only when the round is genuinely 'active' — a no-op otherwise,
 * same "never force something that isn't real" discipline every other
 * force button here already has), then calls the real
 * `resolveStageRoundAction` so the round resolves immediately for
 * *both* occupied seats at once — this is the Session Simulator's
 * "Resolve Round Now" button. Its return value (the real resolver's own
 * per-seat outcomes, never values this function invents) is returned
 * here too, so the simulator panel's forced-outcome feedback always
 * reflects what the actual resolution logic decided for each seat, not
 * just what the per-seat Force Continue/Narrow Loss/Replace buttons cast
 * votes *aiming* for.
 */
export async function forceStageRoundDeadline(eventId: string): Promise<Array<{ eventSpeakersId: string; outcome: SeatResolutionOutcome }>> {
  assertSimulatorAvailable();
  const supabase = createServiceClient();
  const past = new Date(Date.now() - 1000).toISOString();

  await supabase.from("stage_rounds").update({ ends_at: past }).eq("event_id", eventId).eq("phase", "active");

  return resolveStageRoundAction(eventId);
}

/**
 * The individual-narrow-loss-speaker equivalent — backdates *that
 * seat's own* `closing_ends_at` (only while it's genuinely 'closing'),
 * then calls the real `resolveSeatClosingAction`. Deliberately separate
 * from `forceStageRoundDeadline` — Part 4's "the other speaker should
 * not be forced into that final-30 state" means accelerating one
 * speaker's individual closing window must never touch the shared
 * clock or the other seat.
 */
export async function forceSeatClosingDeadline(eventSpeakersId: string): Promise<boolean> {
  assertSimulatorAvailable();
  const supabase = createServiceClient();
  const past = new Date(Date.now() - 1000).toISOString();

  await supabase.from("event_speakers").update({ closing_ends_at: past }).eq("id", eventSpeakersId).eq("round_phase", "closing");

  return resolveSeatClosingAction(eventSpeakersId);
}

export type ResetSimulatorSessionResult = {
  messagesDeleted: number;
  reactionsDeleted: number;
  speakersDeleted: number;
  requestVotesDeleted: number;
  roundVotesDeleted: number;
};

/**
 * The second deliberate adapter — see this file's own doc comment.
 * "Reset Session": genuinely destroys everything the simulator created
 * this run, not just stops future activity (that's Stop Simulation,
 * unchanged).
 *
 * **Ownership mechanism — investigated before writing anything
 * destructive, reported here rather than defaulting to a schema
 * change.** None of the tables a simulated identity can write to
 * (`event_chat_messages`, `event_chat_message_reactions`,
 * `speaker_requests`, `speaker_request_votes`, `event_speakers`,
 * `speaker_round_votes`) has a spare column that could safely double as
 * a "created by the simulator" tag, and a real guest's `guest_id` is
 * structurally identical to a simulated one (both are bare
 * `crypto.randomUUID()` values — see `lib/guest.ts`/
 * `lib/simulator/identities.ts`) — so a filter like "guest_id is not
 * null" would delete real audience participation, not just simulated
 * rows. A `simulation_run_id uuid` column on each table was considered
 * (and would work) but isn't the only, or the simplest, safe mechanism:
 * `SessionSimulatorPanel` already knows the *exact* set of guest ids it
 * generated this run (every one minted via `crypto.randomUUID()` in this
 * tab, accumulated across Start/Stop cycles, passed in as `guestIds`
 * below) — deleting `WHERE guest_id = ANY(guestIds)` is exact identity
 * matching against ids the app itself created, never an inference from
 * display name or any other heuristic. This is "an equivalent
 * preview-only ownership mechanism," just implemented as an in-memory
 * set the panel already tracked rather than a new persisted column —
 * chosen specifically to avoid touching four SECURITY DEFINER RPCs and a
 * migration on the shared linked database for a preview-only tool, when
 * the exact-id-list approach is already fully precise and safe. The
 * tradeoff, stated plainly: this only resets what the *current browser
 * tab* remembers generating — a hard page reload loses that memory, same
 * as every other piece of this panel's presentation-only state.
 *
 * **Deletion order and cascade reasoning**: every FK among these tables
 * is `ON DELETE CASCADE` except `speaker_requests.selection_round_id`
 * (`SET NULL`, into `speaker_selection_rounds` — deliberately left
 * alone; see below). Deletes below are still explicit per table, in an
 * order that's correct with or without relying on cascade:
 * 1. `speaker_request_votes` by `voter_guest_id` — a simulated identity's
 *    vote on *any* request (including a real one).
 * 2. `event_chat_message_reactions` by `reactor_guest_id` — a simulated
 *    like on *any* message (including a real one).
 * 3. `speaker_round_votes` by `voter_guest_id` — a simulated identity's
 *    Continue/Replace vote on *any* round (including a real speaker's).
 * 4. `event_speakers` by `guest_id` — the simulated seats themselves;
 *    cascades to delete any *remaining* `speaker_round_votes` tied to
 *    those seats (e.g. a real audience member's vote on a now-deleted
 *    fake speaker's round — meaningless once that round no longer
 *    exists, not "real user data" in any sense worth preserving).
 * 5. `event_chat_messages` by `author_guest_id` — simulated ordinary
 *    comments *and* simulated Request-to-Speak messages alike (the same
 *    table, distinguished only by `is_speaker_request`); cascades to
 *    `speaker_requests` (deleting a simulated request-to-speak),
 *    transitively to any remaining `speaker_request_votes` on it, and to
 *    any remaining `event_chat_message_reactions` on it (e.g. a real
 *    like on a fake comment — same reasoning as step 4).
 * 6. `stage_rounds` (issue #21, second corrective pass) — the shared
 *    round clock is deleted outright, but *only* when step 4 leaves the
 *    event with zero occupied seats at all (real or simulated): with
 *    nobody seated, nothing could possibly depend on that row's
 *    round_number/deadline surviving, and dropping it is what lets the
 *    *next* Start Simulated Session begin cleanly at "Round 1" instead
 *    of continuing to increment a stale counter — the explicit product
 *    requirement for Reset. If a real speaker is still seated (a mixed
 *    real+simulated stage), the row is never deleted — only resynced via
 *    `ensureStageRound`, the same self-healing call every seat-vacate
 *    path already makes, so their own shared round state is reduced to
 *    match the new (likely solo, `awaiting_pairing`) occupancy rather
 *    than being destroyed. Same "shared production state — resync,
 *    never blind-delete" precedent this doc comment already applies to
 *    `speaker_selection_rounds` below.
 *
 * **`speaker_selection_rounds` is deliberately left untouched.** It has
 * no guest/profile column at all, and its only writer,
 * `freeze_speaker_candidates`, is a genuinely shared production RPC —
 * fired whenever *any* seat opens, real or simulated, and can freeze a
 * pool containing a mix of real and simulated requests. There is no safe
 * way to attribute a frozen round to "the simulator" specifically.
 * Leaving it alone is harmless: nothing in this app's UI reads
 * `speaker_selection_rounds` rows directly (Top Speaker Requests reads
 * `speaker_requests` itself, which this *does* clean up), and any row
 * left referencing only now-deleted requests is an inert, invisible
 * bookkeeping artifact — not a data-integrity or safety problem.
 *
 * Scoped to `eventId` wherever a table has that column, as defense in
 * depth — the guest-id list alone is already exact, since each id is a
 * freshly generated UUID that could never coincide with a real guest's.
 */
export async function resetSimulatorSession(eventId: string, guestIds: string[]): Promise<ResetSimulatorSessionResult> {
  assertSimulatorAvailable();
  const empty: ResetSimulatorSessionResult = {
    messagesDeleted: 0,
    reactionsDeleted: 0,
    speakersDeleted: 0,
    requestVotesDeleted: 0,
    roundVotesDeleted: 0,
  };
  if (guestIds.length === 0) return empty;

  const supabase = createServiceClient();

  const { count: requestVotesDeleted } = await supabase
    .from("speaker_request_votes")
    .delete({ count: "exact" })
    .eq("event_id", eventId)
    .in("voter_guest_id", guestIds);

  const { count: reactionsDeleted } = await supabase
    .from("event_chat_message_reactions")
    .delete({ count: "exact" })
    .in("reactor_guest_id", guestIds);

  const { count: roundVotesDeleted } = await supabase
    .from("speaker_round_votes")
    .delete({ count: "exact" })
    .in("voter_guest_id", guestIds);

  const { count: speakersDeleted } = await supabase
    .from("event_speakers")
    .delete({ count: "exact" })
    .eq("event_id", eventId)
    .in("guest_id", guestIds);

  const { count: messagesDeleted } = await supabase
    .from("event_chat_messages")
    .delete({ count: "exact" })
    .eq("event_id", eventId)
    .in("author_guest_id", guestIds);

  const { count: remainingOccupied } = await supabase
    .from("event_speakers")
    .select("*", { count: "exact", head: true })
    .eq("event_id", eventId)
    .is("left_at", null);

  if ((remainingOccupied ?? 0) === 0) {
    await supabase.from("stage_rounds").delete().eq("event_id", eventId);
  } else {
    await ensureStageRound(eventId);
  }

  return {
    messagesDeleted: messagesDeleted ?? 0,
    reactionsDeleted: reactionsDeleted ?? 0,
    speakersDeleted: speakersDeleted ?? 0,
    requestVotesDeleted: requestVotesDeleted ?? 0,
    roundVotesDeleted: roundVotesDeleted ?? 0,
  };
}

export type DebugSnapshotState = {
  fetchedAt: string;
  round: { round_number: number; phase: string; ends_at: string } | null;
  seats: Array<{
    seat_number: 1 | 2;
    display_name: string;
    identity_kind: "profile" | "guest";
    disconnected: boolean;
  }>;
  pendingRequests: Array<{
    id: string;
    display_name: string;
    identity_kind: "profile" | "guest";
    vote_count: number;
    is_current_candidate: boolean;
    reserved_seat_number: 1 | 2 | null;
    frozen_rank: number | null;
    selection_failed: boolean;
  }>;
};

/**
 * Issue #21, tenth corrective pass, Sections 1-25: the authoritative
 * (never client-cached) read behind the Session Simulator's "Copy Debug
 * Snapshot" — see `SessionSimulatorPanel`'s own doc comment on that
 * button for the full reasoning. A **read-only** query, deliberately:
 * no `ensureActiveSelectionRound`, no freeze, no claim, nothing that
 * could change what a subsequent real reproduction attempt would see —
 * "capture what's true right now," never "make something true first."
 * Runs a fresh service-client read on every call rather than reusing any
 * already-fetched props, so a snapshot taken at the exact moment of a
 * suspected bug reflects the database's own current state, not
 * whatever this tab's own Realtime subscription happened to have
 * received by then — the caller (the panel) separately compares this
 * against its own current props to surface exactly that kind of
 * client/authoritative divergence.
 */
export async function fetchDebugSnapshotState(eventId: string): Promise<DebugSnapshotState> {
  assertSimulatorAvailable();
  const supabase = createServiceClient();

  const [{ data: roundRow }, { data: seatRows }, { data: requestRows }, { data: voteRows }] = await Promise.all([
    supabase.from("stage_rounds").select("round_number, phase, ends_at").eq("event_id", eventId).maybeSingle(),
    supabase
      .from("event_speakers_active")
      .select("seat_number, display_name, profile_id, guest_id, disconnected_at")
      .eq("event_id", eventId)
      .order("seat_number", { ascending: true }),
    supabase
      .from("speaker_requests")
      .select("id, message_id, profile_id, guest_id, is_current_candidate, reserved_seat_number, frozen_rank, selection_failed")
      .eq("event_id", eventId)
      .eq("status", "pending")
      .order("created_at", { ascending: true }),
    supabase.from("speaker_request_votes").select("request_id").eq("event_id", eventId),
  ]);

  const requestIds = (requestRows ?? []).map((r) => r.id);
  const { data: messageRows } =
    requestIds.length > 0
      ? await supabase
          .from("event_chat_messages")
          .select("id, author_display_name")
          .in(
            "id",
            (requestRows ?? []).map((r) => r.message_id),
          )
      : { data: [] as { id: string; author_display_name: string }[] };
  const nameByMessageId = new Map((messageRows ?? []).map((m) => [m.id, m.author_display_name]));

  const voteCountByRequestId = new Map<string, number>();
  for (const vote of voteRows ?? []) {
    voteCountByRequestId.set(vote.request_id, (voteCountByRequestId.get(vote.request_id) ?? 0) + 1);
  }

  return {
    fetchedAt: new Date().toISOString(),
    round: roundRow ? { round_number: roundRow.round_number, phase: roundRow.phase, ends_at: roundRow.ends_at } : null,
    seats: (seatRows ?? []).map((s) => ({
      seat_number: s.seat_number as 1 | 2,
      display_name: s.display_name ?? "(unknown)",
      identity_kind: s.profile_id ? "profile" : ("guest" as const),
      disconnected: s.disconnected_at !== null,
    })),
    pendingRequests: (requestRows ?? []).map((r) => ({
      id: r.id,
      display_name: nameByMessageId.get(r.message_id) ?? "(unknown)",
      identity_kind: r.profile_id ? "profile" : "guest",
      vote_count: voteCountByRequestId.get(r.id) ?? 0,
      is_current_candidate: r.is_current_candidate,
      reserved_seat_number: r.reserved_seat_number as 1 | 2 | null,
      frozen_rank: r.frozen_rank,
      selection_failed: r.selection_failed,
    })),
  };
}

export type AdvanceSelectionResult =
  | { claimed: false }
  | { claimed: true; guestId: string; seatNumber: 1 | 2 };

/**
 * The third deliberate adapter — see this file's own doc comment.
 * Closes the loop production's own automatic promotion can't close for a
 * simulated identity: `useAutomaticPromotion` polls
 * `checkPromotionEligibility`/`claimOpenSeat` from a *specific candidate's
 * own browser tab*, both of which resolve "who is asking" from that
 * tab's session cookie (`resolveIdentity()`) — there is no session to
 * resolve for a simulated guest id, so no real pathway could ever
 * promote one automatically, no matter how many votes their request
 * earned.
 *
 * The freeze/deterministic-pick step itself (`ensureActiveSelectionRound`)
 * is identity-agnostic — it operates on the whole event's pending pool,
 * not on "the caller" — so it's reused directly, unmodified, exactly as
 * production's own `resolveClaimDecision` calls it. Only the *claim* step
 * needs this adapter, and only for the specific case production has no
 * mechanism for at all.
 *
 * **The one safety-critical check**: after the (real, authoritative)
 * selection round has picked a winner, this only proceeds if that
 * winner's `guest_id` is in the caller-supplied `simulatedGuestIds` list
 * — the exact same "ids the panel itself generated this run" ownership
 * mechanism `resetSimulatorSession` already uses. If a real user's
 * request organically wins the same deterministic pick (entirely
 * possible — real and simulated requests share one pool), this returns
 * `{claimed:false}` without touching anything, leaving that real user's
 * own `useAutomaticPromotion` to claim it for themselves exactly as
 * production always has. This function only ever completes a promotion
 * production itself could never have completed on its own.
 *
 * **Issue #21, fifth corrective pass: seat-aware, like the real
 * selection pipeline it mirrors.** With two seats able to open — and get
 * reserved candidates — simultaneously (see `ensureActiveSelectionRound`'s
 * own doc comment, room/actions.ts), this now looks for *any* currently-
 * reserved candidate that's a known simulated identity, across every
 * open seat, and claims that candidate's own `reserved_seat_number` —
 * never `findOpenSeat`'s generic "the lowest-numbered open one," which
 * could name a seat reserved for a *different* candidate entirely. One
 * call still only ever completes one claim (matching one seat's own
 * reservation); the caller (the natural replacement loop, or the
 * simulator's own sequential startup seeding) polls/calls again for the
 * other seat, same as before.
 */
export async function simulateAdvanceSelection(
  eventId: string,
  simulatedGuestIds: string[],
  displayNameByGuestId: Record<string, string>,
): Promise<AdvanceSelectionResult> {
  assertSimulatorAvailable();

  const activeSpeakers = await listActiveSpeakersForSimulator(eventId);
  if (findOpenSeats(activeSpeakers).length === 0) return { claimed: false };

  await ensureActiveSelectionRound(eventId, activeSpeakers);
  const candidates = await freezeSpeakerCandidates(eventId);
  const winner = candidates.find(
    (c) => c.is_current && c.reserved_seat_number !== null && c.guest_id && simulatedGuestIds.includes(c.guest_id),
  );
  if (!winner?.guest_id || winner.reserved_seat_number === null) {
    return { claimed: false };
  }

  const seatNumber = winner.reserved_seat_number;
  const displayName = displayNameByGuestId[winner.guest_id] ?? "Simulated Speaker";
  try {
    await claimSpeakerSeat(eventId, { type: "guest", id: winner.guest_id }, seatNumber, displayName);
  } catch {
    // Same "someone else just took it" tolerance claimOpenSeat has —
    // another poll (real or simulated) can legitimately win the race.
    //
    // Issue #21, tenth corrective pass, Section 40: the simulator uses
    // the exact same authoritative failure-recovery the real claim path
    // now does (see room/actions.ts' claimOpenSeat and migration
    // 00000000000039) — releasing this winner's reservation and
    // advancing the next-ranked eligible candidate, rather than a
    // simulator-only "just try again" that would leave the seat's
    // reservation stuck on a candidate who will never claim it.
    try {
      await releaseFailedSpeakerClaim(winner.request_id);
      await ensureActiveSelectionRound(eventId, await listActiveSpeakersForSimulator(eventId));
    } catch {
      // Best-effort — a failed cleanup here must never be reported as
      // if the (already-reported) claim failure were something worse.
    }
    return { claimed: false };
  }
  await markSpeakerRequestGranted(winner.request_id);
  await resetSpeakerCandidatePool(eventId, winner.request_id);

  return { claimed: true, guestId: winner.guest_id, seatNumber };
}
