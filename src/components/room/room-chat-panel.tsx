import { ChatPanel } from "@/components/lobby/chat-panel";
import { cn } from "@/lib/utils";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";

/**
 * Wraps the same chat the lobby uses (`event_chat_messages` is
 * event-scoped, not lobby-phase-scoped, so the conversation carries
 * straight over into the room) and reserves a slot above the feed for a
 * future pinned/expandable "Featured Comments" section.
 *
 * `featuredSlot` is always `undefined` today — nothing calls this with a
 * value yet, and building Featured Comments itself is explicitly out of
 * this issue's scope. The slot exists so that feature is an *addition* to
 * this component later (pass a node here) rather than a restructure of
 * the room's layout — see DECISIONS.md.
 */
export function RoomChatPanel({
  eventId,
  messages,
  reactions,
  micRequestMode,
  onMicRequestModeChange,
  onHasPendingRequestChange,
  featuredSlot,
  className,
}: {
  eventId: string;
  messages: LobbyMessage[];
  reactions: Record<string, ReactionState>;
  micRequestMode: boolean;
  onMicRequestModeChange: (value: boolean) => void;
  onHasPendingRequestChange: (value: boolean) => void;
  featuredSlot?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {featuredSlot}
      <ChatPanel
        eventId={eventId}
        messages={messages}
        reactions={reactions}
        micRequestMode={micRequestMode}
        onMicRequestModeChange={onMicRequestModeChange}
        onHasPendingRequestChange={onHasPendingRequestChange}
      />
    </div>
  );
}
