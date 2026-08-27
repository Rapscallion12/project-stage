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
 * **The one deliberate adapter, isolated and reported**:
 * `forceRoundDeadline` backdates `event_speakers.round_ends_at`/
 * `closing_ends_at` directly via the service client — there is no real
 * user pathway that skips time, and there never should be one. It exists
 * solely so the deterministic test-panel buttons ("Force Continue
 * Outcome," etc.) don't require literally waiting out a real 60/30
 * second window. After backdating, it still calls the *real*
 * `resolveSpeakerRoundAction` — the actual outcome decision (tally
 * votes, compare thresholds, transition phase/evict) is never
 * short-circuited, only the clock is.
 */

import { createServiceClient } from "@/lib/supabase/service";
import { isPreviewOrDevBuild } from "@/lib/preview-mode";
import { insertMessage, insertReaction } from "@/lib/repositories/chat";
import { requestToSpeakAsGuest, castSpeakerRequestVoteAsGuest } from "@/lib/repositories/speaker-requests";
import { claimSpeakerSeat, endSpeakerSeat, castSpeakerRoundVoteAsGuest } from "@/lib/repositories/event-speakers";
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
 * `resolveSpeakerRoundAction` so the round resolves immediately.
 */
export async function forceRoundDeadline(eventSpeakersId: string): Promise<void> {
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

  await resolveSpeakerRoundAction(eventSpeakersId);
}
