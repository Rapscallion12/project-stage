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
export type LeftReason = "voluntary" | "replaced" | "moderator_removed" | "event_ended" | "disconnected";

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
};

/**
 * Currently-occupied seats for an event (left_at is null). Still a plain
 * read — the table itself has no insert/update grant (see migration
 * 00000000000005); every write goes through one of the functions below
 * instead, never a direct `.insert()`/`.update()` here.
 */
export async function listActiveSpeakers(eventId: string): Promise<EventSpeaker[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("event_speakers")
    .select("*")
    .eq("event_id", eventId)
    .is("left_at", null)
    .order("seat_number", { ascending: true });
  return (data ?? []) as EventSpeaker[];
}

/**
 * Whether — and in which seat — a specific identity (account or guest)
 * currently holds an active occupancy for an event. Used by the LiveKit
 * token endpoint (issues #2/#16) to decide `canPublish`; a targeted query
 * rather than filtering `listActiveSpeakers()` client-side, since it
 * expresses the actual question being asked.
 */
export async function getActiveSeatForIdentity(eventId: string, identity: SeatIdentity): Promise<EventSpeaker | null> {
  const supabase = await createClient();
  const column = identity.type === "profile" ? "profile_id" : "guest_id";
  const { data } = await supabase
    .from("event_speakers")
    .select("*")
    .eq("event_id", eventId)
    .eq(column, identity.id)
    .is("left_at", null)
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
 * reason: no anon/authenticated grant, service client only. Today's real
 * callers are the LiveKit webhook route handler (after it independently
 * verifies LiveKit's webhook signature) and, once #16 ships, the same
 * handler for guest disconnects too. Returns `null`, not an error, if
 * the identity had no active seat — a safe no-op (e.g. the webhook
 * firing for someone who was only ever audience).
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
