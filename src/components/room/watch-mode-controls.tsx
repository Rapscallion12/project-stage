/**
 * The four persistent Watch Mode controls (issue #21, "05 — Social
 * Stage" interaction model): Comment/Request-to-Speak, React, Vote,
 * Gift — small translucent "glass" emblems that stay on top of the
 * video without permanently covering it, replacing the old
 * comments-toggle button and full-height chat panel.
 *
 * **Phase 1 (static shell) — all four are visually final but
 * functionally inert.** Each becomes real in its own later phase, not
 * this one:
 * - Comment composer → Phase 2 (reuses ChatPanel's existing
 *   send/request-to-speak actions and its synchronous-onPrepareMedia
 *   gesture-safety requirement — see ChatPanel's own doc comment. Not
 *   duplicated here.)
 * - React → Phases 5 (ambient broadcast) and 6 (double-tap targeting)
 * - Vote / Gift → Phase 7, and even then only as local-UI prototype
 *   shells — no backend, no persistence; see DECISIONS.md.
 *
 * Deliberately a `disabled` `<button>` for each control in this phase
 * rather than a plain `<div>` — semantically correct (screen readers
 * announce them as controls, just not currently operable) and it means
 * later phases only need to remove `disabled` and add a real handler,
 * not restructure the markup.
 */
export function WatchModeControls() {
  return (
    <div className="flex items-center gap-2.5">
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
      <ControlEmblem testId="watch-emoji-emblem" emoji="🙂" label="React" />
      <ControlEmblem testId="watch-vote-emblem" emoji="🗳" label="Vote" />
      <ControlEmblem testId="watch-gift-emblem" emoji="🎁" label="Gift" />
    </div>
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
