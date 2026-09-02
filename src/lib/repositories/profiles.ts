import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

export async function getProfileDisplayName(userId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("display_name").eq("id", userId).maybeSingle();
  return data?.display_name ?? null;
}

/**
 * The one username a currently-authenticated identity has, if any —
 * used by `resolveIdentity` so every caller (the room's own account
 * menu, the live-identity directory) can decide whether "My Profile"
 * should link to the public profile or to the edit/complete-your-
 * profile flow, without a second round-trip.
 */
export async function getProfileUsername(userId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("username").eq("id", userId).maybeSingle();
  return data?.username ?? null;
}

/**
 * Issue #29: the public-facing shape of a profile — exactly the columns
 * `public_profiles` (migration 00000000000044) exposes, never the base
 * `profiles` table's internal `reliability_score`/`reputation_score`.
 */
export type PublicProfile = {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  social_links: Record<string, string>;
  created_at: string;
};

// `id`/`display_name`/`created_at` are typed nullable here only because
// Postgres view columns are always nullable in the generator's own
// output, regardless of the base table's real NOT NULL constraints
// (`profiles.id`/`display_name`/`created_at` are all NOT NULL) — safe
// to assert non-null on every field this view actually returns a row
// for.
function toPublicProfile(row: {
  id: string | null;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  bio: string | null;
  social_links: unknown;
  created_at: string | null;
}): PublicProfile {
  return {
    id: row.id!,
    username: row.username!, // public_profiles' own `where username is not null` guarantees this
    display_name: row.display_name!,
    avatar_url: row.avatar_url,
    bio: row.bio,
    social_links: (row.social_links ?? {}) as Record<string, string>,
    created_at: row.created_at!,
  };
}

/**
 * The public profile page's own read — `/profile/[username]`. Reads
 * `public_profiles`, the one anon-reachable surface (see that view's
 * own doc comment) — never the base `profiles` table, so a guest
 * visitor is never even structurally capable of pulling internal
 * columns through this path. Case-insensitive lookup (matches the
 * case-insensitive uniqueness the stored, already-lowercased column
 * gives for free) — the URL segment is lowercased before the query, not
 * relied on to already be.
 */
export async function getPublicProfileByUsername(username: string): Promise<PublicProfile | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("public_profiles")
    .select("id, username, display_name, avatar_url, bio, social_links, created_at")
    .eq("username", username.toLowerCase())
    .maybeSingle();
  return data ? toPublicProfile(data) : null;
}

/**
 * Batched profile lookup for the live room's own identity directory
 * (issue #29, Section 15/17) — speaker tiles, comments, and RTS
 * candidate rows already carry a live `profile_id` FK; this resolves a
 * whole set of them to `{username, avatarUrl}` in one query rather than
 * one round-trip per visible identity. Only ever returns entries for
 * profiles that actually have a username (i.e., have a real public
 * profile to link to) — a profile_id with no entry in the returned map
 * means "not linkable yet," which callers treat identically to a guest
 * (non-navigable avatar, current display-name snapshot only). Reads
 * `public_profiles`, so this is safe to call from a guest's own render
 * path too — nothing here requires the caller to be authenticated.
 */
export async function getPublicProfilesByIds(ids: string[]): Promise<Map<string, { username: string; avatarUrl: string | null }>> {
  if (ids.length === 0) return new Map();
  const supabase = await createClient();
  const { data } = await supabase.from("public_profiles").select("id, username, avatar_url").in("id", ids);
  return new Map((data ?? []).map((row) => [row.id!, { username: row.username!, avatarUrl: row.avatar_url }]));
}

/** The service-client equivalent of `getPublicProfilesByIds` — for a caller with no real user session to read cookies from (mirrors `listActiveSpeakersAuthoritative`'s own reasoning). */
export async function getPublicProfilesByIdsAuthoritative(ids: string[]): Promise<Map<string, { username: string; avatarUrl: string | null }>> {
  if (ids.length === 0) return new Map();
  const supabase = createServiceClient();
  const { data } = await supabase.from("public_profiles").select("id, username, avatar_url").in("id", ids);
  return new Map((data ?? []).map((row) => [row.id!, { username: row.username!, avatarUrl: row.avatar_url }]));
}

/**
 * The full row, for the owner's own Edit Profile page — includes a
 * `username: null` account (unlike the public view, which excludes
 * those entirely), since this is exactly the read that has to detect
 * "hasn't completed their profile yet" in the first place. Session-
 * bound client, not service client: `profiles`' own base-table RLS
 * ("Users can update their own profile") already scopes writes to
 * `auth.uid() = id`, and its select policy is authenticated-only — this
 * function is never called for anyone but the current session's own
 * identity, so relying on that existing RLS (rather than trusting a
 * caller-supplied id) is the safer default.
 */
export type OwnProfile = {
  id: string;
  username: string | null;
  display_name: string;
  avatar_url: string | null;
  bio: string | null;
  social_links: Record<string, string>;
  created_at: string;
};

export async function getOwnProfile(userId: string): Promise<OwnProfile | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, username, display_name, avatar_url, bio, social_links, created_at")
    .eq("id", userId)
    .maybeSingle();
  if (!data) return null;
  return {
    id: data.id,
    username: data.username,
    display_name: data.display_name,
    avatar_url: data.avatar_url,
    bio: data.bio,
    social_links: (data.social_links ?? {}) as Record<string, string>,
    created_at: data.created_at,
  };
}

export type ProfileUpdateInput = {
  displayName: string;
  username: string;
  bio: string | null;
  socialLinks: Record<string, string>;
};

export type ProfileUpdateError = { field: "username" | "displayName" | "bio" | "general"; message: string };

/**
 * The one explicit Save action for Edit Profile (Section 13's own
 * "explicit save action, not every keystroke") — session-bound client,
 * so RLS's own `auth.uid() = id` is the actual authorization boundary,
 * not an application-level check that could drift from it. The
 * username-uniqueness violation (Postgres 23505, from the base table's
 * own `unique` constraint) is the one error translated into a specific,
 * field-addressable message here — every other constraint
 * (`username_format`/`username_not_reserved`/`bio_length`) is already
 * pre-validated client-side (`lib/username.ts`, `bio.length <= 160`
 * checked inline) before this ever runs, so reaching this function with
 * one of *those* violations would mean the client validation itself
 * drifted from the database — worth surfacing plainly rather than
 * masking, not worth a bespoke message per constraint.
 */
export async function updateOwnProfile(userId: string, input: ProfileUpdateInput): Promise<ProfileUpdateError | null> {
  const supabase = await createClient();
  const { error } = await supabase
    .from("profiles")
    .update({
      display_name: input.displayName,
      username: input.username,
      bio: input.bio,
      social_links: input.socialLinks,
    })
    .eq("id", userId);

  if (!error) return null;
  if (error.code === "23505") {
    return { field: "username", message: "That username is already taken." };
  }
  return { field: "general", message: error.message };
}

/** Avatar removal (Section 20) and the post-upload write-back both go through this — the one place `profiles.avatar_url` is ever set, independent of the main Save action's own timing (Section 20: "users should be able to remove avatar... " as its own immediate action, not gated behind the form's Save button). */
export async function updateOwnAvatarUrl(userId: string, avatarUrl: string | null): Promise<void> {
  const supabase = await createClient();
  const { error } = await supabase.from("profiles").update({ avatar_url: avatarUrl }).eq("id", userId);
  if (error) throw new Error(error.message);
}

/**
 * Issue #29, Section 10: "number of stage appearances... ONLY if this
 * can be derived reliably from existing data." `event_speakers` already
 * has exactly one row per occupancy episode with a live `profile_id` FK
 * (see migration 00000000000005) — counting distinct events a profile
 * has ever occupied a seat in (regardless of how the episode ended) is
 * a direct, reliable derivation from data that already exists for an
 * unrelated reason, not a new tracked statistic. Deliberately not
 * cached/denormalized — a prototype's profile page rendering once per
 * view doesn't need it, and a stored counter would be one more place to
 * keep in sync.
 */
export async function getStageAppearanceCount(profileId: string): Promise<number> {
  const supabase = await createClient();
  const { data } = await supabase.from("event_speakers").select("event_id").eq("profile_id", profileId);
  if (!data) return 0;
  return new Set(data.map((row) => row.event_id)).size;
}
