import Link from "next/link";
import { EventCountdown } from "@/components/events/event-countdown";
import { formatEventDateTime } from "@/lib/events";
import type { Event } from "@/lib/repositories/events";

export function EventCard({ event }: { event: Event }) {
  return (
    <Link
      href={`/events/${event.id}`}
      className="block rounded-xl border border-border p-5 transition-colors hover:bg-foreground/5"
    >
      <div className="mb-2 flex items-start justify-between gap-4">
        <h3 className="text-lg font-semibold">{event.title}</h3>
        <EventCountdown event={event} />
      </div>
      {event.description && (
        <p className="mb-3 line-clamp-2 text-sm text-muted">{event.description}</p>
      )}
      <p className="text-xs text-muted">{formatEventDateTime(event.scheduled_start)}</p>
    </Link>
  );
}
