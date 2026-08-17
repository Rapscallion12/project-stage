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
} from "@/lib/repositories/event-speakers";
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
import { decideClaimEligibility } from "@/lib/speaker-queue";

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

/** Self-service withdrawal of the caller's own pending request (issue #14), extended to guests by issue #16 the same way requestToSpeak was. */
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
 * The actual authorization gate issues #13 and #3 both deferred to
 * "whatever Phase 3 builds" (issue #14), extended by issue #16 to guests.
 * Fetches current state, hands it to `decideClaimEligibility` (the
 * actual, unit-tested decision — see lib/speaker-queue.ts for the
 * top-3-not-top-1 reasoning), and only on a favorable decision calls
 * `claimSpeakerSeat` (service client) on the caller's own behalf and
 * marks their request granted. The client never sees ranking data; it
 * only ever gets a pass/fail from attempting this.
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

  if (!decision.eligible) {
    return { error: CLAIM_REJECTION_MESSAGES[decision.reason] };
  }

  try {
    await claimSpeakerSeat(eventId, identity, decision.seatNumber, identity.displayName);
  } catch {
    return { error: "That seat was just taken — try again." };
  }

  // decision.eligible implies hasPendingRequest was true, which implies
  // myRequest is non-null — decideClaimEligibility only sees the boolean,
  // not the row itself, so TypeScript can't correlate the two on its own.
  await markSpeakerRequestGranted(myRequest!.id);
  await syncPublishPermission({ eventId, identity, canPublish: true });

  return { ok: true };
}
