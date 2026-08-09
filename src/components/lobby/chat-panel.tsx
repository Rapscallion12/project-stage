"use client";

import { useActionState, useEffect, useRef } from "react";
import { sendMessage } from "@/app/events/[id]/lobby/actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { MessageItem } from "@/components/lobby/message-item";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";

const QUICK_EMOJI = ["😂", "🔥", "👀", "❤️", "😮", "🎉"];

export function ChatPanel({
  eventId,
  messages,
  reactions,
}: {
  eventId: string;
  messages: LobbyMessage[];
  reactions: Record<string, ReactionState>;
}) {
  const [state, formAction, pending] = useActionState(sendMessage.bind(null, eventId), undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasPending = useRef(false);

  // Clear the input and refocus once a send completes successfully (no
  // error in state). Doesn't fire on initial mount since wasPending only
  // flips true after a real submission.
  useEffect(() => {
    if (wasPending.current && !pending && !state?.error && inputRef.current) {
      inputRef.current.value = "";
      inputRef.current.focus();
    }
    wasPending.current = pending;
  }, [pending, state]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  function insertEmoji(emoji: string) {
    if (!inputRef.current) return;
    inputRef.current.value += emoji;
    inputRef.current.focus();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="flex-1 overflow-y-auto px-4 py-2">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted">
            No messages yet — say hello.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {messages.map((message) => (
              <MessageItem key={message.id} message={message} reaction={reactions[message.id]} />
            ))}
          </div>
        )}
      </div>

      <div className="border-t border-border p-3">
        <div className="mb-2 flex gap-1">
          {QUICK_EMOJI.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => insertEmoji(emoji)}
              className="rounded-md px-1.5 py-0.5 text-base hover:bg-foreground/5"
              aria-label={`Insert ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
        <form action={formAction} className="flex gap-2">
          <Input
            ref={inputRef}
            name="body"
            placeholder="Say something…"
            autoComplete="off"
            maxLength={500}
            required
            className="flex-1"
          />
          <Button type="submit" disabled={pending}>
            Send
          </Button>
        </form>
        {state?.error && (
          <p className="mt-1.5 text-xs text-red-500" role="alert">
            {state.error}
          </p>
        )}
      </div>
    </div>
  );
}
