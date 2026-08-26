"use client";

import { useEffect, useRef, useState } from "react";
import { ChatPanel } from "@/components/lobby/chat-panel";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

/** Distance (px) from the bottom of the scroll container still counted as "at the newest comment" — matches the loose feel of "at/near the newest" from the product spec rather than requiring pixel-perfect bottom. */
const NEAR_BOTTOM_PX = 48;

/**
 * Issue #21, "Discussion Expanded" (the phase every Watch Mode doc
 * comment since Phase 3 has explicitly named as not-built-yet): an
 * intentional, tap-opened surface for *reading* the live comment stream,
 * layered over the lower portion of the room rather than replacing
 * Watch Mode's ambient default. Reuses the exact same `messages` array
 * every other room composition already receives from `useLobbyRealtime`
 * — no new backend, no duplicated message state — and the exact same
 * `ChatPanel` compact composer/actions every collapsed composition
 * already threads through, so sending from here is the identical
 * `sendMessage`/`submitSpeakerRequest` path, not a second one.
 *
 * **Opened only from an ambient comment bubble's tap**, deliberately not
 * from the collapsed composer's own focus/tap: that was tried first and
 * broke the already-approved "tap the composer, type, send" flow, since
 * every composer focus would open this full sheet before the keyboard
 * even mattered. The ambient bubbles already carried a `data-message-id`
 * seam explicitly left for this exact purpose (see `AmbientComments`'
 * own doc comment) — reusing it costs nothing and adds no new permanent
 * chrome. One known, accepted limitation of this narrow first pass: a
 * viewer can't open this sheet while zero ambient bubbles are currently
 * visible (e.g., a silent room, or between a burst's 7s fade cycles) —
 * an easy follow-up (a small dedicated affordance) if that turns out to
 * matter on real-device review.
 *
 * **Presentation-only, deliberately**: this component owns no role,
 * media, seat, or LiveKit state of anything — `open`/`onClose` are
 * plain local UI state owned by the caller (see each room composition's
 * own `commentsOpen` `useState`, never lifted into `EventRoom`). Opening
 * or closing this sheet cannot touch `participantRole`, `canPublish`,
 * seat ownership, or the promotion/inactivity timers, because it never
 * reads or writes any of them — the surest way to avoid recreating
 * issue #18's role-synchronization bugs is for this feature to have no
 * causal path to that state at all, not to carefully avoid one.
 *
 * **No drag-to-resize**: this project tried and retired gesture-driven
 * reveal twice already (see DECISIONS.md's original "dead-zone drag"
 * design and its later replacement by tap-driven Watch Mode/Comments
 * Mode). A fixed-height, tap-open/tap-close sheet stays consistent with
 * that established direction — "obvious close/collapse button," per the
 * product spec, is satisfied by an actual button, not a gesture.
 *
 * **Live-follow vs. reading-history**: `following` tracks whether the
 * viewer is at/near the newest comment. While following, a new message
 * auto-scrolls the list. Once the viewer scrolls up past
 * `NEAR_BOTTOM_PX`, `following` goes false and *nothing* about the
 * scroll position is touched by new arrivals — they only bump
 * `newSinceScrolledUp`, which drives the "New comments" pill. Scrolling
 * back near the bottom (or tapping the pill) resumes following. This is
 * the one piece of real interaction logic in this component; everything
 * else is presentation.
 *
 * **Replies (schema check, not implemented)**: `event_chat_messages` has
 * no self-referencing column today (confirmed against
 * `src/types/database.ts` and every migration) — one-level replies would
 * need a real migration (nullable FK + RLS), not a small additive
 * change, so they're deliberately out of this pass. `CommentRow` below
 * renders one flat, chronological list keyed by `message.id`; a future
 * pass can group by a `reply_to_message_id` into a `repliesByParentId`
 * map and render children indented under their parent without
 * restructuring this component or its scroll/follow logic.
 */
export function ExpandedComments({
  open,
  onClose,
  eventId,
  messages,
  micRequestMode,
  onMicRequestModeChange,
  onHasPendingRequestChange,
  onPrepareMedia,
  allowMicRequest = true,
  hasPendingRequest = false,
  onCancelPendingRequest,
}: {
  open: boolean;
  onClose: () => void;
  eventId: string;
  messages: LobbyMessage[];
  micRequestMode: boolean;
  onMicRequestModeChange: (value: boolean) => void;
  onHasPendingRequestChange: (value: boolean) => void;
  onPrepareMedia: () => Promise<void>;
  allowMicRequest?: boolean;
  hasPendingRequest?: boolean;
  onCancelPendingRequest?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [newSinceScrolledUp, setNewSinceScrolledUp] = useState(0);
  const prevLengthRef = useRef(messages.length);
  const wasOpenRef = useRef(false);

  // Opening fresh always starts at the newest comment, following live —
  // matches "returning to the newest comments resumes normal live-follow
  // behavior" for the open gesture itself, not just the jump-to-latest
  // affordance.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setFollowing(true);
      setNewSinceScrolledUp(0);
      prevLengthRef.current = messages.length;
      // No smooth animation on open — this is establishing the initial
      // position, not reacting to a live arrival.
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
    wasOpenRef.current = open;
    // messages.length deliberately excluded — this effect only cares
    // about the closed->open transition, not ongoing message growth
    // while already open (the next effect below owns that).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    const delta = messages.length - prevLengthRef.current;
    prevLengthRef.current = messages.length;
    if (!open || delta <= 0) return;

    if (following) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    } else {
      setNewSinceScrolledUp((count) => count + delta);
    }
  }, [messages.length, following, open]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distanceFromBottom < NEAR_BOTTOM_PX;
    if (atBottom && !following) {
      setFollowing(true);
      setNewSinceScrolledUp(0);
    } else if (!atBottom && following) {
      setFollowing(false);
    }
  }

  function jumpToLatest() {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: "smooth" });
    setFollowing(true);
    setNewSinceScrolledUp(0);
  }

  if (!open) return null;

  return (
    <div
      data-testid="expanded-comments"
      className="absolute inset-x-0 bottom-0 z-20 flex h-[70vh] max-h-full flex-col rounded-t-2xl border-t border-white/10 bg-black/92 shadow-[0_-8px_30px_rgba(0,0,0,0.4)] landscape:h-[85vh]"
    >
      <div className="flex shrink-0 items-center justify-between px-3 pt-2">
        <span aria-hidden="true" className="h-1 w-9 rounded-full bg-white/25" />
        <button
          type="button"
          data-testid="expanded-comments-close"
          onClick={onClose}
          aria-label="Close comments"
          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-sm text-white/80"
        >
          ✕
        </button>
      </div>

      <div className="shrink-0 px-4 pb-2 pt-1 text-sm font-medium text-white/90">Comments</div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={listRef}
          onScroll={handleScroll}
          data-testid="expanded-comments-list"
          className="h-full overflow-y-auto px-4 pb-2"
        >
          {messages.length === 0 ? (
            <p className="py-8 text-center text-sm text-white/50">No comments yet — say hello.</p>
          ) : (
            messages.map((message) => <CommentRow key={message.id} message={message} />)
          )}
        </div>

        {newSinceScrolledUp > 0 && (
          <button
            type="button"
            data-testid="expanded-comments-jump-latest"
            onClick={jumpToLatest}
            className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-accent px-3 py-1.5 text-xs font-medium text-white shadow-lg"
          >
            {newSinceScrolledUp} new comment{newSinceScrolledUp === 1 ? "" : "s"} · Jump to latest ↓
          </button>
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        <ChatPanel
          eventId={eventId}
          messages={messages}
          reactions={{}}
          micRequestMode={micRequestMode}
          onMicRequestModeChange={onMicRequestModeChange}
          onHasPendingRequestChange={onHasPendingRequestChange}
          onPrepareMedia={onPrepareMedia}
          allowMicRequest={allowMicRequest}
          hasPendingRequest={hasPendingRequest}
          onCancelPendingRequest={onCancelPendingRequest}
          compact
        />
      </div>
    </div>
  );
}

function CommentRow({ message }: { message: LobbyMessage }) {
  const time = new Date(message.created_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div data-testid="expanded-comment-row" className="flex flex-col gap-0.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-white/90">{message.author_display_name}</span>
        {message.is_speaker_request && (
          <span
            className="rounded-full bg-accent/25 px-1.5 py-0.5 text-[10px] font-medium text-accent"
            title="Requested the mic"
          >
            🎙 requesting to speak
          </span>
        )}
        <span className="text-xs text-white/40">{time}</span>
      </div>
      <p className="break-words text-sm text-white/80">{message.body}</p>
    </div>
  );
}
