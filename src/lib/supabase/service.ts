import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * The one place this project uses the Supabase service_role key — it
 * bypasses RLS and every table/function grant entirely. Never import this
 * outside a genuinely trusted, non-client-reachable server code path that
 * has its own independent authorization check *before* calling anything
 * with it. Today that's: the LiveKit webhook handler (gated by verifying
 * LiveKit's webhook signature) and the event-speakers write functions that
 * are deliberately not granted to anon/authenticated
 * (`claim_speaker_seat`, `end_speaker_seat` — see migration
 * 00000000000006 and DECISIONS.md's authorization-model entry for issue
 * #13). Every other server-side Supabase access in this app uses
 * lib/supabase/server.ts (anon key + the caller's own session), by design.
 */
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured.");
  }

  return createSupabaseClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
