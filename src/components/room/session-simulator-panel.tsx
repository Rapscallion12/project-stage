"use client";

import { useEffect, useRef, useState } from "react";
import {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceRoundDeadline,
} from "@/app/events/[id]/room/simulator-actions";
import { createClient } from "@/lib/supabase/client";
import { createSimulatedAudience, randomIdentity, randomSubset, type SimulatedIdentity } from "@/lib/simulator/identities";
import { jitteredDelayMs, randomOrdinaryComment, randomSpeakerRequestComment } from "@/lib/simulator/content";
import { replacePercentage } from "@/lib/speaker-round";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

const AUDIENCE_SIZE = 20;

/**
 * Issue #21, Part 5: preview/dev-only Session Simulator — tooling, not
 * part of the Virtual Stage consumer experience (Part 11's explicit
 * instruction). Never rendered at all unless the caller's own
 * server-computed `isPreviewBuild` is true (see `EventRoom`, the one
 * place that decides this) — and every action it calls independently
 * re-checks the same thing server-side regardless (see
 * `simulator-actions.ts`'s own doc comment for why that's the actual
 * enforcement).
 *
 * **"Fake the people, not the systems"**: every button here calls a
 * `simulator-actions.ts` function that in turn calls the *same*
 * repository function/RPC a real guest's own action would. This
 * component's own job is only orchestration (which identity, which
 * target, how often) — never a parallel implementation of comments,
 * likes, votes, or selection.
 *
 * **Realistic mode**: independent jittered (never perfectly periodic —
 * Part 6) `setTimeout` loops for comments, ordinary likes, Request-to-
 * Speak submissions, request-vote shifting, and round voting — each
 * re-schedules itself with a fresh random delay after firing, until
 * `runningRef` goes false. Round votes deliberately use only a random
 * subset of the audience per tick (Part 10: "not every fake viewer
 * should vote") and lean Continue more often than Replace, so realistic
 * mode doesn't reflexively evict every speaker within seconds — but can
 * still organically produce a Replace outcome over enough ticks.
 *
 * **Deterministic mode**: one-shot buttons that combine casting an exact
 * vote split with `forceRoundDeadline` (this pass's one clock-skipping
 * adapter — see `simulator-actions.ts`) so an outcome is observable
 * immediately rather than after a real 60/30s wait.
 */
export function SessionSimulatorPanel({
  eventId,
  speakers,
  pendingRequests,
  messages,
}: {
  eventId: string;
  speakers: EventSpeaker[];
  pendingRequests: RankedPendingRequest[];
  messages: LobbyMessage[];
}) {
  const [running, setRunning] = useState(false);
  const [audience, setAudience] = useState<SimulatedIdentity[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [roundVoteTallies, setRoundVoteTallies] = useState<Record<string, { continue: number; replace: number }>>({});
  const [poolResetCount, setPoolResetCount] = useState(0);
  const prevPendingCountRef = useRef(0);

  const runningRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const speakersRef = useRef(speakers);
  const pendingRequestsRef = useRef(pendingRequests);
  const messagesRef = useRef(messages);
  const audienceRef = useRef<SimulatedIdentity[]>([]);

  speakersRef.current = speakers;
  pendingRequestsRef.current = pendingRequests;
  messagesRef.current = messages;

  function appendLog(line: string) {
    setLog((prev) => [`${new Date().toLocaleTimeString()} — ${line}`, ...prev].slice(0, 30));
  }

  // Part 14 observability: a crude, honest proxy for "pool generation/
  // reset count" — increments whenever the live pending-request count
  // drops to zero after having been non-zero, which is what a
  // successful-promotion pool reset (or simply everyone withdrawing)
  // looks like from the outside. Not a precise generation counter (this
  // component has no access to speaker_selection_rounds directly), and
  // documented as such rather than overstating its precision.
  useEffect(() => {
    if (prevPendingCountRef.current > 0 && pendingRequests.length === 0) {
      setPoolResetCount((c) => c + 1);
    }
    prevPendingCountRef.current = pendingRequests.length;
  }, [pendingRequests.length]);

  // Live round-vote tallies for the observability panel — speaker_round_votes
  // is publicly selectable (same RLS tier as speaker_requests), so this
  // reads it directly, the same "no new backend" spirit as everything
  // else here. Polls lightly (every 3s) rather than a full Realtime
  // subscription, since this is testing-only observability, not a
  // production feature.
  const speakerIdsKey = speakers.map((s) => s.id).join(",");
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    async function refresh() {
      const ids = speakersRef.current.map((s) => s.id);
      if (ids.length === 0) {
        if (!cancelled) setRoundVoteTallies({});
        return;
      }
      const { data } = await supabase.from("speaker_round_votes").select("event_speakers_id, choice").in("event_speakers_id", ids);
      if (cancelled || !data) return;
      const tallies: Record<string, { continue: number; replace: number }> = {};
      for (const id of ids) tallies[id] = { continue: 0, replace: 0 };
      for (const row of data) {
        const bucket = tallies[row.event_speakers_id];
        if (bucket) bucket[row.choice as "continue" | "replace"]++;
      }
      setRoundVoteTallies(tallies);
    }

    void refresh();
    const interval = setInterval(refresh, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [speakerIdsKey]);

  function schedule(fn: () => void, minMs: number, maxMs: number) {
    if (!runningRef.current) return;
    const timer = setTimeout(() => {
      if (runningRef.current) fn();
      schedule(fn, minMs, maxMs);
    }, jitteredDelayMs(minMs, maxMs));
    timersRef.current.push(timer);
  }

  function stopAllTimers() {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
  }

  async function startSimulation() {
    const newAudience = createSimulatedAudience(AUDIENCE_SIZE);
    audienceRef.current = newAudience;
    setAudience(newAudience);
    runningRef.current = true;
    setRunning(true);
    appendLog(`Started — ${AUDIENCE_SIZE} simulated audience identities generated`);

    // Comments: every 3-8s.
    schedule(() => {
      const identity = randomIdentity(audienceRef.current);
      void simulateComment(eventId, identity.id, identity.displayName, randomOrdinaryComment());
    }, 3000, 8000);

    // Ordinary likes: every 2-6s, on a random recent ordinary comment.
    schedule(() => {
      const ordinary = messagesRef.current.filter((m) => !m.is_speaker_request);
      if (ordinary.length === 0) return;
      const identity = randomIdentity(audienceRef.current);
      const target = ordinary[Math.floor(Math.random() * ordinary.length)];
      void simulateLike(target.id, identity.id);
    }, 2000, 6000);

    // Request-to-Speak submissions: every 15-30s.
    schedule(() => {
      const identity = randomIdentity(audienceRef.current);
      void simulateRequestToSpeak(eventId, identity.id, identity.displayName, randomSpeakerRequestComment());
    }, 15000, 30000);

    // Request-vote shifting: every 4-10s.
    schedule(() => {
      const pending = pendingRequestsRef.current;
      if (pending.length === 0) return;
      const identity = randomIdentity(audienceRef.current);
      const target = pending[Math.floor(Math.random() * pending.length)];
      void simulateRequestVote(eventId, target.message_id, identity.id);
    }, 4000, 10000);

    // Round voting: every 3-7s, a small random subset per active round,
    // leaning Continue (Part 10: "not every fake viewer should vote" +
    // avoids reflexively evicting every speaker within seconds).
    schedule(() => {
      const activeRounds = speakersRef.current.filter((s) => s.round_phase === "active");
      for (const round of activeRounds) {
        const voters = randomSubset(audienceRef.current, 3 + Math.floor(Math.random() * 5));
        for (const voter of voters) {
          const choice = Math.random() < 0.72 ? "continue" : "replace";
          void simulateRoundVote(round.id, choice, voter.id);
        }
      }
    }, 3000, 7000);
  }

  function stopSimulation() {
    runningRef.current = false;
    setRunning(false);
    stopAllTimers();
    appendLog("Stopped — no further activity will be generated (already-written data is untouched)");
  }

  useEffect(() => stopAllTimers, []);

  function requireAudience(): SimulatedIdentity[] | null {
    if (audienceRef.current.length === 0) {
      appendLog("Start the simulation first — deterministic actions reuse the generated audience pool");
      return null;
    }
    return audienceRef.current;
  }

  function generateComments(count = 5) {
    const pool = requireAudience();
    if (!pool) return;
    for (let i = 0; i < count; i++) {
      const identity = randomIdentity(pool);
      void simulateComment(eventId, identity.id, identity.displayName, randomOrdinaryComment());
    }
    appendLog(`Generated ${count} comments`);
  }

  function generateSpeakerRequests(count = 2) {
    const pool = requireAudience();
    if (!pool) return;
    const chosen = randomSubset(pool, count);
    for (const identity of chosen) {
      void simulateRequestToSpeak(eventId, identity.id, identity.displayName, randomSpeakerRequestComment());
    }
    appendLog(`Generated ${chosen.length} speaker requests`);
  }

  function shiftRequestVotes(count = 5) {
    const pool = requireAudience();
    const pending = pendingRequestsRef.current;
    if (!pool || pending.length === 0) {
      appendLog("No pending speaker requests to vote on right now");
      return;
    }
    for (let i = 0; i < count; i++) {
      const identity = randomIdentity(pool);
      const target = pending[Math.floor(Math.random() * pending.length)];
      void simulateRequestVote(eventId, target.message_id, identity.id);
    }
    appendLog(`Shifted ${count} request votes`);
  }

  function firstActiveRound(): EventSpeaker | null {
    return speakersRef.current.find((s) => s.round_phase === "active") ?? null;
  }

  async function castVotesAndForce(continueCount: number, replaceCount: number, label: string) {
    const pool = requireAudience();
    const round = firstActiveRound();
    if (!pool || !round) {
      appendLog(`${label}: no speaker currently in an active round`);
      return;
    }
    const voters = randomSubset(pool, continueCount + replaceCount);
    for (let i = 0; i < continueCount; i++) {
      void simulateRoundVote(round.id, "continue", voters[i].id);
    }
    for (let i = 0; i < replaceCount; i++) {
      void simulateRoundVote(round.id, "replace", voters[continueCount + i].id);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // let votes land before forcing the deadline
    await forceRoundDeadline(round.id);
    appendLog(`${label}: cast ${continueCount}c/${replaceCount}r for ${round.display_name}, forced deadline`);
  }

  function openSeat() {
    const occupied = speakersRef.current[0];
    if (!occupied) {
      appendLog("Open Speaker Seat: no seat is currently occupied");
      return;
    }
    const identity = occupied.profile_id ? null : { type: "guest" as const, id: occupied.guest_id! };
    if (!identity) {
      appendLog("Open Speaker Seat: real account-held seats aren't touched by the simulator — pick a simulated speaker instead");
      return;
    }
    void simulateOpenSeat(eventId, identity.id);
    appendLog(`Opened seat ${occupied.seat_number} (${occupied.display_name})`);
  }

  async function seedTwoSpeakers() {
    const pool = requireAudience();
    if (!pool) return;
    const [a, b] = randomSubset(pool, 2);
    if (a) await simulateSeedSpeaker(eventId, a.id, a.displayName, 1);
    if (b) await simulateSeedSpeaker(eventId, b.id, b.displayName, 2);
    appendLog("Seeded 2 simulated speakers directly (bootstrap only — real claim_speaker_seat RPC)");
  }

  return (
    <div
      data-testid="session-simulator-panel"
      className="fixed bottom-2 right-2 z-50 max-h-[70vh] w-80 overflow-y-auto rounded-xl border border-yellow-500/50 bg-black/95 p-3 text-xs text-white shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-semibold text-yellow-400">Session Simulator (preview only)</span>
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        <button
          type="button"
          data-testid="sim-start"
          onClick={() => void startSimulation()}
          disabled={running}
          className="rounded bg-emerald-600 px-2 py-1 font-medium disabled:opacity-40"
        >
          Start Simulated Session
        </button>
        <button
          type="button"
          data-testid="sim-stop"
          onClick={stopSimulation}
          disabled={!running}
          className="rounded bg-red-600 px-2 py-1 font-medium disabled:opacity-40"
        >
          Stop Simulation
        </button>
        <button type="button" data-testid="sim-seed-speakers" onClick={() => void seedTwoSpeakers()} className="rounded bg-white/10 px-2 py-1">
          Seed 2 Speakers
        </button>
        <button type="button" data-testid="sim-generate-comments" onClick={() => generateComments()} className="rounded bg-white/10 px-2 py-1">
          Generate Comments
        </button>
        <button type="button" data-testid="sim-generate-requests" onClick={() => generateSpeakerRequests()} className="rounded bg-white/10 px-2 py-1">
          Generate Speaker Requests
        </button>
        <button type="button" data-testid="sim-shift-votes" onClick={() => shiftRequestVotes()} className="rounded bg-white/10 px-2 py-1">
          Shift Request Votes
        </button>
        <button
          type="button"
          data-testid="sim-force-continue"
          onClick={() => void castVotesAndForce(3, 0, "Force Continue")}
          className="rounded bg-white/10 px-2 py-1"
        >
          Force Continue Outcome
        </button>
        <button
          type="button"
          data-testid="sim-force-narrow-loss"
          onClick={() => void castVotesAndForce(2, 3, "Force Narrow Loss")}
          className="rounded bg-white/10 px-2 py-1"
        >
          Force Narrow Loss
        </button>
        <button
          type="button"
          data-testid="sim-force-decisive"
          onClick={() => void castVotesAndForce(0, 2, "Force Decisive Replace")}
          className="rounded bg-white/10 px-2 py-1"
        >
          Force Decisive Replace
        </button>
        <button type="button" data-testid="sim-open-seat" onClick={openSeat} className="rounded bg-white/10 px-2 py-1">
          Open Speaker Seat
        </button>
      </div>

      <div data-testid="sim-observability" className="mb-3 flex flex-col gap-2 rounded-lg bg-white/5 p-2">
        <div className="font-semibold text-white/70">Speaker rounds</div>
        {speakers.length === 0 && <p className="text-white/40">No seats occupied</p>}
        {speakers.map((s) => {
          const tally = roundVoteTallies[s.id] ?? { continue: 0, replace: 0 };
          const pct = replacePercentage(tally.continue, tally.replace);
          const deadline = s.round_phase === "closing" ? s.closing_ends_at : s.round_ends_at;
          const remaining = deadline ? Math.max(0, Math.ceil((new Date(deadline).getTime() - Date.now()) / 1000)) : null;
          return (
            <div key={s.id} data-testid="sim-round-status" className="border-t border-white/10 pt-1">
              <p className="font-medium">
                {s.display_name} — seat {s.seat_number} — round #{s.round_number} ({s.round_phase})
              </p>
              <p>remaining: {remaining ?? "—"}s{s.round_phase === "closing" ? " (final grace period)" : ""}</p>
              <p>
                continue: {tally.continue} · replace: {tally.replace}
                {pct !== null ? ` (${pct.toFixed(0)}% replace)` : ""}
              </p>
            </div>
          );
        })}

        <div className="border-t border-white/10 pt-1 font-semibold text-white/70">Top Speaker Requests</div>
        {pendingRequests.length === 0 && <p className="text-white/40">No pending requests</p>}
        {pendingRequests.slice(0, 3).map((r, i) => (
          <p key={r.id} data-testid="sim-top-request">
            #{i + 1} {r.profile_id ? "profile" : "guest"}:{(r.profile_id ?? r.guest_id ?? "").slice(0, 8)} — {r.voteCount} votes
          </p>
        ))}

        <div className="border-t border-white/10 pt-1">
          <p data-testid="sim-pool-reset-count">pool resets observed: {poolResetCount}</p>
          <p>simulated audience: {audience.length}</p>
        </div>
      </div>

      <div data-testid="sim-log" className="flex flex-col gap-0.5 text-[10px] text-white/50">
        {log.map((line, i) => (
          <p key={i}>{line}</p>
        ))}
      </div>
    </div>
  );
}
