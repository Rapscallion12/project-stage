import { redirect } from "next/navigation";

/**
 * Issue #17: `/events/[id]` is now the one event URL — the lobby and the
 * live room are the same persistent experience, not separate routes.
 * This stays only as a backward-compatible redirect for any link shared
 * before this change. `actions.ts` in this same directory stays put —
 * it's a co-located Server Actions module, not tied to this route
 * actually rendering anything.
 */
export default async function RoomPage(props: PageProps<"/events/[id]/room">) {
  const { id } = await props.params;
  redirect(`/events/${id}`);
}
