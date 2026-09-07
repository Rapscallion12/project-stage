"use client";

import { useState, useTransition } from "react";
import { cn } from "@/lib/utils";
import { addReaction } from "@/app/events/[id]/lobby/actions";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";

export function MessageItem({
  message,
  reaction,
  onRetry,
}: {
  message: LobbyMessage;
  reaction: ReactionState | undefined;
  /**
   * Real-device report (optimistic-send redesign, Section 16 — "both
   * composer surfaces... same underlying system"): the full (non-compact)
   * `ChatPanel` renders live comments through this same `submitComment`
   * path, so an own message here can be `optimisticStatus: "sending"` or
   * `"failed"` exactly like `ExpandedComments`' `CommentRow`. `onRetry`
   * is `useLobbyRealtime`'s `retryComment`, called with this message's own
   * id — undefined for callers (or messages) that never need it.
   */
  onRetry?: (id: string) => void;
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
        {message.is_speaker_request && (
          <span
            className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent"
            title="Requested the mic"
          >
            🎤 requesting to speak
          </span>
        )}
        {message.optimisticStatus === "failed" ? (
          <button
            type="button"
            onClick={() => onRetry?.(message.id)}
            className="text-xs font-medium text-red-500 underline-offset-2 hover:underline"
          >
            Not sent · Retry
          </button>
        ) : message.optimisticStatus === "sending" ? (
          <span className="text-xs text-muted/70">Sending…</span>
        ) : (
          <span className="text-xs text-muted">{time}</span>
        )}
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
            reacted ? "border-accent bg-accent/10 text-accent" : "text-muted hover:bg-surface-hover",
          )}
        >
          👍 {count > 0 && count}
        </button>
      </div>
    </div>
  );
}
