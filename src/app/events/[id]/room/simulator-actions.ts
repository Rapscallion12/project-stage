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
 * **Two deliberate adapters, both isolated and reported**:
 * - `forceRoundDeadline` backdates `event_speakers.round_ends_at`/
 *   `closing_ends_at` directly via the service client — there is no real
 *   user pathway that skips time, and there never should be one. It exists
 *   solely so the deterministic test-panel buttons ("Force Continue
 *   Outcome," etc.) don't require literally waiting out a real 60/30
 *   second window. After backdating, it still calls the *real*
 *   `resolveSpeakerRoundAction` — the actual outcome decision (tally
 *   votes, compare thresholds, transition phase/evict) is never
 *   short-circuited, only the clock is.
 * - `resetSimulatorSession` bulk-deletes rows by an exact guest-id list —
 *   there is no real user pathway that bulk-deletes another identity's
 *   data either. See its own doc comment for why an exact in-memory id
 *   list (not a new `simulation_run_id` schema column) is the safe,
 *   sufficient ownership mechanism here.
 */

import { createServiceClient } from "@/lib/supabase/service";
import { isPreviewOrDevBuild } from "@/lib/preview-mode";
import { insertMessage, insertReaction } from "@/lib/repositories/chat";
import { requestToSpeakAsGuest, castSpeakerRequestVoteAsGuest } from "@/lib/repositories/speaker-requests";
import { claimSpeakerSeat, endSpeakerSeat, castSpeakerRoundVoteAsGuest } from "@/lib/repositories/event-speakers";
import type { ResolveSpeakerRoundOutcome } from "@/lib/repositories/event-speakers";
import { resolveSpeakerRoundAction } from "./actions";

function assertSimulatorAvailable(): void {
  if (!isPreviewOrDevBuild()) {
    throw new Error("The Session Simulator is not available on this deployment.");
  }
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

export async function simulateRequestToSpeak(eventId: string, guestId: string, displayName: string, body: string) {
  assertSimulatorAvailable();
  await requestToSpeakAsGuest(eventId, guestId, displayName, body);
}

export async function simulateRequestVote(eventId: string, messageId: string, guestId: string) {
  assertSimulatorAvailable();
  await castSpeakerRequestVoteAsGuest(eventId, messageId, guestId);
}

export async function simulateRoundVote(eventSpeakersId: string, choice: "continue" | "replace", guestId: string) {
  assertSimulatorAvailable();
  await castSpeakerRoundVoteAsGuest(eventSpeakersId, choice, guestId);
}

/** Bootstraps the initial "2 speakers, where appropriate" seed (Part 5) — skips the request/selection preamble purely for quick setup convenience, but still goes through the exact real `claim_speaker_seat` RPC (its own uniqueness/race-safety included), not a raw insert. Every subsequent speaker change from this point on flows through the real round-resolution -> Phase 1 selection pipeline, same as any other seat. */
export async function simulateSeedSpeaker(
  eventId: string,
  guestId: string,
  displayName: string,
  seatNumber: 1 | 2,
) {
  assertSimulatorAvailable();
  await claimSpeakerSeat(eventId, { type: "guest", id: guestId }, seatNumber, displayName);
}

/** "Open Speaker Seat" deterministic test-panel action — ends whichever seat is asked for, the same `end_speaker_seat` RPC a moderator-removal would use. Real eviction, not a display trick: the seat is genuinely open afterward, picked up by Phase 1's own polling exactly like any other opening. */
export async function simulateOpenSeat(eventId: string, guestId: string) {
  assertSimulatorAvailable();
  await endSpeakerSeat(eventId, { type: "guest", id: guestId }, "moderator_removed");
}

/**
 * The one deliberate adapter — see this file's own doc comment.
 * Backdates whichever deadline is *currently* governing the round
 * (`round_ends_at` while active, `closing_ends_at` while closing) — never
 * both unconditionally, which would violate the row's own
 * `closing_ends_at_matches_phase` CHECK constraint (closing_ends_at must
 * stay null while phase is 'active'). Then calls the real
 * `resolveSpeakerRoundAction` so the round resolves immediately — its
 * return value (the real resolver's own outcome, never a value this
 * function invents) is returned here too, so the simulator panel's
 * forced-outcome feedback always reflects what the actual resolution
 * logic decided, not just what the caller intended to force.
 */
export async function forceRoundDeadline(eventSpeakersId: string): Promise<ResolveSpeakerRoundOutcome> {
  assertSimulatorAvailable();
  const supabase = createServiceClient();
  const past = new Date(Date.now() - 1000).toISOString();

  const { data: row } = await supabase
    .from("event_speakers")
    .select("round_phase")
    .eq("id", eventSpeakersId)
    .single();

  if (row?.round_phase === "closing") {
    await supabase.from("event_speakers").update({ closing_ends_at: past }).eq("id", eventSpeakersId);
  } else {
    await supabase.from("event_speakers").update({ round_ends_at: past }).eq("id", eventSpeakersId);
  }

  return resolveSpeakerRoundAction(eventSpeakersId);
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

  return {
    messagesDeleted: messagesDeleted ?? 0,
    reactionsDeleted: reactionsDeleted ?? 0,
    speakersDeleted: speakersDeleted ?? 0,
    requestVotesDeleted: requestVotesDeleted ?? 0,
    roundVotesDeleted: roundVotesDeleted ?? 0,
  };
}
