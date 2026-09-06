import { createClient } from "@/lib/supabase/server";

/**
 * Issue #29 (first profile/social-identity pass): the minimal follow
 * relationship — see migration 00000000000044's own doc comment for the
 * schema (`follows`, composite primary key, `no_self_follow` check,
 * RLS). Every write here goes through the session-bound client, never
 * the service client — `follows`' own RLS (`follower_id = auth.uid()`)
 * is the actual authorization boundary for both insert and delete, the
 * same "let RLS be the boundary, not an application-level check that
 * could drift from it" reasoning `updateOwnProfile` already uses.
 */

/**
 * Idempotent by design, not just by convention: a duplicate follow is a
 * primary-key violation (Postgres 23505) on the same (follower,
 * following) pair — caught here and treated as success, since "already
 * following" and "the follow you just requested succeeded" are the same
 * end state from the caller's own point of view. Self-follow is
 * rejected by the database's own `no_self_follow` check (23514) before
 * this ever needs to guess at it from the two ids — surfaced as a plain
 * thrown error since the UI is expected to never offer a Follow button
 * on a viewer's own profile in the first place (this is the
 * authoritative backstop, not the primary defense).
 */
export async function followProfile(followerId: string, followingId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("follows").insert({ follower_id: followerId, following_id: followingId });
  if (error && error.code !== "23505") {
    throw new Error(error.message);
  }
}

/** A delete matching zero rows (already not following) is already a harmless no-op — nothing extra needed for idempotency here. */
export async function unfollowProfile(followerId: string, followingId: string): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("follows").delete().eq("follower_id", followerId).eq("following_id", followingId);
  if (error) {
    throw new Error(error.message);
  }
}

export async function isFollowing(followerId: string, followingId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("follows")
    .select("follower_id")
    .eq("follower_id", followerId)
    .eq("following_id", followingId)
    .maybeSingle();
  return data !== null;
}

export type FollowCounts = { followers: number; following: number };

/** `follows` is public-select (migration 00000000000044) — safe to call for a guest's own view of a profile, per this pass's own explicit "guests can see follower/following counts" requirement. */
export async function getFollowCounts(profileId: string): Promise<FollowCounts> {
  const supabase = await createClient();
  const [{ count: followers }, { count: following }] = await Promise.all([
    supabase.from("follows").select("*", { count: "exact", head: true }).eq("following_id", profileId),
    supabase.from("follows").select("*", { count: "exact", head: true }).eq("follower_id", profileId),
  ]);
  return { followers: followers ?? 0, following: following ?? 0 };
}
