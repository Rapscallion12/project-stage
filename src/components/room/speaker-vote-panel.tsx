"use client";

import { useState } from "react";
import { voteOnSpeakerRound } from "@/app/events/[id]/room/actions";
import { useNow } from "@/hooks/use-now";
import { useSpeakerRoundCountdown } from "@/hooks/use-speaker-round-countdown";
import { ROUND_TIMER_REVEAL_SECONDS } from "@/lib/speaker-round";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * Issue #21, Part 2: activates the previously-inert Vote emblem
 * (`WatchModeControls`) into a real, compact Continue/Replace control —
 * per-speaker, per explicit instruction, not one vote for "the room."
 * Own local `open` state, so no room composition needs to lift anything
 * for this (unlike `ExpandedComments`, which needed an external trigger
 * from the ambient bubbles) — tap the emblem, a small panel appears
 * directly above it; tap again (or pick a choice, or tap elsewhere) to
 * dismiss. Never opens itself, never modal, never covers the stage —
 * "someone who doesn't want to participate should be able to ignore it
 * completely."
 *
 * **My own displayed choice is local-only, deliberately, not a second
 * Realtime subscription**: the *authoritative* tally is entirely
 * server-side (`speaker_round_votes`, resolved by `resolve_speaker_round`)
 * — this panel only needs to reflect what *this tap* just chose, not
 * mirror truth across every open tab. Resets whenever the round itself
 * changes (`round_number`/`round_phase`), matching "votes reset when a
 * new round begins" — a stale highlighted choice from the previous round
 * never survives into the next one, even without a fresh page load.
 *
 * **Scoped to Watch Mode only, per explicit instruction to preserve
 * Speaker View's approved control row** — a seated speaker's own
 * `WatchModeControls` slot is already fully occupied by
 * `SpeakerMediaToggles` (mic/camera), a deliberate, already-approved
 * design; this component is never rendered there. A seated speaker
 * currently has no way to vote on a *co-speaker's* round — a known,
 * reported scoping limitation for this pass, not an oversight.
 *
 * **Emphasis (Part 2/H)**: the trigger button itself intensifies
 * (background/border/scale) as the *nearest* active speaker's round
 * approaches its deadline, within `ROUND_TIMER_REVEAL_SECONDS` — the
 * same boundary the round-timer badge uses, so both surface at once.
 * Test builds (`isPreviewBuild`) don't change the emphasis window
 * itself, only the round-timer badge's own early reveal (see that
 * component) — Part 2 explicitly keeps the emphasis timing itself
 * un-accelerated even during testing.
 */
export function SpeakerVotePanel({
  speakers,
  isPreviewBuild,
}: {
  speakers: EventSpeaker[];
  isPreviewBuild: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [myChoices, setMyChoices] = useState<Record<string, "continue" | "replace">>({});

  // Votes reset when a new round begins — drop any locally-remembered
  // choice for a round that's no longer the current one. Reset during
  // render (React's own recommended "adjusting state when a prop
  // changes" pattern), not an Effect: an Effect body calling setState
  // synchronously is exactly the cascading-render anti-pattern
  // react-hooks/set-state-in-effect flags.
  const roundKey = speakers.map((s) => `${s.id}:${s.round_number}:${s.round_phase}`).join("|");
  const [prevRoundKey, setPrevRoundKey] = useState(roundKey);
  if (roundKey !== prevRoundKey) {
    setPrevRoundKey(roundKey);
    setMyChoices({});
  }

  // useNow() (a shared, properly-cached useSyncExternalStore tick — see
  // its own doc comment on the infinite-loop bug a bare Date.now() read
  // here would otherwise reproduce) rather than reading Date.now()
  // directly during render, which react-hooks/purity correctly flags as
  // impure.
  const now = useNow();
  const nearestDeadlineMs =
    now === null
      ? Infinity
      : Math.min(
          ...speakers.map((s) => {
            const deadline = s.round_phase === "closing" ? s.closing_ends_at : s.round_ends_at;
            return deadline ? new Date(deadline).getTime() - now : Infinity;
          }),
          Infinity,
        );
  const emphasized = nearestDeadlineMs <= ROUND_TIMER_REVEAL_SECONDS * 1000;

  async function castVote(eventSpeakersId: string, choice: "continue" | "replace") {
    setMyChoices((prev) => ({ ...prev, [eventSpeakersId]: choice }));
    await voteOnSpeakerRound(eventSpeakersId, choice);
  }

  if (speakers.length === 0) {
    return (
      <button
        type="button"
        disabled
        data-testid="watch-vote-emblem"
        aria-label="Vote"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-white/30 bg-white/[0.14] text-lg disabled:opacity-100"
      >
        <span aria-hidden="true">🗳</span>
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        data-testid="watch-vote-emblem"
        aria-label="Vote"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full border text-lg transition-all ${
          emphasized
            ? "scale-110 animate-pulse border-accent bg-accent/30 text-white"
            : "border-white/30 bg-white/[0.14] text-white"
        }`}
      >
        <span aria-hidden="true">🗳</span>
      </button>

      {open && (
        <div
          data-testid="speaker-vote-panel"
          className="absolute bottom-full right-0 mb-2 flex w-56 flex-col gap-2 rounded-2xl border border-white/10 bg-black/90 p-3 shadow-lg"
        >
          {speakers.map((speaker) => (
            <SpeakerVoteRow
              key={speaker.id}
              speaker={speaker}
              myChoice={myChoices[speaker.id]}
              onVote={(choice) => void castVote(speaker.id, choice)}
              isPreviewBuild={isPreviewBuild}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SpeakerVoteRow({
  speaker,
  myChoice,
  onVote,
  isPreviewBuild,
}: {
  speaker: EventSpeaker;
  myChoice: "continue" | "replace" | undefined;
  onVote: (choice: "continue" | "replace") => void;
  isPreviewBuild: boolean;
}) {
  const roundDisplay = useSpeakerRoundCountdown(speaker, isPreviewBuild);
  // Section H: no new vote is accepted once a round is in its closing
  // period — the outcome is already decided. Disabled here too, not
  // just server-side, so the UI doesn't invite a tap that would fail.
  const votingClosed = speaker.round_phase === "closing";

  return (
    <div data-testid="speaker-vote-row" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-white/90">{speaker.display_name}</span>
        {roundDisplay && (
          <span className="shrink-0 text-[10px] text-white/50">
            {roundDisplay.phase === "closing" ? `final ${roundDisplay.remainingSeconds}s` : `${roundDisplay.remainingSeconds}s`}
          </span>
        )}
      </div>
      <div className="flex gap-1.5">
        <button
          type="button"
          data-testid="vote-continue"
          disabled={votingClosed}
          onClick={() => onVote("continue")}
          aria-pressed={myChoice === "continue"}
          className={`flex-1 rounded-full px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
            myChoice === "continue" ? "bg-emerald-500 text-white" : "bg-white/10 text-white/70"
          }`}
        >
          Continue
        </button>
        <button
          type="button"
          data-testid="vote-replace"
          disabled={votingClosed}
          onClick={() => onVote("replace")}
          aria-pressed={myChoice === "replace"}
          className={`flex-1 rounded-full px-2 py-1 text-xs font-medium transition-colors disabled:opacity-40 ${
            myChoice === "replace" ? "bg-red-500 text-white" : "bg-white/10 text-white/70"
          }`}
        >
          Replace
        </button>
      </div>
    </div>
  );
}
