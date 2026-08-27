import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Plain domain type, not aliased from the generated `Database` type (see
 * ARCHITECTURE.md's Vendor portability section) — `left_reason` is a
 * Postgres CHECK-constrained text column, not a native enum, so the
 * generator can't express its vocabulary as a TypeScript union. This is
 * the one place that vocabulary is typed; keep it in sync with the
 * `left_reason` CHECK in migration 00000000000005.
 */
export type LeftReason = "voluntary" | "replaced" | "moderator_removed" | "event_ended" | "disconnected" | "inactive";

/**
 * Minimal identity shape this repository needs — not imported from
 * `lib/identity.ts` to avoid coupling this data-access layer to that
 * module's auth/cookie concerns. Same pattern `lib/repositories/chat.ts`
 * already established for guest vs. account authorship.
 */
export type SeatIdentity = { type: "profile" | "guest"; id: string };

export type EventSpeaker = {
  id: string;
  event_id: string;
  /**
   * Exactly one of profile_id/guest_id is set (issue #16's prototype-
   * testing exception to the account-only speaking rule — see
   * PRODUCT.md and DECISIONS.md; governed by
   * `PROTOTYPE_CONFIG.guestParticipationEnabled`). Enforced in Postgres
   * by `event_speakers_exactly_one_identity` (migration 00000000000012),
   * not just convention here.
   */
  profile_id: string | null;
  guest_id: string | null;
  seat_number: 1 | 2;
  /**
   * A denormalized snapshot of the occupant's display name at the moment
   * claim_speaker_seat assigned this seat (migration 00000000000010,
   * extended for guests in 00000000000012) — not a live join. Guests
   * can't read `profiles` (RLS grants select to authenticated only), so
   * the room's speaker display renders entirely from event_speakers;
   * this is what makes that possible without exposing profiles to anon.
   * profile_id/guest_id remain the durable identity reference for
   * everything else (auth checks, uniqueness, joins) — display_name is
   * presentation-only.
   */
  display_name: string;
  joined_at: string;
  left_at: string | null;
  left_reason: LeftReason | null;
  /**
   * Issue #18 UX finding: when this identity's LiveKit connection was
   * last observed dropping (set by the webhook's `participant_left`
   * handler via `markSpeakerDisconnected`), or null while actively
   * connected / already released. The server-authoritative grace-period
   * clock — see migration 00000000000016 and `checkAndEvictInactiveSpeaker`
   * (room/actions.ts). Flows through Realtime like every other column
   * here, so `useSpeakerReconnectGrace` can derive "who's currently in
   * a disconnect grace window" directly from already-subscribed
   * `speakers` state, no separate signal needed.
   */
  disconnected_at: string | null;
  /**
   * Issue #18 unified inactive-speaker finding: when this identity's own
   * connected client last observed itself publishing no usable media at
   * all (both camera and microphone off/muted — see
   * `isLocalMediaInactive`, `lib/speaker-presence.ts`), or null while
   * actively publishing something / already released. The server side of
   * the *other* half of "inactive" — see migration 00000000000017 and
   * this repository's `markSpeakerMediaInactive`. Never read directly by
   * a component; `lib/speaker-presence.ts`'s `inactiveSince`/
   * `deriveSpeakerPresence` are the one place this and `disconnected_at`
   * collapse into the single `speakerPresence` concept the UI uses.
   */
  media_inactive_since: string | null;
  /** Issue #21, Part 1: which protected 60-second block this is for the current occupant — 1 at claim time, incremented each time a round resolves to "continue". */
  round_number: number;
  round_started_at: string;
  /** Authoritative round deadline — see `resolve_speaker_round` (migration 00000000000021) and `useSpeakerRoundResolution`. Client countdowns display this; they never own it. */
  round_ends_at: string;
  /** 'active': normal round, voting open. 'closing': a narrow Replace loss already decided the outcome — this is the 30s grace period to finish speaking, not another survival vote. */
  round_phase: "active" | "closing";
  /** Set only while round_phase is 'closing' — the guaranteed-replacement deadline. */
  closing_ends_at: string | null;
};

export type SpeakerRoundVote = {
  id: string;
  event_speakers_id: string;
  voter_profile_id: string | null;
  voter_guest_id: string | null;
  choice: "continue" | "replace";
  created_at: string;
};

/**
 * Currently-occupied seats for an event. Still a plain read — the table
 * itself has no insert/update grant (see migration 00000000000005);
 * every write goes through one of the functions below instead, never a
 * direct `.insert()`/`.update()` here.
 *
 * Issue #18 expiration-enforcement finding: reads from
 * `event_speakers_active` (migration 00000000000018), not the base
 * table's own `left_at is null` — a row whose inactivity deadline has
 * already passed no longer counts as active here, even if it hasn't
 * been physically released yet. This is what `findOpenSeat`
 * (`room/actions.ts`) actually decides "is this seat open" from, so an
 * expired-but-not-yet-cleaned-up occupant no longer blocks a genuine new
 * claimant from being offered that seat.
 */
export async function listActiveSpeakers(eventId: string): Promise<EventSpeaker[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("event_speakers_active")
    .select("*")
    .eq("event_id", eventId)
    .order("seat_number", { ascending: true });
  return (data ?? []) as EventSpeaker[];
}

/**
 * Which of the given events currently have at least one active speaker —
 * used by the landing page's "Join Live Audience" fast path (issue #26)
 * to prefer a room that's actually live over one that's merely joinable.
 * Returns a set of ids, not full `EventSpeaker` rows: the caller only
 * needs "does this event qualify," not who's seated.
 */
export async function listEventIdsWithActiveSpeakers(eventIds: string[]): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const supabase = await createClient();
  const { data } = await supabase
    .from("event_speakers_active")
    .select("event_id")
    .in("event_id", eventIds);
  // event_id is NOT NULL on the base table; Supabase's type generator
  // just can't express that through a view — see this file's other view
  // reads for the same cast pattern.
  return new Set((data ?? []).map((row) => row.event_id as string));
}

/**
 * Whether — and in which seat — a specific identity (account or guest)
 * currently holds an active occupancy for an event. Used by the LiveKit
 * token endpoint (issues #2/#16) to decide `canPublish`; a targeted query
 * rather than filtering `listActiveSpeakers()` client-side, since it
 * expresses the actual question being asked.
 *
 * Issue #18 expiration-enforcement finding: reads from
 * `event_speakers_active` (migration 00000000000018), the same
 * expiration-aware view `listActiveSpeakers` uses, not the base table's
 * `left_at is null`. This is the exact check `mintLiveKitToken`'s
 * `determineCanPublish` runs on every token request (including a
 * returning speaker's "Tap to reconnect," which mints a fresh token on a
 * genuinely fresh page/tab) — an identity whose inactivity deadline has
 * already passed now correctly reads as having no active seat here, so
 * a stale reconnect can no longer be granted `canPublish: true` just
 * because the physical row hadn't been released yet.
 */
export async function getActiveSeatForIdentity(eventId: string, identity: SeatIdentity): Promise<EventSpeaker | null> {
  const supabase = await createClient();
  const column = identity.type === "profile" ? "profile_id" : "guest_id";
  const { data } = await supabase
    .from("event_speakers_active")
    .select("*")
    .eq("event_id", eventId)
    .eq(column, identity.id)
    .maybeSingle();
  return (data as EventSpeaker | null) ?? null;
}

/**
 * Self-service voluntary leave for an account holder (issue #13). Uses
 * the ordinary session-bound client, never the service client —
 * `leave_speaker_seat` is `auth.uid()`-gated in Postgres (migration
 * 00000000000006), so this can only ever end the calling user's own
 * seat. A guest speaker uses `leaveSpeakerSeatAsGuest` below instead —
 * guests have no `auth.uid()`, so voluntary leave can't be self-service
 * the same way; see migration 00000000000012.
 */
export async function leaveSpeakerSeat(eventId: string): Promise<EventSpeaker> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("leave_speaker_seat", { p_event_id: eventId });
  if (error || !data) {
    throw new Error(error?.message ?? "leave_speaker_seat returned no row");
  }
  return data as EventSpeaker;
}

/**
 * A seated guest's own voluntary leave (issue #16). Service-role-only,
 * called with the guest id already resolved server-side from the
 * httpOnly session cookie — never accepted as client input. See
 * migration 00000000000012's `leave_speaker_seat_as_guest`.
 */
export async function leaveSpeakerSeatAsGuest(eventId: string, guestId: string): Promise<EventSpeaker> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("leave_speaker_seat_as_guest", {
    p_event_id: eventId,
    p_guest_id: guestId,
  });
  if (error || !data) {
    throw new Error(error?.message ?? "leave_speaker_seat_as_guest returned no row");
  }
  return data as EventSpeaker;
}

/**
 * Atomic seat assignment/replacement (issue #13, widened to guests by
 * issue #16). Ends whoever currently holds `seatNumber` (left_reason
 * 'replaced') and seats `identity`, as a single Postgres transaction —
 * see migration 00000000000006 for the race-safety argument (the partial
 * unique indexes are the real backstop, not this function).
 *
 * `guestDisplayName` is required (and only meaningful) when `identity.type
 * === "guest"` — a profile's display_name is still read server-side from
 * `profiles` inside the function itself, never a caller-supplied
 * parameter (unchanged from migration 00000000000010); guests have no
 * `profiles` row for the function to read from, so the caller (already
 * holding the guest's name from their session cookie) supplies it.
 *
 * Deliberately uses the service client: `claim_speaker_seat` has no
 * anon/authenticated grant on purpose, so this is only callable from
 * genuinely trusted server code, never from a Server Action a browser
 * could invoke directly. See DECISIONS.md's authorization-model entries
 * for issues #13 and #16.
 */
export async function claimSpeakerSeat(
  eventId: string,
  identity: SeatIdentity,
  seatNumber: 1 | 2,
  guestDisplayName?: string,
): Promise<EventSpeaker> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("claim_speaker_seat", {
    p_event_id: eventId,
    p_seat_number: seatNumber,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
    p_guest_display_name: identity.type === "guest" ? guestDisplayName : undefined,
  });
  if (error || !data) {
    throw new Error(error?.message ?? "claim_speaker_seat returned no row");
  }
  return data as EventSpeaker;
}

/**
 * Ends a specific identity's active occupancy without assigning a
 * replacement (issue #13, widened to guests by issue #16) —
 * 'moderator_removed', 'event_ended', or 'disconnected'. Same
 * trusted-server-only tier as `claimSpeakerSeat` and for the same
 * reason: no anon/authenticated grant, service client only. Real
 * callers: the LiveKit webhook route handler (after it independently
 * verifies LiveKit's webhook signature) for an immediate eviction, and
 * `checkAndEvictInactiveSpeaker` (room/actions.ts, real-device
 * reconnect-grace-period finding) for the graced path — the latter is
 * reachable from an ordinary client call, but only ever actually reaches
 * this function after its own independent re-verification via LiveKit's
 * `RoomServiceClient` confirms the identity is genuinely absent right
 * now; the caller's own claim is never trusted directly. Returns `null`,
 * not an error, if the identity had no active seat — a safe no-op (e.g.
 * the webhook firing for someone who was only ever audience, or a
 * redundant grace-period check after the seat was already vacated some
 * other way).
 */
export async function endSpeakerSeat(
  eventId: string,
  identity: SeatIdentity,
  reason: Extract<LeftReason, "moderator_removed" | "event_ended" | "disconnected">,
): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("end_speaker_seat", {
    p_event_id: eventId,
    p_reason: reason,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
  });
  if (error) {
    throw new Error(error.message);
  }
  // PostgREST calls a non-SETOF composite-returning function via `FROM
  // fn(...)`; when the function's own result is SQL NULL (the no-active-
  // seat no-op — see `end_speaker_seat`'s `if not found then return null`
  // in migration 00000000000009), that FROM-clause call still contributes
  // exactly one row, so this comes back as `{id: null, ...}` — a real
  // object with every field null, not JSON `null`. Checking `id` is what
  // actually distinguishes "no matching row" from a genuine result here.
  const row = data as EventSpeaker | null;
  return row?.id ? row : null;
}

/**
 * Starts the server-authoritative disconnect grace period (issue #18 UX
 * finding) — see migration 00000000000016's `mark_speaker_disconnected`.
 * The only real caller is the LiveKit webhook route's `participant_left`
 * handler, after it independently verifies LiveKit's webhook signature —
 * same trusted-server-only tier as `endSpeakerSeat`. Idempotent (a
 * duplicate/retried webhook delivery never restarts the clock) and a
 * safe no-op for an identity with no active seat.
 */
export async function markSpeakerDisconnected(eventId: string, identity: SeatIdentity): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("mark_speaker_disconnected", {
    p_event_id: eventId,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = data as EventSpeaker | null;
  return row?.id ? row : null;
}

/**
 * Clears the disconnect grace-period clock (issue #18 UX finding) — see
 * migration 00000000000016's `mark_speaker_reconnected`. The only real
 * caller is the LiveKit webhook route's `participant_joined` handler —
 * the same authoritative, server-to-server signal disconnection uses.
 * Scoped to this identity's own active seat row only, never by seat
 * number, which is what makes a stale reconnect signal for an
 * already-released/reclaimed seat a harmless no-op — see the migration's
 * own comment.
 */
export async function markSpeakerReconnected(eventId: string, identity: SeatIdentity): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("mark_speaker_reconnected", {
    p_event_id: eventId,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = data as EventSpeaker | null;
  return row?.id ? row : null;
}

/**
 * The disconnect-only grace-period enforcement (issue #18 UX finding) —
 * see migration 00000000000016's `release_expired_disconnected_speaker`
 * for the full race-safety reasoning (a single atomic UPDATE, not a
 * check-then-write): the actual release decision is re-derived from
 * Postgres's own clock and the row's own `disconnected_at` every time,
 * never trusted from the caller. Returns `null` (not an error) whenever
 * nothing was released: not yet expired, already reconnected
 * (`disconnected_at` cleared), already released, or never seated.
 *
 * **Superseded for live app code** (issue #18 unified inactive-speaker
 * finding) — `checkAndEvictInactiveSpeaker` (room/actions.ts) now calls
 * `releaseExpiredInactiveSpeaker` below instead, which covers *either*
 * cause via the same race-safety shape. This function is kept, unchanged,
 * for tests/callers that specifically want the disconnect-only check.
 */
export async function releaseExpiredDisconnectedSpeaker(
  eventId: string,
  identity: SeatIdentity,
  graceSeconds: number,
): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("release_expired_disconnected_speaker", {
    p_event_id: eventId,
    p_grace_seconds: graceSeconds,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = data as EventSpeaker | null;
  return row?.id ? row : null;
}

/**
 * Starts the media-inactivity grace-period clock (issue #18 unified
 * inactive-speaker finding) — see migration 00000000000017's
 * `mark_speaker_media_inactive`. Unlike `markSpeakerDisconnected`, the
 * intended caller here is the speaker's own connected client (via the
 * `reportSpeakerMediaInactive` server action), not a webhook — there is
 * no server-observable signal for mute state in this app to trust
 * instead. Idempotent (a duplicate report never restarts the clock) and
 * a safe no-op for an identity with no active seat.
 */
export async function markSpeakerMediaInactive(eventId: string, identity: SeatIdentity): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("mark_speaker_media_inactive", {
    p_event_id: eventId,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = data as EventSpeaker | null;
  return row?.id ? row : null;
}

/**
 * Clears the media-inactivity clock (issue #18 unified inactive-speaker
 * finding) — see migration 00000000000017's `mark_speaker_media_active`.
 * Called the instant the speaker's own client observes either camera or
 * microphone becoming active again (either alone is enough — see
 * `isLocalMediaInactive`).
 */
export async function markSpeakerMediaActive(eventId: string, identity: SeatIdentity): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("mark_speaker_media_active", {
    p_event_id: eventId,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = data as EventSpeaker | null;
  return row?.id ? row : null;
}

/**
 * The unified, server-authoritative expiration enforcement (issue #18
 * unified inactive-speaker finding) — see migration 00000000000017's
 * `release_expired_inactive_speaker`: a single atomic UPDATE covering
 * *either* a genuine LiveKit disconnect or media inactivity, whichever
 * (if either) has actually crossed the grace period right now. This is
 * the function `checkAndEvictInactiveSpeaker` (room/actions.ts) calls —
 * `releaseExpiredDisconnectedSpeaker` above is kept for the tests/callers
 * that specifically want the disconnect-only check, but every live
 * caller in the app now goes through this one instead, since a seat can
 * become unavailable for either reason.
 */
export async function releaseExpiredInactiveSpeaker(
  eventId: string,
  identity: SeatIdentity,
  graceSeconds: number,
): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("release_expired_inactive_speaker", {
    p_event_id: eventId,
    p_grace_seconds: graceSeconds,
    p_profile_id: identity.type === "profile" ? identity.id : undefined,
    p_guest_id: identity.type === "guest" ? identity.id : undefined,
  });
  if (error) {
    throw new Error(error.message);
  }
  const row = data as EventSpeaker | null;
  return row?.id ? row : null;
}

/**
 * Issue #21, Part 2: casts/transfers/changes the caller's one active
 * Continue/Replace vote for a specific speaker's current round. Rejected
 * server-side (not just hidden in the UI) once the round has moved to
 * `'closing'` — see migration 00000000000021's `cast_speaker_round_vote`
 * for why: a narrow-loss outcome is already decided, and accepting more
 * votes at that point would be meaningless.
 */
export async function castSpeakerRoundVote(eventSpeakersId: string, choice: "continue" | "replace"): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("cast_speaker_round_vote", {
    p_event_speakers_id: eventSpeakersId,
    p_choice: choice,
  });
  if (error) {
    throw new Error(error.message);
  }
}

/** A guest's own round vote — service-role-only, same tier as `castSpeakerRequestVoteAsGuest`. */
export async function castSpeakerRoundVoteAsGuest(
  eventSpeakersId: string,
  choice: "continue" | "replace",
  guestId: string,
): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase.rpc("cast_speaker_round_vote_as_guest", {
    p_event_speakers_id: eventSpeakersId,
    p_choice: choice,
    p_guest_id: guestId,
  });
  if (error) {
    throw new Error(error.message);
  }
}

export type ResolveSpeakerRoundOutcome =
  | "no-active-occupancy"
  | "active-not-yet-expired"
  | "closing-not-yet-expired"
  | "continue"
  | "narrow-loss"
  | "decisive-replace"
  | "replaced-after-closing";

export type ResolveSpeakerRoundResult = {
  outcome: ResolveSpeakerRoundOutcome;
  /** The occupancy row's own identity — returned unconditionally (even for a no-op outcome), so callers that need to react to a replacement (e.g. revoking LiveKit publish rights) never need a second fetch. Null only when outcome is 'no-active-occupancy'. */
  eventId: string | null;
  identity: SeatIdentity | null;
};

/**
 * Issue #21, Part 1: the one authoritative round state transition — see
 * migration 00000000000021/00000000000022's `resolve_speaker_round` for
 * the full decision (mirrors `lib/speaker-round.ts`'s
 * `resolveRoundOutcome` exactly). Trusted-server-only; always safe to
 * call early, late, or repeatedly — it re-derives everything from the
 * row's own timestamps and the real vote tally, and is a pure no-op if
 * it's not actually time yet. See `useSpeakerRoundResolution` for how
 * every connected client independently schedules a call to this at the
 * real deadline, so resolution never depends on any one browser staying
 * open.
 */
export async function resolveSpeakerRound(eventSpeakersId: string): Promise<ResolveSpeakerRoundResult> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("resolve_speaker_round", { p_event_speakers_id: eventSpeakersId });
  if (error) {
    throw new Error(error.message);
  }
  const row = data?.[0];
  const outcome = (row?.outcome ?? "no-active-occupancy") as ResolveSpeakerRoundOutcome;
  if (!row || (row.profile_id === null && row.guest_id === null)) {
    return { outcome, eventId: null, identity: null };
  }
  return {
    outcome,
    eventId: row.event_id,
    identity: row.profile_id ? { type: "profile", id: row.profile_id } : { type: "guest", id: row.guest_id! },
  };
}

/** Live vote tally for a speaker's current round — publicly readable, same tier as `listActiveSpeakers`. */
export async function listSpeakerRoundVotes(eventSpeakersId: string): Promise<SpeakerRoundVote[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("speaker_round_votes")
    .select("*")
    .eq("event_speakers_id", eventSpeakersId);
  return (data as SpeakerRoundVote[] | null) ?? [];
}
