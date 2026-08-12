"use server";

import { resolveIdentity } from "@/lib/identity";
import {
  claimSpeakerSeat,
  getActiveSeatForProfile,
  leaveSpeakerSeat as leaveSpeakerSeatRow,
  listActiveSpeakers,
} from "@/lib/repositories/event-speakers";
import {
  getPendingRequestForProfile,
  markSpeakerRequestGranted,
  rankPendingSpeakerRequests,
  requestToSpeak as requestToSpeakRow,
  withdrawSpeakerRequest as withdrawSpeakerRequestRow,
} from "@/lib/repositories/speaker-requests";
import { mintLiveKitToken } from "@/lib/livekit/token";
import { syncPublishPermission } from "@/lib/livekit/permissions";
import { decideClaimEligibility } from "@/lib/speaker-queue";

export type GetLiveKitTokenResult = { token: string } | { error: string };

/**
 * Mints a LiveKit access token scoped to the caller's *current*
 * `event_speakers` occupancy — never trusts anything the client sends to
 * decide `canPublish`. Guests always come back `canPublish: false`
 * (structurally: `event_speakers` is account-only, so a guest can never
 * have an active seat — see migration 00000000000005). Changing an
 * already-connected participant's permissions in real time (so a
 * replaced speaker loses publish rights immediately, not just on their
 * next token request) is issue #13's concern, not this one — see
 * DECISIONS.md's authorization-model entry for the split and why.
 */
export async function getLiveKitToken(eventId: string): Promise<GetLiveKitTokenResult> {
  const identity = await resolveIdentity();

  const activeSeat = identity.type === "profile" ? await getActiveSeatForProfile(eventId, identity.id) : null;

  try {
    const token = await mintLiveKitToken({ eventId, identity, activeSeat });
    return { token };
  } catch {
    return { error: "Couldn't connect to the live room. Try again." };
  }
}

export type LeaveSpeakerSeatResult = { ok: true } | { error: string };

/**
 * Ends the caller's own active speaker occupancy (issue #13's voluntary-
 * leave path, self-service and `auth.uid()`-gated all the way down to
 * Postgres — see `leave_speaker_seat` in migration 00000000000006) and
 * best-effort pushes `canPublish: false` to their already-connected
 * LiveKit participant so the change is visible immediately, not just on
 * their next token request. No UI calls this yet (issue #3/#6 build the
 * room's "leave the stage" control) — ships as a tested primitive, same
 * pattern as `getLiveKitToken` above.
 */
export async function leaveSpeakerSeat(eventId: string): Promise<LeaveSpeakerSeatResult> {
  try {
    const row = await leaveSpeakerSeatRow(eventId);
    await syncPublishPermission({ eventId, profileId: row.profile_id, canPublish: false });
    return { ok: true };
  } catch {
    return { error: "Couldn't leave the stage. Try again." };
  }
}

export type SpeakerRequestActionResult = { ok: true } | { error: string };

/**
 * Submits a mic request (issue #14) — atomically posts a chat message and
 * a `speaker_requests` row via `request_to_speak` (migration
 * 00000000000011), never two independent writes. Guests get the exact
 * PRODUCT.md-scripted prompt, never a generic wall.
 *
 * Error messages are matched against `request_to_speak`'s own
 * `raise exception` text — a real coupling to that migration's wording,
 * accepted for now rather than duplicating the same guards in
 * TypeScript (which would just be a second place for them to drift out
 * of sync with the actual, authoritative check).
 */
export async function requestToSpeak(eventId: string, body: string): Promise<SpeakerRequestActionResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    return { error: "Create an account to request the mic." };
  }

  const trimmed = body.trim();
  if (!trimmed) {
    return { error: "Say a bit about why you'd like the mic." };
  }

  try {
    await requestToSpeakRow(eventId, trimmed);
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

/** Self-service withdrawal of the caller's own pending request (issue #14). */
export async function withdrawSpeakerRequest(eventId: string): Promise<SpeakerRequestActionResult> {
  try {
    await withdrawSpeakerRequestRow(eventId);
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
 * The actual authorization gate issues #13 and #3 both deferred to
 * "whatever Phase 3 builds" (issue #14). Fetches current state, hands it
 * to `decideClaimEligibility` (the actual, unit-tested decision — see
 * lib/speaker-queue.ts for the top-3-not-top-1 reasoning), and only on a
 * favorable decision calls `claimSpeakerSeat` (service client) on the
 * caller's own behalf and marks their request granted. The client never
 * sees ranking data; it only ever gets a pass/fail from attempting this.
 *
 * Not re-checking seat availability a second time immediately before
 * `claimSpeakerSeat` — `claim_speaker_seat`'s own unique-index race
 * safety (issue #13) is the real backstop if two eligible requesters
 * attempt this at nearly the same moment; the bounded, benign outcome
 * (whichever call lands second replaces the first) is accepted, same
 * reasoning issue #13's own race-safety test documents.
 */
export async function claimOpenSeat(eventId: string): Promise<SpeakerRequestActionResult> {
  const identity = await resolveIdentity();
  if (identity.type !== "profile") {
    return { error: "Create an account to request the mic." };
  }

  const [myRequest, activeSpeakers, ranked] = await Promise.all([
    getPendingRequestForProfile(eventId, identity.id),
    listActiveSpeakers(eventId),
    rankPendingSpeakerRequests(eventId),
  ]);

  const decision = decideClaimEligibility({
    profileId: identity.id,
    hasPendingRequest: myRequest !== null,
    activeSpeakers,
    rankedRequests: ranked,
  });

  if (!decision.eligible) {
    return { error: CLAIM_REJECTION_MESSAGES[decision.reason] };
  }

  try {
    await claimSpeakerSeat(eventId, identity.id, decision.seatNumber);
  } catch {
    return { error: "That seat was just taken — try again." };
  }

  // decision.eligible implies hasPendingRequest was true, which implies
  // myRequest is non-null — decideClaimEligibility only sees the boolean,
  // not the row itself, so TypeScript can't correlate the two on its own.
  await markSpeakerRequestGranted(myRequest!.id);
  await syncPublishPermission({ eventId, profileId: identity.id, canPublish: true });

  return { ok: true };
}
