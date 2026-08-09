import { notFound, redirect } from "next/navigation";
import { LobbyRoom } from "@/components/lobby/lobby-room";
import { getEventPhase } from "@/lib/events";
import { resolveIdentity } from "@/lib/identity";
import { getEventById } from "@/lib/repositories/events";
import { listRecentMessages, listReactionsForMessages } from "@/lib/repositories/chat";
import type { ReactionState } from "@/hooks/use-lobby-realtime";

const HISTORY_LIMIT = 100;

export default async function LobbyPage(props: PageProps<"/events/[id]/lobby">) {
  const { id } = await props.params;

  const event = await getEventById(id);
  if (!event) {
    notFound();
  }

  // The lobby isn't a thing to browse into early — before lobby_opens_at
  // there's nothing here yet, so send visitors back to the detail page's
  // countdown instead of showing an empty room.
  if (getEventPhase(event) === "upcoming") {
    redirect(`/events/${id}`);
  }

  const identity = await resolveIdentity();
  const messages = await listRecentMessages(id, HISTORY_LIMIT);
  const reactionRows = await listReactionsForMessages(messages.map((m) => m.id));

  const initialReactions: Record<string, ReactionState> = {};
  for (const row of reactionRows) {
    const existing = initialReactions[row.message_id] ?? { count: 0, reactedByMe: false };
    const isMine =
      identity.type === "profile"
        ? row.reactor_profile_id === identity.id
        : row.reactor_guest_id === identity.id;
    initialReactions[row.message_id] = {
      count: existing.count + 1,
      reactedByMe: existing.reactedByMe || isMine,
    };
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <LobbyRoom
        event={event}
        identity={identity}
        initialMessages={messages.slice().reverse()}
        initialReactions={initialReactions}
      />
    </div>
  );
}
