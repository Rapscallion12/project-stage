import { createServiceClient } from "@/lib/supabase/service";
import { claimSpeakerSeat, listActiveSpeakers, type EventSpeaker } from "@/lib/repositories/event-speakers";
import { DEV_EVENT_PREFIX, devTimingForPhase } from "@/lib/dev-demo";

/**
 * Data access for the dev-only `/dev` page (`src/app/dev/`) — never
 * imported by production-facing pages/components/actions, only by that
 * page's own route and Server Actions, both of which independently gate
 * on `isDevToolsAvailable()` before ever calling anything here. Shares
 * the `[dev-harness] ` tagging convention with `scripts/dev-harness.mts`
 * (via `lib/dev-demo.ts`) so either tool's cleanup finds what the other
 * created.
 *
 * No new schema, no new RPC functions, no new authorization path: every
 * write here goes through primitives issue #13/#14 already built and
 * authorized (`claimSpeakerSeat`, the same `service_role` client every
 * other trusted-server-only code path in this app uses) — this file is
 * orchestration, not a new capability.
 */

export type DevDemoEvent = { id: string; title: string; created_at: string };

export async function listDevDemoEvents(): Promise<DevDemoEvent[]> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from("events")
    .select("id, title, created_at")
    .ilike("title", `${DEV_EVENT_PREFIX}%`)
    .order("created_at", { ascending: false });
  return data ?? [];
}

export async function createDevDemoEvent(titleSuffix: string): Promise<DevDemoEvent> {
  const supabase = createServiceClient();
  const { scheduled_start, lobby_opens_at } = devTimingForPhase("ready");
  const { data, error } = await supabase
    .from("events")
    .insert({
      title: `${DEV_EVENT_PREFIX}${titleSuffix.trim() || "demo"}`,
      description: "Created from the /dev page — safe to delete, never real content.",
      scheduled_start,
      lobby_opens_at,
    })
    .select("id, title, created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "failed to create demo event");
  return data;
}

/**
 * Seats the given profile directly — bypassing the production
 * request-queue/ranking gate (issue #14's `claimOpenSeat`) entirely, on
 * purpose. This is the same bypass `scripts/dev-harness.mts`'s `seat`
 * command already established as acceptable for testing; exposing it
 * through a button doesn't change what it's allowed to do, only how you
 * invoke it. `claimSpeakerSeat` itself is unchanged — this calls the
 * exact function issue #13 built, at the exact same trusted tier.
 */
export async function seatCurrentUserAsSpeaker(
  eventId: string,
  profileId: string,
  seatNumber: 1 | 2,
): Promise<EventSpeaker> {
  return claimSpeakerSeat(eventId, profileId, seatNumber);
}

export async function listActiveSpeakersForDevEvent(eventId: string): Promise<EventSpeaker[]> {
  return listActiveSpeakers(eventId);
}

export async function resetDevDemoEvents(): Promise<{ eventsDeleted: number }> {
  const supabase = createServiceClient();
  const { data: events, error: readError } = await supabase
    .from("events")
    .select("id")
    .ilike("title", `${DEV_EVENT_PREFIX}%`);
  if (readError) throw new Error(readError.message);
  if (!events || events.length === 0) return { eventsDeleted: 0 };

  // Deleted by id, not by the ilike filter directly — an explicit id
  // list is what's actually verified against the tag, rather than
  // trusting a second identical-looking filter at delete time. Same
  // discipline as scripts/dev-harness.mts's resetHarness.
  const { error: deleteError, count } = await supabase
    .from("events")
    .delete({ count: "exact" })
    .in(
      "id",
      events.map((e) => e.id),
    );
  if (deleteError) throw new Error(deleteError.message);
  return { eventsDeleted: count ?? events.length };
}
