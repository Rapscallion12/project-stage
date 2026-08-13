import Link from "next/link";
import { notFound } from "next/navigation";
import { Button, ButtonLink } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { resolveIdentity } from "@/lib/identity";
import { isDevToolsAvailable } from "@/lib/dev-demo";
import { listActiveSpeakersForDevEvent, listDevDemoEvents } from "@/lib/repositories/dev-demo";
import { createDemoEvent, resetDemoEvents, seatMe } from "./actions";

/**
 * Local-only usability-testing entry point — create a live event, open
 * its room, and seat yourself as a speaker without the CLI
 * (`scripts/dev-harness.mts`, still the right tool for a synthetic
 * second speaker's account). Not a product feature: no new schema, no
 * new RPC, no new authorization path — every write here goes through
 * `claimSpeakerSeat` (issue #13) and a plain `events` insert via the
 * same trusted service client the rest of this app's dev/backend tooling
 * already uses. See DECISIONS.md for the full design.
 *
 * `notFound()` here is the first of two independent guards — every
 * Server Action this page calls (`./actions.ts`) checks
 * `isDevToolsAvailable()` itself too, since an action's endpoint is
 * reachable independently of whether this page ever rendered.
 */
export default async function DevPage() {
  if (!isDevToolsAvailable()) {
    notFound();
  }

  const identity = await resolveIdentity();
  const events = await listDevDemoEvents();
  const eventsWithSpeakers = await Promise.all(
    events.map(async (event) => ({ event, speakers: await listActiveSpeakersForDevEvent(event.id) })),
  );

  return (
    <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-12">
      <h1 className="mb-1 text-2xl font-semibold">Dev / demo tools</h1>
      <p className="mb-8 text-sm text-muted">
        Local-only — this page (and every action on it) is inert in production. Testing
        infrastructure, not a product feature. Complements <code>npm run dev:harness</code> — see
        README.md.
      </p>

      {identity.type === "guest" ? (
        <p className="mb-8 text-sm text-muted">
          <Link href="/login" className="text-accent underline">
            Log in
          </Link>{" "}
          or{" "}
          <Link href="/signup" className="text-accent underline">
            sign up
          </Link>{" "}
          to seat yourself as a speaker.
        </p>
      ) : (
        <p className="mb-8 text-sm text-muted">
          Signed in as <span className="font-medium text-foreground">{identity.displayName}</span>.
        </p>
      )}

      <form action={createDemoEvent} className="mb-10 flex gap-2">
        <Input name="title" placeholder="Demo event title (optional)" maxLength={100} className="flex-1" />
        <Button type="submit">Create a demo event</Button>
      </form>

      {eventsWithSpeakers.length === 0 ? (
        <p className="mb-10 text-sm text-muted">No demo events yet — create one above.</p>
      ) : (
        <ul className="mb-10 flex flex-col gap-4">
          {eventsWithSpeakers.map(({ event, speakers }) => {
            const seat1 = speakers.find((s) => s.seat_number === 1)?.display_name ?? "open";
            const seat2 = speakers.find((s) => s.seat_number === 2)?.display_name ?? "open";
            return (
              <li key={event.id} className="rounded-lg border border-border p-4">
                <p className="mb-1 font-medium">{event.title}</p>
                <div className="mb-3 flex gap-3">
                  <ButtonLink href={`/events/${event.id}`} variant="ghost">
                    Event page
                  </ButtonLink>
                  <ButtonLink href={`/events/${event.id}/room`} variant="ghost">
                    Open room
                  </ButtonLink>
                </div>
                <p className="mb-3 text-xs text-muted">
                  Seat 1: {seat1} · Seat 2: {seat2}
                </p>
                {identity.type === "profile" && (
                  <div className="flex gap-2">
                    <form action={seatMe.bind(null, event.id, 1)}>
                      <Button type="submit" variant="secondary">
                        Seat me in seat 1
                      </Button>
                    </form>
                    <form action={seatMe.bind(null, event.id, 2)}>
                      <Button type="submit" variant="secondary">
                        Seat me in seat 2
                      </Button>
                    </form>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <form action={resetDemoEvents}>
        <Button type="submit" variant="ghost">
          Reset all demo events
        </Button>
      </form>
    </main>
  );
}
