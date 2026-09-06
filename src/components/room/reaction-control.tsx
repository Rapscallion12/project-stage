"use client";

import { useState } from "react";
import { ReactionButton } from "@/components/room/reaction-button";
import { ReactionPanel } from "@/components/room/reaction-panel";
import type { ReactionsController } from "@/hooks/use-stage-reactions";

/**
 * Pre-launch interaction pass: the button + its own settings panel,
 * wired to the one shared `ReactionsController` instance (see
 * `useReactionsController`, instantiated once in `EventRoom`) — this
 * component owns only the panel's open/closed state, nothing else.
 * Rendered in place of `WatchModeControls`' previous inert "React"
 * emblem.
 */
export function ReactionControl({
  reactions,
  onOpenChange,
  idle = false,
}: {
  reactions: ReactionsController;
  /** Pre-launch interaction pass, Section 8: lets the caller (e.g. PortraitRoom's own idle-activity hold) know the panel opened/closed, since it renders as a popover the parent has no other visibility into. Optional — every existing caller/test that doesn't care about idle transparency can omit it. */
  onOpenChange?: (open: boolean) => void;
  /** Pre-launch interaction pass, Section 8: passed straight through to the button's own idle background treatment — see ReactionButton's own doc comment. */
  idle?: boolean;
}) {
  const [panelOpen, setPanelOpen] = useState(false);

  function togglePanel() {
    setPanelOpen((open) => {
      const next = !open;
      onOpenChange?.(next);
      return next;
    });
  }

  function closePanel() {
    setPanelOpen(false);
    onOpenChange?.(false);
  }

  return (
    <div className="relative">
      <ReactionButton
        emoji={reactions.selectedEmoji}
        heatFraction={reactions.heatFraction}
        inCooldown={reactions.inCooldown}
        onOpenPanel={togglePanel}
        idle={idle}
      />
      <ReactionPanel
        open={panelOpen}
        onClose={closePanel}
        selectedEmoji={reactions.selectedEmoji}
        onSelectEmoji={reactions.setSelectedEmoji}
        displayMode={reactions.displayMode}
        onSelectDisplayMode={reactions.setDisplayMode}
        showReactions={reactions.showReactions}
        onToggleShowReactions={reactions.setShowReactions}
      />
    </div>
  );
}
