import { createClient } from "@/lib/supabase/server";

/**
 * Plain domain type, not aliased from `Database["public"]["Tables"]["events"]["Row"]`.
 * The shapes happen to match today (Postgres row → this type, structurally),
 * but callers of this repository never import anything Supabase-flavored —
 * if the underlying client/ORM ever changes, only this file's
 * implementation needs to change, not every page that displays an event.
 * See ARCHITECTURE.md's "Vendor portability" section for the reasoning.
 */
export type Event = {
  id: string;
  title: string;
  description: string;
  scheduled_start: string;
  lobby_opens_at: string;
  created_at: string;
  /**
   * Which ruleset this room runs under (issue #19) — a Postgres
   * CHECK-constrained text column, not a native enum, so the generator
   * can't express its vocabulary as a TypeScript union; only 'main_stage'
   * exists today. A future format adds itself to both this union and the
   * `events_format_check` constraint in migration 00000000000014 together,
   * never one without the other.
   */
  format: "main_stage";
};

/**
 * The events list must always have at least one testable room reachable
 * through this exact query — real-device testing repeatedly hit "nothing
 * scheduled" because every fixture event aged past `sinceIso`. Rather
 * than the list depending on someone remembering to keep a fixture
 * fresh, one specific row (`is_permanent_test`, migration 00000000000015
 * — enforced to be at most one by a partial unique index) is exempted
 * from the cutoff entirely and sorted first, so it's always here
 * regardless of how stale everything else has gotten.
 */
export async function listUpcomingEvents(sinceIso: string): Promise<Event[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("events")
    .select("*")
    .or(`scheduled_start.gt.${sinceIso},is_permanent_test.eq.true`)
    .order("is_permanent_test", { ascending: false })
    .order("scheduled_start", { ascending: true });
  return (data ?? []) as Event[];
}

export async function getEventById(id: string): Promise<Event | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("events").select("*").eq("id", id).maybeSingle();
  return (data as Event | null) ?? null;
}
