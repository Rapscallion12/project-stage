import { resolveIdentity } from "@/lib/identity";
import { getOwnProfile } from "@/lib/repositories/profiles";
import { EditProfileForm } from "@/components/profile/edit-profile-form";
import { AvatarEditor } from "@/components/profile/avatar-editor";
import { ButtonLink } from "@/components/ui/button";

export const metadata = { title: "Edit profile — Virtual Stage" };

/**
 * Issue #29, Section 13/14: the one place a registered user completes
 * or edits their profile — including choosing a username for the first
 * time (Section 3's own "prompted to choose a username when entering
 * profile editing / completing profile"). Reachable without a
 * username: `getOwnProfile` returns the row regardless (unlike
 * `public_profiles`, which excludes it).
 *
 * **Never a login wall** (AGENTS.md's progressive-authentication rule):
 * a guest landing here — a stale tab, a bookmarked link — sees an
 * inline, benefit-framed prompt, not a redirect to `/login`.
 */
export default async function EditProfilePage() {
  const identity = await resolveIdentity();

  if (identity.type !== "profile") {
    return (
      <div className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center px-6 py-16 text-center">
        <h1 className="mb-2 text-xl font-semibold">Create an account to set up your Virtual Stage profile</h1>
        <p className="mb-6 text-sm text-muted">
          A profile gives you a persistent identity — a photo, a username, and a bio other viewers can see.
        </p>
        <div className="flex items-center justify-center gap-2">
          <ButtonLink href="/login" variant="ghost">
            Log in
          </ButtonLink>
          <ButtonLink href="/signup" variant="primary">
            Sign up
          </ButtonLink>
        </div>
      </div>
    );
  }

  const profile = await getOwnProfile(identity.id);
  if (!profile) {
    // Every authenticated user has a `profiles` row from signup
    // (migration 00000000000001's own trigger) — this should be
    // unreachable, but fails safely rather than crashing if it somehow
    // isn't.
    return <p className="p-6 text-center text-sm text-muted">Couldn&apos;t load your profile — try refreshing.</p>;
  }

  return (
    <div className="mx-auto flex w-full max-w-lg flex-1 flex-col gap-6 px-6 py-10">
      <div>
        <h1 className="text-xl font-semibold">{profile.username ? "Edit profile" : "Complete your profile"}</h1>
        {!profile.username && <p className="mt-1 text-sm text-muted">Choose a username to get your own public profile page.</p>}
      </div>
      <AvatarEditor userId={profile.id} displayName={profile.display_name} initialAvatarUrl={profile.avatar_url} />
      <EditProfileForm profile={profile} />
    </div>
  );
}
