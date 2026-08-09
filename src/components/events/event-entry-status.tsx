"use client";

import { ButtonLink } from "@/components/ui/button";
import { useNow } from "@/hooks/use-now";
import { formatCountdown, getEventPhase, type EventTiming } from "@/lib/events";

/**
 * Live-updating countdown + "Enter Lobby" CTA. A client component so the
 * CTA appears on its own once the lobby opens or the event goes live,
 * without requiring the visitor to refresh — the whole point of showing a
 * countdown is that the page stays truthful while they watch it.
 */
export function EventEntryStatus({ eventId, event }: { eventId: string; event: EventTiming }) {
  const nowMs = useNow();

  if (nowMs === null) return null;

  const now = new Date(nowMs);
  const phase = getEventPhase(event, now);

  if (phase === "upcoming") {
    return (
      <div className="rounded-xl border border-border p-5">
        <p className="text-sm text-muted">
          Lobby opens in{" "}
          <span className="font-medium text-foreground">
            {formatCountdown(event.lobby_opens_at, now)}
          </span>
        </p>
      </div>
    );
  }

  if (phase === "lobby_open") {
    return (
      <div className="rounded-xl border border-accent/40 bg-accent/5 p-5">
        <p className="mb-4 text-sm text-muted">
          Live conversation starts in{" "}
          <span className="font-medium text-foreground">
            {formatCountdown(event.scheduled_start, now)}
          </span>
          {" — the pre-show lobby is open now."}
        </p>
        <ButtonLink href={`/events/${eventId}/lobby`} className="w-full sm:w-auto">
          Enter Lobby
        </ButtonLink>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-accent/40 bg-accent/5 p-5">
      <p className="mb-4 text-sm font-medium text-accent">
        This event is starting now.
      </p>
      <ButtonLink href={`/events/${eventId}/lobby`} className="w-full sm:w-auto">
        Enter Lobby
      </ButtonLink>
    </div>
  );
}
