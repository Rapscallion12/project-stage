import { notFound, redirect } from "next/navigation";
import { LiveRoom } from "@/components/room/live-room";
import { getEventPhase } from "@/lib/events";
import { resolveIdentity } from "@/lib/identity";
import { getEventById } from "@/lib/repositories/events";
import { listActiveSpeakers } from "@/lib/repositories/event-speakers";
import { listRecentMessages, listReactionsForMessages } from "@/lib/repositories/chat";
import { getPendingRequestForProfile } from "@/lib/repositories/speaker-requests";
import { getLiveKitToken } from "./actions";
import type { ReactionState } from "@/hooks/use-lobby-realtime";

const HISTORY_LIMIT = 100;

export default async function RoomPage(props: PageProps<"/events/[id]/room">) {
  const { id } = await props.params;

  const event = await getEventById(id);
  if (!event) {
    notFound();
  }

  // The room isn't enterable before the event actually goes live — send
  // early visitors back to the lobby's countdown instead of an empty
  // room, same precedent as the lobby redirecting visitors back to the
  // event page before lobby_opens_at.
  if (getEventPhase(event) !== "ready") {
    redirect(`/events/${id}/lobby`);
  }

  const identity = await resolveIdentity();
  const [speakers, messages, tokenResult, myPendingRequest] = await Promise.all([
    listActiveSpeakers(id),
    listRecentMessages(id, HISTORY_LIMIT),
    getLiveKitToken(id),
    identity.type === "profile" ? getPendingRequestForProfile(id, identity.id) : Promise.resolve(null),
  ]);
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
      <LiveRoom
        event={event}
        identity={identity}
        initialToken={"token" in tokenResult ? tokenResult.token : null}
        initialSpeakers={speakers}
        initialMessages={messages.slice().reverse()}
        initialReactions={initialReactions}
        initialHasPendingRequest={myPendingRequest !== null}
      />
    </div>
  );
}
