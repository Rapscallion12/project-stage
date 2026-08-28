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
  forceStageRoundDeadline,
  forceSeatClosingDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
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
import { SELECTION_RANK_WEIGHTS } from "@/lib/speaker-selection";
import { useNow } from "@/hooks/use-now";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { SeatResolutionOutcome, StageRound } from "@/lib/repositories/stage-rounds";

/**
 * The exact same rank-weighted odds `selectWeightedCandidate`
 * (`lib/speaker-selection.ts`) actually draws against — reusing
 * `SELECTION_RANK_WEIGHTS` directly rather than re-deriving the curve,
 * per Part 19's "reuse production decision logic, do not duplicate
 * business rules." Display-only: this never influences the real draw,
 * which happens once, server-side, in `ensureActiveSelectionRound`.
 */
function weightedSelectionOdds(count: number): number[] {
  const weights = Array.from({ length: count }, (_, i) => SELECTION_RANK_WEIGHTS[i] ?? 1);
  const total = weights.reduce((sum, w) => sum + w, 0);
  return weights.map((w) => (w / total) * 100);
}

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
/** A fresh continue-bias in [min, max) — never one fixed constant. See `moodBiasFor`'s own doc comment for why each round needs its own independently-rolled bias, not a single global one. */
function randomMoodBias(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Maps the real resolver's outcome to the short label the log/feedback lines show — see this file's own doc comment on why the outcome itself always comes from the real resolver, never invented here. */
function resolvedOutcomeLabel(outcome: SeatResolutionOutcome): string {
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
 * **One-tap full session**: `Start Simulated Session` seeds both stage
 * seats itself (via `seedTwoSpeakers`, called once from
 * `startSimulation`) rather than requiring a separate press of `Seed 2
 * Speakers` — the stage is immediately watchable, not assembled by
 * hand. `Seed 2 Speakers` stays available standalone for a deterministic
 * manual re-seed (e.g. right after an Open Seat).
 *
 * **Corrective pass — real joins take precedence**: the automatic
 * candidate-promotion loop below is the one background poll that could
 * ever race a real person tapping an open seat (both ultimately call the
 * same `claim_speaker_seat` RPC). Two layers close that race: (1) the
 * RPC itself, since this pass, refuses to silently steal an
 * already-active seat (see migration 00000000000024) — a lost race now
 * always surfaces as a clean, caught error, never a silent takeover; (2)
 * this component additionally *pauses* its own polling for as long as
 * `realJoinInProgress` is true (a real join or promotion actually in
 * flight, per `EventRoom`'s own `isJoiningSeat`/`promotionCountdown`
 * state) — an explicit, deliberate yield, not just a fair coin-flip race.
 *
 * **Shared round model — corrective pass**: the stage pairing now runs
 * one shared 60-second round (`stageRound`, from `useStageRound`) rather
 * than two independent per-speaker clocks — Continue/Replace is still
 * voted on and resolved per speaker independently, only the *deadline*
 * is shared. `Force Continue`/`Force Narrow Loss`/`Force Replace` now
 * only cast the vote split that *configures* a seat's outcome at the
 * next shared resolution — `Resolve Round Now` is the one control that
 * actually advances the shared deadline and invokes the real resolver
 * for both seats at once. A seat's own individual narrow-loss closing
 * period (Part 4's "Final 30s") is unaffected — still per-seat, still
 * immediately forceable via `Force Replace Now`.
 *
 * **Realistic mode**: independent jittered (never perfectly periodic —
 * Part 6) `setTimeout` loops for comments, ordinary likes, Request-to-
 * Speak submissions, request-vote shifting, round voting, and automatic
 * candidate promotion — each re-schedules itself with a fresh random
 * delay after firing, until `runningRef` goes false. Round votes use
 * only a random subset of the audience per tick (Part 10: "not every
 * fake viewer should vote"), and each *round* gets its own
 * independently-rolled continue-bias per seat (`moodBiasFor`) rather
 * than one fixed constant — over enough rounds this naturally produces
 * Continue, narrow-loss, and decisive-Replace outcomes for either seat,
 * not just whichever one a single fixed bias would statistically always
 * converge on.
 */
export function SessionSimulatorPanel({
  eventId,
  speakers,
  pendingRequests,
  messages,
  stageRound,
  realJoinInProgress = false,
  onSimulatedIdentitiesCreated,
  onSimulatorReset,
}: {
  eventId: string;
  speakers: EventSpeaker[];
  pendingRequests: RankedPendingRequest[];
  messages: LobbyMessage[];
  /** The shared round clock, live — see `useStageRound`. Drives the one stage-level timer this panel shows once, at the top of the observability block. */
  stageRound: StageRound | null;
  /** Corrective pass: true while `EventRoom` has a real join or promotion actually in flight (`isJoiningSeat`/`promotionCountdown`) — the automatic candidate-promotion loop pauses for as long as this is true, so it can never race a real person's own explicit action. Optional/defaults false so tests/standalone use are unaffected. */
  realJoinInProgress?: boolean;
  /** Real-device follow-up: reports every guest id this panel generates, once, at creation — the caller (EventRoom) uses this purely cosmetically, to let SpeakerTile render an obviously-simulated placeholder. Optional so this component still works standalone in tests that don't care. */
  onSimulatedIdentitiesCreated?: (ids: string[]) => void;
  /** Reset Session follow-up: called once cleanup completes, so the caller (EventRoom) can clear its own `simulatedGuestIds` set — that state is otherwise only ever added to, never removed. Optional, same reasoning as the prop above. */
  onSimulatorReset?: () => void;
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
  // Reset Session: a small inline "are you sure" step (never a native
  // confirm() dialog — keeps the whole interaction inside this panel's
  // own testable DOM) so a single stray tap can't destroy test state.
  const [resetConfirming, setResetConfirming] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const runningRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const speakersRef = useRef(speakers);
  const pendingRequestsRef = useRef(pendingRequests);
  const messagesRef = useRef(messages);
  const realJoinInProgressRef = useRef(realJoinInProgress);
  const audienceRef = useRef<SimulatedIdentity[]>([]);
  // Part 5: "Seed 2 Speakers should create the same two stable simulated
  // identities for that simulation run" — generated once in
  // startSimulation, reused by every subsequent Seed 2 Speakers click in
  // the same run, never re-randomized per click.
  const seedSpeakersRef = useRef<[SimulatedIdentity, SimulatedIdentity] | null>(null);
  // Reset Session: every guest id this panel has ever generated since the
  // last reset (or mount), across every Start/Stop cycle — not just the
  // current run's `audienceRef`, which Start *replaces* rather than
  // extends. This is the exact ownership list Reset deletes by; see
  // `resetSimulatorSession`'s own doc comment for why an exact in-memory
  // id list is the safe mechanism here, not a new schema column.
  const allSimulatedGuestIdsRef = useRef<Set<string>>(new Set());
  // Display names for every guest id above — kept alongside the id set
  // rather than re-derived, since `simulateAdvanceSelection` needs a
  // display name for whichever simulated identity gets promoted, and the
  // audience pool that originally generated it may have been superseded
  // by a later Start. A ref (for the scheduled-timer/handler reads that
  // need it, e.g. `simulateAdvanceSelection`'s own argument), mirrored
  // into state (`guestDisplayNames` below) purely so `candidateName` can
  // read it during render — react-hooks/refs correctly forbids reading a
  // ref's `.current` inside the render body itself.
  const guestDisplayNamesRef = useRef<Record<string, string>>({});
  const [guestDisplayNames, setGuestDisplayNames] = useState<Record<string, string>>({});
  // Part 3: "the simulator should naturally be capable of producing all
  // outcomes over time rather than always converging on the same one" —
  // a single fixed continue-bias would, over enough votes, reliably land
  // in "continue" territory almost every time (law of large numbers).
  // Each *round* (keyed by `event_speakers.id:round_number` — which now
  // tracks the shared round's own number, kept in sync by
  // ensure_stage_round, so a fresh shared round gets a fresh roll for
  // every seat) gets its own randomly-rolled bias instead, so some
  // rounds naturally trend toward Replace and others toward Continue.
  const roundMoodRef = useRef<Map<string, number>>(new Map());

  function moodBiasFor(speaker: EventSpeaker): number {
    const key = `${speaker.id}:${speaker.round_number}`;
    const existing = roundMoodRef.current.get(key);
    if (existing !== undefined) return existing;
    const bias = randomMoodBias(0.2, 0.9);
    roundMoodRef.current.set(key, bias);
    return bias;
  }

  /**
   * A human-readable name for a Request-to-Speak candidate — `speaker_requests`
   * itself carries no display name (only `message_id`), so this resolves
   * it the same way the real room UI would: the request's own chat
   * message's `author_display_name` first (works for real *and*
   * simulated requesters alike, since `simulateRequestToSpeak` writes a
   * real message row through the real `requestToSpeakAsGuest` path), then
   * this panel's own generated-name map as a fallback for a message not
   * yet present in the live `messages` window, then a truncated id as a
   * last resort so the observability panel never renders a blank name.
   */
  function candidateName(request: RankedPendingRequest): string {
    const fromMessage = messages.find((m) => m.id === request.message_id)?.author_display_name;
    if (fromMessage) return fromMessage;
    const guestName = request.guest_id ? guestDisplayNames[request.guest_id] : undefined;
    if (guestName) return guestName;
    return `(${(request.profile_id ?? request.guest_id ?? "unknown").slice(0, 8)})`;
  }

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
    realJoinInProgressRef.current = realJoinInProgress;
  }, [speakers, pendingRequests, messages, realJoinInProgress]);

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

  /**
   * Real-device follow-up: "I should not need to separately press Seed 2
   * Speakers just to make the simulator resemble an actual live
   * session." Start now performs the full setup in one tap — stable
   * audience, 2 seeded speakers (real seats, real 60s rounds), and every
   * realistic-mode activity loop, including the ones that keep the
   * session moving on its own (round voting, and automatic candidate
   * promotion once a seat opens). `Seed 2 Speakers` stays available
   * standalone for deterministic re-seeding (e.g. right after a manual
   * Open Seat), not as a required extra step.
   */
  async function startSimulation() {
    appendLog("Starting session…");
    const newAudience = createSimulatedAudience(AUDIENCE_SIZE);
    audienceRef.current = newAudience;
    setAudience(newAudience);
    const seedSpeakers: [SimulatedIdentity, SimulatedIdentity] = [createSimulatedIdentity(), createSimulatedIdentity()];
    seedSpeakersRef.current = seedSpeakers;
    const allNewIdentities = [...newAudience, ...seedSpeakers];
    for (const identity of allNewIdentities) {
      allSimulatedGuestIdsRef.current.add(identity.id);
      guestDisplayNamesRef.current[identity.id] = identity.displayName;
    }
    setGuestDisplayNames({ ...guestDisplayNamesRef.current });
    onSimulatedIdentitiesCreated?.(allNewIdentities.map((identity) => identity.id));
    runningRef.current = true;
    setRunning(true);
    appendLog(`${AUDIENCE_SIZE} simulated audience identities generated`);

    await seedTwoSpeakers();

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

    // Round voting: every 3-7s, a small random subset per active seat
    // (Part 10: "not every fake viewer should vote"). Each seat's current
    // round gets its own independently-rolled continue-bias
    // (`moodBiasFor`) rather than one fixed constant, so outcomes vary
    // seat to seat and round to round instead of always converging on
    // Continue.
    schedule(() => {
      const activeSeats = speakersRef.current.filter((s) => s.round_phase === "active");
      for (const seat of activeSeats) {
        const bias = moodBiasFor(seat);
        const voters = randomSubset(audienceRef.current, randomVoterCount(3, 8));
        for (const voter of voters) {
          void simulateRoundVote(seat.id, randomRoundChoice(bias), voter.id);
        }
      }
    }, 3000, 7000);

    // Part 4/5: automatic candidate promotion — every 4-6s (matching
    // production's own useAutomaticPromotion polling interval), checks
    // whether a seat is open and, only when the real weighted-selection
    // round's winner is already a known simulated identity, completes
    // the exact claim a real candidate's own browser would perform. See
    // simulateAdvanceSelection's own doc comment for the full reasoning
    // and the safety check that keeps this from ever acting on a real
    // user's behalf. Paused entirely while `realJoinInProgress` is true —
    // a real join/promotion always gets first refusal, never a race.
    schedule(() => {
      if (realJoinInProgressRef.current) return;
      if (speakersRef.current.length >= 2) return;
      void simulateAdvanceSelection(eventId, Array.from(allSimulatedGuestIdsRef.current), guestDisplayNamesRef.current).then(
        (result) => {
          if (result.claimed) {
            const name = guestDisplayNamesRef.current[result.guestId] ?? "a simulated candidate";
            appendLog(`Seat ${result.seatNumber} → ${name} promoted (real weighted selection)`);
          }
        },
      );
    }, 4000, 6000);
  }

  function stopSimulation() {
    runningRef.current = false;
    setRunning(false);
    stopAllTimers();
    appendLog("Stopped — no further activity will be generated (already-written data is untouched)");
  }

  /**
   * "Reset Session" — genuinely destroys everything the simulator wrote
   * this run and returns to a clean test room, unlike Stop (which only
   * halts future activity). Stops the session first (a reset run can't
   * keep generating activity against data that's about to be deleted),
   * deletes every DB row owned by any guest id this panel has generated
   * since the last reset, then clears every piece of local run state —
   * the *next* Start Simulated Session genuinely starts fresh, with a new
   * audience and no memory of the old one (including the shared round:
   * once both seeded seats are gone, `ensure_stage_round` marks the stage
   * `awaiting_pairing` again server-side, same as any other double-vacancy).
   */
  async function confirmReset() {
    setResetConfirming(false);
    runningRef.current = false;
    setRunning(false);
    stopAllTimers();

    const guestIds = Array.from(allSimulatedGuestIdsRef.current);
    const result = await resetSimulatorSession(eventId, guestIds);

    allSimulatedGuestIdsRef.current = new Set();
    guestDisplayNamesRef.current = {};
    setGuestDisplayNames({});
    roundMoodRef.current = new Map();
    audienceRef.current = [];
    seedSpeakersRef.current = null;
    setAudience([]);
    setRoundVoteTallies({});
    setPoolResetCount(0);
    prevPendingCountRef.current = 0;
    setLog([
      `${new Date().toLocaleTimeString()} — Reset — cleared ${result.messagesDeleted} comments, ${result.reactionsDeleted} likes, ${result.speakersDeleted} speaker seats, ${result.requestVotesDeleted} request votes, ${result.roundVotesDeleted} round votes`,
    ]);
    onSimulatorReset?.();
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
   * Corrective pass: scoped to one specific seat's `event_speakers`
   * row — never a global "whichever round" ambiguity. Casts the
   * requested vote split for *that* seat only, aiming its outcome at the
   * *next shared resolution* — unlike the old per-speaker model, this no
   * longer forces anything itself. `Resolve Round Now` is the separate
   * control that actually advances the shared deadline and reports what
   * each seat's real outcome turned out to be.
   */
  function castVotesForSeat(speaker: EventSpeaker, continueCount: number, replaceCount: number, label: string) {
    const pool = requireAudience();
    if (!pool) return;
    const voters = randomSubset(pool, continueCount + replaceCount);
    for (let i = 0; i < continueCount; i++) {
      void simulateRoundVote(speaker.id, "continue", voters[i].id);
    }
    for (let i = 0; i < replaceCount; i++) {
      void simulateRoundVote(speaker.id, "replace", voters[continueCount + i].id);
    }
    const pct = replacePercentage(continueCount, replaceCount);
    appendLog(
      `Seat ${speaker.seat_number} configured → aiming for ${label} (${pct !== null ? pct.toFixed(0) : "0"}% Replace) — click Resolve Round Now to apply`,
    );
  }

  /** Backdates the shared deadline and invokes the real resolver for both occupied seats at once — the one control that actually advances the round. */
  async function resolveRoundNow() {
    const outcomes = await forceStageRoundDeadline(eventId);
    if (outcomes.length === 0) {
      appendLog("Resolve Round Now: no active shared round to resolve");
      return;
    }
    for (const { eventSpeakersId, outcome } of outcomes) {
      const seat = speakersRef.current.find((s) => s.id === eventSpeakersId);
      appendLog(`Seat ${seat?.seat_number ?? "?"} → ${resolvedOutcomeLabel(outcome)}`);
    }
  }

  /** The closing-phase equivalent — no further voting is accepted once a seat is in its own 30s closing period (Part 4: "no new Continue/Replace vote during those 30s"), so this just backdates that one seat's deadline and resolves it, never touching the shared clock or the other seat. */
  async function forceClosingNow(speaker: EventSpeaker) {
    const resolved = await forceSeatClosingDeadline(speaker.id);
    appendLog(`Seat ${speaker.seat_number} → ${resolved ? "Replaced" : "not yet in closing"}`);
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

  /**
   * Claims both seats for the run's two stable identities, one at a time
   * — issue #21, second corrective pass, real-device finding. Previously
   * claimed both seats *concurrently* (`Promise.allSettled` firing two
   * simultaneous `claim_speaker_seat` calls), which raced a genuine
   * database bug: on a brand-new event with no `stage_rounds` row yet,
   * both concurrent calls' own `ensure_stage_round` step could try to
   * insert that row at once, and the loser's uncaught unique-constraint
   * violation rolled back its *entire* transaction — including the seat
   * claim itself — silently leaving only one seat occupied. Fixed at the
   * root, in the database (migration 00000000000028): the insert is now
   * conflict-safe. Claiming sequentially here besides is what makes this
   * mirror the realistic case the fix targets — two people (or a person
   * and this panel) claiming seats moments apart, not at the exact same
   * instant — and it's what makes each step's own success/failure
   * individually reportable below, rather than an ambiguous combined
   * result. Each step is still independently tolerant of that one seat
   * already being occupied (a real user got there first, or this is a
   * manual re-seed after only one seat opened) — a genuine per-step
   * failure is logged with its real error message, never swallowed, per
   * "either reach the valid two-speaker state or clearly report the
   * actual failure."
   */
  async function seedTwoSpeakers() {
    const pool = requireAudience();
    const seedSpeakers = seedSpeakersRef.current;
    if (!pool || !seedSpeakers) return;
    const [a, b] = seedSpeakers;

    appendLog("Seeding Seat 1…");
    const seat1Ok = await claimSeedSeat(a, 1);

    appendLog("Seeding Seat 2…");
    const seat2Ok = await claimSeedSeat(b, 2);

    if (seat1Ok && seat2Ok) {
      appendLog("Starting Round 1…");
      const supabase = createClient();
      const { data: round } = await supabase.from("stage_rounds").select("round_number, phase").eq("event_id", eventId).maybeSingle();
      if (round?.phase === "active") {
        appendLog(`Seeded 2 stable simulated speakers — ${a.displayName} → seat 1, ${b.displayName} → seat 2, Round ${round.round_number} active`);
      } else {
        appendLog(
          `Seeded 2 stable simulated speakers, but the shared round did not start (phase: ${round?.phase ?? "unknown"}) — this is unexpected; check server logs`,
        );
      }
    } else if (seat1Ok || seat2Ok) {
      appendLog(`Seeded 1 simulated speaker (${seat1Ok ? a.displayName : b.displayName}) — the other seat was already occupied`);
    } else {
      appendLog("Could not seed simulated speakers — both seats already occupied");
    }
  }

  /** One seat-claim attempt for `seedTwoSpeakers` above — returns whether it succeeded, logging the real error (not a swallowed failure) when it didn't. */
  async function claimSeedSeat(identity: SimulatedIdentity, seatNumber: 1 | 2): Promise<boolean> {
    try {
      await simulateSeedSpeaker(eventId, identity.id, identity.displayName, seatNumber);
      return true;
    } catch (err) {
      appendLog(`Seat ${seatNumber} seed failed: ${err instanceof Error ? err.message : "unknown error"}`);
      return false;
    }
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

  const sharedRemaining =
    stageRound && stageRound.phase === "active" && now !== null
      ? Math.max(0, Math.ceil((new Date(stageRound.ends_at).getTime() - now) / 1000))
      : null;

  /**
   * Part 3/4: "was the #1 request legitimately outdrawn by the weighted
   * random pick, or did something actually fail" — answerable only if
   * the panel shows the *same* frozen ranking/weights/pick the real
   * resolver used, never a separate guess. `pendingRequests` already
   * carries `frozen_rank`/`frozen_vote_count`/`is_current_candidate` set
   * by the real `freeze_speaker_candidates`/`set_current_speaker_candidate`
   * RPCs (see `ensureActiveSelectionRound`, actions.ts) — this just reads
   * them, live, for as long as the frozen round's members are still
   * `pending` (a promoted/expired member drops out of `pendingRequests`
   * once the pool resets, at which point the activity log's own
   * "promoted" line is the durable record of what happened).
   */
  const frozenCandidates = pendingRequests
    .filter((r) => r.frozen_rank !== null)
    .sort((a, b) => (a.frozen_rank ?? 0) - (b.frozen_rank ?? 0));
  const frozenOdds = weightedSelectionOdds(frozenCandidates.length);
  const selectedCandidate = frozenCandidates.find((r) => r.is_current_candidate) ?? null;
  const selectedSeat = selectedCandidate
    ? (speakers.find(
        (s) =>
          (selectedCandidate.profile_id && s.profile_id === selectedCandidate.profile_id) ||
          (selectedCandidate.guest_id && s.guest_id === selectedCandidate.guest_id),
      ) ?? null)
    : null;

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
        {resetConfirming ? (
          <div data-testid="sim-reset-confirm-row" className="flex items-center gap-1.5 rounded bg-white/10 px-2 py-1">
            <span className="font-medium">Reset simulated session?</span>
            <button type="button" data-testid="sim-reset-cancel" onClick={() => setResetConfirming(false)} className="rounded bg-white/10 px-1.5 py-0.5">
              Cancel
            </button>
            <button type="button" data-testid="sim-reset-confirm" onClick={() => void confirmReset()} className="rounded bg-red-600 px-1.5 py-0.5 font-medium">
              Reset
            </button>
          </div>
        ) : (
          <button
            type="button"
            data-testid="sim-reset"
            onClick={() => setResetConfirming(true)}
            className="rounded bg-orange-700 px-2 py-1 font-medium"
          >
            Reset Session
          </button>
        )}
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
        <button type="button" data-testid="sim-resolve-round" onClick={() => void resolveRoundNow()} className="rounded bg-indigo-600 px-2 py-1 font-medium">
          Resolve Round Now
        </button>
      </div>

      <div data-testid="sim-observability" className="mb-3 flex flex-col gap-2 rounded-lg bg-white/5 p-2">
        <div data-testid="sim-shared-round" className="font-semibold text-white/90">
          {stageRound === null
            ? "Round: —"
            : stageRound.phase === "awaiting_pairing"
              ? `Round ${stageRound.round_number} · awaiting pairing`
              : `Round ${stageRound.round_number} · ${sharedRemaining ?? "—"}s`}
        </div>

        {speakers.length === 0 && <p className="text-white/40">No seats occupied</p>}
        {speakers.map((s) => {
          const tally = roundVoteTallies[s.id] ?? { continue: 0, replace: 0 };
          const totalVotes = tally.continue + tally.replace;
          const replacePct = replacePercentage(tally.continue, tally.replace);
          const continuePct = replacePct === null ? null : 100 - replacePct;
          const projected =
            s.round_phase === "closing" ? projectedOutcomeLabel("decisive-replace") : projectedOutcomeLabel(resolveRoundOutcome(tally.continue, tally.replace));
          const closingRemaining =
            s.round_phase === "closing" && s.closing_ends_at && now !== null
              ? Math.max(0, Math.ceil((new Date(s.closing_ends_at).getTime() - now) / 1000))
              : null;
          return (
            <div key={s.id} data-testid="sim-round-status" className="border-t border-white/10 pt-1">
              <p className="font-medium">
                Seat {s.seat_number} — {s.display_name}
                {s.round_phase === "closing" ? ` (final ${closingRemaining ?? "—"}s)` : ""}
              </p>
              {totalVotes === 0 ? (
                <p className="text-white/40">No votes yet</p>
              ) : (
                <>
                  <p>
                    Continue {tally.continue} · {continuePct?.toFixed(0)}%
                  </p>
                  <p>
                    Replace {tally.replace} · {replacePct?.toFixed(0)}%
                  </p>
                  <p className="text-white/50">{totalVotes} votes cast</p>
                </>
              )}
              <p data-testid="sim-projected-outcome">Projected: {projected}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {s.round_phase === "active" ? (
                  <>
                    <button
                      type="button"
                      data-testid="sim-force-continue"
                      onClick={() => castVotesForSeat(s, 3, 0, "Continue")}
                      className="rounded bg-white/10 px-1.5 py-0.5"
                    >
                      Force Continue
                    </button>
                    <button
                      type="button"
                      data-testid="sim-force-narrow-loss"
                      onClick={() => castVotesForSeat(s, 2, 3, "Narrow Loss")}
                      className="rounded bg-white/10 px-1.5 py-0.5"
                    >
                      Force Narrow Loss
                    </button>
                    <button
                      type="button"
                      data-testid="sim-force-replace"
                      onClick={() => castVotesForSeat(s, 0, 2, "Replace")}
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
            #{i + 1} {candidateName(r)} — {r.voteCount} votes
          </p>
        ))}

        {/*
          Part 3/4: makes the weighted-selection draw legible — "did #1
          legitimately lose the weighted draw, or did something actually
          fail" is unanswerable without seeing the same frozen
          ranking/odds/pick the real resolver used. See `frozenCandidates`'
          own doc comment above.
        */}
        <div className="border-t border-white/10 pt-1 font-semibold text-white/70">Selection</div>
        {frozenCandidates.length === 0 ? (
          <p className="text-white/40">No candidate selection in progress</p>
        ) : (
          <>
            <p className="text-white/50">Frozen Top {frozenCandidates.length}:</p>
            {frozenCandidates.map((r, i) => (
              <p key={r.id} data-testid="sim-frozen-candidate">
                #{r.frozen_rank} {candidateName(r)} — {r.frozen_vote_count} votes — {frozenOdds[i]?.toFixed(0)}%
                {r.is_current_candidate && (
                  <span data-testid="sim-selected-candidate" className="font-semibold text-emerald-400">
                    {" "}
                    — selected
                  </span>
                )}
              </p>
            ))}
            {selectedCandidate && (
              <p data-testid="sim-selection-status">
                Selected: {candidateName(selectedCandidate)} — {selectedSeat ? `promoted (Seat ${selectedSeat.seat_number})` : "joining"}
              </p>
            )}
          </>
        )}

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
