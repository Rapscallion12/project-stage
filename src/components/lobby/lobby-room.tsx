"use client";

import { ChatPanel } from "@/components/lobby/chat-panel";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { ButtonLink } from "@/components/ui/button";
import { useLobbyRealtime, type LobbyMessage, type ReactionState } from "@/hooks/use-lobby-realtime";
import { useNow } from "@/hooks/use-now";
import { formatCountdown, formatEventDateTime, getEventPhase, type EventTiming } from "@/lib/events";
import type { Identity } from "@/lib/identity";

type EventInfo = EventTiming & { id: string; title: string };

/**
 * Top-level lobby orchestrator — the one place useLobbyRealtime is
 * called. Everything below it (ChatPanel, banner, sidebar) is
 * presentation only, reading from this component's state. See
 * ARCHITECTURE.md's mobile orientation implementation notes: this
 * structure — live state owned above, presentation split below — is
 * exactly the shape that will matter once the live room adds real
 * orientation-specific layouts. The lobby itself doesn't branch by
 * orientation (see ARCHITECTURE.md for why), just by width via Tailwind.
 */
export function LobbyRoom({
  event,
  identity,
  initialMessages,
  initialReactions,
}: {
  event: EventInfo;
  identity: Identity;
  initialMessages: LobbyMessage[];
  initialReactions: Record<string, ReactionState>;
}) {
  const { messages, reactions, attendeeCount } = useLobbyRealtime(
    event.id,
    identity,
    initialMessages,
    initialReactions,
  );

  const nowMs = useNow();
  const now = nowMs === null ? null : new Date(nowMs);
  const phase = now ? getEventPhase(event, now) : "lobby_open";

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex flex-col gap-4 border-b border-border p-5 md:w-72 md:shrink-0 md:border-b-0 md:border-r">
        <div>
          <h1 className="text-lg font-semibold">{event.title}</h1>
          <p className="text-xs text-muted">{formatEventDateTime(event.scheduled_start)}</p>
        </div>

        <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
          {phase === "ready" ? (
            <div>
              <p className="mb-3 text-sm font-medium text-accent">
                This event is starting now — the live conversation is open.
              </p>
              <ButtonLink href={`/events/${event.id}/room`} className="w-full sm:w-auto">
                Enter the room
              </ButtonLink>
            </div>
          ) : (
            <p className="text-sm text-muted">
              Pre-show lobby — the live conversation hasn&apos;t started yet.
              {now && (
                <>
                  {" "}Starts in{" "}
                  <span className="font-medium text-foreground">
                    {formatCountdown(event.scheduled_start, now)}
                  </span>
                  .
                </>
              )}
            </p>
          )}
        </div>

        <p className="text-sm text-muted">
          <span className="font-medium text-foreground">{attendeeCount}</span>{" "}
          {attendeeCount === 1 ? "person" : "people"} here now
        </p>

        {identity.type === "guest" && <GuestNameEditor initialName={identity.displayName} />}
      </aside>

      <ChatPanel eventId={event.id} messages={messages} reactions={reactions} />
    </div>
  );
}
