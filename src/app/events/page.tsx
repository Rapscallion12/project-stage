import { EventCard } from "@/components/events/event-card";
import { getEventsListCutoffIso } from "@/lib/events";
import { listUpcomingEvents } from "@/lib/repositories/events";

export default async function EventsPage() {
  const events = await listUpcomingEvents(getEventsListCutoffIso());

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-16">
      <h1 className="mb-1 text-2xl font-semibold">Upcoming events</h1>
      <p className="mb-8 text-sm text-muted">
        No account needed to watch — join any event below as a guest.
      </p>
      {events.length > 0 ? (
        <div className="flex flex-col gap-4">
          {events.map((event) => (
            <EventCard key={event.id} event={event} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted">
          Nothing scheduled right now — check back soon.
        </p>
      )}
    </main>
  );
}
