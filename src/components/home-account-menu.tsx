"use client";

import { useEffect, useRef, useState } from "react";
import { signOut } from "@/app/auth/actions";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { AccountMenuLinks } from "@/components/profile/account-menu-links";
import { Button } from "@/components/ui/button";

/**
 * Issue #29, profile UX polish pass, Section 1: the authenticated home
 * header's own identity/account control — replaces the old bare
 * "{email} + Log out" pair with a single avatar that consolidates
 * navigation, my/edit profile, and logging out behind one tap. Consumes
 * the same authoritative `getOwnProfile` read `SiteHeader` already fetches
 * server-side (Section 9: no separate cached avatar/identity state) —
 * this component is purely presentational over props, identical in spirit
 * to how `SpeakerTile`/`ExpandedComments` consume `useProfileDirectory`
 * rather than each re-deriving identity themselves.
 *
 * **A corner-anchored dropdown, not a full-screen overlay** (unlike
 * `RoomInfoOverlay`'s bottom sheet): this sits in the ordinary page header,
 * not the room's fixed-height stage, so there's no reason to reach for the
 * heavier room-only sheet/popover split. `right-0` keeps the panel
 * anchored inside the header's own existing right-side inset (`px-6` on
 * `SiteHeader`) — Section 4's "menu does not clip off-screen" requirement
 * — and this is deliberately not `position: fixed`, so it carries no
 * safe-area-inset concerns a viewport-edge-pinned sheet would.
 *
 * Closes on Escape, on an outside click/tap (the dropdown's own stand-in
 * for a backdrop, since it doesn't have one), and on any of its own link
 * taps (`onNavigate`) — never left open after the thing it was opened for
 * is done.
 */
export function HomeAccountMenu({
  displayName,
  username,
  avatarUrl,
}: {
  displayName: string;
  username: string | null;
  avatarUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef} data-testid="home-account-menu">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        data-testid="home-account-avatar-trigger"
        // p-1 around a 36px (size="sm") avatar brings the actual tap
        // target to 44px — the project's own established minimum
        // (see Button's own BASE_CLASSES comment) — without visually
        // enlarging the avatar itself.
        className="-m-1 rounded-full p-1 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ParticipantAvatar name={displayName} imageUrl={avatarUrl} size="sm" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          data-testid="home-account-menu-panel"
          className="absolute right-0 top-full z-50 mt-2 flex w-56 flex-col gap-1 rounded-xl border border-border bg-surface p-2 shadow-lg"
        >
          <div className="truncate px-2 py-1.5 text-sm font-medium">{displayName}</div>
          <AccountMenuLinks username={username} onNavigate={() => setOpen(false)} />
          <form action={signOut}>
            <Button type="submit" variant="ghost" className="w-full justify-start px-2 min-h-9">
              Log out
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}
