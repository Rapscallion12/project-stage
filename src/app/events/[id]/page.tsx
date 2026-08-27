import { notFound } from "next/navigation";
import { EventRoom } from "@/components/room/event-room";
import { getEventPhase } from "@/lib/events";
import { resolveIdentity } from "@/lib/identity";
import { getEventById } from "@/lib/repositories/events";
import { listActiveSpeakers } from "@/lib/repositories/event-speakers";
import { listRecentMessages, listReactionsForMessages } from "@/lib/repositories/chat";
import { getPendingRequestForIdentity, listPendingSpeakerRequests } from "@/lib/repositories/speaker-requests";
import { isPreviewOrDevBuild } from "@/lib/preview-mode";
import { getLiveKitToken } from "./room/actions";
import type { ReactionState } from "@/hooks/use-lobby-realtime";

const HISTORY_LIMIT = 100;

/**
 * The one event URL (issue #17) — replaces the old event-detail →
 * `/lobby` → `/room` three-route split. Fetches everything a viewer
 * could need regardless of phase (speakers, chat, a LiveKit token, their
 * own pending-request status) and hands it all to one persistent client
 * component, which decides what to show and when to actually connect to
 * LiveKit. No phase-based redirect here — someone arriving before the
 * lobby opens, during it, or after the show already started all land on
 * this same URL and get the correct state on first paint, computed from
 * `initialPhase` below.
 */
export default async function EventPage(props: PageProps<"/events/[id]">) {
  const { id } = await props.params;

  const event = await getEventById(id);
  if (!event) {
    notFound();
  }

  const identity = await resolveIdentity();
  const [speakers, messages, tokenResult, myPendingRequest, pendingRequests] = await Promise.all([
    listActiveSpeakers(id),
    listRecentMessages(id, HISTORY_LIMIT),
    getLiveKitToken(id),
    getPendingRequestForIdentity(id, identity),
    listPendingSpeakerRequests(id),
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
      <EventRoom
        event={event}
        identity={identity}
        initialPhase={getEventPhase(event)}
        initialToken={"token" in tokenResult ? tokenResult.token : null}
        initialSpeakers={speakers}
        initialMessages={messages.slice().reverse()}
        initialReactions={initialReactions}
        initialHasPendingRequest={myPendingRequest !== null}
        initialPendingRequests={pendingRequests}
        isPreviewBuild={isPreviewOrDevBuild()}
      />
    </div>
  );
}
