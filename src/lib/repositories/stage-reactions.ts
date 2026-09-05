import { createServiceClient } from "@/lib/supabase/service";
import type { SeatIdentity } from "@/lib/repositories/event-speakers";

/**
 * Pre-launch interaction pass: server-authoritative rate limiting for
 * directed live-stage emoji reactions — see migration
 * 00000000000045_stage_reaction_heat.sql for the actual decay/hysteresis
 * math (an atomic Postgres function, not reimplemented here) and its own
 * doc comment for why this is a `service_role`-only RPC, same trusted-
 * server-only tier as `claimSpeakerSeat` above it in this file's sibling
 * module: identity here is a parameter, not derived from `auth.uid()`
 * inside the function (guests aren't real Supabase Auth users), so it
 * must only ever be called with an identity this server has already
 * resolved itself (`resolveIdentity()`), never one a client supplied
 * directly.
 *
 * The visible client-side heat meter (`useReactionHeat`) is UX only —
 * this is the actual security boundary a modified client can't bypass.
 * Tuning constants are this function's own SQL defaults; kept in sync by
 * hand with `src/lib/reactions/constants.ts`'s client-side mirror (see
 * that file's own comment) — not passed explicitly here so the database
 * migration stays the one place they're changed for a real tuning pass.
 */
export async function recordStageReactionAttempt(
  eventId: string,
  identity: SeatIdentity,
): Promise<{ accepted: boolean; heatAfter: number; inCooldownAfter: boolean }> {
  const supabase = createServiceClient();
  // `p_profile_id`/`p_guest_id` are genuinely nullable uuid parameters in
  // the SQL function (see the migration's own XOR check) — the generated
  // type marks them required only because they lack a SQL `default`
  // (unlike the tuning parameters, which do), not because PostgREST
  // actually rejects an explicit null. The cast below reflects that
  // generator limitation, not a real runtime constraint.
  const { data, error } = await supabase.rpc("record_stage_reaction_attempt", {
    p_event_id: eventId,
    p_profile_id: (identity.type === "profile" ? identity.id : null) as unknown as string,
    p_guest_id: (identity.type === "guest" ? identity.id : null) as unknown as string,
  });
  if (error || !data || data.length === 0) {
    throw new Error(error?.message ?? "record_stage_reaction_attempt returned no row");
  }
  const row = data[0];
  return { accepted: row.accepted, heatAfter: row.heat_after, inCooldownAfter: row.in_cooldown_after };
}
