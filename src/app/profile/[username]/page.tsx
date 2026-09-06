import { notFound } from "next/navigation";
import { resolveIdentity } from "@/lib/identity";
import { getPublicProfileByUsername, getStageAppearanceCount } from "@/lib/repositories/profiles";
import { getFollowCounts, isFollowing } from "@/lib/repositories/follows";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { SocialLinksDisplay } from "@/components/profile/social-links-display";
import { FollowButtonSection } from "@/components/profile/follow-button-section";
import { ButtonLink } from "@/components/ui/button";

/**
 * Issue #29, Section 9: the public profile view — `/profile/[username]`,
 * not `/@[username]` (Next.js App Router reserves the `@folder`
 * convention exclusively for parallel-route slots; a literal folder
 * named `@[username]` would define a route *slot* named `[username]`,
 * never a segment matching a literal `@` in the URL — confirmed against
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-
 * conventions/parallel-routes.md` before choosing this, per this
 * project's own "read the docs before writing routing code" rule). This
 * is the documented fallback the pass's own instructions anticipated.
 *
 * Works for guests — reads `getPublicProfileByUsername`/
 * `getFollowCounts`, both backed by anon-readable surfaces
 * (`public_profiles`, `follows` — migration 00000000000044). No
 * authentication required to view; only the Follow button's own tap
 * gates on it.
 */
export default async function PublicProfilePage(props: PageProps<"/profile/[username]">) {
  const { username } = await props.params;
  const profile = await getPublicProfileByUsername(username);
  if (!profile) notFound();

  const identity = await resolveIdentity();
  const isOwnProfile = identity.type === "profile" && identity.id === profile.id;

  const [followCounts, viewerIsFollowing, appearanceCount] = await Promise.all([
    getFollowCounts(profile.id),
    identity.type === "profile" && !isOwnProfile ? isFollowing(identity.id, profile.id) : Promise.resolve(false),
    getStageAppearanceCount(profile.id),
  ]);

  const joinedDate = new Date(profile.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long" });

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-5 px-6 py-10">
      <div className="flex items-start justify-between gap-4">
        <ParticipantAvatar name={profile.display_name} imageUrl={profile.avatar_url} size="lg" />
        {isOwnProfile ? (
          <div className="flex flex-col items-end gap-2">
            <ButtonLink href="/profile/edit" variant="secondary">
              Edit profile
            </ButtonLink>
            <div className="flex gap-3 text-sm">
              <span data-testid="follower-count">
                <span className="font-semibold">{followCounts.followers}</span> <span className="text-muted">Followers</span>
              </span>
              <span data-testid="following-count">
                <span className="font-semibold">{followCounts.following}</span> <span className="text-muted">Following</span>
              </span>
            </div>
          </div>
        ) : (
          <FollowButtonSection
            targetProfileId={profile.id}
            initiallyFollowing={viewerIsFollowing}
            initialFollowerCount={followCounts.followers}
            initialFollowingCount={followCounts.following}
          />
        )}
      </div>

      <div>
        <h1 className="text-xl font-semibold">{profile.display_name}</h1>
        <p className="text-sm text-muted">@{profile.username}</p>
      </div>

      {profile.bio && <p className="text-sm">{profile.bio}</p>}

      <SocialLinksDisplay socialLinks={profile.social_links} />

      <div className="flex flex-col gap-1 border-t border-border pt-4 text-sm text-muted">
        <p>Joined {joinedDate}</p>
        {appearanceCount > 0 && (
          <p>
            Appeared as a speaker in {appearanceCount} event{appearanceCount === 1 ? "" : "s"}
          </p>
        )}
      </div>
    </div>
  );
}
