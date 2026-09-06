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
    // Responsive/accessibility polish pass: real-device feedback found
    // "VIRTUAL STAGE"/"Log in" wrapping onto two lines at ~375-390px
    // guest-header widths — four items (wordmark, Events, two buttons)
    // in one row with the *original* px-6/gap-6/gap-3/px-5 spacing simply
    // needed a few more px than the narrowest supported phones have.
    // Tightened spacing below `sm` (restored above it, where there's
    // room to spare) plus explicit `whitespace-nowrap` on the wordmark
    // and both guest buttons — nowrap alone doesn't fix width pressure
    // (it would just overflow instead of wrapping), so both are needed
    // together. The authenticated branch (`HomeAccountMenu`, a single
    // avatar) was never at risk — nothing here touches it.
    <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-4 sm:px-6">
      <div className="flex min-w-0 items-center gap-3 sm:gap-6">
        <Link href="/" className="shrink-0 text-sm font-semibold tracking-wide whitespace-nowrap">
          VIRTUAL STAGE
        </Link>
        <Link href="/events" className="shrink-0 text-sm text-muted whitespace-nowrap hover:text-foreground">
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
        <div className="flex shrink-0 items-center gap-2 sm:gap-3">
          <ButtonLink href="/login" variant="ghost" className="shrink-0 px-3.5 whitespace-nowrap sm:px-5">
            Log in
          </ButtonLink>
          <ButtonLink href="/signup" variant="primary" className="shrink-0 px-3.5 whitespace-nowrap sm:px-5">
            Sign up
          </ButtonLink>
        </div>
      )}
    </header>
  );
}
