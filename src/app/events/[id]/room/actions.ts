"use server";

import { resolveIdentity } from "@/lib/identity";
import { PROTOTYPE_CONFIG } from "@/lib/config";
import { getEventPhase } from "@/lib/events";
import { getEventById } from "@/lib/repositories/events";
import {
  claimSpeakerSeat,
  getActiveSeatForIdentity,
  leaveSpeakerSeat as leaveSpeakerSeatRow,
  leaveSpeakerSeatAsGuest,
  listActiveSpeakers,
  listActiveSpeakersAuthoritative,
  markSpeakerMediaActive,
  markSpeakerMediaInactive,
  releaseExpiredInactiveSpeaker,
  castSpeakerRoundVote,
  castSpeakerRoundVoteAsGuest,
} from "@/lib/repositories/event-speakers";
import type { SeatIdentity, EventSpeaker } from "@/lib/repositories/event-speakers";
import { resolveStageRound, resolveSeatClosing } from "@/lib/repositories/stage-rounds";
import type { SeatResolutionOutcome } from "@/lib/repositories/stage-rounds";
import {
  getPendingRequestForIdentity,
  markSpeakerRequestGranted,
  rankPendingSpeakerRequests,
  requestToSpeak as requestToSpeakRow,
  requestToSpeakAsGuest,
  withdrawSpeakerRequest as withdrawSpeakerRequestRow,
  withdrawSpeakerRequestAsGuest,
  castSpeakerRequestVote,
  castSpeakerRequestVoteAsGuest,
  freezeSpeakerCandidates,
  reserveSpeakerCandidatesForSeats,
  resetSpeakerCandidatePool,
} from "@/lib/repositories/speaker-requests";
import { mintLiveKitToken } from "@/lib/livekit/token";
import { syncPublishPermission } from "@/lib/livekit/permissions";
import { decideClaimEligibility, findOpenSeat, findOpenSeats, type ClaimDecision } from "@/lib/speaker-queue";
import { isStageEstablished, ensureStageRound } from "@/lib/repositories/stage-rounds";
import { SPEAKER_DISCONNECT_GRACE_SECONDS } from "@/lib/speaker-reconnect";

export type GetLiveKitTokenResult = { token: string } | { error: string };

/**
 * Mints a LiveKit access token scoped to the caller's *current*
 * `event_speakers` occupancy — never trusts anything the client sends to
 * decide `canPublish`. Guests can hold an active seat as of issue #16
 * (an explicit, reversible prototype-testing exception — see PRODUCT.md/
 * DECISIONS.md, gated by `PROTOTYPE_CONFIG.guestParticipationEnabled`),
 * so the occupancy lookup now runs for either identity type; with the
 * flag off, guest occupancy can never exist in the first place (nothing
 * can write a guest-owned seat), so this degrades to the pre-#16
 * behavior automatically, not via a second code path here. Changing an
 * already-connected participant's permissions in real time (so a
 * replaced speaker loses publish rights immediately, not just on their
 * next token request) is issue #13's concern, not this one — see
 * DECISIONS.md's authorization-model entry for the split and why.
 */
export async function getLiveKitToken(eventId: string): Promise<GetLiveKitTokenResult> {
  const identity = await resolveIdentity();

  const activeSeat = await getActiveSeatForIdentity(eventId, identity);

  try {
    const token = await mintLiveKitToken({ eventId, identity, activeSeat });
    return { token };
  } catch {
    return { error: "Couldn't connect to the live room. Try again." };
  }
}

export type LeaveSpeakerSeatResult = { ok: true } | { error: string };

/**
 * Ends the caller's own active speaker occupancy — issue #13's
 * voluntary-leave path for account holders (self-service,
 * `auth.uid()`-gated all the way down to Postgres), extended by issue
 * #16 to guests via a service-role-only equivalent (no `auth.uid()`
 * exists for a guest to self-service with — see migration
 * 00000000000012's `leave_speaker_seat_as_guest`, called only with the
 * guest id already resolved server-side, never client input). Best-
 * effort pushes `canPublish: false` to the already-connected LiveKit
 * participant either way, so the change is visible immediately.
 */
export async function leaveSpeakerSeat(eventId: string): Promise<LeaveSpeakerSeatResult> {
  const identity = await resolveIdentity();
  try {
    if (identity.type === "profile") {
      await leaveSpeakerSeatRow(eventId);
    } else {
      await leaveSpeakerSeatAsGuest(eventId, identity.id);
    }
    await syncPublishPermission({ eventId, identity, canPublish: false });
    return { ok: true };
  } catch {
    return { error: "Couldn't leave the stage. Try again." };
  }
}

export type SpeakerRequestActionResult = { ok: true } | { error: string };

/**
 * Submits a mic request (issue #14) — atomically posts a chat message and
 * a `speaker_requests` row, never two independent writes. Account
 * holders use the existing self-service `request_to_speak`
 * (auth.uid()-gated). Guests, as of issue #16, use a service-role-only
 * equivalent when `PROTOTYPE_CONFIG.guestParticipationEnabled` is true —
 * an explicit, reversible prototype-testing exception (see PRODUCT.md/
 * DECISIONS.md), not a permanent change to who may request the mic.
 * With the flag off, guests still get PRODUCT.md's scripted account
 * prompt, exactly as before #16.
 *
 * Error messages are matched against the RPCs' own `raise exception`
 * text — a real coupling to the migrations' wording, accepted for now
 * rather than duplicating the same guards in TypeScript (which would
 * just be a second place for them to drift out of sync with the actual,
 * authoritative check).
 */
export async function requestToSpeak(eventId: string, body: string): Promise<SpeakerRequestActionResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile" && !PROTOTYPE_CONFIG.guestParticipationEnabled) {
    return { error: "Create an account to request the mic." };
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return { error: "Say a bit about why you'd like the mic." };
  }

  try {
    if (identity.type === "profile") {
      await requestToSpeakRow(eventId, trimmed);
    } else {
      await requestToSpeakAsGuest(eventId, identity.id, identity.displayName, trimmed);
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("already an active speaker")) {
      return { error: "You're already speaking." };
    }
    if (message.includes("already has a pending request")) {
      return { error: "You already have a pending request." };
    }
    return { error: "Couldn't submit your request. Try again." };
  }
}

/**
 * Self-service withdrawal of the caller's own pending request (issue
 * #14), extended to guests by issue #16 the same way requestToSpeak was.
 *
 * Real-device finding (2026-08-23): the repository layer now returns
 * `null` (not a thrown error) when there's no matching *pending* row —
 * e.g. the request was already granted and consumed by `claimOpenSeat`.
 * That's success from this action's own contract too: either way, the
 * caller has no pending request left, which is the only thing
 * `useAutomaticPromotion`'s `cancel()` actually checks before clearing
 * `hasPendingRequest`. Treating "nothing to withdraw" as an error was
 * exactly what left a "Withdraw" button that appeared to do nothing.
 */
export async function withdrawSpeakerRequest(eventId: string): Promise<SpeakerRequestActionResult> {
  const identity = await resolveIdentity();
  try {
    if (identity.type === "profile") {
      await withdrawSpeakerRequestRow(eventId);
    } else {
      await withdrawSpeakerRequestAsGuest(eventId, identity.id);
    }
    return { ok: true };
  } catch {
    return { error: "Couldn't withdraw your request. Try again." };
  }
}

export type VoteForSpeakerRequestResult = { ok: true; voted: boolean } | { error: string };

/**
 * Issue #21, Phase 1, Section A: casts, transfers, or toggles off the
 * caller's one active vote for a Request-to-Speak comment. Distinct from
 * `addReaction` (ordinary comment likes, untouched) — this calls
 * `cast_speaker_request_vote(_as_guest)`, which enforces the exclusive
 * "one active vote per viewer, transferable, toggle-off on re-tap"
 * semantics server-side (migration 00000000000019), not just in this
 * wrapper. `voted: false` in the result means the tap toggled the vote
 * off; `voted: true` means it's now active (fresh or transferred) —
 * the caller doesn't need to separately track which case it was, the
 * request's own `is_current_candidate`/live vote count (via Realtime)
 * reflects the outcome either way.
 *
 * Guest-eligible unconditionally, not gated on
 * `PROTOTYPE_CONFIG.guestParticipationEnabled` — that flag scopes
 * *becoming a guest speaker* specifically; voting is audience-level
 * engagement, the same tier as `addReaction` (ordinary comment likes),
 * which has never required an account (PRODUCT.md's progressive
 * authentication model: guests watch, react, and vote with zero
 * session).
 */
export async function voteForSpeakerRequest(
  eventId: string,
  messageId: string,
): Promise<VoteForSpeakerRequestResult> {
  const identity = await resolveIdentity();

  try {
    const { votedRequestId } =
      identity.type === "profile"
        ? await castSpeakerRequestVote(eventId, messageId)
        : await castSpeakerRequestVoteAsGuest(eventId, messageId, identity.id);
    return { ok: true, voted: votedRequestId !== null };
  } catch {
    return { error: "Couldn't record your vote. Try again." };
  }
}

const CLAIM_REJECTION_MESSAGES = {
  "no-request": "You don't have an active request to speak.",
  "no-open-seat": "Both seats are currently full.",
  "not-eligible": "You're in the running, but weren't this round's pick — hang tight.",
} as const;

/**
 * Issue #21, third corrective pass: selection is now deterministic —
 * "the eligible Request-to-Speak candidate with the most audience votes
 * wins," no weighted/random draw. `freeze_speaker_candidates`
 * (migration 00000000000019/20) already ranks its snapshot by
 * `vote_count desc, created_at asc, id asc` — highest votes first,
 * earliest request breaking a tie — so `rank 1` *is* the deterministic
 * winner; no separate tiebreak logic is needed here, and the ordering is
 * authoritative in the database, shared identically by every caller
 * (real users and the simulator alike), not re-derived per caller. The
 * previous weighted-random system (`lib/speaker-selection.ts`,
 * `SELECTION_RANK_WEIGHTS`, `Math.random()`) is retired entirely — see
 * DECISIONS.md for why (simplicity, predictability, a direct connection
 * between votes and outcome, per explicit instruction not to leave it
 * half-active).
 *
 * Ensures a seat opening has an active, resolved selection round before
 * eligibility is checked — the freeze (snapshot the eligible pool) and
 * the deterministic pick both happen here, lazily, on first need, rather
 * than via a background job (this serverless deployment has none — same
 * reasoning every other "evaluate on next real activity" mechanism in
 * this codebase already uses, see DECISIONS.md's voting-window entry).
 *
 * Safe to call on every poll: `freezeSpeakerCandidates` is itself
 * idempotent (returns the existing active round's candidates instead of
 * erroring if one's already in flight — see migration
 * 00000000000020) — this function only performs the pick when the round
 * doesn't already have one (`is_current` false on every returned
 * candidate), so a second/third call never re-decides an already-decided
 * round. A withdrawn/declined winner's fallback to the next-ranked
 * candidate is handled entirely by `withdraw_speaker_request(_as_guest)`
 * itself (same frozen `rank` order, migration 00000000000019) — this
 * function only ever makes the *first* pick for a freshly frozen round.
 *
 * Exported (not just used internally by `resolveClaimDecision`) so
 * `simulator-actions.ts`'s `simulateAdvanceSelection` can trigger the
 * exact same freeze/pick — the Session Simulator has no real per-candidate
 * browser tab to poll `checkPromotionEligibility` on a simulated
 * identity's own behalf (see that function's own doc comment), but the
 * freeze/pick step itself is identity-agnostic and needs no adapter at
 * all to reuse directly.
 *
 * **Issue #21, fifth corrective pass: seat-aware, not "pick one winner
 * for the event."** A real-device pass found the stage stuck on
 * "Selecting next speaker…" on *both* seats for far too long even with
 * two already-voted-for eligible candidates in the pool — traced to the
 * old event-wide "at most one current candidate" model: with two seats
 * open at once, only one candidate could ever be reserved, and claiming
 * a seat wiped every other pending request (including the second seat's
 * own legitimate candidate) via `resetSpeakerCandidatePool`'s bulk
 * reset. This now reserves a *distinct* candidate for every currently
 * open seat, per Section 3's explicit "rank the pool, reserve #1 for
 * seat A, reevaluate the remaining pool, reserve the next-highest for
 * seat B." Never selects the same request for both seats, and never
 * re-picks a seat that's already got a live reservation from an earlier
 * call (idempotent — safe to call on every poll).
 *
 * **Section 4: the reservation decision itself is one atomic,
 * server-side call** (`reserveSpeakerCandidatesForSeats`, migration
 * 00000000000036), not a TypeScript loop making one RPC call per seat —
 * seat 1's own decision doesn't have to trust that seat 2's concurrent
 * decision (from a *different* connected client's own reconciliation
 * poll landing at the same moment) won't independently pick the same
 * top-ranked candidate for a different seat. See that migration's own
 * doc comment for the exact race this closes.
 *
 * **Takes `activeSpeakers` as a parameter, not a self-fetch**: every real
 * caller (`resolveClaimDecision` below, `simulator-actions.ts`'s
 * `simulateAdvanceSelection`) already has a fresh occupancy read of its
 * own by the time it needs this — re-fetching internally would mean a
 * second, redundant read on every call, and would force this function
 * onto one specific data-access tier (the request-scoped `listActiveSpeakers`)
 * that real-database tests calling this directly, outside any Next.js
 * request context, can't use at all (`cookies()` throws outside a
 * request scope). Passing it in keeps this function I/O-source-agnostic:
 * a real request's own `listActiveSpeakers`, the simulator's service-
 * client `listActiveSpeakersForSimulator`, or a bare test's own
 * `service.from("event_speakers_active")` read all work identically.
 */
export async function ensureActiveSelectionRound(eventId: string, activeSpeakers: Pick<EventSpeaker, "seat_number">[]): Promise<void> {
  const openSeats = findOpenSeats(activeSpeakers);
  if (openSeats.length === 0) return;

  const candidates = await freezeSpeakerCandidates(eventId);
  if (candidates.length === 0) return;

  await reserveSpeakerCandidatesForSeats(eventId, openSeats);
}

/**
 * The actual authorization decision, shared by `claimOpenSeat` (which
 * acts on it) and `checkPromotionEligibility` (issue #23, read-only —
 * the automatic-promotion countdown's "should I even start counting
 * down" check). Ensures a selection round exists for the current
 * opening, then reads whether the caller's own pending request is that
 * round's currently-selected candidate — see `lib/speaker-queue.ts`'s
 * `decideClaimEligibility` for the pure decision, and
 * `ensureActiveSelectionRound` above for how the round/pick itself gets
 * created. Extracted so the eligibility *check* the countdown polls and
 * the eligibility *enforcement* the actual claim performs can never
 * drift apart into two separately-maintained copies of the same rule.
 */
async function resolveClaimDecision(
  eventId: string,
  identity: SeatIdentity,
): Promise<{ decision: ClaimDecision; myRequestId: string | null }> {
  const activeSpeakers = await listActiveSpeakers(eventId);
  if (findOpenSeats(activeSpeakers).length > 0) {
    await ensureActiveSelectionRound(eventId, activeSpeakers);
  }

  const myRequest = await getPendingRequestForIdentity(eventId, identity);

  const decision = decideClaimEligibility({
    myPendingRequest: myRequest
      ? { is_current_candidate: myRequest.is_current_candidate, reserved_seat_number: myRequest.reserved_seat_number }
      : null,
    activeSpeakers,
  });

  return { decision, myRequestId: myRequest?.id ?? null };
}

/**
 * The actual authorization gate issues #13 and #3 both deferred to
 * "whatever Phase 3 builds" (issue #14), extended by issue #16 to
 * guests. Issue #23 removed this function's only remaining caller being
 * a manual "Claim your seat" click — it's now called automatically, at
 * the end of the automatic-promotion countdown (`useAutomaticPromotion`),
 * never by the user tapping anything. The authorization logic itself is
 * completely unchanged: only on a favorable decision does this call
 * `claimSpeakerSeat` (service client) on the caller's own behalf and
 * mark their request granted. The client never sees vote counts, ranks,
 * or who else is in the running — it only ever gets a pass/fail from
 * attempting this — and per issue #23's explicit requirement, the
 * countdown that leads up to this call is not itself an eligibility
 * mechanism, just client-side UX; this is still the one and only place
 * eligibility is actually decided and enforced.
 *
 * Issue #21, Phase 1 (selection now deterministic — third corrective
 * pass): with a selection round in play, there is at most *one* eligible
 * identity at a time (the round's
 * `is_current_candidate`) rather than the old top-3-race model's several
 * simultaneously-eligible requesters — the race-safety note below is
 * about `claim_speaker_seat`'s own unique-index protection against a
 * *different* kind of race (two seats opening near-simultaneously,
 * or a stale client retry), not about multiple candidates racing each
 * other for the same seat the way the old design allowed.
 *
 * Issue #17: requesting the mic is available from the moment the lobby
 * opens (see requestToSpeak above), but *claiming* a seat — actually
 * going live — is enforced here to require the event's scheduled start
 * to have arrived. This is server-enforced, not just a hidden button:
 * the unified event/room experience makes RoomControls reachable well
 * before "ready" now, so without this check, a claim during the waiting
 * phase would start the live conversation early, which the scheduled
 * start time exists to prevent.
 */
export async function claimOpenSeat(eventId: string): Promise<SpeakerRequestActionResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile" && !PROTOTYPE_CONFIG.guestParticipationEnabled) {
    return { error: "Create an account to request the mic." };
  }

  const event = await getEventById(eventId);
  if (!event || getEventPhase(event) !== "ready") {
    return { error: "The conversation hasn't started yet — hang tight." };
  }

  const { decision, myRequestId } = await resolveClaimDecision(eventId, identity);

  if (!decision.eligible) {
    return { error: CLAIM_REJECTION_MESSAGES[decision.reason] };
  }

  try {
    await claimSpeakerSeat(eventId, identity, decision.seatNumber, identity.displayName);
  } catch {
    return { error: "That seat was just taken — try again." };
  }

  // decision.eligible implies myPendingRequest was non-null, which
  // implies myRequestId is non-null — decideClaimEligibility only sees
  // is_current_candidate, not the row itself, so TypeScript can't
  // correlate the two on its own.
  await markSpeakerRequestGranted(myRequestId!);
  await syncPublishPermission({ eventId, identity, canPublish: true });

  // Issue #21, Phase 1, Section E: the authoritative, race-safe pool
  // reset — every other still-pending request for this event ends here,
  // not just the winner's, and every request vote is cleared. Runners-up
  // do not remain automatically queued; anyone who still wants to speak
  // (including the speaker who just left, once they do) must submit a
  // fresh request afterward. Called after markSpeakerRequestGranted (not
  // before) so the winner's own row is already 'granted', not 'pending',
  // when reset_speaker_candidate_pool excludes it from the bulk expiry.
  await resetSpeakerCandidatePool(eventId, myRequestId!);

  return { ok: true };
}

export type PromotionEligibilityResult = { eligible: boolean };

/**
 * Issue #23: read-only — never claims anything, never mutates state.
 * `useAutomaticPromotion` polls this while a candidate has a pending
 * request, to decide whether to start the "You're up next" countdown.
 * Explicitly *not* an eligibility mechanism itself (the countdown that
 * follows a `true` result is pure client-side UX) — this just answers
 * the same question `claimOpenSeat` independently re-answers for real at
 * the end of that countdown, via the exact same shared decision
 * (`resolveClaimDecision`), so the two can never disagree about what
 * "eligible" means, only about *when* each happens to ask.
 */
export async function checkPromotionEligibility(eventId: string): Promise<PromotionEligibilityResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile" && !PROTOTYPE_CONFIG.guestParticipationEnabled) {
    return { eligible: false };
  }

  const event = await getEventById(eventId);
  if (!event || getEventPhase(event) !== "ready") {
    return { eligible: false };
  }

  const { decision } = await resolveClaimDecision(eventId, identity);
  return { eligible: decision.eligible };
}

export type JoinOpenSeatResult =
  | { ok: true }
  | { ok: false; reason: "queue-exists" }
  /**
   * Issue #18 real-device finding (2026-08-27): a distinct, typed
   * reason — not folded into the generic `"error"` string case — because
   * this one means something structurally different: the server just
   * proved (via `getActiveSeatForIdentity`, the same expiration-aware
   * check `mintLiveKitToken` uses) that this identity already owns an
   * active seat, at the exact moment the caller believed otherwise
   * (`handleTapEmptySeat` only ever calls this when the client's own
   * `isSpeaker` was false). That's a genuine contradiction between the
   * server's authoritative state and this client's accumulated
   * `useActiveSpeakers` state, not an ordinary rejection — carrying
   * `seatNumber` lets the caller reconcile immediately instead of
   * leaving the user stuck on a dead-end error. See `EventRoom`'s own
   * handling of this reason.
   */
  | { ok: false; reason: "already-speaking"; seatNumber: 1 | 2 }
  /**
   * Issue #21, third corrective pass (real-device finding): once the
   * event's stage has ever achieved its initial two-speaker pairing,
   * tapping a newly-empty seat can no longer claim it directly — that
   * seat is controlled by Request-to-Speak selection now, not first-tap.
   * A distinct, typed reason (not folded into `queue-exists`, even
   * though the caller's own UI currently treats them the same way —
   * falling back to the composer's request mode) because they mean
   * different things: `queue-exists` is "other people are already
   * waiting, join the queue too"; this is "direct joins are never
   * available here anymore, regardless of queue length." See
   * `isStageEstablished` (lib/repositories/stage-rounds.ts) for the
   * authoritative signal, and migration 00000000000029's
   * `claim_speaker_seat` for the actual, database-level enforcement this
   * check exists only to give a clean early message for — a client that
   * somehow reached the claim below anyway would still be rejected
   * there, never trusted based on this check alone.
   */
  | { ok: false; reason: "selection-required" }
  /**
   * Issue #21, fifth corrective pass, Section 10: the small-room
   * fallback (both seats empty, zero eligible requests) is open, but
   * this identity is one of the speaker(s) just removed the last time
   * both seats went empty — ineligible to reclaim a fallback seat for
   * *this* recovery cycle specifically (not a ban: they can still
   * comment, vote, and submit a fresh Request-to-Speak — see Section
   * 11). `claim_speaker_seat` (migration 00000000000033) is the actual
   * authority; this is a clean typed rejection for a check this action
   * doesn't need to duplicate to report accurately.
   */
  | { ok: false; reason: "fallback-excluded" }
  | { ok: false; reason: "error"; error: string };

/**
 * Issue #27: tapping a visibly empty seat tile when nobody is queued for
 * it. Deliberately a *different* entry point from `claimOpenSeat` above,
 * not a variant of it — that one exists specifically for a requester who
 * already went through ranking; this one exists specifically for when
 * there's no ranking to go through. No request message, no separate
 * claim step: one tap, one round-trip.
 *
 * **Only available during initial stage formation** (issue #21, third
 * corrective pass) — once the event's stage has ever achieved its
 * initial two-speaker pairing, this refuses outright regardless of
 * whether a seat happens to be empty right now (`isStageEstablished`,
 * checked before the queue-protection check below); an empty seat after
 * that point is controlled by Request-to-Speak selection
 * (`claimOpenSeat`), not this function. The database's own
 * `claim_speaker_seat` (migration 00000000000029) enforces the same rule
 * independently — this early check exists only for a clean typed
 * rejection, never as the actual authority.
 *
 * Queue protection is the second point of this function, checked here
 * server-side (never trusted from the client): if *any* pending
 * `speaker_requests` exist for the event, this refuses outright and
 * returns `"queue-exists"` — the caller (the empty tile's tap handler)
 * is expected to fall back to the composer's mic-request mode instead,
 * but even a client that skipped that fallback and called this directly
 * would still be refused here, since the check happens before any seat
 * is touched.
 *
 * Reuses `claimSpeakerSeat` exactly as `claimOpenSeat` does — no new
 * database-level primitive. Two simultaneous taps on the same genuinely
 * empty seat still resolve to exactly one winner via
 * `event_speakers_active_seat_uniq` (migration 00000000000005), the same
 * partial unique index every other seat-claim path already relies on;
 * the loser's `claimSpeakerSeat` call throws and this returns a plain
 * "try again" error, never a silent overwrite.
 */
export async function joinOpenSeat(eventId: string): Promise<JoinOpenSeatResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile" && !PROTOTYPE_CONFIG.guestParticipationEnabled) {
    return { ok: false, reason: "error", error: "Create an account to join as a speaker." };
  }

  const event = await getEventById(eventId);
  if (!event || getEventPhase(event) !== "ready") {
    return { ok: false, reason: "error", error: "The conversation hasn't started yet — hang tight." };
  }

  const alreadySeated = await getActiveSeatForIdentity(eventId, identity);
  if (alreadySeated) {
    return { ok: false, reason: "already-speaking", seatNumber: alreadySeated.seat_number };
  }

  const [activeSpeakers, ranked] = await Promise.all([
    listActiveSpeakers(eventId),
    rankPendingSpeakerRequests(eventId),
  ]);

  if (await isStageEstablished(eventId)) {
    // Issue #21, fifth corrective pass, Sections 8-15: the small-room
    // fallback — a direct join is legal again in exactly one established-
    // stage case: both seats empty AND nobody eligible to select from.
    // Any other established-stage empty seat stays selection-controlled.
    if (activeSpeakers.length > 0 || ranked.length > 0) {
      return { ok: false, reason: "selection-required" };
    }
    const seatNumber = findOpenSeat(activeSpeakers) ?? 1; // both empty, confirmed above
    try {
      await claimSpeakerSeat(eventId, identity, seatNumber, identity.displayName);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("recently removed")) {
        return { ok: false, reason: "fallback-excluded" };
      }
      return { ok: false, reason: "error", error: "That seat was just taken — try again." };
    }
    await syncPublishPermission({ eventId, identity, canPublish: true });
    return { ok: true };
  }

  // Initial stage formation — unchanged. The actual queue-protection
  // check (see this function's own doc comment), checked before
  // touching any seat, not after.
  if (ranked.length > 0) {
    return { ok: false, reason: "queue-exists" };
  }

  const seatNumber = findOpenSeat(activeSpeakers);
  if (seatNumber === null) {
    return { ok: false, reason: "error", error: "Both seats are currently full." };
  }

  try {
    await claimSpeakerSeat(eventId, identity, seatNumber, identity.displayName);
  } catch {
    return { ok: false, reason: "error", error: "That seat was just taken — try again." };
  }

  await syncPublishPermission({ eventId, identity, canPublish: true });
  return { ok: true };
}

export type ComposerRequestState = { error: string } | undefined;

/**
 * Thin `useActionState`-shaped adapter over `requestToSpeak` above — same
 * business logic, same authoritative path (`request_to_speak`/
 * `request_to_speak_as_guest`), just matching the `(prevState, formData)`
 * calling convention the composer's mic-request mode needs, the same way
 * `sendMessage` (lobby/actions.ts) already does for normal chat. No logic
 * duplicated here; this only unwraps a `FormData` and re-shapes the
 * result.
 */
export async function submitSpeakerRequest(
  eventId: string,
  _prevState: ComposerRequestState,
  formData: FormData,
): Promise<ComposerRequestState> {
  const body = String(formData.get("body") ?? "");
  const result = await requestToSpeak(eventId, body);
  return "error" in result ? { error: result.error } : undefined;
}

export type CheckSpeakerReconnectResult = { evicted: boolean };

/**
 * Issue #18 unified inactive-speaker finding: the server-authoritative
 * half of the speaker inactivity grace period — for *either* cause. The
 * LiveKit webhook (api/livekit/webhook/route.ts) starts/clears the
 * connection half of the clock (`disconnected_at`); the speaker's own
 * client starts/clears the media half (`reportSpeakerMediaInactive`/
 * `reportSpeakerMediaActive`, below) — this function is what actually
 * *releases* the seat, once either clock genuinely clears
 * `SPEAKER_DISCONNECT_GRACE_SECONDS`.
 *
 * **Called by a connected client's local estimate, never trusted
 * directly**: `useSpeakerReconnectGrace` schedules this call once it
 * expects the grace period to have elapsed for a seat it's watching —
 * but the actual release decision is `release_expired_inactive_speaker`'s
 * (migration 00000000000017), a single atomic `UPDATE ... WHERE ...`
 * that re-derives "has the grace period really elapsed, for either
 * cause" from Postgres's own clock and the row's own `disconnected_at`/
 * `media_inactive_since`, every time. A caller invoking this early,
 * repeatedly, or against a speaker who already recovered (either way)
 * can never force an eviction — the WHERE clause simply doesn't match,
 * and this returns `{ evicted: false }`. Idempotent — multiple viewers'
 * independent timers firing around the same moment just mean the first
 * one to actually clear the threshold wins; every later call finds the
 * seat already vacated and no-ops too.
 */
export async function checkAndEvictInactiveSpeaker(
  eventId: string,
  seatIdentity: SeatIdentity,
): Promise<CheckSpeakerReconnectResult> {
  const released = await releaseExpiredInactiveSpeaker(eventId, seatIdentity, SPEAKER_DISCONNECT_GRACE_SECONDS);
  if (released) {
    // Issue #18 expiration-enforcement finding: ARCHITECTURE.md's LiveKit
    // authorization model is explicit that a speaker losing their seat
    // needs publish rights revoked immediately, not left to their next
    // token request — this is that live push, for the eviction path
    // specifically (every other eviction path already had it). Best
    // effort, matching syncPublishPermission's own contract: if this
    // identity isn't currently connected, or the push fails, nothing is
    // left wrong — getActiveSeatForIdentity (now expiration-aware, see
    // migration 00000000000018) already makes their *next* token request
    // self-correct to canPublish: false regardless.
    await syncPublishPermission({ eventId, identity: seatIdentity, canPublish: false });
  }
  return { evicted: released !== null };
}

/**
 * Issue #18 expiration-enforcement finding: the returning speaker's own
 * confirmation trigger — called by their own client the instant its
 * local countdown reaches zero, so an identity that's otherwise alone in
 * the room (no co-speaker or audience member around to schedule
 * `checkAndEvictInactiveSpeaker` on their behalf — `useSpeakerReconnectGrace`
 * deliberately never watches the viewer's own seat) still gets its
 * expiration confirmed promptly instead of waiting on some other
 * client's timer. Resolves the caller's own identity server-side, same
 * self-service pattern as `leaveSpeakerSeat` — the client asserts
 * nothing about *whether* it's expired, only *that it wants the current
 * state confirmed*; `releaseExpiredInactiveSpeaker`'s own atomic
 * re-derivation from Postgres's clock is what actually decides. Calling
 * this before the real deadline, or after the seat is already released
 * (or was never held), is a harmless no-op — same idempotency guarantee
 * as `checkAndEvictInactiveSpeaker`.
 */
export async function confirmOwnSeatExpiration(eventId: string): Promise<CheckSpeakerReconnectResult> {
  const identity = await resolveIdentity();
  return checkAndEvictInactiveSpeaker(eventId, identity);
}

/**
 * Issue #18 unified inactive-speaker finding: starts the media half of
 * the inactivity grace period — called by the speaker's own connected
 * client the instant it observes itself publishing no usable media at
 * all (both camera and mic off/muted, or never activated — see
 * `isLocalMediaInactive`, `lib/speaker-presence.ts`). Resolves the
 * caller's identity server-side, same as every other action here — the
 * client only asserts *that* it's currently media-inactive, never *whose*
 * seat to touch. Idempotent (a duplicate report never restarts the
 * clock) and a safe no-op for a caller with no active seat.
 */
export async function reportSpeakerMediaInactive(eventId: string): Promise<void> {
  const identity = await resolveIdentity();
  await markSpeakerMediaInactive(eventId, identity);
}

/**
 * Clears the media half of the inactivity grace period — called by the
 * speaker's own connected client the instant either camera or
 * microphone becomes active again (either alone is enough).
 */
export async function reportSpeakerMediaActive(eventId: string): Promise<void> {
  const identity = await resolveIdentity();
  await markSpeakerMediaActive(eventId, identity);
}

/**
 * Issue #21, Part 2: casts/changes the caller's one active Continue/
 * Replace vote for a specific seated speaker's current round.
 * `eventSpeakersId` (not a seat number) is what the vote actually keys
 * on — the client already has it via `RoomLayoutProps.speakers[].id`,
 * the same row every other piece of speaker state already reads from.
 * Rejected server-side once the round has moved to 'closing' (see
 * `castSpeakerRoundVote`'s own doc comment) — this action just surfaces
 * that as a friendly result instead of throwing.
 */
export async function voteOnSpeakerRound(
  eventSpeakersId: string,
  choice: "continue" | "replace",
): Promise<{ ok: true } | { error: string }> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile" && !PROTOTYPE_CONFIG.guestParticipationEnabled) {
    return { error: "Create an account to vote." };
  }
  try {
    if (identity.type === "profile") {
      await castSpeakerRoundVote(eventSpeakersId, choice);
    } else {
      await castSpeakerRoundVoteAsGuest(eventSpeakersId, choice, identity.id);
    }
    return { ok: true };
  } catch {
    return { error: "Couldn't record your vote. Try again." };
  }
}

/**
 * Issue #21 corrective pass: triggers the one authoritative resolution
 * of the *shared* round deadline for a stage pairing — see
 * `resolveStageRound` (lib/repositories/stage-rounds.ts) for what this
 * actually decides (both occupied seats' Continue/Replace outcomes,
 * independently, against the one shared deadline). Called from
 * `useStageRoundResolution`'s scheduled deadline timer, by *any*
 * connected client — never trusted to run on its own schedule, always
 * safe to call early/late/repeatedly.
 *
 * On a replacement outcome (`decisive-replace`) for a given seat,
 * immediately revokes that departing speaker's LiveKit publish rights —
 * the same "instant revoke, not left to their next token request"
 * discipline every other eviction path in this app already follows
 * (`checkAndEvictInactiveSpeaker`).
 *
 * **Issue #21, ninth corrective pass: also directly triggers candidate
 * selection for the seat(s) it just vacated, in this same call.** A
 * real-device pass found "Selecting next speaker…" taking noticeably
 * longer than intentional at exactly the round boundary; tracing found
 * this action had never itself called `ensureActiveSelectionRound` at
 * all — the old doc comment here (see git history) described the seat
 * becoming open as "picked up... the next time any client polls
 * `checkPromotionEligibility`," which undersold even what was true by
 * the fifth pass: `useSpeakerSelectionReconciliation` reactively
 * re-triggers selection in every connected client once *their own*
 * `speakers` state reflects the new vacancy — but reaching that point
 * still requires a full Realtime round trip (this write → every
 * client's own `event_speakers` subscription delivering it → a React
 * effect firing → a *second*, separate Server Action call) before
 * selection is even attempted, on top of whatever the reservation
 * itself then takes. Calling `ensureActiveSelectionRound` here, in the
 * same request that authoritatively knows the seat just vacated, closes
 * that entire chain — reservation for a round-boundary replacement no
 * longer waits on any client's own Realtime subscription or React
 * effect to get started. `useSpeakerSelectionReconciliation` is
 * unchanged and remains exactly what it already was: the bounded
 * backstop for a missed Realtime delta or a resolution triggered by a
 * since-disconnected client, not the primary trigger. Never a second,
 * competing selection *path* — this calls the exact same idempotent,
 * atomically-locked function reconciliation already calls; doing so
 * from the authoritative moment instead of only reactively-afterward
 * cannot introduce a new race, since the underlying RPC's own
 * row-locking is what already makes concurrent callers safe.
 */
export async function resolveStageRoundAction(eventId: string): Promise<Array<{ eventSpeakersId: string; outcome: SeatResolutionOutcome }>> {
  const results = await resolveStageRound(eventId);
  for (const result of results) {
    if (result.outcome === "decisive-replace") {
      await syncPublishPermission({ eventId, identity: result.identity, canPublish: false });
    }
  }
  if (results.some((r) => r.outcome === "decisive-replace")) {
    await ensureActiveSelectionRound(eventId, await listActiveSpeakersAuthoritative(eventId));
  }
  return results.map((r) => ({ eventSpeakersId: r.eventSpeakersId, outcome: r.outcome }));
}

/**
 * The individual-narrow-loss-speaker equivalent — see
 * `resolveSeatClosing` (lib/repositories/stage-rounds.ts). Same
 * "any connected client, always safe to call early/late/repeatedly"
 * shape, and the same instant-publish-revoke discipline: a closing-
 * period expiry is always a replacement (never any other outcome), so
 * the revoke happens whenever this actually resolved something. Returns
 * whether it did (`false` for the ordinary no-op case: not yet expired,
 * or no such closing seat) — used by the Session Simulator's "Force
 * Replace Now" to report accurate feedback without a second fetch.
 *
 * **Issue #21, ninth corrective pass**: same direct-selection-trigger
 * fix as `resolveStageRoundAction` above, for the Final-30/closing-
 * period boundary specifically — see that function's own doc comment
 * for the full reasoning.
 */
export async function resolveSeatClosingAction(eventSpeakersId: string): Promise<boolean> {
  const result = await resolveSeatClosing(eventSpeakersId);
  if (result) {
    await syncPublishPermission({ eventId: result.eventId, identity: result.identity, canPublish: false });
    await ensureActiveSelectionRound(result.eventId, await listActiveSpeakersAuthoritative(result.eventId));
  }
  return result !== null;
}

/**
 * Issue #21, fourth corrective pass: the client-side reactive backstop
 * for the shared-round invariant — "a normal shared round may exist and
 * count down only while the stage's two-speaker pairing is actually
 * established" (`ensure_stage_round`, migration 00000000000024, is the
 * authoritative enforcement; this just makes sure it actually gets
 * called whenever it matters). Every production seat-claim/seat-vacate
 * RPC already triggers `ensure_stage_round` as a side effect
 * (`claimSpeakerSeat`, `leaveSpeakerSeat(AsGuest)`, eviction) — this
 * exists for the gap a real-device pass found: any client whose own view
 * of occupancy just changed re-verifies the invariant directly, rather
 * than trusting that whichever server path changed it already reconciled
 * the round. Idempotent and safe from every connected client
 * simultaneously (`ensure_stage_round` itself is), same as
 * `resolveStageRoundAction` above. See `useStageRoundReconciliation`
 * (hooks/use-stage-round-reconciliation.ts) for the client-side trigger.
 */
export async function reconcileStageRoundAction(eventId: string): Promise<void> {
  await ensureStageRound(eventId);
}

/**
 * Issue #21, fifth corrective pass, Section 6: the bounded-recovery
 * backstop for candidate selection/reservation — same reasoning as
 * `reconcileStageRoundAction` above, for a different invariant.
 * Selection is normally event-driven: `ensureActiveSelectionRound` is
 * triggered whenever an eligible candidate's own client polls
 * `checkPromotionEligibility`, or a claim is attempted. That relies on
 * *some* eligible candidate's tab actually being the one to poll — a
 * real gap if every candidate's tab happens to be backgrounded/closed
 * right when a seat opens, or a partially-failed transition left a seat
 * open with an eligible pool nobody has re-evaluated yet. Any connected
 * client (not just a waiting candidate) calling this whenever its own
 * view of occupancy or the pending-request pool changes closes that gap
 * — idempotent and safe from every connected client simultaneously, the
 * same "any connected client can be the one whose action fires"
 * precedent `useStageRoundResolution`/`useStageRoundReconciliation`
 * already established. Never a blind timer: this re-derives from actual
 * current state every time, exactly like the function it calls.
 */
export async function reconcileSpeakerSelectionAction(eventId: string): Promise<void> {
  const activeSpeakers = await listActiveSpeakers(eventId);
  if (findOpenSeats(activeSpeakers).length === 0) return;
  await ensureActiveSelectionRound(eventId, activeSpeakers);
}
