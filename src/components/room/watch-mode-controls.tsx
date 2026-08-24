import type { ReactNode } from "react";

/**
 * The four persistent Watch Mode controls (issue #21, "05 — Social
 * Stage" interaction model): Comment/Request-to-Speak, React, Vote,
 * Gift — small translucent "glass" emblems that stay on top of the
 * video without permanently covering it, replacing the old
 * comments-toggle button and full-height chat panel.
 *
 * **Phase 1 (static shell)** shipped all four visually final but
 * functionally inert. **Phase 2** makes the composer real —
 * `composer` is the compact `ChatPanel` (reusing its existing
 * send/request-to-speak actions and synchronous-`onPrepareMedia`
 * gesture-safety requirement verbatim, see `ChatPanel`'s own doc
 * comment) — while React/Vote/Gift stay `disabled` placeholders until
 * their own later phase:
 * - React → Phases 5 (ambient broadcast) and 6 (double-tap targeting)
 * - Vote / Gift → Phase 7, and even then only as local-UI prototype
 *   shells — no backend, no persistence; see DECISIONS.md.
 *
 * `composer` defaults to the original Phase 1 inert placeholder if the
 * caller doesn't pass one, so this component still renders sensibly on
 * its own (e.g. in isolation in tests).
 *
 * **`micCameraSlot`** (issue #18, Speaker View UI cleanup): when
 * provided, *replaces* the React/Vote pair with whatever's passed in —
 * for Speaker View, `SpeakerMediaToggles` (live mic/camera mute
 * buttons), landing in the exact position React/Vote normally occupy.
 * `Gift` stays in place either way, still inert. Ordinary Watch Mode
 * (every existing caller) never passes this, so the row stays exactly
 * Comment/React/Vote/Gift, unchanged — this is purely additive.
 */
export function WatchModeControls({
  composer,
  micCameraSlot,
}: {
  composer?: ReactNode;
  micCameraSlot?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {composer ?? <InertComposerPlaceholder />}
      {micCameraSlot ?? (
        <>
          <ControlEmblem testId="watch-emoji-emblem" emoji="🙂" label="React" />
          <ControlEmblem testId="watch-vote-emblem" emoji="🗳" label="Vote" />
        </>
      )}
      <ControlEmblem testId="watch-gift-emblem" emoji="🎁" label="Gift" />
    </div>
  );
}

function InertComposerPlaceholder() {
  return (
    <button
      type="button"
      disabled
      data-testid="watch-composer"
      aria-label="Add a comment"
      className="flex h-11 flex-1 items-center gap-2 rounded-full border border-white/30 bg-white/[0.14] px-3 text-left text-sm text-white/60 disabled:opacity-100"
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

function ControlEmblem({ testId, emoji, label }: { testId: string; emoji: string; label: string }) {
  return (
    <button
      type="button"
      disabled
      data-testid={testId}
      aria-label={label}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/[0.14] text-lg disabled:opacity-100"
    >
      <span aria-hidden="true">{emoji}</span>
    </button>
  );
}
