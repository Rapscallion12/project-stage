import Link from "next/link";
import { RoomHeader } from "@/components/room/room-header";
import { HomeAccountMenu } from "@/components/home-account-menu";
import { ButtonLink } from "@/components/ui/button";
import type { RoomStatus } from "@/lib/room-status";
import type { Identity } from "@/lib/identity";

/**
 * Desktop room navigation pass (real-desktop regression): hiding the
 * site-wide `SiteHeader` for the whole time a room is mounted (globals.
 * css's `body.room-active > header` rule) was a correct, deliberate
 * mobile decision — vertical space is scarce there, and every mobile/
 * landscape composition already provides an equivalent path to Home/
 * Events/account via `RoomInfoOverlay`. But on desktop, that same
 * blanket rule left global navigation reachable only by opening a
 * hamburger and scanning a bottom-sheet-shaped overlay — on a screen
 * with width to spare, that reads as "isolated tool," not "part of
 * Virtual Stage." This restores *desktop-only* persistent navigation —
 * mobile/tablet are completely untouched (this component is never
 * imported by `PortraitRoom`/`MobileLandscapeRoom`).
 *
 * **No new breakpoint** — this only ever renders inside `DesktopRoom`,
 * which itself only mounts once `useIsDesktopViewport()` (the existing
 * `min-width: 1024px` / Tailwind `lg` threshold that already decides
 * "does this viewport get the real sidebar composition at all") is
 * true. Reusing that existing gate, rather than picking a second,
 * independent width threshold for the header specifically, is the
 * "audit the actual architecture" answer — there's no scenario where
 * this header renders at a width `DesktopRoom`'s own sidebar/stage
 * layout wasn't already built for.
 *
 * **One row, spanning the full app width** — rendered as a sibling
 * *above* `DesktopRoom`'s own stage+sidebar `flex-row`, not nested
 * inside either column. This is what keeps it aligned with both the
 * stage and the chat sidebar without needing coordinated left/right
 * header halves that could drift out of sync with the columns below
 * them.
 *
 * **Room identity via the existing `RoomHeader`, not a duplicate** —
 * embedded here with its own border/padding stripped (`className`) so
 * it reads as one continuous row rather than a header nested inside a
 * header. `RoomHeader`'s own `justify-between` naturally pushes the
 * viewer count toward this row's own right edge, right before the
 * account control — matching the ticket's own "viewer count, then
 * avatar" right-side grouping without needing a second copy of that
 * layout logic.
 *
 * **Account control reuses `HomeAccountMenu` verbatim** — the exact
 * same component the home page header already uses, not a second
 * account-menu implementation. Guests get the identical `Log in`/
 * `Sign up` pair `SiteHeader`'s own guest branch uses.
 *
 * **`RoomInfoOverlay` (opened via `onOpenRoomInfo`) is untouched** —
 * still reachable from this header's own room-details trigger, still
 * shows the room description/status detail and (redundantly, but
 * harmlessly) the account section — this pass doesn't touch its content
 * hierarchy at all. What changed is that Home/Events/account no longer
 * *require* opening it on desktop; it's why the trigger's accessible
 * name here says "room details," not "navigation."
 */
export function DesktopRoomHeader({
  eventTitle,
  roomStatus,
  countdownText,
  participantCount,
  connectionStatus,
  identity,
  identityAvatarUrl = null,
  onOpenRoomInfo,
}: {
  eventTitle: string;
  roomStatus: RoomStatus;
  countdownText?: string | null;
  participantCount: number;
  connectionStatus: "unavailable" | "connecting" | "connected" | "reconnecting" | "disconnected";
  identity: Identity;
  identityAvatarUrl?: string | null;
  onOpenRoomInfo: () => void;
}) {
  return (
    <div
      data-testid="desktop-room-header"
      className="flex shrink-0 items-center gap-4 border-b border-border bg-surface px-4 py-2"
    >
      <div className="flex shrink-0 items-center gap-4">
        <Link
          href="/"
          aria-label="Virtual Stage home"
          className="text-sm font-semibold tracking-wide whitespace-nowrap hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          VIRTUAL STAGE
        </Link>
        <Link
          href="/events"
          aria-label="Browse events"
          className="text-sm text-muted whitespace-nowrap hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        >
          Events
        </Link>
      </div>

      <div aria-hidden="true" className="h-6 w-px shrink-0 bg-border" />

      <RoomHeader
        eventTitle={eventTitle}
        roomStatus={roomStatus}
        countdownText={countdownText}
        participantCount={participantCount}
        connectionStatus={connectionStatus}
        onOpenRoomInfo={onOpenRoomInfo}
        roomInfoAriaLabel={`Room details for ${eventTitle}`}
        className="min-w-0 flex-1 border-b-0 px-0 py-0"
      />

      <div className="shrink-0">
        {identity.type === "guest" ? (
          <div className="flex items-center gap-2">
            <ButtonLink href="/login" variant="ghost" className="px-3.5 whitespace-nowrap">
              Log in
            </ButtonLink>
            <ButtonLink href="/signup" variant="primary" className="px-3.5 whitespace-nowrap">
              Sign up
            </ButtonLink>
          </div>
        ) : (
          <HomeAccountMenu displayName={identity.displayName} username={identity.username} avatarUrl={identityAvatarUrl} />
        )}
      </div>
    </div>
  );
}
