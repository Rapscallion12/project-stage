"use client";

import { useEffect, useRef } from "react";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

/** Distance (px) from the bottom still counted as "at the live edge" — matches ExpandedComments' own near-bottom threshold. */
const NEAR_BOTTOM_PX = 24;

/**
 * Issue #21: the room's live chat stream (the *same* `messages` array
 * `useLobbyRealtime` already feeds into every room composition — no
 * second backend, no duplicated message state) as a small, lightweight
 * live-stream-style feed in Watch Mode's lower-left. Purely
 * presentational: this component reads `messages`, it never sends,
 * never subscribes to anything of its own.
 *
 * **Rebuilt from the original self-expiring bubble stack** (see git
 * history / DECISIONS.md for the earlier Phase 3 design): comments used
 * to fade in, hold ~7s, then vanish permanently, capped at 3 visible at
 * once. That directly conflicted with the later, explicit product
 * requirement that a viewer be able to scroll back through older
 * ambient comments to inspect something — a permanently-removed bubble
 * can't be scrolled back to. Comments now enter at the bottom and push
 * older ones up through a small, fixed-height (`max-h-32`) scrollable
 * window instead of disappearing — same lightweight visual style (small
 * translucent pills, request-to-speak badge treatment, lower-left
 * corner, no stage reflow), same conservative footprint (roughly the
 * same height the old 3-bubble stack occupied), just no more hard
 * timed removal.
 *
 * **Live-stream feel, not a chat panel**: still capped at a small fixed
 * height via `overflow-y-auto` — this deliberately does not grow to fit
 * its content, so it can never become "a large permanent chat panel."
 * `messages` itself is already capped at 300 in memory
 * (`useLobbyRealtime`), which is the only cap this component needs;
 * older-than-that history remains reachable through Expanded Comments'
 * own (differently-sourced) view instead.
 *
 * **Follow vs. reading — the live-stream-comparable behavior**: while
 * scrolled at/near the bottom (`following`), a new arrival auto-scrolls
 * the window down to reveal it, matching "enter naturally, push
 * previous comments through." The moment the viewer scrolls up past
 * `NEAR_BOTTOM_PX`, `following` goes false and new arrivals are simply
 * appended without moving the scroll position at all — no snapping the
 * view away from what they're reading, and no "new comments" indicator
 * here (that affordance belongs to Expanded Comments' frozen-snapshot
 * model; this view is never frozen, so there's nothing to "catch up"
 * on — scrolling back down reveals whatever arrived in the meantime
 * exactly where it naturally landed). Scrolling back near the bottom
 * resumes following automatically. This is the same follow/threshold
 * shape as a mature livestream comment feed (chat auto-scrolls unless
 * you've scrolled up to read), applied at this component's own small
 * scale rather than Expanded Comments' full-sheet scale.
 *
 * **No stage reflow**: the caller positions this as an absolutely
 * positioned overlay (a sibling of `SpeakerStage`, never a document-flow
 * ancestor) — this component itself has no opinion on where it sits,
 * only what it shows.
 *
 * **Discussion Expanded's tap target**: `onExpand`, when provided, is
 * called on tap of any bubble — the same `data-message-id` seam this
 * component has carried since Phase 3. Native tap-vs-drag distinction
 * (a browser doesn't fire `click` after a real scroll gesture) is what
 * keeps this from fighting the container's own new scrollability; no
 * extra gesture-disambiguation code was needed for that.
 */
export function AmbientComments({
  messages,
  onExpand,
}: {
  messages: LobbyMessage[];
  onExpand?: () => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const followingRef = useRef(true);
  const prevLengthRef = useRef(messages.length);

  // Seeded scroll position on mount: land at the live edge, same as a
  // livestream chat panel opening already caught up.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    // Mount-only — see the arrival effect below for ongoing updates.
  }, []);

  useEffect(() => {
    const delta = messages.length - prevLengthRef.current;
    prevLengthRef.current = messages.length;
    if (delta <= 0) return;
    if (followingRef.current) {
      listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
    }
    // Not following: append happens via the normal messages.map render
    // below with no scroll call at all — position stays exactly where
    // the viewer left it.
  }, [messages.length]);

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    followingRef.current = distanceFromBottom < NEAR_BOTTOM_PX;
  }

  if (messages.length === 0) return null;

  return (
    <div
      ref={listRef}
      onScroll={handleScroll}
      data-testid="ambient-comments"
      className="pointer-events-auto flex max-h-32 flex-col gap-1.5 overflow-y-auto"
    >
      {messages.map((message) => (
        <button
          key={message.id}
          type="button"
          data-testid="ambient-comment"
          data-message-id={message.id}
          onClick={onExpand}
          className="max-w-[220px] shrink-0 animate-[ambient-comment-enter_250ms_ease-out] truncate rounded-full px-3 py-1.5 text-left text-xs text-white"
          style={{
            backgroundColor: message.is_speaker_request ? "rgb(251 146 60 / 0.22)" : "rgb(0 0 0 / 0.32)",
            border: message.is_speaker_request ? "1px solid rgb(251 146 60 / 0.5)" : undefined,
          }}
        >
          {message.is_speaker_request && (
            <span aria-hidden="true" title="Requested the mic">
              🎙{" "}
            </span>
          )}
          <span className="font-medium">{message.author_display_name}</span>
          {": "}
          {message.body}
        </button>
      ))}
    </div>
  );
}
