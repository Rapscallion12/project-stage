"use client";

import { useNow } from "@/hooks/use-now";
import { formatCountdown, getEventPhase, type EventTiming } from "@/lib/events";

/** Live-updating countdown + phase label. Ticks client-side only — the server-rendered initial value is a reasonable snapshot, not a source of truth that needs to stay in sync. */
export function EventCountdown({ event }: { event: EventTiming }) {
  const nowMs = useNow();

  // Avoid a hydration mismatch: render nothing time-dependent until the
  // client clock has ticked once past the server-rendered snapshot.
  if (nowMs === null) return <span className="text-sm text-muted">…</span>;

  const now = new Date(nowMs);
  const phase = getEventPhase(event, now);

  if (phase === "ready") {
    return <span className="text-sm font-medium text-accent">Live now</span>;
  }

  if (phase === "lobby_open") {
    return (
      <span className="text-sm text-muted">
        Starts in <span className="font-medium text-foreground">{formatCountdown(event.scheduled_start, now)}</span>
      </span>
    );
  }

  return (
    <span className="text-sm text-muted">
      Lobby opens in{" "}
      <span className="font-medium text-foreground">{formatCountdown(event.lobby_opens_at, now)}</span>
    </span>
  );
}
