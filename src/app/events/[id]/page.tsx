import { notFound } from "next/navigation";
import { EventEntryStatus } from "@/components/events/event-entry-status";
import { formatEventDateTime } from "@/lib/events";
import { getEventById } from "@/lib/repositories/events";

export default async function EventDetailPage(props: PageProps<"/events/[id]">) {
  const { id } = await props.params;
  const event = await getEventById(id);

  if (!event) {
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
      <h1 className="mb-2 text-2xl font-semibold">{event.title}</h1>
      <p className="mb-6 text-sm text-muted">{formatEventDateTime(event.scheduled_start)}</p>
      {event.description && <p className="mb-8 text-base leading-relaxed">{event.description}</p>}
      <EventEntryStatus eventId={event.id} event={event} />
    </main>
  );
}
