import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { getOwnProfile } from "@/lib/repositories/profiles";
import { ButtonLink } from "@/components/ui/button";
import { HomeAccountMenu } from "@/components/home-account-menu";

/**
 * Issue #29, profile UX polish pass, Section 1: an authenticated visitor's
 * only global identity/profile entry point outside the live room. Real-
 * device feedback: the old header showed a bare email + a full-width "Log
 * out" button and had no way to reach a profile at all — replaced with a
 * single avatar (`HomeAccountMenu`) that consolidates My Profile/Edit
 * Profile/Log out behind one tap, per Section 4's explicit "don't add a
 * fourth large text control" constraint.
 *
 * Fetches the same `getOwnProfile` row Edit Profile/the public profile
 * page already read — no separate cached identity/avatar state (Section
 * 9). The guest branch is untouched (Section 3): no profile concept
 * applies to a guest, so nothing here changes for them.
 */
export async function SiteHeader() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const profile = user ? await getOwnProfile(user.id) : null;

  return (
    <header className="flex shrink-0 items-center justify-between border-b border-border px-6 py-4">
      <div className="flex items-center gap-6">
        <Link href="/" className="text-sm font-semibold tracking-wide">
          VIRTUAL STAGE
        </Link>
        <Link href="/events" className="text-sm text-muted hover:text-foreground">
          Events
        </Link>
      </div>
      {user ? (
        <HomeAccountMenu
          displayName={profile?.display_name ?? "Account holder"}
          username={profile?.username ?? null}
          avatarUrl={profile?.avatar_url ?? null}
        />
      ) : (
        <div className="flex items-center gap-3">
          <ButtonLink href="/login" variant="ghost">
            Log in
          </ButtonLink>
          <ButtonLink href="/signup" variant="primary">
            Sign up
          </ButtonLink>
        </div>
      )}
    </header>
  );
}
