"use client";

import { useEffect } from "react";
import { cn } from "@/lib/utils";
import { REACTION_EMOJI_SET, type ReactionEmoji } from "@/lib/reactions/constants";
import type { ReactionDisplayMode } from "@/hooks/use-reaction-preferences";

/**
 * Pre-launch interaction pass, Section 1: the reaction button's own
 * settings panel — opened by tapping the button, never a "general
 * reaction" send action (there is no such action in this design).
 * Lets the viewer:
 * - choose their current/default reaction emoji (updates the button's
 *   own display; sends nothing — see `onSelectEmoji`)
 * - see the double-tap gesture explained, naming whichever emoji is
 *   currently selected
 * - choose how incoming reactions display locally (Section 4)
 * - hide incoming reactions locally without losing the ability to send
 *   (Section 4's own explicit instruction)
 *
 * **Not a duplicate emoji keyboard** — a small, fixed, curated set
 * (`REACTION_EMOJI_SET`), not a full picker; comments already use the
 * system keyboard for arbitrary emoji.
 *
 * **Dismissal** matches this project's other popovers/panels
 * (`RoomInfoOverlay`): a click-through backdrop and Escape both close
 * it, only while open.
 */
export function ReactionPanel({
  open,
  onClose,
  selectedEmoji,
  onSelectEmoji,
  displayMode,
  onSelectDisplayMode,
  showReactions,
  onToggleShowReactions,
}: {
  open: boolean;
  onClose: () => void;
  selectedEmoji: ReactionEmoji;
  onSelectEmoji: (emoji: ReactionEmoji) => void;
  displayMode: ReactionDisplayMode;
  onSelectDisplayMode: (mode: ReactionDisplayMode) => void;
  showReactions: boolean;
  onToggleShowReactions: (show: boolean) => void;
}) {
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div
        data-testid="reaction-panel-backdrop"
        aria-hidden="true"
        className="fixed inset-0 z-30"
        onClick={onClose}
      />
      <div
        data-testid="reaction-panel"
        role="dialog"
        aria-label="Reaction settings"
        className="absolute right-0 bottom-full z-40 mb-2 w-[min(18rem,80vw)] rounded-2xl border border-white/15 bg-black/85 p-3 text-white shadow-xl backdrop-blur"
      >
        <p className="mb-2 text-xs font-semibold tracking-wide text-white/60 uppercase">React</p>
        <div className="mb-3 grid grid-cols-4 gap-1.5">
          {REACTION_EMOJI_SET.map((emoji) => (
            <button
              key={emoji}
              type="button"
              data-testid={`reaction-emoji-option-${emoji}`}
              onClick={() => onSelectEmoji(emoji)}
              aria-pressed={emoji === selectedEmoji}
              className={cn(
                "flex h-10 items-center justify-center rounded-lg text-xl transition-colors",
                emoji === selectedEmoji ? "bg-accent/30 ring-1 ring-accent" : "bg-white/[0.08] hover:bg-white/[0.14]",
              )}
            >
              <span aria-hidden="true">{emoji}</span>
              <span className="sr-only">
                {emoji === selectedEmoji ? "Selected: " : "Set default reaction to "} {emoji}
              </span>
            </button>
          ))}
        </div>

        <p data-testid="reaction-gesture-hint" className="mb-3 text-xs text-white/70">
          Double-tap a speaker to react with <span aria-hidden="true">{selectedEmoji}</span>
        </p>

        <div className="mb-2 border-t border-white/10 pt-2">
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-white/50 uppercase">Reaction display</p>
          <div className="flex gap-1.5">
            <ToggleChip
              testId="reaction-display-on-speaker"
              label="On speaker"
              active={displayMode === "on-speaker"}
              onClick={() => onSelectDisplayMode("on-speaker")}
            />
            <ToggleChip
              testId="reaction-display-side"
              label="Side"
              active={displayMode === "side"}
              onClick={() => onSelectDisplayMode("side")}
            />
          </div>
        </div>

        <div>
          <p className="mb-1.5 text-[11px] font-semibold tracking-wide text-white/50 uppercase">Show reactions</p>
          <div className="flex gap-1.5">
            <ToggleChip
              testId="reaction-show-on"
              label="On"
              active={showReactions}
              onClick={() => onToggleShowReactions(true)}
            />
            <ToggleChip
              testId="reaction-show-off"
              label="Off"
              active={!showReactions}
              onClick={() => onToggleShowReactions(false)}
            />
          </div>
        </div>
      </div>
    </>
  );
}

function ToggleChip({
  testId,
  label,
  active,
  onClick,
}: {
  testId: string;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "flex-1 rounded-full px-2.5 py-1.5 text-xs font-medium transition-colors",
        active ? "bg-accent text-white" : "bg-white/[0.08] text-white/70 hover:bg-white/[0.14]",
      )}
    >
      {label}
    </button>
  );
}
