"use client";

import { useState } from "react";
import { DEFAULT_REACTION_EMOJI, REACTION_EMOJI_SET, type ReactionEmoji } from "@/lib/reactions/constants";

export type ReactionDisplayMode = "on-speaker" | "side";

const SELECTED_EMOJI_KEY = "vs.reactions.selectedEmoji";
const DISPLAY_MODE_KEY = "vs.reactions.displayMode";
const SHOW_REACTIONS_KEY = "vs.reactions.show";

function isValidEmoji(value: string | null): value is ReactionEmoji {
  return value !== null && (REACTION_EMOJI_SET as readonly string[]).includes(value);
}

/**
 * Pre-launch interaction pass, Section 1/4: the viewer's own local
 * reaction preferences — which emoji double-tapping a speaker currently
 * sends, and how *this browser* chooses to display incoming reactions.
 * Persisted per-browser via `localStorage`, same established pattern
 * (and same try/catch-everywhere discipline) as
 * `ambient-comments.tsx`'s own `useAmbientCommentsHidden` — entering a
 * different room shouldn't unnecessarily reset the choice, and a
 * private-browsing/storage failure degrades to sensible defaults, never
 * a crash.
 *
 * **Local presentation only** — one viewer choosing "Side" or hiding
 * reactions never changes what any other viewer sees or whether this
 * viewer can still *send* reactions (see Section 4's own explicit
 * instruction: hiding is a visual-distraction preference, not a
 * send-permission gate).
 */
export function useReactionPreferences() {
  const [selectedEmoji, setSelectedEmojiState] = useState<ReactionEmoji>(() => {
    try {
      const stored = localStorage.getItem(SELECTED_EMOJI_KEY);
      return isValidEmoji(stored) ? stored : DEFAULT_REACTION_EMOJI;
    } catch {
      return DEFAULT_REACTION_EMOJI;
    }
  });

  const [displayMode, setDisplayModeState] = useState<ReactionDisplayMode>(() => {
    try {
      const stored = localStorage.getItem(DISPLAY_MODE_KEY);
      return stored === "side" ? "side" : "on-speaker";
    } catch {
      return "on-speaker";
    }
  });

  const [showReactions, setShowReactionsState] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(SHOW_REACTIONS_KEY);
      // Absent key = first visit = default ON, per Section 4's spec —
      // only an explicit "0" ever turns it off.
      return stored !== "0";
    } catch {
      return true;
    }
  });

  function setSelectedEmoji(emoji: ReactionEmoji) {
    setSelectedEmojiState(emoji);
    try {
      localStorage.setItem(SELECTED_EMOJI_KEY, emoji);
    } catch {
      // Presentation preference only — see this hook's own doc comment.
    }
  }

  function setDisplayMode(mode: ReactionDisplayMode) {
    setDisplayModeState(mode);
    try {
      localStorage.setItem(DISPLAY_MODE_KEY, mode);
    } catch {
      // Same tolerance as setSelectedEmoji above.
    }
  }

  function setShowReactions(show: boolean) {
    setShowReactionsState(show);
    try {
      localStorage.setItem(SHOW_REACTIONS_KEY, show ? "1" : "0");
    } catch {
      // Same tolerance as setSelectedEmoji above.
    }
  }

  return { selectedEmoji, setSelectedEmoji, displayMode, setDisplayMode, showReactions, setShowReactions };
}
