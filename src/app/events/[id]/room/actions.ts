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
  markSpeakerMediaActive,
  markSpeakerMediaInactive,
  releaseExpiredInactiveSpeaker,
} from "@/lib/repositories/event-speakers";
import type { SeatIdentity } from "@/lib/repositories/event-speakers";
import { findOpenSeat } from "@/lib/speaker-queue";
import {
  getPendingRequestForIdentity,
  markSpeakerRequestGranted,
  rankPendingSpeakerRequests,
  requestToSpeak as requestToSpeakRow,
  requestToSpeakAsGuest,
  withdrawSpeakerRequest as withdrawSpeakerRequestRow,
  withdrawSpeakerRequestAsGuest,
} from "@/lib/repositories/speaker-requests";
import { mintLiveKitToken } from "@/lib/livekit/token";
import { syncPublishPermission } from "@/lib/livekit/permissions";
import { decideClaimEligibility, type ClaimDecision } from "@/lib/speaker-queue";
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

const CLAIM_REJECTION_MESSAGES = {
  "no-request": "You don't have an active request to speak.",
  "no-open-seat": "Both seats are currently full.",
  "not-eligible": "Other requests currently have more support than yours — keep an eye on reactions.",
} as const;

/**
 * The actual authorization decision, shared by `claimOpenSeat` (which
 * acts on it) and `checkPromotionEligibility` (issue #23, read-only —
 * the automatic-promotion countdown's "should I even start counting
 * down" check). Fetches current state and hands it to
 * `decideClaimEligibility` (the pure, unit-tested decision — see
 * lib/speaker-queue.ts for the top-3-not-top-1 reasoning). Extracted so
 * the eligibility *check* the countdown polls and the eligibility
 * *enforcement* the actual claim performs can never drift apart into two
 * separately-maintained copies of the same rule.
 */
async function resolveClaimDecision(
  eventId: string,
  identity: SeatIdentity,
): Promise<{ decision: ClaimDecision; myRequestId: string | null }> {
  const [myRequest, activeSpeakers, ranked] = await Promise.all([
    getPendingRequestForIdentity(eventId, identity),
    listActiveSpeakers(eventId),
    rankPendingSpeakerRequests(eventId),
  ]);

  const decision = decideClaimEligibility({
    identity,
    hasPendingRequest: myRequest !== null,
    activeSpeakers,
    rankedRequests: ranked,
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
 * mark their request granted. The client never sees ranking data; it
 * only ever gets a pass/fail from attempting this — and per issue #23's
 * explicit requirement, the countdown that leads up to this call is not
 * itself an eligibility mechanism, just client-side UX; this is still
 * the one and only place eligibility is actually decided and enforced.
 *
 * Not re-checking seat availability a second time immediately before
 * `claimSpeakerSeat` — `claim_speaker_seat`'s own unique-index race
 * safety (issue #13) is the real backstop if two eligible requesters
 * attempt this at nearly the same moment; the bounded, benign outcome
 * (whichever call lands second replaces the first) is accepted, same
 * reasoning issue #13's own race-safety test documents.
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

  // decision.eligible implies hasPendingRequest was true, which implies
  // myRequestId is non-null — decideClaimEligibility only sees the
  // boolean, not the row itself, so TypeScript can't correlate the two
  // on its own.
  await markSpeakerRequestGranted(myRequestId!);
  await syncPublishPermission({ eventId, identity, canPublish: true });

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
  | { ok: false; reason: "error"; error: string };

/**
 * Issue #27: tapping a visibly empty seat tile when nobody is queued for
 * it. Deliberately a *different* entry point from `claimOpenSeat` above,
 * not a variant of it — that one exists specifically for a requester who
 * already went through ranking; this one exists specifically for when
 * there's no ranking to go through. No request message, no separate
 * claim step: one tap, one round-trip.
 *
 * Queue protection is the actual point of this function, checked here
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

  // The actual queue-protection check — see this function's own doc
  // comment. Checked before touching any seat, not after.
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
