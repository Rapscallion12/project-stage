/**
 * Event timing is derived entirely from `scheduled_start` and
 * `lobby_opens_at` — there is no stored status column. That keeps
 * transitioning between phases a read-time computation instead of a write
 * (a cron job or manual trigger flipping a status field), which matters
 * as attendee count grows: every visitor computing their own phase from
 * two timestamps costs nothing; a shared mutable status column would be a
 * write bottleneck and a staleness risk for no benefit here.
 */
export type EventPhase = "upcoming" | "lobby_open" | "ready";

export type EventTiming = {
  scheduled_start: string;
  lobby_opens_at: string;
};

export function getEventPhase(event: EventTiming, now: Date = new Date()): EventPhase {
  const start = new Date(event.scheduled_start).getTime();
  const lobbyOpensAt = new Date(event.lobby_opens_at).getTime();
  const nowMs = now.getTime();

  if (nowMs >= start) return "ready";
  if (nowMs >= lobbyOpensAt) return "lobby_open";
  return "upcoming";
}

/** Compact countdown string like "2d 4h", "1h 12m", or "45s" — coarsest two units, never more. */
export function formatCountdown(targetIso: string, now: Date = new Date()): string {
  const diffMs = new Date(targetIso).getTime() - now.getTime();
  if (diffMs <= 0) return "0s";

  const totalSeconds = Math.floor(diffMs / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Cutoff for the events list query: hides events that started more than
 * this long ago, without needing an "ended" lifecycle (out of scope this
 * milestone — see ROADMAP.md). A plain helper, not called inline from a
 * component body, so the `new Date()` default lives here rather than as
 * an impure call inside a Server Component's render.
 */
export function getEventsListCutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
}

export function formatEventDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
