"use client";

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import { addReaction } from "@/app/events/[id]/lobby/actions";
import { voteForSpeakerRequest } from "@/app/events/[id]/room/actions";
import { ChatPanel } from "@/components/lobby/chat-panel";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { ProfileLink } from "@/components/room/profile-link";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { ProfileDirectoryEntry } from "@/hooks/use-profile-directory";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";
import type { Identity } from "@/lib/identity";

/** Two taps on the same row within this window count as a double-tap-to-like — long enough for a real double-tap, short enough not to pair up two unrelated taps. */
const DOUBLE_TAP_MS = 350;
/** Downward drag distance (px) on the grabber/header past which release closes the sheet — short of this, it snaps back. */
const CLOSE_DRAG_PX = 90;
/** Up to this many pending requests render in "Top Speaker Requests" — see this file's own doc comment on the ordering signal. */
const TOP_REQUESTS_LIMIT = 3;
/** Distance (px) from the top of Recent Comments still counted as "caught up to newest" — matches AmbientComments' own analogous near-bottom threshold, mirrored here since this list is newest-first (top = newest). */
const NEAR_TOP_PX = 24;

/**
 * Real-device report: is this message authored by the current viewer?
 * Compares `author_profile_id`/`author_guest_id` against the viewer's own
 * resolved identity — never display name (a real, if rare, collision
 * risk this project has already flagged elsewhere) and never "is this
 * simply the newest row" (true for anyone's newest comment, not just
 * mine). `null` (identity not yet resolved, or a caller that doesn't
 * pass one) never matches anything, matching this project's own
 * fail-safe-neutral convention elsewhere.
 */
function isMyMessage(message: LobbyMessage, viewerIdentity: Identity | null): boolean {
  if (!viewerIdentity) return false;
  return viewerIdentity.type === "profile"
    ? message.author_profile_id === viewerIdentity.id
    : message.author_guest_id === viewerIdentity.id;
}

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
 * **Live timeline with viewport anchoring, not a frozen snapshot**
 * (real-device report superseding the original frozen-snapshot design —
 * see DECISIONS.md for the reversal): "Recent Comments" is now the
 * *live* `messages` array itself, newest-first (`displayMessages`, a
 * plain reversal — no local copy, no "new" set to reconcile). New
 * arrivals prepend above whatever the reader is currently looking at
 * without moving their scroll position — see the `useLayoutEffect` below
 * for the actual anchoring mechanics (a `scrollHeight`-delta nudge, the
 * standard technique for "prepend without a visible jump," not a lucky
 * accident of browser scroll-anchoring). While the reader isn't at/near
 * the newest position, arrivals instead increment a small `N new
 * comments` indicator (`newCount`, derived from `caughtUpToId` — how far
 * into the live list the reader has actually reached, never a frozen
 * copy's own staleness) that scrolls them to the top on tap. Posting your
 * *own* comment is the one deliberate exception to all of the above: it
 * always scrolls you straight to it, even if you were reading older
 * comments — see the same effect's own `isMyMessage` branch. This is a
 * strictly *narrower* concept than the old frozen model, not an addition
 * alongside it — there is no more "refresh" action anywhere in this
 * component.
 *
 * **Top Speaker Requests stays live, deliberately** — see
 * `useActiveSpeakerRequests`' own doc comment for the reasoning
 * (candidates for the stage right now, not historical chat). Reads
 * `pendingRequests` directly, cross-referenced against the live
 * `messages` array for each request's own display content — this was
 * already true before the live-timeline rewrite (it never read the old
 * frozen `snapshot`), so nothing about this section's own behavior
 * changes here.
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
 * whether the row itself is being rendered from the live Recent Comments
 * timeline or the Top Speaker Requests section) — never by guessing from
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
 *
 * **`miniStage`** (mobile UX correction, live-user-test finding): a
 * real-device report found this sheet covering the *entire* stage,
 * defeating the "stage-first" concept — a viewer (or a seated speaker)
 * opening comments lost all visual contact with the live conversation.
 * When provided, this renders as a fixed-height band at the very top of
 * this sheet, before the drag handle — both speakers, side-by-side, at a
 * small but legible scale, so the stage stays visible the whole time
 * comments are open. This component still owns no role/media/seat/
 * LiveKit state itself, matching its own doc comment above: the caller
 * builds and passes in whatever `ReactNode` it wants (in practice, a
 * second `SpeakerStage` instance in `compact` mode — see that
 * component's own doc comment for why a *second* instance, reusing the
 * same tiles/reaction filtering, is the safe way to do this without
 * touching the main stage's own already-attached media at all). `null`/
 * omitted keeps this sheet's original full-height behavior exactly as it
 * was, so no existing caller/test is affected until it opts in.
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
  profileDirectory = {},
  miniStage = null,
  viewerIdentity = null,
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
  onPrepareMedia: () => Promise<MediaReadinessState>;
  allowMicRequest?: boolean;
  hasPendingRequest?: boolean;
  onCancelPendingRequest?: () => void;
  /** Issue #29: `profile_id` → `{username, avatarUrl}` for every currently-visible comment author with a public profile — see `useProfileDirectory`'s own doc comment. Optional, defaulting to empty, so every existing caller/test that doesn't care can omit it. */
  profileDirectory?: Record<string, ProfileDirectoryEntry>;
  /** Mobile UX correction — see this component's own doc comment above. `null`/omitted preserves the original full-height sheet exactly. */
  miniStage?: ReactNode;
  /**
   * Real-device report: the viewer's own resolved identity — used only
   * for two things, both about *finding yourself* in the live timeline:
   * marking your own comments "You" (`CommentRow`'s own `isMine`), and
   * detecting "the newest arrival is mine" to jump you straight to it on
   * submit (see the anchoring effect below). Never used to decide
   * *whether* you can comment — that's `ChatPanel`'s own, unrelated,
   * guests-and-accounts-both-can-comment gate. Optional, defaulting to
   * `null` (no message is ever marked "yours," and the jump-to-own-
   * comment behavior never triggers), so a caller that doesn't have it
   * handy yet degrades to "comments are live, but I can't tell which are
   * mine" rather than crashing.
   */
  viewerIdentity?: Identity | null;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const prefersReducedMotion = usePrefersReducedMotion();

  // Real-device report: the live timeline itself — just the same
  // `messages` array reversed, newest first. No local copy, so a new
  // arrival is simply *there* on the very next render; every "did I
  // already see this" question below is about scroll position, never
  // about whether this array is stale.
  const displayMessages = useMemo(() => [...messages].reverse(), [messages]);

  // How far into the live (ascending) `messages` array the reader has
  // actually reached — the id of the newest message they've been shown
  // at the top. `null` before the first open (nothing to compare against
  // yet). Recomputed to "caught up to the current newest" whenever the
  // reader reaches/returns to the top (the scroll handler below, the tap-
  // to-scroll-up indicator, opening the sheet fresh, or posting your own
  // comment) — never decremented, never guessed from a snapshot's own
  // staleness.
  const [caughtUpToId, setCaughtUpToId] = useState<string | null>(null);
  const isNearTopRef = useRef(true);
  const prevScrollHeightRef = useRef(0);
  const prevNewestIdRef = useRef<string | null>(messages.length > 0 ? messages[messages.length - 1].id : null);

  function scrollToNewest(behavior: ScrollBehavior = "smooth") {
    listRef.current?.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : behavior });
    setCaughtUpToId(messages.length > 0 ? messages[messages.length - 1].id : null);
  }

  // Reset to "caught up, scrolled to newest" exactly on the closed->open
  // transition — opening comments always starts you at the true live
  // edge, same mental model AmbientComments already uses for its own
  // mount-time scroll. Not on every render while already open, which is
  // the entire point of tracking `caughtUpToId` instead of re-deriving it
  // from scratch each time.
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setCaughtUpToId(messages.length > 0 ? messages[messages.length - 1].id : null);
      listRef.current?.scrollTo({ top: 0 });
    }
    wasOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The actual live-prepend + viewport-anchoring mechanics. Runs
  // *before* paint (useLayoutEffect, not useEffect) so a scroll
  // adjustment below is never visible as a jump-then-correct flicker —
  // the standard "preserve scrollHeight delta" technique for a prepend-
  // above list, the one explicitly called for over relying on browser
  // scroll-anchoring luck.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) {
      prevScrollHeightRef.current = 0;
      return;
    }

    const newestId = messages.length > 0 ? messages[messages.length - 1].id : null;
    const isNewArrival = newestId !== null && newestId !== prevNewestIdRef.current;

    if (isNewArrival) {
      const newestMessage = messages[messages.length - 1];
      // `queueMicrotask` before every `setCaughtUpToId` below — the
      // scroll mutations above/below still run synchronously, before
      // paint, which is the actual reason this is a `useLayoutEffect`;
      // the state update driving `newCount`/the indicator has no such
      // pre-paint requirement, and deferring it to a microtask is what
      // keeps this out of the same "setState synchronously within an
      // effect" pattern this codebase's own `react-hooks/set-state-in-
      // effect` rule already flags elsewhere (see e.g.
      // useAutomaticPromotion's own `await Promise.resolve()` doc
      // comment for the identical reasoning, a `queueMicrotask` here
      // being the non-`async`-function equivalent).
      if (isMyMessage(newestMessage, viewerIdentity)) {
        // Posting my own comment is the deliberate exception to
        // anchoring: always jump straight to it, even mid-read of older
        // comments — never leave it hidden above the viewport behind a
        // "new comments" counter.
        el.scrollTo({ top: 0, behavior: prefersReducedMotion ? "auto" : "smooth" });
        queueMicrotask(() => setCaughtUpToId(newestId));
      } else if (isNearTopRef.current) {
        // Already at/near the newest position — let it appear naturally
        // at the top with no scroll adjustment at all, and no redundant
        // indicator for something already on screen.
        queueMicrotask(() => setCaughtUpToId(newestId));
      } else {
        // Preserve the reader's exact visual anchor: the new content
        // landed *above* what they're currently looking at, so shift
        // scrollTop by exactly how much taller the list just got —
        // never left to "whatever the browser happens to do."
        const delta = el.scrollHeight - prevScrollHeightRef.current;
        if (delta > 0) el.scrollTop += delta;
      }
    }

    prevNewestIdRef.current = newestId;
    prevScrollHeightRef.current = el.scrollHeight;
  }, [messages, viewerIdentity, prefersReducedMotion]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const nearTop = el.scrollTop < NEAR_TOP_PX;
    isNearTopRef.current = nearTop;
    if (nearTop) {
      // Reached the newest position by scrolling, not by tapping the
      // indicator — clears it the same way either path does.
      setCaughtUpToId(messages.length > 0 ? messages[messages.length - 1].id : null);
    }
  }

  // Derived, never a separately-incremented counter that could drift
  // from the live array — "how many messages exist after the one I've
  // caught up to." A `caughtUpToId` no longer present (the 300-message
  // in-memory cap dropped it) conservatively counts everything as new
  // rather than under-reporting.
  const newCount = useMemo(() => {
    if (caughtUpToId === null) return 0;
    const idx = messages.findIndex((m) => m.id === caughtUpToId);
    if (idx === -1) return messages.length;
    return messages.length - 1 - idx;
  }, [messages, caughtUpToId]);

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
    // Real-device report (root cause of the "commenting is broken"
    // report, traced end to end): the ✕ close button lives *inside* this
    // same handle/header region, so a tap on it also bubbles a
    // `pointerdown` up to this handler. `setPointerCapture` below then
    // redirects the *rest* of that pointer's event sequence — including
    // the synthesized `click` a real tap produces — to this div, the
    // capturing element, instead of the button that was actually tapped.
    // The button's own `onClick={onClose}` never fires as a result:
    // verified live (not assumed) against the real backend — Close was
    // completely unresponsive on a real browser despite passing every
    // existing jsdom test, which never exercises real pointer-capture
    // click redirection. Same interactive-descendant exclusion
    // `useDoubleTap` already uses elsewhere in this codebase: a
    // pointerdown that lands on a real control is never the start of a
    // drag gesture.
    const target = event.target as HTMLElement;
    if (target.closest('button, a, [role="button"], input, textarea')) return;
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
      className={cn(
        "absolute inset-x-0 bottom-0 z-20 flex flex-col border-t border-white/10 bg-black/92 shadow-[0_-8px_30px_rgba(0,0,0,0.4)]",
        // Mobile UX correction: with a mini stage, this sheet spans the
        // full height — the mini stage band itself *is* the visible "top
        // of screen" (see this component's own `miniStage` doc comment),
        // not a separate layer floating above a still-70vh sheet. No
        // rounded top corner in that case either — it should read as the
        // stage continuing into the comment panel, not as a sheet's own
        // edge. Without a mini stage, every existing caller/test keeps
        // the original 70vh/85vh sheet with its rounded top corner,
        // completely unchanged.
        miniStage ? "inset-0" : "h-[70vh] max-h-full rounded-t-2xl landscape:h-[85vh]",
      )}
      style={{
        transform: dragY > 0 ? `translateY(${dragY}px)` : undefined,
        transition: dragging ? "none" : "transform 200ms ease-out",
      }}
    >
      {miniStage && (
        <div data-testid="expanded-comments-mini-stage" className="h-32 shrink-0 overflow-hidden sm:h-36">
          {miniStage}
        </div>
      )}

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
        ref={listRef}
        onScroll={handleScroll}
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
                  profileEntry={message.author_profile_id ? profileDirectory[message.author_profile_id] : undefined}
                  isMine={isMyMessage(message, viewerIdentity)}
                />
              ))}
            </div>
          </div>
        )}

        <div className="sticky top-0 z-10 flex items-center justify-between bg-black/92 px-1 pb-1 pt-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-white/50">Recent Comments</span>
          {/* Real-device report, live-timeline rewrite: comments are
              always live now — this is purely a "you have unread ones
              above you" indicator, never a refresh action. Tapping it
              scrolls to the newest position; reaching it by scrolling
              manually clears it the same way (see handleScroll above).
              Never shown while already at/near the top (Section 9: "do
              not show a redundant indicator if I can already see it
              immediately"), since newCount is 0 there by construction. */}
          {newCount > 0 && (
            <button
              type="button"
              data-testid="expanded-comments-new-indicator"
              onClick={() => scrollToNewest()}
              className="flex items-center gap-1 rounded-full bg-accent/80 px-2 py-0.5 text-[11px] font-medium text-white"
            >
              ↑ {newCount} new comment{newCount === 1 ? "" : "s"}
            </button>
          )}
        </div>

        {displayMessages.length === 0 ? (
          <p className="py-8 text-center text-sm text-white/50">No comments yet — say hello.</p>
        ) : (
          displayMessages.map((message) => (
            <CommentRow
              key={message.id}
              message={message}
              reaction={reactions[message.id]}
              requestVote={voteByMessageId.get(message.id)}
              onLike={handleLike}
              onVote={handleVote}
              testId="expanded-comment-row"
              profileEntry={message.author_profile_id ? profileDirectory[message.author_profile_id] : undefined}
              isMine={isMyMessage(message, viewerIdentity)}
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
  profileEntry,
  isMine = false,
}: {
  message: LobbyMessage;
  reaction: ReactionState | undefined;
  /** Present exactly when this message's request is still active/voteable — see voteByMessageId's own comment for why this, not is_speaker_request, is the source of truth. */
  requestVote: RankedPendingRequest | undefined;
  onLike: (messageId: string) => void;
  onVote: (messageId: string) => void;
  testId: string;
  /** Issue #29: this message author's own public profile, if `message.author_profile_id` has one. Undefined for a guest or an account without a username yet — the avatar stays non-navigable exactly as before. */
  profileEntry?: ProfileDirectoryEntry;
  /**
   * Real-device report, Section 11-12: a small, understated "You" marker
   * beside the display name — computed by the caller via `isMyMessage`
   * (stable `author_profile_id`/`author_guest_id` identity matching,
   * never display name, and never "am I the newest") so a same-name
   * different-identity author is never mismarked. Applies uniformly to
   * every one of my own comments across the whole live timeline, not
   * only the one just posted — this component has no notion of "just
   * posted" at all, only "does this row's author match my identity."
   */
  isMine?: boolean;
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
      className={`flex gap-2 py-2 transition-transform ${justLiked ? "scale-[1.02]" : ""}`}
    >
      <ProfileLink username={profileEntry?.username ?? null} ariaLabel={`${message.author_display_name}'s profile`} className="shrink-0">
        <ParticipantAvatar name={message.author_display_name} imageUrl={profileEntry?.avatarUrl} size="sm" className="mt-0.5" />
      </ProfileLink>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-medium text-white/90">{message.author_display_name}</span>
        {isMine && (
          <span data-testid="comment-mine-marker" className="text-[10px] font-medium uppercase tracking-wide text-white/40">
            You
          </span>
        )}
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
    </div>
  );
}
