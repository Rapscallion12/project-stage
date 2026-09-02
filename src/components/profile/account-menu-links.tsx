import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * Issue #29, profile UX polish pass, Sections 2/11: the one definition of
 * "where do My Profile / Edit Profile point for this account" — shared by
 * the home header's own avatar menu (`HomeAccountMenu`) and the in-room
 * account menu (`RoomInfoOverlay`), rather than each carrying its own copy
 * that could quietly drift (the room menu previously had a single
 * hardcoded "My Profile" link that didn't yet know about "Complete
 * Profile" wording — this is the fix, applied once, for both surfaces).
 *
 * **No username yet**: a single "Complete Profile" link to `/profile/edit`
 * — never "My Profile," and never a link to a public profile page that
 * doesn't exist yet (there's nothing at `/profile/null`, and
 * `getPublicProfileByUsername` would 404 a made-up value anyway).
 *
 * **Username chosen**: "My Profile" (the real public page) *and* "Edit
 * Profile" as two separate links — both are useful from either surface,
 * and collapsing them back into one would lose the distinction between
 * "view what others see" and "change something."
 */
export function AccountMenuLinks({
  username,
  onNavigate,
  linkClassName,
}: {
  username: string | null;
  onNavigate?: () => void;
  linkClassName?: string;
}) {
  const className = cn("rounded-lg px-2 py-2 text-sm font-medium hover:bg-foreground/5", linkClassName);

  if (!username) {
    return (
      <Link href="/profile/edit" onClick={onNavigate} className={className}>
        Complete Profile
      </Link>
    );
  }

  return (
    <>
      <Link href={`/profile/${username}`} onClick={onNavigate} className={className}>
        My Profile
      </Link>
      <Link href="/profile/edit" onClick={onNavigate} className={className}>
        Edit Profile
      </Link>
    </>
  );
}
