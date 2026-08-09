"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { addReaction } from "@/app/events/[id]/lobby/actions";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";

export function MessageItem({
  message,
  reaction,
}: {
  message: LobbyMessage;
  reaction: ReactionState | undefined;
}) {
  const [pending, startTransition] = useTransition();
  const [optimisticallyReacted, setOptimisticallyReacted] = useState(false);

  const reacted = reaction?.reactedByMe || optimisticallyReacted;
  const count = reaction?.count ?? 0;

  function handleReact() {
    if (reacted || pending) return;
    setOptimisticallyReacted(true);
    startTransition(async () => {
      const result = await addReaction(message.id);
      if (result.error) setOptimisticallyReacted(false);
    });
  }

  const time = new Date(message.created_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className="flex flex-col gap-0.5 py-1.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium">{message.author_display_name}</span>
        <span className="text-xs text-muted">{time}</span>
      </div>
      <div className="flex items-end gap-2">
        <p className="break-words text-sm">{message.body}</p>
        <button
          type="button"
          onClick={handleReact}
          disabled={reacted || pending}
          aria-label="React with thumbs up"
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs transition-colors",
            reacted ? "border-accent bg-accent/10 text-accent" : "text-muted hover:bg-foreground/5",
          )}
        >
          👍 {count > 0 && count}
        </button>
      </div>
    </div>
  );
}
