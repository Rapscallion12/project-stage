"use client";

import Link from "next/link";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Issue #29 (first profile/social-identity pass), Sections 15-17: the
 * one place a participant identity (speaker tile, comment, RTS
 * candidate row) becomes tappable into `/profile/[username]` — wraps
 * whatever avatar+name markup the caller already renders, rather than
 * every surface inventing its own link/guard logic.
 *
 * **`username === null` renders as a plain, non-interactive
 * `<span>`** — covers both a guest (Section 16: "do NOT create fake
 * profile pages... leave it non-navigable") and a registered account
 * that hasn't chosen a username yet (no public profile exists for them
 * either, for the identical reason). Deliberately the same, unstyled
 * treatment for both — no "Guest" badge, no visual distinction between
 * the two non-navigable cases — since that reads as consistent, minimal
 * chrome rather than singling guests out, and avoids adding a new
 * visual element to *every* guest identity across the whole room, per
 * this pass's own "choose whichever produces cleaner UX" instruction.
 *
 * **`stopPropagation`, always** — every real caller (a comment bubble,
 * a speaker tile, an RTS request row) already has its own click
 * behavior on the surrounding element; per Section 15's explicit
 * warning, tapping the identity inside it must never also fire that
 * parent's own handler (a vote, a like, a comment-composer focus, a
 * speaker control). A real `<a>` (via `next/link`) is used rather than
 * a `<button>` wrapping a `<button>`-shaped click handler — this is
 * genuinely navigation, and a real anchor is what makes it keyboard/
 * screen-reader operable for free, exactly like every other `Link` in
 * this app.
 */
export function ProfileLink({
  username,
  children,
  className,
  ariaLabel,
}: {
  username: string | null;
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  if (!username) {
    return <span className={className}>{children}</span>;
  }
  return (
    <Link
      href={`/profile/${username}`}
      onClick={(e: MouseEvent) => e.stopPropagation()}
      aria-label={ariaLabel}
      className={cn("rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent", className)}
    >
      {children}
    </Link>
  );
}
