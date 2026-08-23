"use client";

import { useActionState, useEffect, useRef } from "react";
import { sendMessage } from "@/app/events/[id]/lobby/actions";
import { submitSpeakerRequest } from "@/app/events/[id]/room/actions";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { MessageItem } from "@/components/lobby/message-item";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";

const QUICK_EMOJI = ["😂", "🔥", "👀", "❤️", "😮", "🎉"];

/**
 * One composer, two modes (issue #27) — never a second form elsewhere in
 * the room. Normal mode posts a chat message (`sendMessage`, unchanged);
 * activating 🎤 switches the *same* input/button pair into speaker-
 * request mode (`submitSpeakerRequest`, a thin adapter over the existing
 * authoritative `requestToSpeak` — see room/actions.ts), which both
 * posts the request's badged chat message and creates its
 * `speaker_requests` row atomically, exactly as the removed standalone
 * "Request the mic" form already did. Two separate `useActionState`
 * hooks (one per action, `useActionState` only ever binds one action
 * each) rather than one, but only one input/button pair is ever
 * rendered — the mode decides which hook's state/action/pending governs
 * it, not which component is mounted.
 *
 * `micRequestMode` is a controlled prop, not local state — tapping an
 * empty seat that turns out to have a queue (see `SpeakerTile`/
 * `EventRoom`) needs to switch this *same* composer into request mode
 * from outside it, which only works if something above both can set it.
 *
 * Issue #22: submitting the request form is also the gesture that
 * acquires camera/mic (`onPrepareMedia`) — called directly from the
 * form's own `onSubmit`, synchronously, in the same call stack as the
 * click/tap that triggered it. This is deliberately a plain event
 * handler, not something chained off the server action's own pending
 * state or a `.then()` — same Safari gesture requirement as
 * `activateMedia` (see useLiveRoomConnection). It never calls
 * `preventDefault()`, so React's `action` still submits the request
 * normally; the two just both react to the same click. Ordinary
 * comment submission never touches `onPrepareMedia` at all — only the
 * `micRequestMode` branch's `onSubmit` calls it, so a plain "just
 * commenting" viewer is never prompted for camera/mic permission.
 *
 * `compact` (issue #21, "05 — Social Stage" Phase 2): renders only the
 * form itself — no message history, no quick-emoji row — as a small
 * translucent "glass" pill for Watch Mode's persistent bottom
 * composer. Same two `useActionState` hooks, same `micRequestMode`
 * contract, same synchronous `onPrepareMedia()` submit order as above
 * — nothing about the actions/gesture-safety logic is duplicated or
 * reimplemented, only the JSX differs. `messages`/`reactions` are
 * simply unused in this mode (still required props so callers that
 * already have them in scope — `RoomLayoutProps` — don't need a
 * separate code path to obtain them).
 */
export function ChatPanel({
  eventId,
  messages,
  reactions,
  micRequestMode,
  onMicRequestModeChange,
  onHasPendingRequestChange,
  onPrepareMedia,
  compact = false,
}: {
  eventId: string;
  messages: LobbyMessage[];
  reactions: Record<string, ReactionState>;
  micRequestMode: boolean;
  onMicRequestModeChange: (value: boolean) => void;
  onHasPendingRequestChange: (value: boolean) => void;
  onPrepareMedia: () => Promise<void>;
  compact?: boolean;
}) {
  const [sendState, sendFormAction, sendPending] = useActionState(sendMessage.bind(null, eventId), undefined);
  const [requestState, requestFormAction, requestPending] = useActionState(
    submitSpeakerRequest.bind(null, eventId),
    undefined,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const wasPending = useRef(false);

  const pending = micRequestMode ? requestPending : sendPending;
  const error = micRequestMode ? requestState?.error : sendState?.error;

  // Clear the input and refocus once a submission completes successfully
  // (no error from whichever mode was actually active — not both raw
  // states, since a stale error from the *other* mode's last attempt
  // must never block this one) — covers both modes, since only one is
  // ever pending at a time. A successful request also flips
  // hasPendingRequest and drops back to normal mode, the same way a
  // granted claim already updates RoomControls elsewhere.
  useEffect(() => {
    if (wasPending.current && !pending) {
      if (!error) {
        if (inputRef.current) {
          inputRef.current.value = "";
          inputRef.current.focus();
        }
        if (micRequestMode) {
          onHasPendingRequestChange(true);
          onMicRequestModeChange(false);
        }
      }
    }
    wasPending.current = pending;
    // Deliberately not depending on the callbacks themselves — this
    // effect only cares about the pending->settled transition, the same
    // "did the transition just happen" check the original single-mode
    // version used.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, error]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  function insertEmoji(emoji: string) {
    if (!inputRef.current) return;
    inputRef.current.value += emoji;
    inputRef.current.focus();
  }

  const form = (
    <form
      data-testid="chat-composer-form"
      action={micRequestMode ? requestFormAction : sendFormAction}
      onSubmit={
        micRequestMode
          ? () => {
              void onPrepareMedia();
            }
          : undefined
      }
      className={compact ? "flex items-center gap-2" : "flex gap-2"}
    >
      {compact ? (
        <div
          className={cn(
            "flex h-11 flex-1 items-center gap-2 rounded-full border px-1 pr-3 transition-colors",
            micRequestMode ? "border-accent/60 bg-accent/15" : "border-white/30 bg-white/[0.14]",
          )}
        >
          <button
            type="button"
            data-testid="watch-composer-mic"
            onClick={() => onMicRequestModeChange(!micRequestMode)}
            disabled={pending}
            aria-pressed={micRequestMode}
            aria-label={micRequestMode ? "Cancel speaker request" : "Request to speak"}
            className={cn(
              "flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full text-xs transition-colors disabled:opacity-50",
              micRequestMode ? "bg-accent text-white" : "bg-white/10 text-white/80",
            )}
          >
            🎙
          </button>
          <input
            ref={inputRef}
            name="body"
            placeholder={micRequestMode ? "What do you want to talk about?" : "Add a comment…"}
            autoComplete="off"
            maxLength={500}
            required
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/50 focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending}
            aria-label={micRequestMode ? "Send speaker request" : "Send comment"}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/15 text-xs text-white disabled:opacity-50"
          >
            ↑
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => onMicRequestModeChange(!micRequestMode)}
            disabled={pending}
            aria-pressed={micRequestMode}
            aria-label={micRequestMode ? "Cancel speaker request" : "Request to speak"}
            className={cn(
              "flex min-h-11 w-11 shrink-0 items-center justify-center rounded-full border text-base transition-colors disabled:opacity-50",
              micRequestMode
                ? "border-accent bg-accent/15 text-accent"
                : "border-border text-muted hover:bg-foreground/5",
            )}
          >
            🎤
          </button>
          <Input
            ref={inputRef}
            name="body"
            placeholder={micRequestMode ? "What do you want to talk about?" : "Say something…"}
            autoComplete="off"
            maxLength={500}
            required
            className="flex-1"
          />
          <Button type="submit" disabled={pending}>
            {micRequestMode ? (pending ? "Requesting…" : "Request") : pending ? "Sending…" : "Send"}
          </Button>
        </>
      )}
    </form>
  );

  if (compact) {
    return (
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {form}
        {error && (
          <p className="rounded-lg bg-black/35 px-3 py-1.5 text-xs text-red-400" role="alert">
            {error}
          </p>
        )}
      </div>
    );
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
        {form}
        {error && (
          <p className="mt-1.5 text-xs text-red-500" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
