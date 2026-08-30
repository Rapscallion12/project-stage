import { cn } from "@/lib/utils";
import { ROOM_STATUS_LABEL, type RoomStatus } from "@/lib/room-status";

/**
 * Event title, room status, and audience count — the room's "what's
 * happening" summary. `roomStatus` is always shown, regardless of
 * `connectionStatus` — the room's status (from `event_speakers`) doesn't
 * depend on whether *this particular viewer's* LiveKit connection is
 * healthy. `connectionStatus` only surfaces here when this viewer's own
 * connection is degraded, since a healthy connection has nothing worth
 * saying. `countdownText` (issue #17) is appended when the event hasn't
 * gone live yet — "Waiting for speakers" stays literally true pre-show
 * (nobody has claimed a seat), the countdown just adds *when* on top of
 * it, rather than replacing it.
 *
 * `compact` (real-device finding, 2026-08-22): a phone in landscape has
 * little vertical room to spare, so `MobileLandscapeRoom` renders this
 * with tighter padding/type — same information, same markup, just less
 * of it reserved permanently. Portrait/desktop don't pass this; they
 * have room to spare.
 */
export function RoomHeader({
  eventTitle,
  roomStatus,
  countdownText,
  participantCount,
  connectionStatus,
  compact = false,
  onOpenRoomInfo,
}: {
  eventTitle: string;
  roomStatus: RoomStatus;
  countdownText?: string | null;
  participantCount: number;
  connectionStatus: "unavailable" | "connecting" | "connected" | "reconnecting" | "disconnected";
  compact?: boolean;
  /** Issue #21, seventh corrective pass, Section 9: opens the room/navigation overlay — the single entry point for Home/Events/account actions now that the site-wide header is hidden for the whole time a room is mounted. Optional so tests that don't care can omit it; every real caller (DesktopRoom) always passes it. */
  onOpenRoomInfo?: () => void;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-between gap-3 border-b border-border",
        compact ? "px-3 py-1" : "px-4 py-3",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {onOpenRoomInfo && (
          <button
            type="button"
            data-testid="room-info-trigger"
            onClick={onOpenRoomInfo}
            aria-label={`Room info and navigation for ${eventTitle}`}
            className="shrink-0 rounded-full border border-border px-2 py-1 text-xs text-muted hover:bg-foreground/5 hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          >
            ☰
          </button>
        )}
        <div className="min-w-0">
          <h1 className={cn("truncate font-semibold", compact ? "text-sm" : "text-base")}>{eventTitle}</h1>
          {/* Kept even when compact — connection warnings ("Connection lost") matter most on a
              constrained mobile-landscape viewport, not less; only the size shrinks. */}
          <p className={cn("text-muted", compact ? "text-[10px]" : "text-xs")}>
            {ROOM_STATUS_LABEL[roomStatus]}
            {countdownText && ` · ${countdownText}`}
            {connectionStatus === "connecting" && " · Connecting…"}
            {connectionStatus === "reconnecting" && " · Reconnecting…"}
            {connectionStatus === "disconnected" && " · Connection lost"}
            {connectionStatus === "unavailable" && " · Live video isn't configured for this room"}
          </p>
        </div>
      </div>
      <p className={cn("shrink-0 text-muted", compact ? "text-[10px]" : "text-xs")}>
        <span className="font-medium text-foreground">{participantCount}</span> watching
      </p>
    </div>
  );
}
