"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type PointerEvent as ReactPointerEvent } from "react";
import { addReaction } from "@/app/events/[id]/lobby/actions";
import { voteForSpeakerRequest } from "@/app/events/[id]/room/actions";
import { ChatPanel } from "@/components/lobby/chat-panel";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

/** Two taps on the same row within this window count as a double-tap-to-like — long enough for a real double-tap, short enough not to pair up two unrelated taps. */
const DOUBLE_TAP_MS = 350;
/** Downward drag distance (px) on the grabber/header past which release closes the sheet — short of this, it snaps back. */
const CLOSE_DRAG_PX = 90;
/** Up to this many pending requests render in "Top Speaker Requests" — see this file's own doc comment on the ordering signal. */
const TOP_REQUESTS_LIMIT = 3;

/**
 * Issue #21, "Discussion Expanded": an intentional, tap-opened surface
 * for *browsing* the live comment stream — deliberately not just a
 * bigger version of the always-live ambient feed (`AmbientComments`).
 * Reuses the exact same `messages` array every other room composition
 * already receives from `useLobbyRealtime` — no new backend, no
 * duplicated message state — and the exact same `ChatPanel` compact
 * composer/actions every collapsed composition already threads through.
 *
 * **Opened only from an ambient comment bubble's tap** — see
 * `AmbientComments`' own doc comment for the seam and why a
 * composer-focus trigger was tried and reverted.
 *
 * **Frozen snapshot, not a live-follow list** (this is the governing
 * difference from `AmbientComments`, per explicit product direction):
 * "Recent Comments" is captured once, on the closed→open transition (or
 * on an explicit refresh tap) — `snapshot`, newest→oldest. New arrivals
 * keep landing in the background `messages` array via Realtime exactly
 * as always, but never mutate `snapshot` automatically; they only
 * increment `newCount` (derived from which live `messages` aren't in
 * `snapshotIds`), surfaced as a small "↻ N new comments" control above
 * Recent Comments. Tapping it re-snapshots (newest arrivals land at the
 * top, counter resets) — this *replaces* the earlier live-follow/
 * jump-to-latest design entirely, not alongside it.
 *
 * **Top Speaker Requests stays live, deliberately** — see
 * `useActiveSpeakerRequests`' own doc comment for the reasoning
 * (candidates for the stage right now, not historical chat). Reads
 * `pendingRequests` directly, cross-referenced against the live
 * `messages` array for each request's own display content — never the
 * frozen `snapshot`.
 *
 * **Ranking signal for "Top 3" (issue #21, Phase 2 update)**: real vote
 * count, descending — `pendingRequests` arrives from
 * `useActiveSpeakerRequests` already ranked this way (see that hook's
 * own doc comment), so `topRequests` here is just an isolated
 * `.slice(0, 3)` on an already-ordered array. Ranking previously used a
 * FIFO placeholder before request voting existed; superseded, not
 * layered on top of.
 *
 * **Double-tap gesture, two different meanings depending on the row**:
 * an ordinary comment's 👍 (reusing `event_chat_message_reactions` /
 * `addReaction` verbatim, exactly as before — nothing changed there) vs.
 * a Request-to-Speak comment's 👍, which is now a *vote*
 * (`voteForSpeakerRequest`, migration 00000000000019) — exclusive across
 * all active requests, transferable, toggle-off on re-tap. `CommentRow`
 * tells the two apart via whether `requestVote` was resolved for that
 * message (a lookup against the live `pendingRequests`, independent of
 * whether the row itself is being rendered from the frozen `snapshot` or
 * the live Top Speaker Requests section) — never by guessing from
 * `is_speaker_request` alone, since a request that's already resolved
 * (granted/withdrawn/expired) is no longer voteable and correctly falls
 * back to having no `requestVote` at all. Local per-row
 * `lastTapRef`/optimistic-`liked` state (same shape as `MessageItem`'s
 * own reaction handling) for the ordinary-like path — consuming the tap
 * pair after a detected double-tap (resetting the ref) is what stops a
 * fast triple/quadruple tap from re-firing either interaction; the
 * server's own unique constraints are a second, independent guard
 * either way.
 *
 * **Grabber drag-to-close**: pointer handlers are attached to the
 * handle/header region only (`handleDragProps` below), never to
 * `expanded-comments-list` — ordinary scrolling inside Recent Comments
 * is a completely different element and is never touched by this. Live
 * 1:1 tracking while dragging (`dragY`, no CSS transition), a snap
 * animation on release (transition re-enabled) either back to 0 or
 * (past `CLOSE_DRAG_PX`) via `onClose`. The ✕ button remains a full
 * alternative, unconditionally.
 *
 * **Presentation-only, deliberately**: this component owns no role,
 * media, seat, or LiveKit state — `open`/`onClose` are plain local UI
 * state owned by the caller, never lifted into `EventRoom`. See
 * `AmbientComments`' sibling reasoning; identical here.
 *
 * **Replies (schema checked, not implemented)**: `event_chat_messages`
 * has no self-referencing column today (confirmed against
 * `src/types/database.ts` and every migration) — real migration work,
 * not a small additive change — so deferred. `CommentRow` renders one
 * flat list keyed by `message.id`; a future pass can group by a
 * `reply_to_message_id` into a `repliesByParentId` map without
 * restructuring this component.
 */
export function ExpandedComments({
  open,
  onClose,
  eventId,
  messages,
  reactions,
  pendingRequests,
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
  reactions: Record<string, ReactionState>;
  pendingRequests: RankedPendingRequest[];
  micRequestMode: boolean;
  onMicRequestModeChange: (value: boolean) => void;
  onHasPendingRequestChange: (value: boolean) => void;
  onPrepareMedia: () => Promise<void>;
  allowMicRequest?: boolean;
  hasPendingRequest?: boolean;
  onCancelPendingRequest?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<LobbyMessage[]>([]);
  const [snapshotIds, setSnapshotIds] = useState<Set<string>>(new Set());
  const wasOpenRef = useRef(false);

  function takeSnapshot() {
    setSnapshot([...messages].reverse());
    setSnapshotIds(new Set(messages.map((m) => m.id)));
    listRef.current?.scrollTo({ top: 0 });
  }

  // Fresh snapshot exactly on the closed->open transition — not on every
  // render while already open, which is the entire point (see this
  // file's own doc comment on why this replaced live-follow).
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      takeSnapshot();
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const newCount = useMemo(
    () => messages.filter((m) => !snapshotIds.has(m.id)).length,
    [messages, snapshotIds],
  );

  const topRequests = useMemo(() => {
    const withContent = pendingRequests
      .map((request) => ({ request, message: messages.find((m) => m.id === request.message_id) }))
      .filter(
        (entry): entry is { request: RankedPendingRequest; message: LobbyMessage } => entry.message !== undefined,
      );
    return withContent.slice(0, TOP_REQUESTS_LIMIT);
  }, [pendingRequests, messages]);

  // Message id -> live request vote info, for both sections — a request
  // row (Top Speaker Requests or one that happens to appear in Recent
  // Comments) is voteable exactly when its message still has an active
  // pending request; once resolved, it correctly has no entry here and
  // CommentRow falls back to no vote affordance at all (not an ordinary
  // like — see this component's own doc comment).
  const voteByMessageId = useMemo(() => {
    const map = new Map<string, RankedPendingRequest>();
    for (const request of pendingRequests) map.set(request.message_id, request);
    return map;
  }, [pendingRequests]);

  // --- Grabber drag-to-close (handle/header region only — see doc comment) ---
  const [dragY, setDragY] = useState(0);
  const [dragging, setDragging] = useState(false);
  const dragStartYRef = useRef<number | null>(null);

  function handleDragStart(event: ReactPointerEvent<HTMLDivElement>) {
    dragStartYRef.current = event.clientY;
    setDragging(true);
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function handleDragMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragStartYRef.current === null) return;
    setDragY(Math.max(0, event.clientY - dragStartYRef.current));
  }
  function endDrag() {
    dragStartYRef.current = null;
    setDragging(false);
  }
  function handleDragEnd() {
    if (dragY > CLOSE_DRAG_PX) {
      onClose();
    }
    setDragY(0);
    endDrag();
  }
  function handleDragCancel() {
    setDragY(0);
    endDrag();
  }

  function handleLike(messageId: string) {
    void addReaction(messageId);
  }

  function handleVote(messageId: string) {
    void voteForSpeakerRequest(eventId, messageId);
  }

  if (!open) return null;

  return (
    <div
      data-testid="expanded-comments"
      className="absolute inset-x-0 bottom-0 z-20 flex h-[70vh] max-h-full flex-col rounded-t-2xl border-t border-white/10 bg-black/92 shadow-[0_-8px_30px_rgba(0,0,0,0.4)] landscape:h-[85vh]"
      style={{
        transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
        transition: dragging ? "none" : "transform 200ms ease-out",
      }}
    >
      <div
        data-testid="expanded-comments-handle"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragCancel}
        className="flex shrink-0 touch-none items-center justify-between px-3 pt-2"
      >
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

      <div
        data-testid="expanded-comments-scroll"
        className="min-h-0 flex-1 overflow-y-auto px-4 pb-2"
      >
        {topRequests.length > 0 && (
          <div data-testid="expanded-top-requests" className="mb-3 rounded-xl bg-accent/10 p-2">
            <div className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-accent">
              Top Speaker Requests
            </div>
            <div className="divide-y divide-white/5">
              {topRequests.map(({ message }) => (
                <CommentRow
                  key={message.id}
                  message={message}
                  reaction={reactions[message.id]}
                  requestVote={voteByMessageId.get(message.id)}
                  onLike={handleLike}
                  onVote={handleVote}
                  testId="expanded-top-request-row"
                />
              ))}
            </div>
          </div>
        )}

        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/50">Recent Comments</span>
          {newCount > 0 && (
            <button
              type="button"
              data-testid="expanded-comments-refresh"
              onClick={takeSnapshot}
              className="flex items-center gap-1 rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-white/80"
            >
              ↻ {newCount} new comment{newCount === 1 ? "" : "s"}
            </button>
          )}
        </div>

        {snapshot.length === 0 ? (
          <p className="py-8 text-center text-sm text-white/50">No comments yet — say hello.</p>
        ) : (
          snapshot.map((message) => (
            <CommentRow
              key={message.id}
              message={message}
              reaction={reactions[message.id]}
              requestVote={voteByMessageId.get(message.id)}
              onLike={handleLike}
              onVote={handleVote}
              testId="expanded-comment-row"
            />
          ))
        )}
      </div>

      <div className="shrink-0 border-t border-white/10 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2">
        <ChatPanel
          eventId={eventId}
          messages={messages}
          reactions={reactions}
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

function CommentRow({
  message,
  reaction,
  requestVote,
  onLike,
  onVote,
  testId,
}: {
  message: LobbyMessage;
  reaction: ReactionState | undefined;
  /** Present exactly when this message's request is still active/voteable — see voteByMessageId's own comment for why this, not is_speaker_request, is the source of truth. */
  requestVote: RankedPendingRequest | undefined;
  onLike: (messageId: string) => void;
  onVote: (messageId: string) => void;
  testId: string;
}) {
  const [, startTransition] = useTransition();
  const [optimisticallyLiked, setOptimisticallyLiked] = useState(false);
  const [justLiked, setJustLiked] = useState(false);
  const lastTapRef = useRef(0);

  const liked = reaction?.reactedByMe || optimisticallyLiked;
  const count = reaction?.count ?? 0;

  const time = new Date(message.created_at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  function handleTap() {
    const now = Date.now();
    const isDoubleTap = now - lastTapRef.current < DOUBLE_TAP_MS;
    if (!isDoubleTap) {
      lastTapRef.current = now;
      return;
    }
    // Consume the pair so a fast triple/quadruple tap can't re-fire —
    // the server's own unique constraints are a second, independent
    // guard either way.
    lastTapRef.current = 0;
    setJustLiked(true);
    setTimeout(() => setJustLiked(false), 400);

    if (requestVote) {
      // Vote path: always fires — transfer, fresh vote, or toggle-off
      // are all valid outcomes the server decides; no optimistic local
      // override here since the live vote count/isMyVote already comes
      // back over the same Realtime pipe within about as long as an
      // optimistic guess would need reconciling anyway.
      startTransition(() => {
        onVote(message.id);
      });
      return;
    }

    // Ordinary like path: idempotent guard against re-liking (this
    // project's comment likes don't toggle off on re-tap, unlike votes).
    if (liked) return;
    setOptimisticallyLiked(true);
    startTransition(() => {
      onLike(message.id);
    });
  }

  return (
    <div
      data-testid={testId}
      data-message-id={message.id}
      onClick={handleTap}
      className={`flex flex-col gap-0.5 py-2 transition-transform ${justLiked ? "scale-[1.02]" : ""}`}
    >
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
      <div className="flex items-end justify-between gap-2">
        <p className="break-words text-sm text-white/80">{message.body}</p>
        {requestVote ? (
          (requestVote.isMyVote || requestVote.voteCount > 0) && (
            <span
              data-testid="expanded-comment-vote"
              className={`shrink-0 text-xs ${requestVote.isMyVote ? "font-medium text-accent" : "text-white/40"}`}
              title={requestVote.isMyVote ? "Your vote" : undefined}
            >
              {requestVote.isMyVote ? "✓ " : ""}👍{requestVote.voteCount > 0 ? ` ${requestVote.voteCount}` : ""}
            </span>
          )
        ) : (
          (liked || count > 0) && (
            <span
              data-testid="expanded-comment-like"
              className={`shrink-0 text-xs ${liked ? "text-accent" : "text-white/40"}`}
            >
              👍{count > 0 ? ` ${count}` : ""}
            </span>
          )
        )}
      </div>
    </div>
  );
}
