import { ROOM_STATUS_LABEL, type RoomStatus } from "@/lib/room-status";

/**
 * Event title, room status, and audience count — the room's "what's
 * happening" summary. `roomStatus` is always shown, regardless of
 * `connectionStatus` — the room's status (from `event_speakers`) doesn't
 * depend on whether *this particular viewer's* LiveKit connection is
 * healthy. `connectionStatus` only surfaces here when this viewer's own
 * connection is degraded, since a healthy connection has nothing worth
 * saying.
 */
export function RoomHeader({
  eventTitle,
  roomStatus,
  participantCount,
  connectionStatus,
}: {
  eventTitle: string;
  roomStatus: RoomStatus;
  participantCount: number;
  connectionStatus: "unavailable" | "connecting" | "connected" | "reconnecting" | "disconnected";
}) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold">{eventTitle}</h1>
        <p className="text-xs text-muted">
          {ROOM_STATUS_LABEL[roomStatus]}
          {connectionStatus === "connecting" && " · Connecting…"}
          {connectionStatus === "reconnecting" && " · Reconnecting…"}
          {connectionStatus === "disconnected" && " · Connection lost"}
          {connectionStatus === "unavailable" && " · Live video isn't configured for this room"}
        </p>
      </div>
      <p className="shrink-0 text-xs text-muted">
        <span className="font-medium text-foreground">{participantCount}</span> watching
      </p>
    </div>
  );
}
