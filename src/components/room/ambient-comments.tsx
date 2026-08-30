"use client";

import { useEffect, useRef, useState } from "react";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

/** Distance (px) from the bottom still counted as "at the live edge" — matches ExpandedComments' own near-bottom threshold. */
const NEAR_BOTTOM_PX = 24;

/** Issue #21, fifth corrective pass: the Hide/Show preference is a lightweight per-browser presentation choice, not durable event state — no schema change, matches Section 29's explicit "prefer a client preference, don't build a table for this" instruction. */
const HIDDEN_STORAGE_KEY = "virtual-stage:ambient-comments-hidden";

/**
 * Issue #21, fifth corrective pass, Sections 25-29: whether the ambient
 * feed is currently hidden, persisted per-browser via `localStorage` —
 * survives room re-renders/navigation within the same browser, resets
 * naturally on a different device/browser (an acceptable, documented
 * tradeoff for a prototype preference, not a bug). Reading/writing
 * localStorage is wrapped in try/catch throughout (private browsing,
 * disabled storage, SSR) — a failure here only ever means "fall back to
 * showing comments," never a crash.
 */
function useAmbientCommentsHidden(): [boolean, (next: boolean) => void] {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(HIDDEN_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  function setAndPersist(next: boolean) {
    setHidden(next);
    try {
      if (next) localStorage.setItem(HIDDEN_STORAGE_KEY, "1");
      else localStorage.removeItem(HIDDEN_STORAGE_KEY);
    } catch {
      // Presentation preference only — a failed write just means it
      // won't survive this tab closing, never a functional problem.
    }
  }

  return [hidden, setAndPersist];
}

/**
 * Issue #21: the room's live chat stream (the *same* `messages` array
 * `useLobbyRealtime` already feeds into every room composition — no
 * second backend, no duplicated message state) as a small, lightweight
 * live-stream-style feed in Watch Mode's lower-left. Purely
 * presentational: this component reads `messages`, it never sends,
 * never subscribes to anything of its own.
 *
 * **Fifth corrective pass — readability redesign**: real-device testing
 * found the previous single-line "Name: message text…" pill format
 * chopped messages mid-word, unreadable at a glance. Rebuilt around the
 * livestream-app pattern requested — avatar, display name on its own
 * top line (with the request badge beside it, not crammed into the same
 * line as the message), full comment text below, allowed to wrap up to
 * two lines (`line-clamp-2`) before truncating with an ellipsis. A
 * comment that needs to be read in full is exactly what Expanded
 * Comments (opened by tapping any row, unchanged) is for — this feed
 * stays a glanceable summary, never the primary reading surface.
 *
 * **Rebuilt from the original self-expiring bubble stack** (see git
 * history / DECISIONS.md for the earlier Phase 3 design): comments used
 * to fade in, hold ~7s, then vanish permanently, capped at 3 visible at
 * once. That directly conflicted with the later, explicit product
 * requirement that a viewer be able to scroll back through older
 * ambient comments to inspect something — a permanently-removed bubble
 * can't be scrolled back to. Comments now enter at the bottom and push
 * older ones up through a small, fixed-height scrollable window instead
 * of disappearing.
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
 *
 * **Hide/Show (Sections 25-29)**: a one-tap, easily reversible
 * presentation preference — hides only this floating feed. It never
 * touches `messages` itself (still arriving, still counted), never
 * disables the composer, Request-to-Speak, likes/votes, or Expanded
 * Comments — see this component's own `useAmbientCommentsHidden` doc
 * comment for the persistence choice. A small restore pill stays
 * visible in the same corner whenever hidden, so there's never a moment
 * the viewer can't find their way back.
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
  const [hidden, setHidden] = useAmbientCommentsHidden();

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

  if (hidden) {
    // Section 27: never hide the toggle along with the comments — this
    // is the one thing that must always be reachable in this corner.
    return (
      <button
        type="button"
        data-testid="ambient-comments-show"
        onClick={() => setHidden(false)}
        aria-label="Show live comments"
        className="pointer-events-auto flex items-center gap-1 rounded-full bg-black/40 px-2.5 py-1 text-[11px] font-medium text-white/80 backdrop-blur-sm transition-colors hover:bg-black/55 hover:text-white"
      >
        <span aria-hidden="true">💬</span> Show comments
      </button>
    );
  }

  if (messages.length === 0) {
    // Nothing to show yet, but the hide toggle still needs no anchor
    // when there's nothing to hide — same original "render nothing"
    // behavior for an empty feed.
    return null;
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        data-testid="ambient-comments-hide"
        onClick={() => setHidden(true)}
        aria-label="Hide live comments"
        className="pointer-events-auto rounded-full bg-black/30 px-2 py-0.5 text-[10px] font-medium text-white/60 backdrop-blur-sm transition-colors hover:bg-black/45 hover:text-white/90"
      >
        Hide comments
      </button>
      <div
        ref={listRef}
        onScroll={handleScroll}
        data-testid="ambient-comments"
        className="pointer-events-auto flex max-h-40 w-full flex-col gap-1.5 overflow-y-auto"
        // Issue #21, fourth corrective pass, real-device finding, refined
        // in the fifth corrective pass for the taller two-line row
        // height: a mask-image fade on this *container* (not each
        // individual row — a single treatment, not per-item animation)
        // reads as a natural dissolve instead of a hard clip. The fade
        // zone is sized to roughly one row's own height at the new
        // taller layout (avatar + name line + up to two comment lines),
        // out of this container's 160px max-height — still "subtle," not
        // swallowing a large portion of the feed. Both the standard and
        // `-webkit-` prefixed properties are set explicitly — Tailwind
        // can't safely auto-generate the vendor-prefixed one for an
        // inline gradient, and the prefixed form is what iOS Safari
        // (this project's actual target) requires. Purely visual:
        // `overflow-y-auto`'s own scroll/follow behavior, and every
        // row's tap target, are completely unaffected — a mask never
        // blocks pointer events, only paints.
        style={{
          maskImage: "linear-gradient(to bottom, transparent, black 40px)",
          WebkitMaskImage: "linear-gradient(to bottom, transparent, black 40px)",
        }}
      >
        {messages.map((message) => (
          <button
            key={message.id}
            type="button"
            data-testid="ambient-comment"
            data-message-id={message.id}
            onClick={onExpand}
            className="flex w-full max-w-[240px] shrink-0 animate-[ambient-comment-enter_250ms_ease-out] items-start gap-2 rounded-2xl px-2.5 py-1.5 text-left text-white"
            style={{
              backgroundColor: message.is_speaker_request ? "rgb(251 146 60 / 0.22)" : "rgb(0 0 0 / 0.32)",
              border: message.is_speaker_request ? "1px solid rgb(251 146 60 / 0.5)" : undefined,
            }}
          >
            <ParticipantAvatar name={message.author_display_name} size="xs" className="mt-0.5 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                <span className="truncate text-xs font-semibold leading-tight">{message.author_display_name}</span>
                {message.is_speaker_request && (
                  <span
                    data-testid="ambient-comment-request-badge"
                    title="Requesting to speak"
                    className="shrink-0 rounded-full bg-orange-400/25 px-1.5 py-0.5 text-[9px] font-medium leading-none text-orange-100"
                  >
                    requesting to speak
                  </span>
                )}
              </span>
              <span className="line-clamp-2 block text-xs leading-snug text-white/90">{message.body}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
