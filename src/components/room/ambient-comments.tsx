"use client";

import { useEffect, useRef, useState } from "react";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

const MAX_VISIBLE = 3;
/** Total lifetime of one bubble, including its CSS fade-in/fade-out — see the `ambient-comment-fade` keyframe in globals.css. Tunable, not validated against a real device yet. */
const VISIBLE_DURATION_MS = 7000;

type VisibleEntry = { message: LobbyMessage };

/**
 * Issue #21, "05 — Social Stage" Phase 3: the room's live chat stream
 * (the *same* `messages` array `useLobbyRealtime` already feeds into
 * every room composition — no second backend, no duplicated message
 * state) rendered as a small, self-expiring stack of translucent
 * bubbles in Watch Mode's lower-left, instead of the historical
 * scrollable list. Purely presentational: this component reads
 * `messages`, it never sends, never subscribes to anything of its own.
 *
 * **Why local state at all, if `messages` is already the source of
 * truth**: the *ambient* lifecycle (when a bubble fades in, how long it
 * stays, when it's removed) is deliberately different from the
 * underlying data's own lifecycle (a message never disappears from
 * `messages` once posted). This component tracks which message ids it
 * has already shown (`shownIds`) and assigns each one its own
 * fade/expire timer *once*, the first time it's seen — reusing the
 * data, not the data's own permanence.
 *
 * **Seeded on mount, not empty**: a viewer arriving mid-conversation
 * should see the room already feels inhabited, not a blank corner until
 * the next live message happens to arrive — the last `MAX_VISIBLE`
 * messages already in `messages` at mount are shown immediately, each
 * given a fresh expiry timer starting from *now* (not their original
 * `created_at`), since that's when this viewer is first seeing them.
 *
 * **Never more than `MAX_VISIBLE` at once**: a burst of rapid messages
 * evicts the oldest *visible* entry immediately rather than waiting for
 * its timer — this is the "conservative ambient feed size" the approved
 * design calls for, and the seam later phases can tighten further (e.g.
 * shrinking further while a React/Vote/Gift tray is open) without
 * restructuring this component.
 *
 * **No stage reflow**: the caller positions this as an absolutely
 * positioned overlay (a sibling of `SpeakerStage`, never a document-flow
 * ancestor) — this component itself has no opinion on where it sits,
 * only what it shows and for how long.
 *
 * **Discussion Expanded's tap target, now wired**: `onExpand`, when
 * provided, is called on tap of any bubble — this is the seam the doc
 * comment above used to describe as "not built yet." Each bubble already
 * carried `data-message-id` for exactly this; no rewrite of how bubbles
 * render was needed, only this one prop and its `onClick`.
 */
export function AmbientComments({
  messages,
  onExpand,
}: {
  messages: LobbyMessage[];
  onExpand?: () => void;
}) {
  const [visible, setVisible] = useState<VisibleEntry[]>([]);
  const shownIds = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const newOnes = messages.filter((m) => !shownIds.current.has(m.id));
    if (newOnes.length === 0) return;

    for (const message of newOnes) {
      shownIds.current.add(message.id);
      const timer = setTimeout(() => {
        setVisible((prev) => prev.filter((entry) => entry.message.id !== message.id));
        timers.current.delete(message.id);
      }, VISIBLE_DURATION_MS);
      timers.current.set(message.id, timer);
    }

    setVisible((prev) => {
      const next = [...prev, ...newOnes.map((message) => ({ message }))];
      // Never show more than MAX_VISIBLE — evict the oldest immediately
      // (clearing its now-pointless timer) rather than waiting for its
      // own expiry, so a rapid burst can't stack the ambient feed taller
      // than the "conservative size" this phase calls for.
      while (next.length > MAX_VISIBLE) {
        const evicted = next.shift()!;
        const t = timers.current.get(evicted.message.id);
        if (t) clearTimeout(t);
        timers.current.delete(evicted.message.id);
      }
      return next;
    });
  }, [messages]);

  useEffect(() => {
    const timersAtMount = timers.current;
    return () => {
      for (const t of timersAtMount.values()) clearTimeout(t);
    };
  }, []);

  if (visible.length === 0) return null;

  return (
    <div data-testid="ambient-comments" className="flex flex-col gap-1.5">
      {visible.map(({ message }) => (
        <button
          key={message.id}
          type="button"
          data-testid="ambient-comment"
          data-message-id={message.id}
          onClick={onExpand}
          // pointer-events-auto so a tap actually reaches this button —
          // the caller wraps the whole component in a pointer-events-none
          // margin, same click-through pattern used everywhere else in
          // this room; each bubble opts back in.
          className="animate-[ambient-comment-fade_7s_ease-out_forwards] pointer-events-auto max-w-[220px] truncate rounded-full px-3 py-1.5 text-left text-xs text-white"
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
