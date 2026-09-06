import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The persistent Watch Mode controls (issue #21, "05 — Social Stage"
 * interaction model): Comment/Request-to-Speak, React, Vote — small
 * translucent "glass" emblems that stay on top of the video without
 * permanently covering it, replacing the old comments-toggle button and
 * full-height chat panel.
 *
 * **Phase 1 (static shell)** shipped all controls visually final but
 * functionally inert. **Phase 2** made the composer real. The
 * **pre-launch interaction pass** made React real too — see
 * `reactionSlot` below — and removed the fourth, Gift, emblem entirely:
 * gifting/tipping isn't implemented in this prototype, and per that
 * pass's own explicit instruction, a dead affordance that still looked
 * tappable was worse than no affordance at all for a launch-facing
 * build. Nothing about *architecture* for a future gift feature was
 * deleted — this was one JSX line in one component, not a system.
 *
 * **`idle`** (pre-launch interaction pass, Section 8): fades this row's
 * own translucent "glass" backgrounds (never the emoji/text/icon
 * foreground) toward more transparent while the viewer is simply
 * watching — the *actual* background surface covering the lower speaker
 * in this design (the tall gradient `StageOverlayShell` could otherwise
 * apply is dead weight here: every caller already passes `gradient=
 * {false}`, per the 05 redesign's own "small individual emblems, not one
 * tall panel" decision — see that component's own doc comment). Only
 * ever touches the *inert placeholder* emblems this component itself
 * owns the styling of — the real composer (`ChatPanel`) and real Vote
 * panel (`SpeakerVotePanel`) keep their existing appearance regardless,
 * a deliberate scope boundary for this pass (see DECISIONS.md). Defaults
 * to `false` (today's full-opacity glass), so every existing caller/test
 * is unaffected until it opts in.
 *
 * `composer` defaults to the original Phase 1 inert placeholder if the
 * caller doesn't pass one, so this component still renders sensibly on
 * its own (e.g. in isolation in tests).
 *
 * **`micCameraSlot`** (issue #18, Speaker View UI cleanup): when
 * provided, *replaces* the React/Vote pair with whatever's passed in —
 * for Speaker View, `SpeakerMediaToggles` (live mic/camera mute
 * buttons), landing in the exact position React/Vote normally occupy.
 * Ordinary Watch Mode (every existing caller) never passes this, so the
 * row stays exactly Comment/React/Vote, unchanged — this is purely
 * additive. (A seated speaker currently has no reaction-sending UI of
 * their own either, matching the existing "no Vote UI for a seated
 * speaker" scoping choice this same slot already established.)
 *
 * **`voteSlot`** (issue #21, Part 2): activates the Vote position with
 * the real `SpeakerVotePanel` for ordinary Watch Mode callers — only
 * meaningful when `micCameraSlot` is *not* provided. Defaults to the
 * original inert placeholder, so every caller that doesn't pass it is
 * unaffected.
 *
 * **`reactionSlot`** (pre-launch interaction pass): activates the React
 * position with the real `ReactionControl` (button + its own settings
 * panel — see that component's own doc comment) for ordinary Watch Mode
 * callers, same "only meaningful without `micCameraSlot`" reasoning as
 * `voteSlot`. Defaults to the original inert placeholder.
 */
export function WatchModeControls({
  composer,
  micCameraSlot,
  voteSlot,
  reactionSlot,
  idle = false,
}: {
  composer?: ReactNode;
  micCameraSlot?: ReactNode;
  voteSlot?: ReactNode;
  reactionSlot?: ReactNode;
  idle?: boolean;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {composer ?? <InertComposerPlaceholder idle={idle} />}
      {micCameraSlot ?? (
        <>
          {reactionSlot ?? <ControlEmblem testId="watch-emoji-emblem" emoji="🙂" label="React" idle={idle} />}
          {voteSlot ?? <ControlEmblem testId="watch-vote-emblem" emoji="🗳" label="Vote" idle={idle} />}
        </>
      )}
    </div>
  );
}

function InertComposerPlaceholder({ idle }: { idle: boolean }) {
  return (
    <button
      type="button"
      disabled
      data-testid="watch-composer"
      aria-label="Add a comment"
      className={cn(
        "flex h-11 flex-1 items-center gap-2 rounded-full border border-white/30 px-3 text-left text-sm text-white/60 transition-colors duration-300 disabled:opacity-100",
        idle ? "bg-transparent" : "bg-white/[0.14]",
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full bg-white/10 text-xs"
      >
        🎙
      </span>
      <span className="truncate">Add a comment…</span>
    </button>
  );
}

function ControlEmblem({
  testId,
  emoji,
  label,
  idle,
}: {
  testId: string;
  emoji: string;
  label: string;
  idle: boolean;
}) {
  return (
    <button
      type="button"
      disabled
      data-testid={testId}
      aria-label={label}
      className={cn(
        "flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/30 text-lg transition-colors duration-300 disabled:opacity-100",
        idle ? "bg-transparent" : "bg-white/[0.14]",
      )}
    >
      <span aria-hidden="true">{emoji}</span>
    </button>
  );
}
