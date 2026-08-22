import { NextResponse } from "next/server";
import { findJoinableEvent } from "@/lib/repositories/events";

/**
 * Landing page's "Join Live Audience" fast path (issue #26) — a plain GET
 * redirect, not a page: there's nothing to render here, no confirmation
 * step, exactly one navigation from the landing page's link to the
 * destination room. Selection logic lives in `findJoinableEvent`
 * (`lib/repositories/events.ts`), not here — this route is only "pick a
 * destination, redirect."
 *
 * The visitor arrives at `/events/[id]` exactly the way anyone tapping an
 * `EventCard` does — same guest identity (minted proxy-wide, see
 * `src/proxy.ts`), same unified room, same "audience by default" state.
 * Nothing here requests the mic, claims a seat, or activates media; this
 * route's only job is choosing *which* room, never *what happens* once
 * there.
 *
 * Falls back to Browse Events, never a broken destination, if nothing is
 * currently joinable — a real possibility this prototype must handle
 * gracefully, not assume away.
 */
export async function GET(request: Request) {
  const event = await findJoinableEvent();
  const destination = event ? `/events/${event.id}` : "/events";
  return NextResponse.redirect(new URL(destination, request.url));
}
