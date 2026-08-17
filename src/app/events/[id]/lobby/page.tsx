import { redirect } from "next/navigation";

/**
 * Issue #17: `/events/[id]` is now the one event URL — the lobby and the
 * live room are the same persistent experience, not separate routes.
 * This stays only as a backward-compatible redirect for any link shared
 * before this change.
 */
export default async function LobbyPage(props: PageProps<"/events/[id]/lobby">) {
  const { id } = await props.params;
  redirect(`/events/${id}`);
}
