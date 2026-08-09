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
};

export async function listUpcomingEvents(sinceIso: string): Promise<Event[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("events")
    .select("*")
    .gt("scheduled_start", sinceIso)
    .order("scheduled_start", { ascending: true });
  return data ?? [];
}

export async function getEventById(id: string): Promise<Event | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("events").select("*").eq("id", id).maybeSingle();
  return data ?? null;
}
