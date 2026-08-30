"use client";

import { useEffect } from "react";
import Link from "next/link";
import { signOut } from "@/app/auth/actions";
import { Button, ButtonLink } from "@/components/ui/button";
import { ROOM_STATUS_LABEL, type RoomStatus } from "@/lib/room-status";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";

/**
 * Issue #21, seventh corrective pass, Sections 8-15: the collapsed
 * room/navigation control's own contents — a temporary overlay, not a
 * permanent header. `EventRoom` now hides the site-wide `SiteHeader`
 * outright for the whole time a room is mounted (see globals.css's
 * `body.room-active > header` rule, broadened from a short-landscape-only
 * exception to every viewport this pass) — this is the one remaining
 * place Home/Events navigation and account actions (login/signup/log
 * out) live while inside a room, plus the room's own identity/status
 * information that `RoomHeader`/the various minimal top-chrome pills
 * already show in each composition but at a glance only.
 *
 * **Rendered once, at the `EventRoom` level** (a sibling of the
 * portrait/landscape/desktop composition branch, never a wrapper around
 * it) — opening/closing this can never remount `SpeakerStage`, the
 * LiveKit connection, or any of the room's own hooks, satisfying
 * Section 41's explicit "responsive presentation must not alter
 * authoritative room state." Each composition only renders a small
 * trigger (the existing room-identity status pill, in Portrait/Mobile
 * Landscape/Speaker View; a small icon button in `RoomHeader` for
 * Desktop) that calls the same `onOpenRoomInfo` passed down through
 * `RoomLayoutProps`.
 *
 * **Overlay, not a resize** (Section 11's explicit preference): `fixed`
 * positioned, a backdrop click/Escape/✕ all dismiss it — never pushes or
 * resizes the stage underneath. Mobile gets a bottom sheet (matching
 * `ExpandedComments`' own established shape); at the desktop width
 * threshold (`lg`, 1024px — the same breakpoint `useIsDesktopViewport`
 * uses, so this never disagrees with which composition is actually
 * mounted) it becomes a compact top-right popover instead, per Section
 * 11's "compact popover/dropdown ... as appropriate."
 *
 * `z-[60]`, deliberately above the preview-only Session Simulator panel's
 * own `z-50` — this is real room-facing UI, not a debug tool, so it
 * takes priority if both are ever open at once (a preview-only
 * collision, invisible to production, which mounts no SIM panel at all).
 */
export function RoomInfoOverlay({
  open,
  onClose,
  event,
  roomStatus,
  identity,
}: {
  open: boolean;
  onClose: () => void;
  event: Pick<Event, "title" | "description">;
  roomStatus: RoomStatus;
  identity: Identity;
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

  if (!open) return null;

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
        className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[80vh] flex-col gap-4 overflow-y-auto rounded-t-2xl border-t border-border bg-background p-4 shadow-2xl lg:inset-x-auto lg:top-16 lg:right-4 lg:bottom-auto lg:max-h-[75vh] lg:w-80 lg:rounded-2xl lg:border"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-muted">Room Info</h2>
          <button
            type="button"
            data-testid="room-info-close"
            onClick={onClose}
            aria-label="Close room info"
            className="rounded-full px-2 py-1 text-lg leading-none text-muted hover:bg-foreground/5 hover:text-foreground"
          >
            ✕
          </button>
        </div>

        <div>
          <h1 className="text-lg font-semibold">{event.title}</h1>
          <p className="text-sm text-muted">{ROOM_STATUS_LABEL[roomStatus]}</p>
          {event.description && <p className="mt-2 text-sm text-muted">{event.description}</p>}
        </div>

        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <Link href="/" className="rounded-lg px-2 py-2 text-sm font-medium hover:bg-foreground/5">
            Virtual Stage / Home
          </Link>
          <Link href="/events" className="rounded-lg px-2 py-2 text-sm font-medium hover:bg-foreground/5">
            Events
          </Link>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
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
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm text-muted">{identity.displayName}</span>
              <form action={signOut}>
                <Button type="submit" variant="secondary">
                  Log out
                </Button>
              </form>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
