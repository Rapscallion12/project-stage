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

export type EventSpeaker = {
  id: string;
  event_id: string;
  profile_id: string;
  seat_number: 1 | 2;
  joined_at: string;
  left_at: string | null;
  left_reason: LeftReason | null;
};

/**
 * Currently-occupied seats for an event (left_at is null). Still a plain
 * read — the table itself has no insert/update grant (see migration
 * 00000000000005); every write goes through one of the three functions
 * below instead, never a direct `.insert()`/`.update()` here.
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
 * Whether — and in which seat — a specific profile currently holds an
 * active occupancy for an event. Used by the LiveKit token endpoint
 * (issue #2) to decide `canPublish`; a targeted query rather than
 * filtering `listActiveSpeakers()` client-side, since it expresses the
 * actual question being asked.
 */
export async function getActiveSeatForProfile(eventId: string, profileId: string): Promise<EventSpeaker | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("event_speakers")
    .select("*")
    .eq("event_id", eventId)
    .eq("profile_id", profileId)
    .is("left_at", null)
    .maybeSingle();
  return (data as EventSpeaker | null) ?? null;
}

/**
 * Self-service voluntary leave (issue #13). Uses the ordinary session-
 * bound client, never the service client — `leave_speaker_seat` is
 * `auth.uid()`-gated in Postgres (migration 00000000000006), so this can
 * only ever end the calling user's own seat. Throws if the caller has no
 * active seat in this event; there's no caller yet (issue #3/#6 build the
 * "leave" control), so this is a tested primitive for now.
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
 * Atomic seat assignment/replacement (issue #13). Ends whoever currently
 * holds `seatNumber` (left_reason 'replaced') and seats `profileId`, as a
 * single Postgres transaction — see migration 00000000000006 for the
 * race-safety argument (the partial unique indexes are the real backstop,
 * not this function).
 *
 * Deliberately uses the service client: `claim_speaker_seat` has no
 * anon/authenticated grant on purpose, so this is only callable from
 * genuinely trusted server code, never from a Server Action a browser
 * could invoke directly. There is no caller in this issue — Phase 3's
 * queue/voting system is what will decide *who* gets to claim a seat and
 * call this; wiring that authorization gate is explicitly out of scope
 * here. See DECISIONS.md's authorization-model entry for issue #13.
 */
export async function claimSpeakerSeat(
  eventId: string,
  profileId: string,
  seatNumber: 1 | 2,
): Promise<EventSpeaker> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("claim_speaker_seat", {
    p_event_id: eventId,
    p_profile_id: profileId,
    p_seat_number: seatNumber,
  });
  if (error || !data) {
    throw new Error(error?.message ?? "claim_speaker_seat returned no row");
  }
  return data as EventSpeaker;
}

/**
 * Ends a specific profile's active occupancy without assigning a
 * replacement (issue #13) — 'moderator_removed', 'event_ended', or
 * 'disconnected'. Same trusted-server-only tier as `claimSpeakerSeat` and
 * for the same reason: no anon/authenticated grant, service client only.
 * Today's only real caller is the LiveKit webhook route handler (after it
 * independently verifies LiveKit's webhook signature). Returns `null`,
 * not an error, if the profile had no active seat — a safe no-op (e.g.
 * the webhook firing for someone who was only ever audience).
 */
export async function endSpeakerSeat(
  eventId: string,
  profileId: string,
  reason: Extract<LeftReason, "moderator_removed" | "event_ended" | "disconnected">,
): Promise<EventSpeaker | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("end_speaker_seat", {
    p_event_id: eventId,
    p_profile_id: profileId,
    p_reason: reason,
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
