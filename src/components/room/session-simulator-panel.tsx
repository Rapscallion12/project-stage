"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
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
import {
  createSimulatedAudience,
  createSimulatedIdentity,
  randomIdentity,
  randomSubset,
  type SimulatedIdentity,
} from "@/lib/simulator/identities";
import { jitteredDelayMs, randomOrdinaryComment, randomSpeakerRequestComment } from "@/lib/simulator/content";
import { replacePercentage, resolveRoundOutcome } from "@/lib/speaker-round";
import { useNow } from "@/hooks/use-now";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";
import type { EventSpeaker, ResolveSpeakerRoundOutcome } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

/**
 * `Math.random()` wrapped in named, module-level helpers (never called
 * inline in the component body) — react-hooks/purity flags a direct
 * impure call reachable from a component's render path; every one of
 * these is only ever invoked from an event handler or a scheduled
 * callback, never render itself, but the helper indirection is what lets
 * the linter (and a reader) see that at a glance.
 */
function randomElement<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}
function randomVoterCount(min: number, maxExclusive: number): number {
  return min + Math.floor(Math.random() * (maxExclusive - min));
}
function randomRoundChoice(continueBias: number): "continue" | "replace" {
  return Math.random() < continueBias ? "continue" : "replace";
}

/** Maps the real resolver's outcome to the short label the log/feedback lines show — see this file's own doc comment on why the outcome itself always comes from the real resolver, never invented here. */
function resolvedOutcomeLabel(outcome: ResolveSpeakerRoundOutcome): string {
  switch (outcome) {
    case "continue":
      return "Continue";
    case "narrow-loss":
      return "Narrow Loss";
    case "decisive-replace":
      return "Decisive Replace";
    case "replaced-after-closing":
      return "Replaced";
    default:
      return outcome;
  }
}

/** "What would happen if this round ended right now" — Part 4's projected-outcome observability line, computed with the exact same pure decision function the real RPC mirrors (`lib/speaker-round.ts`), never a separate guess. */
function projectedOutcomeLabel(outcome: ReturnType<typeof resolveRoundOutcome>): string {
  switch (outcome) {
    case "continue":
      return "Continue +60s";
    case "narrow-loss":
      return "Final 30s then replace";
    case "decisive-replace":
      return "Replace";
  }
}

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
  onSimulatedIdentitiesCreated,
}: {
  eventId: string;
  speakers: EventSpeaker[];
  pendingRequests: RankedPendingRequest[];
  messages: LobbyMessage[];
  /** Real-device follow-up: reports every guest id this panel generates, once, at creation — the caller (EventRoom) uses this purely cosmetically, to let SpeakerTile render an obviously-simulated placeholder. Optional so this component still works standalone in tests that don't care. */
  onSimulatedIdentitiesCreated?: (ids: string[]) => void;
}) {
  const [running, setRunning] = useState(false);
  const [audience, setAudience] = useState<SimulatedIdentity[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [roundVoteTallies, setRoundVoteTallies] = useState<Record<string, { continue: number; replace: number }>>({});
  const [poolResetCount, setPoolResetCount] = useState(0);
  const prevPendingCountRef = useRef(0);
  // react-hooks/purity: the round-status "remaining seconds" display below
  // needs the current time, but reading Date.now() directly during render
  // is an impure call — useNow() is this codebase's existing ticking-clock
  // hook (see its own doc comment), same fix speaker-vote-panel.tsx already
  // uses for the identical class of issue.
  const now = useNow();

  // Presentation-only state (real-device follow-up, same issue #21): whether
  // the panel is collapsed to a small "SIM" pill, and its dragged screen
  // position. Deliberately separate from every piece of state above —
  // collapsing/moving the panel must never touch `running`/`audience`/
  // timers, so a real device can be used around the panel without
  // interrupting the simulated session underneath it.
  const [collapsed, setCollapsed] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const runningRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const speakersRef = useRef(speakers);
  const pendingRequestsRef = useRef(pendingRequests);
  const messagesRef = useRef(messages);
  const audienceRef = useRef<SimulatedIdentity[]>([]);
  // Part 5: "Seed 2 Speakers should create the same two stable simulated
  // identities for that simulation run" — generated once in
  // startSimulation, reused by every subsequent Seed 2 Speakers click in
  // the same run, never re-randomized per click.
  const seedSpeakersRef = useRef<[SimulatedIdentity, SimulatedIdentity] | null>(null);

  // react-hooks/refs: writing a ref during render is disallowed even for
  // this "mirror the latest prop for later async callbacks" pattern — the
  // assignment has to happen after commit, in an effect, not inline in
  // the render body. These refs are still never *read* during render
  // (only from scheduled timers/event handlers below), so this doesn't
  // change when the mirrored value becomes visible to anything that
  // matters — one render's worth of lag on a ref nothing reads
  // synchronously is invisible.
  useEffect(() => {
    speakersRef.current = speakers;
    pendingRequestsRef.current = pendingRequests;
    messagesRef.current = messages;
  }, [speakers, pendingRequests, messages]);

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

  // Real-device follow-up: keep the panel draggable but never fully
  // offscreen, on a phone that can rotate or resize its visual viewport
  // mid-session. A small margin (not 0) so it's never glued flush to the
  // very edge, where it'd be hard to grab again.
  const DRAG_MARGIN = 8;
  function clampToViewport(x: number, y: number, width: number, height: number) {
    const maxX = Math.max(window.innerWidth - width - DRAG_MARGIN, DRAG_MARGIN);
    const maxY = Math.max(window.innerHeight - height - DRAG_MARGIN, DRAG_MARGIN);
    return {
      x: Math.min(Math.max(x, DRAG_MARGIN), maxX),
      y: Math.min(Math.max(y, DRAG_MARGIN), maxY),
    };
  }

  function handleHeaderPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if ((event.target as HTMLElement).closest("[data-drag-ignore]")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: rect.left,
      originY: rect.top,
    };
    // Guarded rather than called unconditionally: jsdom (this component's
    // own test environment) doesn't implement the Pointer Capture methods
    // at all, unlike every real target browser.
    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
  }

  function handleHeaderPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const rect = panel.getBoundingClientRect();
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    setPosition(clampToViewport(drag.originX + dx, drag.originY + dy, rect.width, rect.height));
  }

  function handleHeaderPointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragStateRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    if (typeof event.currentTarget.hasPointerCapture === "function" && event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  // Re-clamp an existing dragged position whenever the viewport itself
  // changes shape (device rotation, mobile browser chrome show/hide) or
  // the panel's own size changes (collapse/expand) — otherwise a position
  // valid for a wide landscape panel could strand the panel off a
  // narrower portrait one. Presentation-only; never touches simulation
  // state.
  useEffect(() => {
    function reclamp() {
      const panel = panelRef.current;
      if (!panel) return;
      setPosition((prev) => {
        if (!prev) return prev;
        const rect = panel.getBoundingClientRect();
        return clampToViewport(prev.x, prev.y, rect.width, rect.height);
      });
    }
    reclamp();
    window.addEventListener("resize", reclamp);
    window.addEventListener("orientationchange", reclamp);
    return () => {
      window.removeEventListener("resize", reclamp);
      window.removeEventListener("orientationchange", reclamp);
    };
  }, [collapsed]);

  async function startSimulation() {
    const newAudience = createSimulatedAudience(AUDIENCE_SIZE);
    audienceRef.current = newAudience;
    setAudience(newAudience);
    const seedSpeakers: [SimulatedIdentity, SimulatedIdentity] = [createSimulatedIdentity(), createSimulatedIdentity()];
    seedSpeakersRef.current = seedSpeakers;
    onSimulatedIdentitiesCreated?.([...newAudience, ...seedSpeakers].map((identity) => identity.id));
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
      const target = randomElement(ordinary);
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
      const target = randomElement(pending);
      void simulateRequestVote(eventId, target.message_id, identity.id);
    }, 4000, 10000);

    // Round voting: every 3-7s, a small random subset per active round,
    // leaning Continue (Part 10: "not every fake viewer should vote" +
    // avoids reflexively evicting every speaker within seconds).
    schedule(() => {
      const activeRounds = speakersRef.current.filter((s) => s.round_phase === "active");
      for (const round of activeRounds) {
        const voters = randomSubset(audienceRef.current, randomVoterCount(3, 8));
        for (const voter of voters) {
          void simulateRoundVote(round.id, randomRoundChoice(0.72), voter.id);
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
      const target = randomElement(pending);
      void simulateRequestVote(eventId, target.message_id, identity.id);
    }
    appendLog(`Shifted ${count} request votes`);
  }

  /**
   * Part 3: scoped to one specific seat's `event_speakers` row — never
   * "whichever round happens to be active first" (the old ambiguous
   * global version). Casts the requested vote split for *that* seat only,
   * backdates *that* seat's deadline, then lets the real
   * `resolveSpeakerRoundAction` (via `forceRoundDeadline`) decide the
   * actual outcome — the returned outcome, not our intended split, is
   * what the log line and the round-status "if ended now" projection
   * ultimately reflect.
   */
  async function castVotesAndForceForSeat(speaker: EventSpeaker, continueCount: number, replaceCount: number) {
    const pool = requireAudience();
    if (!pool) return;
    const voters = randomSubset(pool, continueCount + replaceCount);
    for (let i = 0; i < continueCount; i++) {
      void simulateRoundVote(speaker.id, "continue", voters[i].id);
    }
    for (let i = 0; i < replaceCount; i++) {
      void simulateRoundVote(speaker.id, "replace", voters[continueCount + i].id);
    }
    await new Promise((resolve) => setTimeout(resolve, 300)); // let votes land before forcing the deadline
    const outcome = await forceRoundDeadline(speaker.id);
    const pct = replacePercentage(continueCount, replaceCount);
    appendLog(`Seat ${speaker.seat_number} → ${resolvedOutcomeLabel(outcome)} (${pct !== null ? pct.toFixed(0) : "0"}% Replace)`);
  }

  /** The closing-phase equivalent — no further voting is accepted once a seat is in its 30s closing period (Part 3's "no new Continue/Replace vote during those 30s"), so this just backdates and resolves without casting anything. */
  async function forceClosingNow(speaker: EventSpeaker) {
    const outcome = await forceRoundDeadline(speaker.id);
    appendLog(`Seat ${speaker.seat_number} → ${resolvedOutcomeLabel(outcome)}`);
  }

  function openSeat(speaker: EventSpeaker) {
    const guestId = speaker.profile_id ? null : speaker.guest_id;
    if (!guestId) {
      appendLog(`Seat ${speaker.seat_number}: real account-held seats aren't touched by the simulator — pick a simulated speaker instead`);
      return;
    }
    void simulateOpenSeat(eventId, guestId);
    appendLog(`Opened seat ${speaker.seat_number} (${speaker.display_name})`);
  }

  async function seedTwoSpeakers() {
    const pool = requireAudience();
    const seedSpeakers = seedSpeakersRef.current;
    if (!pool || !seedSpeakers) return;
    const [a, b] = seedSpeakers;
    await simulateSeedSpeaker(eventId, a.id, a.displayName, 1);
    await simulateSeedSpeaker(eventId, b.id, b.displayName, 2);
    appendLog(`Seeded 2 stable simulated speakers — ${a.displayName} → seat 1, ${b.displayName} → seat 2 (real claim_speaker_seat RPC)`);
  }

  const positionStyle = position ? { left: position.x, top: position.y, right: "auto", bottom: "auto" } : undefined;

  if (collapsed) {
    return (
      <div
        ref={panelRef}
        data-testid="session-simulator-panel"
        style={positionStyle}
        className="fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] right-[max(0.5rem,env(safe-area-inset-right))] z-50"
      >
        <button
          type="button"
          data-testid="sim-collapsed-toggle"
          onClick={() => setCollapsed(false)}
          aria-label="Restore Session Simulator"
          className="flex items-center gap-1 rounded-full border border-yellow-500/50 bg-black/95 px-3 py-2 text-xs font-semibold text-yellow-400 shadow-2xl"
        >
          <span>SIM</span>
          {running && (
            <span aria-hidden="true" data-testid="sim-collapsed-active-dot" className="text-emerald-400">
              •
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      data-testid="session-simulator-panel"
      style={positionStyle}
      className="fixed bottom-[max(0.5rem,env(safe-area-inset-bottom))] right-[max(0.5rem,env(safe-area-inset-right))] z-50 flex max-h-[min(55dvh,26rem)] w-64 max-w-[85vw] flex-col overflow-hidden rounded-xl border border-yellow-500/50 bg-black/95 text-xs text-white shadow-2xl"
    >
      <div
        data-testid="sim-header"
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerEnd}
        onPointerCancel={handleHeaderPointerEnd}
        className="flex shrink-0 touch-none cursor-grab items-center justify-between rounded-t-xl bg-white/5 px-2 py-1.5 active:cursor-grabbing"
      >
        <span className="font-semibold text-yellow-400">Session Simulator (preview only)</span>
        <button
          type="button"
          data-testid="sim-minimize"
          data-drag-ignore
          onClick={() => setCollapsed(true)}
          aria-label="Minimize Session Simulator"
          className="rounded px-1.5 text-sm font-bold text-white/70 hover:bg-white/10"
        >
          −
        </button>
      </div>

      <div
        className="flex-1 overflow-y-auto overscroll-contain p-2"
        style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
      >
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
      </div>

      <div data-testid="sim-observability" className="mb-3 flex flex-col gap-2 rounded-lg bg-white/5 p-2">
        <div className="font-semibold text-white/70">Speaker rounds</div>
        {speakers.length === 0 && <p className="text-white/40">No seats occupied</p>}
        {speakers.map((s) => {
          const tally = roundVoteTallies[s.id] ?? { continue: 0, replace: 0 };
          const pct = replacePercentage(tally.continue, tally.replace);
          const deadline = s.round_phase === "closing" ? s.closing_ends_at : s.round_ends_at;
          const remaining = deadline && now !== null ? Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000)) : null;
          const projected = s.round_phase === "closing" ? projectedOutcomeLabel("decisive-replace") : projectedOutcomeLabel(resolveRoundOutcome(tally.continue, tally.replace));
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
              <p data-testid="sim-projected-outcome">if ended now: {projected}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {s.round_phase === "active" ? (
                  <>
                    <button
                      type="button"
                      data-testid="sim-force-continue"
                      onClick={() => void castVotesAndForceForSeat(s, 3, 0)}
                      className="rounded bg-white/10 px-1.5 py-0.5"
                    >
                      Force Continue
                    </button>
                    <button
                      type="button"
                      data-testid="sim-force-narrow-loss"
                      onClick={() => void castVotesAndForceForSeat(s, 2, 3)}
                      className="rounded bg-white/10 px-1.5 py-0.5"
                    >
                      Force Narrow Loss
                    </button>
                    <button
                      type="button"
                      data-testid="sim-force-replace"
                      onClick={() => void castVotesAndForceForSeat(s, 0, 2)}
                      className="rounded bg-white/10 px-1.5 py-0.5"
                    >
                      Force Replace
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    data-testid="sim-force-replace-now"
                    onClick={() => void forceClosingNow(s)}
                    className="rounded bg-white/10 px-1.5 py-0.5"
                  >
                    Force Replace Now
                  </button>
                )}
                <button type="button" data-testid="sim-open-seat" onClick={() => openSeat(s)} className="rounded bg-white/10 px-1.5 py-0.5">
                  Open Seat
                </button>
              </div>
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
    </div>
  );
}
