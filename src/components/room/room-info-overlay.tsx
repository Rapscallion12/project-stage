"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { ButtonLink } from "@/components/ui/button";
import { AccountMenuLinks } from "@/components/profile/account-menu-links";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { cn } from "@/lib/utils";
import { ROOM_STATUS_LABEL, type RoomStatus } from "@/lib/room-status";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";

/**
 * Issue #21, seventh corrective pass, Sections 8-15: the collapsed
 * room/navigation control's own contents — a temporary overlay, not a
 * permanent header. `EventRoom` now hides the site-wide `SiteHeader`
 * outright for the whole time a room is mounted (see globals.css's
 * `body.room-active > header` rule) — this is the one remaining place
 * Home/Events navigation and account actions live while inside a room.
 *
 * **Redesigned this pass (real-iPhone feedback)**: the previous version
 * was flat, undifferentiated text — "Virtual Stage / Home" read as a
 * breadcrumb, not a tappable action; the room description could push
 * navigation off the initial mobile viewport; the account row (name +
 * Log out button side by side) had no visual relationship to the "My
 * Profile" link beneath it. Reorganized into three visually distinct
 * groups — room identity, navigation, account — each with real spacing
 * between groups and tighter spacing within one, rather than one uniform
 * column of equally-weighted rows. See DECISIONS.md for the full
 * reasoning (why `NavRow` is icon+label+description, why the description
 * clamps, why Log out is now small/secondary text instead of a button
 * competing with the account holder's own name).
 *
 * **Rendered once, at the `EventRoom` level** (a sibling of the
 * portrait/landscape/desktop composition branch, never a wrapper around
 * it) — opening/closing this can never remount `SpeakerStage`, the
 * LiveKit connection, or any of the room's own hooks.
 *
 * **Overlay, not a resize**: `fixed` positioned, a backdrop click/Escape/
 * ✕ all dismiss it — never pushes or resizes the stage underneath. Mobile
 * gets a bottom sheet; at the desktop width threshold (`lg`, 1024px —
 * the same breakpoint `useIsDesktopViewport` uses) it becomes a compact
 * top-right popover instead. Both share the exact same section markup —
 * only the outer positioning/sizing classes differ — so "apply the same
 * information architecture to both" (this pass's own instruction) holds
 * by construction, not by keeping two structures in sync by hand.
 *
 * `z-[60]`, deliberately above the preview-only Session Simulator panel's
 * own `z-50`.
 */
export function RoomInfoOverlay({
  open,
  onClose,
  event,
  roomStatus,
  identity,
  identityAvatarUrl = null,
}: {
  open: boolean;
  onClose: () => void;
  event: Pick<Event, "title" | "description">;
  roomStatus: RoomStatus;
  identity: Identity;
  /** Visual identity pass: the account holder's own avatar for the identity block — `null` for a guest or an account without one uploaded yet, in which case `ParticipantAvatar` falls back to initials, same as everywhere else this component is used. */
  identityAvatarUrl?: string | null;
}) {
  // Section 12: "Escape on desktop." Only listens while actually open, and
  // removed on close/unmount — never a stray global listener outliving
  // this overlay's own visibility.
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Room Info redesign: a long description (this project's own
  // dev-harness demo rooms carry a multi-sentence one) shouldn't push
  // navigation below the fold — clamp to 2 lines and offer "Show more."
  // Reset to collapsed every time the sheet re-opens, rather than
  // persisting across opens, so it never surprises a returning visitor by
  // silently starting pre-expanded.
  const [descExpanded, setDescExpanded] = useState(false);
  useEffect(() => {
    // `open` toggling doesn't unmount this component (its own JSX
    // conditionally returns `null` below rather than the parent
    // unmounting the element), so `descExpanded` would otherwise persist
    // silently across a close/reopen — the `await` makes this a real
    // microtask continuation rather than a synchronous effect-body
    // setState, matching this codebase's own established fix for this
    // exact lint rule (see `useAutomaticPromotion`).
    let cancelled = false;
    async function reset() {
      await Promise.resolve();
      if (cancelled) return;
      if (open) setDescExpanded(false);
    }
    reset();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  // A heuristic, not a real overflow measurement (avoids a ResizeObserver
  // just for this) — long enough that two lines of an ordinary event
  // description almost never trip it, short enough that the dev-harness
  // demo room's own multi-sentence description reliably does.
  const descriptionIsLong = (event.description?.length ?? 0) > 140;

  return (
    <div
      data-testid="room-info-backdrop"
      onClick={onClose}
      className="fixed inset-0 z-[60] bg-black/50"
    >
      <div
        data-testid="room-info-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Room information and navigation"
        // Section 12: a tap *inside* the panel must not bubble to the
        // backdrop's own onClose — this is the standard modal-backdrop
        // pattern, not a second dismissal mechanism.
        onClick={(e) => e.stopPropagation()}
        className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[85vh] flex-col overflow-y-auto rounded-t-2xl border-t border-border bg-surface shadow-2xl lg:inset-x-auto lg:top-16 lg:right-4 lg:bottom-auto lg:max-h-[75vh] lg:w-80 lg:rounded-2xl lg:border"
        style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center justify-between px-4 pt-4 pb-1">
          <h2 className="text-xs font-semibold tracking-wide text-muted uppercase">Room Info</h2>
          <button
            type="button"
            data-testid="room-info-close"
            onClick={onClose}
            aria-label="Close room info"
            className="-mr-1.5 flex h-9 w-9 items-center justify-center rounded-full text-lg leading-none text-muted hover:bg-surface-hover hover:text-foreground"
          >
            ✕
          </button>
        </div>

        {/* Room identity — kept, but no longer the dominant thing on the
            initial viewport ("should NOT consume most of the initial
            mobile viewport"). */}
        <div className="flex flex-col gap-1 px-4 pt-1 pb-3">
          <div className="flex items-center gap-2">
            <span
              aria-hidden="true"
              data-testid="room-status-dot"
              className={cn("h-2 w-2 shrink-0 rounded-full", roomStatus === "live" ? "bg-vote-continue" : "bg-muted")}
            />
            <h1 className="min-w-0 truncate text-base font-semibold">{event.title}</h1>
          </div>
          <p className="text-xs font-medium text-muted">{ROOM_STATUS_LABEL[roomStatus]}</p>
          {event.description && (
            <div>
              <p className={cn("mt-1 text-sm text-secondary", !descExpanded && "line-clamp-2")}>{event.description}</p>
              {descriptionIsLong && (
                <button
                  type="button"
                  data-testid="room-description-toggle"
                  onClick={() => setDescExpanded((v) => !v)}
                  className="mt-0.5 text-xs font-medium text-accent hover:underline"
                >
                  {descExpanded ? "Show less" : "Show more"}
                </button>
              )}
            </div>
          )}
        </div>

        {/* Navigation — the primary escape route from the room. Icon +
            label + short description per row, a real tap target with its
            own hover/press affordance, not plain text. */}
        <div className="flex flex-col gap-0.5 border-t border-border px-2 py-2">
          <NavRow
            href="/"
            icon="🏠"
            label="Home"
            description="Virtual Stage"
            ariaLabel="Return to the Virtual Stage home page"
            testId="room-nav-home"
          />
          <NavRow
            href="/events"
            icon="📅"
            label="Browse Events"
            description="Find another live room"
            ariaLabel="Browse other live events"
            testId="room-nav-events"
          />
        </div>

        {/* Account — identity block first, actions grouped tightly
            beneath it, Log out demoted to small secondary text so it
            never competes with the account holder's own name. */}
        <div className="flex flex-col gap-3 border-t border-border px-4 py-3">
          {identity.type === "guest" ? (
            <div className="flex items-center gap-2">
              <ButtonLink href="/login" variant="ghost" className="flex-1">
                Log in
              </ButtonLink>
              <ButtonLink href="/signup" variant="primary" className="flex-1">
                Sign up
              </ButtonLink>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <ParticipantAvatar name={identity.displayName} imageUrl={identityAvatarUrl} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{identity.displayName}</p>
                  <p className="truncate text-xs text-muted">{identity.username ? `@${identity.username}` : "Complete your profile"}</p>
                </div>
              </div>
              <div className="flex flex-col">
                <AccountMenuLinks username={identity.username} linkClassName="-mx-2 rounded-lg px-2 py-2 text-sm font-medium" />
              </div>
              <form action={signOut}>
                <button type="submit" className="self-start text-xs font-medium text-danger hover:underline">
                  Log out
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * One tappable navigation row — icon, label, short description. Local to
 * this file rather than its own component: only ever used twice, here,
 * and not a general-purpose pattern the rest of the app needs yet.
 */
function NavRow({
  href,
  icon,
  label,
  description,
  ariaLabel,
  testId,
}: {
  href: string;
  icon: string;
  label: string;
  description: string;
  ariaLabel: string;
  testId: string;
}) {
  return (
    <Link
      href={href}
      aria-label={ariaLabel}
      data-testid={testId}
      className="flex items-center gap-3 rounded-xl px-2 py-2.5 hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-base"
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold">{label}</span>
        <span className="block truncate text-xs text-muted">{description}</span>
      </span>
    </Link>
  );
}
