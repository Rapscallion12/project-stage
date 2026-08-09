import { createClient } from "@/lib/supabase/server";

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
 * Currently-occupied seats for an event (left_at is null). Read-only —
 * this table has no insert/update grant yet. The write path (who's
 * allowed to occupy a seat) is issue #13's atomic assignment function, not
 * here; see the migration's comment and DECISIONS.md for why.
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
