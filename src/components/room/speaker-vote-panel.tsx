"use client";

import { useEffect, useRef, useState } from "react";
import { voteOnSpeakerRound } from "@/app/events/[id]/room/actions";
import { createClient } from "@/lib/supabase/client";
import { useNow } from "@/hooks/use-now";
import { useSpeakerRoundCountdown } from "@/hooks/use-speaker-round-countdown";
import { ROUND_TIMER_REVEAL_SECONDS, replacePercentage } from "@/lib/speaker-round";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

type RoundTally = { continue: number; replace: number };

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
 * **Emphasis (Part 2/H, extended in the second corrective pass)**: the
 * trigger button itself intensifies (background/border/scale, plus a
 * "Vote · Ns" countdown label replacing the bare icon) as the *nearest*
 * active speaker's round approaches its deadline, within
 * `ROUND_TIMER_REVEAL_SECONDS` — the same boundary the round-timer badge
 * uses, so both surface at once. Test builds (`isPreviewBuild`) don't
 * change the emphasis window itself, only the round-timer badge's own
 * early reveal (see that component) — Part 2 explicitly keeps the
 * emphasis timing itself un-accelerated even during testing. Never opens
 * the panel automatically — someone who doesn't want to participate
 * keeps seeing exactly the same trigger, just louder.
 *
 * **Sentiment display (second corrective pass, Part 9)**: opening the
 * panel now shows each speaker's live Continue/Replace *percentages* (a
 * two-color bar, not raw counts — Part 10's explicit "percentages matter
 * more than counts" split for this surface; the Session Simulator's own
 * panel is where raw counts belong) — polled lightly from
 * `speaker_round_votes` only while the panel is actually open, never a
 * permanent subscription, so this stays "lightweight," not a standing
 * polling dashboard. Zero votes reads "No votes yet · defaults to
 * Continue" rather than a bare "0% | 0%" that could look like a real,
 * decided sentiment (Part 11). A speaker whose round has entered its
 * Final 30s closing period shows "Replacement decided" instead of a
 * tally, and its Continue/Replace buttons disappear entirely (not just
 * disabled) — that speaker's outcome is already locked, so there is
 * nothing left to vote on (Part 12); the *other* speaker's row is
 * unaffected. The percentages/bar are the exact same
 * `replacePercentage` calculation the round resolver and the Session
 * Simulator both use — never a separate guess (Part 7/9's "same
 * authoritative math" requirement, which applies here too even though
 * it was written about the simulator).
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
  const containerRef = useRef<HTMLDivElement>(null);

  // Part 2: the expanded panel is a dismissible transient surface, not a
  // modal — tapping anywhere outside it (a real pointerdown target
  // outside this component's own DOM, not just "anywhere") or pressing
  // Escape closes it, same as any ordinary popover. Only listens while
  // actually open, and only on the *document*, so interacting inside the
  // panel (a vote tap, scrolling the row list) never triggers this —
  // those events never reach `document` as an *outside* target, they
  // just bubble through this component's own subtree first. Closing only
  // ever calls `setOpen(false)` — the viewer's `myChoices` selection is
  // untouched, so reopening shows the same highlighted choice again (the
  // authoritative vote itself was already recorded server-side the
  // moment they tapped it, same as before this change).
  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: PointerEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

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
  const emphasisSeconds = emphasized && Number.isFinite(nearestDeadlineMs) ? Math.max(0, Math.ceil(nearestDeadlineMs / 1000)) : null;

  async function castVote(eventSpeakersId: string, choice: "continue" | "replace") {
    setMyChoices((prev) => ({ ...prev, [eventSpeakersId]: choice }));
    await voteOnSpeakerRound(eventSpeakersId, choice);
  }

  // Part 9: live Continue/Replace tallies for the sentiment bar — polled
  // only while the panel is actually open (never a standing
  // subscription; "extremely easy and non-annoying," not a permanent
  // dashboard). `speaker_round_votes` is publicly selectable (same RLS
  // tier the Session Simulator's own tally poll already relies on), so
  // this reads it directly rather than adding a new Server Action.
  const speakerIdsKey = speakers.map((s) => s.id).join(",");
  const [tallies, setTallies] = useState<Record<string, RoundTally>>({});
  useEffect(() => {
    if (!open || speakers.length === 0) return;
    const supabase = createClient();
    let cancelled = false;

    async function refresh() {
      const ids = speakers.map((s) => s.id);
      const { data } = await supabase.from("speaker_round_votes").select("event_speakers_id, choice").in("event_speakers_id", ids);
      if (cancelled || !data) return;
      const next: Record<string, RoundTally> = {};
      for (const id of ids) next[id] = { continue: 0, replace: 0 };
      for (const row of data) {
        const bucket = next[row.event_speakers_id];
        if (bucket) bucket[row.choice as "continue" | "replace"]++;
      }
      setTallies(next);
    }

    void refresh();
    const interval = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- speakerIdsKey is the intentional dependency (identical seat-id set), not the speakers array reference itself, which changes every Realtime tick and would otherwise restart this poll constantly.
  }, [open, speakerIdsKey]);

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
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid="watch-vote-emblem"
        aria-label="Vote"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-11 shrink-0 items-center justify-center rounded-full border text-lg transition-all ${
          emphasized
            ? "scale-110 gap-1 animate-pulse border-accent bg-accent/30 px-3 text-white"
            : "w-11 border-white/30 bg-white/[0.14] text-white"
        }`}
      >
        <span aria-hidden="true">🗳</span>
        {emphasisSeconds !== null && (
          <span data-testid="vote-emphasis-countdown" className="text-xs font-semibold">
            {emphasisSeconds}s
          </span>
        )}
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
              tally={tallies[speaker.id] ?? { continue: 0, replace: 0 }}
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
  tally,
}: {
  speaker: EventSpeaker;
  myChoice: "continue" | "replace" | undefined;
  onVote: (choice: "continue" | "replace") => void;
  isPreviewBuild: boolean;
  tally: RoundTally;
}) {
  const roundDisplay = useSpeakerRoundCountdown(speaker, isPreviewBuild);
  // Section H: no new vote is accepted once a round is in its closing
  // period — the outcome is already decided. The Continue/Replace
  // buttons are omitted entirely below (not just disabled) once this is
  // true — Part 12: "stop presenting their vote as though it remains
  // undecided," a grace period for the speaker to finish their thought,
  // not another voting window.
  const votingClosed = speaker.round_phase === "closing";
  const totalVotes = tally.continue + tally.replace;
  const replacePct = replacePercentage(tally.continue, tally.replace);
  const continuePct = replacePct === null ? null : 100 - replacePct;

  return (
    <div data-testid="speaker-vote-row" className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium text-white/90">{speaker.display_name}</span>
        {roundDisplay && <span className="shrink-0 text-[10px] text-white/50">final {roundDisplay.remainingSeconds}s</span>}
      </div>

      {votingClosed ? (
        <p data-testid="speaker-vote-locked" className="text-[11px] text-white/50">
          Replacement decided — voting closed
        </p>
      ) : totalVotes === 0 ? (
        <p data-testid="speaker-vote-sentiment" className="text-[11px] text-white/40">
          No votes yet · defaults to Continue
        </p>
      ) : (
        <div data-testid="speaker-vote-sentiment" className="flex items-center gap-1.5">
          <div className="flex h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
            <div className="h-full bg-vote-continue" style={{ width: `${continuePct}%` }} />
            <div className="h-full bg-vote-replace" style={{ width: `${replacePct}%` }} />
          </div>
          <span className="shrink-0 text-[10px] text-white/70">
            {continuePct?.toFixed(0)}% | {replacePct?.toFixed(0)}%
          </span>
        </div>
      )}

      {!votingClosed && (
        <div className="flex gap-1.5">
          <button
            type="button"
            data-testid="vote-continue"
            onClick={() => onVote("continue")}
            aria-pressed={myChoice === "continue"}
            className={`flex-1 rounded-full px-2 py-1 text-xs font-medium transition-colors ${
              myChoice === "continue" ? "bg-vote-continue text-white" : "bg-white/10 text-white/70"
            }`}
          >
            Continue
          </button>
          <button
            type="button"
            data-testid="vote-replace"
            onClick={() => onVote("replace")}
            aria-pressed={myChoice === "replace"}
            className={`flex-1 rounded-full px-2 py-1 text-xs font-medium transition-colors ${
              myChoice === "replace" ? "bg-vote-replace text-white" : "bg-white/10 text-white/70"
            }`}
          >
            Replace
          </button>
        </div>
      )}
    </div>
  );
}
