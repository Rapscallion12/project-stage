import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

/**
 * The one place this project uses the Supabase service_role key — it
 * bypasses RLS and every table/function grant entirely. Never import this
 * outside a genuinely trusted, non-client-reachable server code path that
 * has its own independent authorization check *before* calling anything
 * with it. Current callers, each independently gated:
 * - The LiveKit webhook handler (gated by verifying LiveKit's webhook
 *   signature).
 * - `lib/repositories/event-speakers.ts`'s `claimSpeakerSeat`/
 *   `endSpeakerSeat`, deliberately not granted to anon/authenticated
 *   (`claim_speaker_seat`, `end_speaker_seat` — migration
 *   00000000000006, DECISIONS.md's authorization-model entry for issue
 *   #13).
 * - `lib/repositories/speaker-requests.ts`'s `rankPendingSpeakerRequests`/
 *   `markSpeakerRequestGranted` — same tier, migration 00000000000011,
 *   issue #14.
 * - `lib/repositories/dev-demo.ts`, used only by the dev-only `/dev`
 *   route (`src/app/dev/`), which independently gates on
 *   `isDevToolsAvailable()` (`process.env.NODE_ENV !== "production"`)
 *   before ever calling anything here — see DECISIONS.md.
 *
 * Every other server-side Supabase access in this app uses
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
