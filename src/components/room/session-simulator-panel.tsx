"use client";

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateWithdrawRequest,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceStageRoundDeadline,
  forceSeatClosingDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
} from "@/app/events/[id]/room/simulator-actions";
import { reconcileStageRoundAction } from "@/app/events/[id]/room/actions";
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
import { useSeatPromotionTiming } from "@/hooks/use-seat-promotion-timing";
import { PROMOTION_COUNTDOWN_SECONDS } from "@/hooks/use-automatic-promotion";
import { SimButton } from "@/components/room/sim-button";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { SeatResolutionOutcome, StageRound } from "@/lib/repositories/stage-rounds";

/**
 * Issue #21, third corrective pass: selection is now deterministic —
 * highest vote count wins, earliest active request breaks a tie (the
 * exact order `freeze_speaker_candidates` already ranks by). This
 * mirrors that same reasoning purely for the observability label, never
 * deciding anything itself — the real pick happens once, server-side, in
 * `ensureActiveSelectionRound`.
 */
function selectionReason(frozen: RankedPendingRequest[]): string {
  const winner = frozen.find((r) => r.frozen_rank === 1);
  if (!winner) return "";
  const runnerUp = frozen.find((r) => r.frozen_rank === 2);
  if (runnerUp && runnerUp.frozen_vote_count === winner.frozen_vote_count) {
    return `Tied at ${winner.frozen_vote_count} votes · earlier request`;
  }
  return "Highest vote count";
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

/**
 * Issue #21, sixth corrective pass, Sections 2-3, 20-21: formats a
 * millisecond delta from a seat's own `vacantAt` for the diagnostic
 * timeline below — every input is a real `Date.now()` difference
 * (`useSeatPromotionTiming`), never an estimate. Milliseconds under a
 * second stay as milliseconds (the resolution that actually matters for
 * "was this instant or not"); a second or more switches to one decimal
 * of seconds, matching the user's own example format.
 */
function formatDelta(ms: number): string {
  return ms < 1000 ? `+${ms}ms` : `+${(ms / 1000).toFixed(1)}s`;
}

/** Short, human-readable label for the compact Startup observability block (Section 8) — never invents a state the machine itself doesn't have. */
function startupPhaseLabel(phase: StartupPhase): string {
  switch (phase) {
    case "idle":
      return "Idle";
    case "preparing":
      return "Preparing";
    case "seeding":
      return "Seeding seats";
    case "verifying-pairing":
      return "Verifying pairing";
    case "establishing-round":
      return "Starting round";
    case "running":
      return "Running";
    case "failed":
      return "Failed";
  }
}

const AUDIENCE_SIZE = 20;

/**
 * Issue #21, fourth corrective pass: a real-device pass found the
 * simulator could enter an invalid state — both seats "Selecting next
 * speaker…" while a shared round kept counting down. The invariant this
 * pass exists to enforce: **a normal shared round may exist/count down
 * only once the stage's two-speaker pairing is authoritatively
 * established.** `startSimulation` used to flip `running` true and
 * schedule every natural-activity loop *before* confirming seeding had
 * actually succeeded — this bounded state machine closes that gap.
 *
 * Phases: `preparing` (audience/identity generation) → `seeding` (seat
 * establishment, see `establishSeat`'s Case A/B split below) →
 * `verifying-pairing` (both seats confirmed, tracked here for
 * observability even though establishSeat's own return already gates
 * progress) → `establishing-round` (confirms the shared round actually
 * started, backstopped by `reconcileStageRoundAction` — see that
 * action's own doc comment) → `running`, or `failed` at any bounded step
 * that didn't succeed. Natural activity is only ever scheduled after
 * `running` is reached — see `startSimulation`.
 */
type StartupPhase = "idle" | "preparing" | "seeding" | "verifying-pairing" | "establishing-round" | "running" | "failed";
type SeatStartupStatus = "pending" | "claiming" | "authorized" | "occupied" | "failed";
type StartupState = {
  phase: StartupPhase;
  seat1: SeatStartupStatus;
  seat2: SeatStartupStatus;
  pairing: "waiting" | "established";
  sharedRound: "not-started" | "active";
  error: string | null;
};
const IDLE_STARTUP_STATE: StartupState = {
  phase: "idle",
  seat1: "pending",
  seat2: "pending",
  pairing: "waiting",
  sharedRound: "not-started",
  error: null,
};
/** Bounded retry budget for a Case B (authorized Request-to-Speak) seat claim — see `establishSeat`. Never a blind sleep-and-hope: each attempt is a fresh, real `simulateAdvanceSelection` call against actual server state, not a timer alone. */
// Issue #21, eighth corrective pass: reproduced live against a real dev
// server — the previous budget (5 attempts × 150ms = 750ms total) was
// measured to be far too tight. A real reconciliation/reservation round
// trip in this environment routinely takes 150-330ms on its own (see
// this pass's own real-device report and DECISIONS.md for the measured
// numbers); 750ms gave the *whole* freeze→reserve→claim chain less time
// than a single ordinary round trip sometimes takes on its own, so
// startup seeding could — and, live-reproduced, did — give up and mark
// the seat "failed" while the underlying reservation was still
// genuinely in progress. Once startup gives up, `running` never becomes
// true, so *no* natural-activity loop (including the reactive
// candidate-promotion effect below) ever starts — the exact "selected
// but never claimed" stall this pass exists to fix, except triggered by
// this retry budget itself, not the reactive-promotion gap it was
// otherwise masking. Raised generously (6s total ceiling, not
// unbounded) — still a real, bounded retry against real server state
// each time, never a blind sleep-and-hope.
const MAX_CLAIM_ATTEMPTS = 20;
const CLAIM_RETRY_DELAY_MS = 300;

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
  // Issue #21, fourth corrective pass: the bounded startup state machine
  // — see this file's own doc comment on `StartupState` above. Separate
  // from `running`, which now only flips true once this reaches
  // "running" — never before.
  const [startupState, setStartupState] = useState<StartupState>(IDLE_STARTUP_STATE);
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
  // Issue #21, sixth corrective pass, Sections 1-3, 20-21: real, observed
  // per-seat promotion timing — see this hook's own doc comment for
  // exactly what it records and why. Purely additive diagnostic data;
  // never read by anything that decides selection/authorization.
  const seatTiming = useSeatPromotionTiming(speakers, pendingRequests);

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
  // Issue #21, eighth corrective pass, Section 29: a short, preview-only
  // identifier for *this browser tab's own SIM panel instance* — never
  // a real identity/security-sensitive value, just enough to tell two
  // simultaneously-open tabs' own log lines apart when diagnosing a
  // multi-tab scenario ("Client A triggered reservation, Client B
  // observed it," per the explicit request). Generated once, in an
  // effect (react-hooks/purity forbids `crypto.randomUUID()` during
  // render), and included in every `appendLog` line below.
  const tabIdRef = useRef<string>("…");
  useEffect(() => {
    tabIdRef.current = crypto.randomUUID().slice(0, 6);
  }, []);

  const runningRef = useRef(false);
  // Issue #21, fourth corrective pass: `startSimulation` now does real
  // awaited work (`establishInitialPairing`) before it's safe to flip
  // `running` true — if Stop (or Reset) is pressed while that's still in
  // flight, the async chain must not resurrect `running` once it finally
  // resolves. Every Stop/Reset bumps this; `startSimulation` captures its
  // own value at the start and only commits to "running" if nothing else
  // has bumped it since — the same "was this superseded" guard a request
  // sequence number gives you, without needing a full cancellation API.
  const startupTokenRef = useRef(0);
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
    setLog((prev) => [`${new Date().toLocaleTimeString()} [tab ${tabIdRef.current}] — ${line}`, ...prev].slice(0, 30));
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

  /**
   * Issue #21, eighth corrective pass, Sections 8, 33: a real-device
   * report found "Selecting next speaker…" persisting for several
   * seconds specifically when the eligible candidate was
   * simulator-generated (no real browser tab). Traced to a real gap:
   * `useAutomaticPromotion`'s sixth-pass reactive fast path only helps a
   * *real* candidate's own tab — a simulated identity has no such tab,
   * so its entire claim step depended solely on the natural-activity
   * loop's own 4-6s poll (`schedule(...)` below) noticing the
   * reservation, even though the reservation itself
   * (`useSpeakerSelectionReconciliation`, already mounted in this same
   * tab via `EventRoom`) typically completes in well under a second.
   * Worst case: up to a full poll interval of pure additional wait, on
   * top of the (already-fast) reservation — exactly the "clearly not
   * momentary" delay the real-device report described.
   *
   * This effect is the same reactive-first/poll-as-backstop shape
   * `useAutomaticPromotion`'s own sixth-pass fix already established:
   * reacts immediately to `pendingRequests` (already a live prop) as
   * soon as it shows one of *this run's own* simulated identities
   * reserved for an open seat, instead of waiting for the next
   * scheduled tick. The poll below is unchanged and remains as a
   * bounded backstop.
   *
   * **Sequential drain, not one call per reservation** (Section 15,
   * real-device-reproduced bug in this pass's own first two cuts): with
   * two seats open and two distinct simulated candidates each reserved
   * (the atomic dual-seat reservation already handles this correctly
   * server-side — see `reserve_speaker_candidates_for_seats`),
   * `simulateAdvanceSelection` itself only ever targets *one* winner per
   * call — whichever reserved simulated candidate its own internal
   * `candidates.find(...)` reaches first, by rank, regardless of which
   * seat that candidate is reserved for. A first attempt at this
   * effect fired one call *per* reservation, in parallel, and a second
   * attempt deduplicated by "have I already attempted this exact
   * reservation" — both proven live, against a real dev server, to
   * leave the *second* seat's reservation permanently unclaimed: every
   * parallel/deduplicated call kept independently re-discovering and
   * targeting the *same* first-ranked winner, and once that one
   * candidate's own reservation had already been "attempted" once (by
   * either version's own bookkeeping), nothing ever tried again for it
   * even though that specific call never actually touched it. The fix
   * is to stop tracking *which* reservation was attempted at all — call
   * `simulateAdvanceSelection` once, `await` its result, and if it
   * *claimed* something, call it again immediately (its own next
   * internal `.find()` naturally advances to whichever winner is left,
   * since the one just claimed is no longer `pending`) — sequentially
   * draining every currently-reserved simulated candidate, one real
   * authoritative call at a time, until nothing is left to claim.
   * `promotionDrainingRef` prevents an unrelated `pendingRequests`
   * change (e.g. a vote count ticking) from starting a second,
   * overlapping drain while one is already running; the bounded
   * iteration cap is a safety valve, never expected to bind in practice
   * (at most two seats can ever be open at once).
   */
  const promotionDrainingRef = useRef(false);
  useEffect(() => {
    if (!runningRef.current || realJoinInProgressRef.current) return;
    if (promotionDrainingRef.current) return;
    const hasSimulatedWinner = pendingRequests.some(
      (r) => r.is_current_candidate && r.reserved_seat_number !== null && r.guest_id && allSimulatedGuestIdsRef.current.has(r.guest_id),
    );
    if (!hasSimulatedWinner) return;

    promotionDrainingRef.current = true;
    void (async () => {
      // Issue #21, eighth corrective pass: reproduced live — an
      // unhandled rejection from *any* iteration (a transient DB error,
      // a genuine race with another concurrent caller) used to escape
      // this loop entirely, skipping the reset below and leaving
      // `promotionDrainingRef` stuck `true` forever — silently
      // disabling every future reactive promotion for the rest of the
      // run, including for an entirely unrelated later vacancy. The
      // `try/finally` is what actually makes this a *bounded* retry
      // rather than a single unlucky call permanently wedging the whole
      // mechanism; a failed iteration is logged, not swallowed.
      try {
        for (let i = 0; i < 10; i++) {
          if (!runningRef.current || realJoinInProgressRef.current) break;
          const result = await simulateAdvanceSelection(eventId, Array.from(allSimulatedGuestIdsRef.current), guestDisplayNamesRef.current);
          if (!result.claimed) break;
          const name = guestDisplayNamesRef.current[result.guestId] ?? "a simulated candidate";
          appendLog(`Seat ${result.seatNumber} → ${name} promoted (reactive, real weighted selection)`);
        }
      } catch (err) {
        appendLog(`Reactive candidate promotion failed: ${err instanceof Error ? err.message : "unknown error"} — the bounded backstop poll will retry`);
      } finally {
        promotionDrainingRef.current = false;
      }
    })();
  }, [pendingRequests, eventId]);

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
    const token = ++startupTokenRef.current;
    appendLog("Starting session…");
    setStartupState({ ...IDLE_STARTUP_STATE, phase: "preparing" });
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
    appendLog(`${AUDIENCE_SIZE} simulated audience identities generated`);

    // Issue #21, fourth corrective pass: the whole point of this bounded
    // state machine — `running` (and therefore every natural-activity
    // loop below) only ever flips on once the two-speaker pairing has
    // actually been confirmed established, never before. A failure here
    // leaves `running` false and reports why via `startupState`/the log
    // — it does not silently half-start.
    const established = await establishInitialPairing(seedSpeakers);
    if (!established) {
      appendLog("Startup did not complete — session not started. See the Startup status above for why.");
      return;
    }
    // Stop/Reset pressed while the above was still in flight must win —
    // this async chain resolving late must never resurrect `running`. See
    // `startupTokenRef`'s own doc comment.
    if (startupTokenRef.current !== token) return;

    runningRef.current = true;
    setRunning(true);
    setStartupState((s) => ({ ...s, phase: "running" }));
    appendLog("Simulation running");

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

    // Issue #21, third corrective pass, item 18: occasional natural
    // withdrawal — a simulated candidate changing their mind before
    // selection, same as a real person tapping "Cancel Request." Low
    // frequency (every 25-45s) and only ever targets a *simulated*
    // request (checked against this run's own generated guest ids) —
    // never a real viewer's genuine request, which this identity has no
    // business touching. Exercises the exact same deterministic
    // re-ranking (next-highest-voted eligible candidate) a real
    // withdrawal would.
    schedule(() => {
      const pending = pendingRequestsRef.current.filter((r) => r.guest_id && allSimulatedGuestIdsRef.current.has(r.guest_id));
      if (pending.length === 0) return;
      const target = randomElement(pending);
      void simulateWithdrawRequest(eventId, target.guest_id!);
    }, 25000, 45000);

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
    // Issue #21, eighth corrective pass: the *primary* trigger for this
    // is now the reactive effect above (fires the instant this tab's own
    // live `pendingRequests` shows a simulated candidate reserved) — this
    // poll is unchanged and remains only as the bounded backstop for a
    // missed Realtime delta, the same relationship the sixth pass
    // established between `useAutomaticPromotion`'s own poll and its
    // reactive fast path.
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
    // Invalidates any startup still in flight — see `startupTokenRef`'s
    // own doc comment; without this, a startup that finishes seeding
    // *after* Stop was pressed would silently flip `running` back on.
    startupTokenRef.current++;
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
   *
   * **One tap, no confirmation** (issue #21, seventh corrective pass,
   * Section 20 — explicit instruction): this is a preview-only tool, not
   * a real-user-facing destructive action, so the previous "tap Reset →
   * confirm row appears → tap Reset again" step is gone. `SimButton`
   * (see that component's own doc comment) is what actually makes a
   * single tap *feel* safe despite firing immediately — a genuine
   * pressed state on tap, then a disabled/dimmed "executing" state for
   * as long as this function's own promise is in flight, so a second tap
   * on an already-running reset can't fire a second, overlapping one
   * (Section 25) — the *duplicate-prevention* moved from a confirmation
   * step into the button's own async-in-flight state, rather than being
   * dropped outright.
   *
   * **Client reconciliation (Section 19)**: this function's own job ends
   * once the database rows are gone and this component's own local state
   * is cleared — `speakers`/`pendingRequests`/`messages`/`stageRound` are
   * *props*, owned by `EventRoom`'s Realtime-subscribed hooks, not local
   * state here. Those hooks each correctly clear a deleted row from
   * their own client state via their own Realtime DELETE handlers
   * (`useStageRound`'s own real bug — a `stage_rounds` DELETE being
   * silently ignored, leaving a stale "Round 1 · awaiting pairing" on
   * screen indefinitely — is fixed at its own source, not papered over
   * here; see that hook's own doc comment). `onSimulatorReset` (below)
   * additionally triggers an explicit `refetchSpeakers()` from
   * `EventRoom` as defense in depth against a missed Realtime delta —
   * the same "don't just trust the incremental delta arrived" discipline
   * `useActiveSpeakers`' own SUBSCRIBED-triggers-full-refetch already
   * uses elsewhere in this room.
   */
  async function handleReset() {
    startupTokenRef.current++; // see `startupTokenRef`'s own doc comment
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
    setStartupState(IDLE_STARTUP_STATE);
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

  function setSeatStartupStatus(seatNumber: 1 | 2, status: SeatStartupStatus) {
    setStartupState((s) => (seatNumber === 1 ? { ...s, seat1: status } : { ...s, seat2: status }));
  }

  /** A fresh, authoritative read of the shared round row — never the possibly-stale `stageRound` prop. Used both to decide Case A vs. Case B (see `establishSeat`) and to verify the round actually started afterward. */
  async function fetchStageRoundRow(): Promise<{ round_number: number; phase: string } | null> {
    const supabase = createClient();
    const { data } = await supabase.from("stage_rounds").select("round_number, phase").eq("event_id", eventId).maybeSingle();
    return data ?? null;
  }

  /**
   * Claims both seats for the run's two stable identities, one at a time
   * — issue #21, second corrective pass, real-device finding (see git
   * history for the concurrent-claim race this sequential order fixed).
   * Rebuilt in the fourth corrective pass around the invariant this pass
   * exists to close: **a normal shared round may exist/count down only
   * once the two-speaker pairing is authoritatively established.** Every
   * step below verifies against fresh, authoritative state — never the
   * possibly-stale `speakers`/`stageRound` props — and a genuine failure
   * at any step stops here rather than silently proceeding.
   *
   * **Case A vs. Case B (Section 5)**: a single fresh read of
   * `stage_rounds.round_number` decides which path every seat below
   * uses — `>= 1` means the stage has *ever* achieved its initial
   * pairing (the same permanent signal `isStageEstablished` reads
   * server-side), so direct seat claims are no longer authorized; `0`
   * means this is genuinely the stage's first pairing, where a direct
   * join is still the legitimate initial-formation path. Both seats use
   * the *same* decision — the stage doesn't become "established" partway
   * through seeding its own initial pairing.
   */
  async function establishInitialPairing(seedSpeakers: [SimulatedIdentity, SimulatedIdentity]): Promise<boolean> {
    const [a, b] = seedSpeakers;
    setStartupState((s) => ({ ...s, phase: "seeding" }));

    const before = await fetchStageRoundRow();
    const established = (before?.round_number ?? 0) >= 1;
    appendLog(
      established
        ? "Stage already established — seeding via authorized Request-to-Speak selection, not a direct join"
        : "Stage not yet established — seeding via direct initial-formation join",
    );

    appendLog("Seeding Seat 1…");
    const seat1Ok = await establishSeat(a, 1, established);
    appendLog("Seeding Seat 2…");
    const seat2Ok = await establishSeat(b, 2, established);

    if (!seat1Ok && !seat2Ok) {
      setStartupState((s) => ({ ...s, phase: "failed", error: "Could not seed either simulated speaker — see the log above for the real failure." }));
      appendLog("Could not seed simulated speakers — startup failed; no shared round will be started");
      return false;
    }
    if (!seat1Ok || !seat2Ok) {
      setStartupState((s) => ({
        ...s,
        phase: "failed",
        error: "Only one seat could be established — a shared round requires both, so none was started.",
      }));
      appendLog(`Seeded 1 simulated speaker (${seat1Ok ? a.displayName : b.displayName}) — the other seat could not be established; no shared round will be started`);
      return false;
    }

    setStartupState((s) => ({ ...s, phase: "verifying-pairing", pairing: "established" }));

    setStartupState((s) => ({ ...s, phase: "establishing-round" }));
    appendLog("Verifying shared round…");
    let round = await fetchStageRoundRow();
    if (round?.phase !== "active") {
      // The reactive backstop, called explicitly here too — see
      // `reconcileStageRoundAction`'s own doc comment. Every production
      // seat-claim RPC already triggers `ensure_stage_round` as a side
      // effect, so this should be a no-op in the ordinary case; calling
      // it directly (not a blind sleep-and-recheck) is what makes this a
      // genuine self-heal rather than hoping the first read was just
      // early.
      await reconcileStageRoundAction(eventId);
      round = await fetchStageRoundRow();
    }
    if (round?.phase !== "active") {
      setStartupState((s) => ({
        ...s,
        phase: "failed",
        error: `Both seats are occupied, but the shared round did not start (phase: ${round?.phase ?? "unknown"}) — this should be impossible; check server logs.`,
      }));
      appendLog(`Seeded 2 stable simulated speakers, but the shared round did not start (phase: ${round?.phase ?? "unknown"}) — this is unexpected; check server logs`);
      return false;
    }

    setStartupState((s) => ({ ...s, sharedRound: "active" }));
    appendLog(`Seeded 2 stable simulated speakers — ${a.displayName} → seat 1, ${b.displayName} → seat 2, Round ${round.round_number} active`);
    return true;
  }

  /**
   * One seat's establishment — branches on `established` (see
   * `establishInitialPairing` above), never bypassing authorization once
   * the stage has ever achieved its pairing. Case A reuses the existing
   * direct-join adapter unchanged. Case B reuses the *exact* real
   * Request-to-Speak → selection → authorized-claim pipeline
   * (`simulateRequestToSpeak` + `simulateAdvanceSelection`) a real
   * candidate's own browser tab would go through — no simulator-only
   * loophole. Bounded retries on the claim step (never a blind sleep):
   * each attempt is a fresh, real `simulateAdvanceSelection` call, which
   * can legitimately need a couple of tries if selection hasn't frozen
   * the just-submitted request yet.
   */
  async function establishSeat(identity: SimulatedIdentity, seatNumber: 1 | 2, established: boolean): Promise<boolean> {
    setSeatStartupStatus(seatNumber, "claiming");

    if (!established) {
      try {
        await simulateSeedSpeaker(eventId, identity.id, identity.displayName, seatNumber);
        setSeatStartupStatus(seatNumber, "occupied");
        return true;
      } catch (err) {
        appendLog(`Seat ${seatNumber} seed failed: ${err instanceof Error ? err.message : "unknown error"}`);
        setSeatStartupStatus(seatNumber, "failed");
        return false;
      }
    }

    try {
      await simulateRequestToSpeak(eventId, identity.id, identity.displayName, randomSpeakerRequestComment());
    } catch (err) {
      appendLog(`Seat ${seatNumber} request-to-speak failed: ${err instanceof Error ? err.message : "unknown error"}`);
      setSeatStartupStatus(seatNumber, "failed");
      return false;
    }
    setSeatStartupStatus(seatNumber, "authorized");

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      const result = await simulateAdvanceSelection(eventId, [identity.id], { [identity.id]: identity.displayName });
      if (result.claimed) {
        setSeatStartupStatus(seatNumber, "occupied");
        return true;
      }
      if (attempt < MAX_CLAIM_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_DELAY_MS));
      }
    }
    appendLog(`Seat ${seatNumber}: ${identity.displayName}'s request did not result in an authorized claim within the expected window`);
    setSeatStartupStatus(seatNumber, "failed");
    return false;
  }

  /**
   * The standalone "Seed 2 Speakers" button — deterministic manual
   * re-seed using this run's same two stable identities, reusing the
   * *exact* Case A/B logic above rather than a parallel bypass-only path
   * (Section 5's "do not create a simulator-only loophole" applies here
   * too, not just to Start). Once both seats are already occupied by
   * these identities, this correctly reports nothing-to-do rather than
   * pretending to re-seed them: an already-occupied seat can't
   * legitimately be re-claimed for its own occupant through any real
   * pathway either.
   */
  async function seedTwoSpeakers() {
    const pool = requireAudience();
    const seedSpeakers = seedSpeakersRef.current;
    if (!pool || !seedSpeakers) return;
    await establishInitialPairing(seedSpeakers);
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

  // Issue #21, fourth corrective pass: Start is disabled for the whole
  // bounded startup sequence, not just once `running` finally flips —
  // otherwise a second tap mid-seeding could kick off a second,
  // overlapping attempt. A `failed` phase deliberately leaves Start
  // enabled again — pressing it is the retry (Section 7: "offer
  // Start/Retry again"), it re-enters `preparing` from scratch.
  const startingUp = startupState.phase !== "idle" && startupState.phase !== "running" && startupState.phase !== "failed";

  /**
   * Issue #21, third corrective pass: "was #1 legitimately not the pick,
   * or did something actually fail" — now trivially answerable, since
   * selection is deterministic (highest votes, earliest-request
   * tiebreak) rather than a weighted draw. `pendingRequests` already
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
  /**
   * Issue #21, fifth corrective pass: up to *two* simultaneously-current
   * candidates now — one per open seat (`reserved_seat_number`), never
   * two for the same seat. Section 16's "SIM observability should show
   * per seat: candidate selected / authorized / Going Live / occupied" —
   * this reads the same live `reserved_seat_number`/`is_current_candidate`
   * fields the real reservation RPC sets, never a separate derivation.
   */
  function selectedCandidateForSeat(seatNumber: 1 | 2) {
    return frozenCandidates.find((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber) ?? null;
  }
  function seatIsOccupied(seatNumber: 1 | 2): boolean {
    return speakers.some((s) => s.seat_number === seatNumber);
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
        <SimButton data-testid="sim-start" onClick={startSimulation} disabled={running || startingUp} className="rounded bg-emerald-600 px-2 py-1 font-medium">
          Start Simulated Session
        </SimButton>
        <SimButton
          data-testid="sim-stop"
          onClick={stopSimulation}
          // Issue #21, fourth corrective pass: Stop must be able to
          // interrupt a startup that's still in flight, not only a
          // fully-`running` session — otherwise there'd be no way to
          // back out of a slow/stuck bounded startup short of waiting
          // for it to fail on its own. `stopSimulation` bumps
          // `startupTokenRef`, so an in-flight `startSimulation` that
          // finishes seeding *after* this is pressed correctly discards
          // its own result instead of resurrecting `running`.
          disabled={!running && !startingUp}
          className="rounded bg-red-600 px-2 py-1 font-medium"
        >
          Stop Simulation
        </SimButton>
        {/*
          Issue #21, seventh corrective pass, Section 20: one tap, no
          confirmation step — see handleReset's own doc comment for why
          this is safe (a preview-only tool, and SimButton's own
          executing/disabled state already prevents a duplicate
          concurrent reset).
        */}
        <SimButton data-testid="sim-reset" onClick={handleReset} className="rounded bg-orange-700 px-2 py-1 font-medium">
          Reset Session
        </SimButton>
        <SimButton data-testid="sim-seed-speakers" onClick={seedTwoSpeakers} className="rounded bg-white/10 px-2 py-1">
          Seed 2 Speakers
        </SimButton>
        <SimButton data-testid="sim-generate-comments" onClick={() => generateComments()} className="rounded bg-white/10 px-2 py-1">
          Generate Comments
        </SimButton>
        <SimButton data-testid="sim-generate-requests" onClick={() => generateSpeakerRequests()} className="rounded bg-white/10 px-2 py-1">
          Generate Speaker Requests
        </SimButton>
        <SimButton data-testid="sim-shift-votes" onClick={() => shiftRequestVotes()} className="rounded bg-white/10 px-2 py-1">
          Shift Request Votes
        </SimButton>
        <SimButton data-testid="sim-resolve-round" onClick={resolveRoundNow} className="rounded bg-indigo-600 px-2 py-1 font-medium">
          Resolve Round Now
        </SimButton>
      </div>

      {/*
        Issue #21, fourth corrective pass, Section 8: compact, preview-only
        startup observability — enough to distinguish seat-authorization
        failure vs. selection failure vs. round-creation failure without a
        new diagnostics system. Shown for the whole bounded startup
        sequence (including a `failed` outcome, so it stays visible to
        screenshot); collapses away once `running` is reached, back into
        the existing observability below.
      */}
      {startupState.phase !== "idle" && startupState.phase !== "running" && (
        <div data-testid="sim-startup" className="mb-3 flex flex-col gap-0.5 rounded-lg bg-white/5 p-2">
          <p data-testid="sim-startup-phase" className="font-semibold text-white/90">
            Simulation: {startupPhaseLabel(startupState.phase)}
          </p>
          <p>Audience: {startupState.phase === "preparing" ? "Preparing" : "Ready"}</p>
          <p data-testid="sim-startup-seat-1">Seat 1: {startupState.seat1}</p>
          <p data-testid="sim-startup-seat-2">Seat 2: {startupState.seat2}</p>
          <p data-testid="sim-startup-pairing">Pairing: {startupState.pairing}</p>
          <p data-testid="sim-startup-round">
            Shared round: {startupState.sharedRound === "active" ? `Round ${stageRound?.round_number ?? "?"} active` : "not started"}
          </p>
          {startupState.error && (
            <p data-testid="sim-startup-error" className="mt-0.5 text-red-400">
              {startupState.error}
            </p>
          )}
        </div>
      )}

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
                    <SimButton data-testid="sim-force-continue" onClick={() => castVotesForSeat(s, 3, 0, "Continue")} className="rounded bg-white/10 px-1.5 py-0.5">
                      Force Continue
                    </SimButton>
                    <SimButton data-testid="sim-force-narrow-loss" onClick={() => castVotesForSeat(s, 2, 3, "Narrow Loss")} className="rounded bg-white/10 px-1.5 py-0.5">
                      Force Narrow Loss
                    </SimButton>
                    <SimButton data-testid="sim-force-replace" onClick={() => castVotesForSeat(s, 0, 2, "Replace")} className="rounded bg-white/10 px-1.5 py-0.5">
                      Force Replace
                    </SimButton>
                  </>
                ) : (
                  <SimButton data-testid="sim-force-replace-now" onClick={() => forceClosingNow(s)} className="rounded bg-white/10 px-1.5 py-0.5">
                    Force Replace Now
                  </SimButton>
                )}
                <SimButton data-testid="sim-open-seat" onClick={() => openSeat(s)} className="rounded bg-white/10 px-1.5 py-0.5">
                  Open Seat
                </SimButton>
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
          Issue #21, third corrective pass: makes deterministic selection
          legible — "did #1 legitimately not win, or did something
          actually fail" is answerable from the same frozen ranking the
          real resolver used. See `frozenCandidates`' own doc comment
          above. No weighted odds anymore — highest votes wins, ties
          break on earliest request.
        */}
        <div className="border-t border-white/10 pt-1 font-semibold text-white/70">Next Speaker</div>
        {frozenCandidates.length === 0 ? (
          <p className="text-white/40">No candidate selection in progress</p>
        ) : (
          <>
            {frozenCandidates.map((r) => (
              <p key={r.id} data-testid="sim-frozen-candidate">
                #{r.frozen_rank} {candidateName(r)} — {r.frozen_vote_count} votes
                {r.is_current_candidate && (
                  <span data-testid="sim-selected-candidate" className="font-semibold text-emerald-400">
                    {" "}
                    — selected (Seat {r.reserved_seat_number ?? "?"})
                  </span>
                )}
              </p>
            ))}
            <p data-testid="sim-selection-reason" className="text-white/50">
              Reason: {selectionReason(frozenCandidates)}
            </p>
          </>
        )}
        {/*
          Issue #21, eighth corrective pass, Section 9: one row per
          currently-*pending* request (the full live pool — not just
          `frozenCandidates` above, which only shows candidates already
          part of a frozen selection round's own snapshot, and would
          silently omit a request that arrived after that snapshot but
          before a new one encompasses it). "Authorized" is deliberately
          not a separate column from "Reserved" — in this architecture
          they're the same signal (`is_current_candidate` +
          `reserved_seat_number`, exactly what `claim_speaker_seat`
          itself checks server-side); showing two columns for one fact
          would invent a distinction this system doesn't actually have.
          "Going Live" is likewise not shown per-candidate here — for a
          *real* candidate, whether they're currently counting down is
          local state inside their own browser tab, genuinely invisible
          from any other client (see the WAITING AT reason below, which
          says this honestly rather than guessing).
        */}
        <div className="border-t border-white/10 pt-1 font-semibold text-white/70">Candidates (Section 9)</div>
        {pendingRequests.length === 0 ? (
          <p className="text-white/40">No pending requests</p>
        ) : (
          pendingRequests.map((r) => {
            const occupied = speakers.some(
              (s) => (r.profile_id !== null && s.profile_id === r.profile_id) || (r.guest_id !== null && s.guest_id === r.guest_id),
            );
            return (
              <p key={r.id} data-testid="sim-candidate-row" className="text-white/70">
                {candidateName(r)} — requested ✓ · eligible {r.selection_failed ? "✗" : "✓"} · rank{" "}
                {r.frozen_rank ?? "—"} ·{" "}
                {r.is_current_candidate && r.reserved_seat_number !== null
                  ? `reserved (Seat ${r.reserved_seat_number})`
                  : "not reserved"}{" "}
                · occupied {occupied ? "✓" : "✗"}
              </p>
            );
          })
        )}
        {/*
          Issue #21, fifth corrective pass, Section 16: per-seat
          candidate/authorization/occupancy — up to two reservations can
          be in flight simultaneously (two seats opened at once), never
          collapsed into one ambiguous "the" selection the way a single
          seat's worth of state used to be enough to show.
        */}
        {([1, 2] as const).map((seatNumber) => {
          const candidate = selectedCandidateForSeat(seatNumber);
          const occupied = seatIsOccupied(seatNumber);
          return (
            <p key={seatNumber} data-testid={`sim-selection-status-${seatNumber}`}>
              Seat {seatNumber}:{" "}
              {occupied
                ? "occupied"
                : candidate
                  ? `${candidateName(candidate)} — authorized, joining`
                  : "no candidate reserved"}
            </p>
          );
        })}
        {/*
          Issue #21, sixth corrective pass, Sections 1-3, 20-21: real,
          observed per-seat promotion timing — a real-device report found
          "Selecting next speaker…" giving no way to tell *where* time
          was actually going. Every value below is an actual `Date.now()`
          this client observed (`useSeatPromotionTiming`'s own doc
          comment explains exactly what it can and can't measure) — never
          an estimated/fabricated number. Once a seat is still waiting,
          shows the *specific* reason (Section 21) instead of a generic
          "Selecting…", distinguishing the intentional Going Live
          countdown from everything before it (Section 11) rather than
          lumping all latency into one number.
        */}
        <div className="border-t border-white/10 pt-1 font-semibold text-white/70">Selection Timing (real, observed)</div>
        {([1, 2] as const).map((seatNumber) => {
          const t = seatTiming[seatNumber];
          const hasEligibleRequests = pendingRequests.length > 0;
          const establishedForFallback = stageRound !== null && stageRound.round_number >= 1;
          const bothEmpty = speakers.length === 0;
          const fallbackOpen = establishedForFallback && bothEmpty && !hasEligibleRequests;
          const reservedForThisSeat = pendingRequests.some((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber);

          if (t.vacantAt === null) {
            return (
              <p key={seatNumber} data-testid={`sim-seat-timing-${seatNumber}`} className="text-white/40">
                Seat {seatNumber}: occupied — no vacancy cycle in progress
              </p>
            );
          }

          const rows: { label: string; value: string }[] = [{ label: "Vacant", value: "+0ms" }];
          if (t.candidatesFoundAt !== null) rows.push({ label: "Candidates observed", value: formatDelta(t.candidatesFoundAt - t.vacantAt) });
          if (t.reservedAt !== null) rows.push({ label: "Reservation observed locally", value: formatDelta(t.reservedAt - t.vacantAt) });
          if (t.occupiedAt !== null) rows.push({ label: "Occupied", value: formatDelta(t.occupiedAt - t.vacantAt) });

          // Issue #21, eighth corrective pass, Section 9: more granular
          // WAITING AT reasons — the sixth pass's single "Going Live
          // countdown or claim pending" bucket couldn't distinguish
          // "still within the intentional 3s window" from "reserved a
          // while ago and still not occupied," which is exactly the
          // distinction needed to tell a genuine stall apart from normal
          // Going Live. `reservedForMs` is real, observed elapsed time
          // (now - the real reservedAt timestamp) — never an estimate.
          // `PROMOTION_COUNTDOWN_SECONDS` is the one real intentional
          // delay in this path; the extra buffer accounts for claim
          // round-trip time, not a second guess at another intentional
          // wait.
          const reservedForMs = t.reservedAt !== null && now !== null ? now - t.reservedAt : null;
          const CLAIM_GRACE_MS = 4000;
          const waitingReason =
            t.occupiedAt !== null
              ? null
              : reservedForThisSeat
                ? reservedForMs !== null && reservedForMs > PROMOTION_COUNTDOWN_SECONDS * 1000 + CLAIM_GRACE_MS
                  ? `authoritative seat claim — reserved ${formatDelta(reservedForMs)} ago, past the intentional ${PROMOTION_COUNTDOWN_SECONDS}s countdown, not yet occupied`
                  : `Going Live (up to ${PROMOTION_COUNTDOWN_SECONDS}s, intentional) or candidate client acknowledgement — cannot be distinguished from this vantage point (see doc comment)`
                : hasEligibleRequests
                  ? "reservation RPC pending, or reservation not yet propagated to this client — cannot be distinguished from this vantage point"
                  : fallbackOpen
                    ? "fallback open — tap to join"
                    : "eligible candidate detection — no eligible request observed yet";

          return (
            <div key={seatNumber} data-testid={`sim-seat-timing-${seatNumber}`}>
              <p className="font-medium text-white/80">Seat {seatNumber}</p>
              {rows.map((r) => (
                <p key={r.label} className="pl-2 text-white/70">
                  {r.label} {r.value}
                </p>
              ))}
              {t.occupiedAt !== null ? (
                <p data-testid={`sim-seat-timing-total-${seatNumber}`} className="pl-2 font-semibold text-emerald-400">
                  Total: {formatDelta(t.occupiedAt - t.vacantAt)}
                </p>
              ) : (
                <p data-testid={`sim-waiting-${seatNumber}`} className="pl-2 font-semibold text-amber-400">
                  WAITING AT: {waitingReason}
                </p>
              )}
            </div>
          );
        })}

        {/*
          Issue #21, fifth corrective pass, Section 16: "if blocked, show
          why" — the small-room fallback's own current state, read from
          the exact same authoritative signals `SpeakerStage` uses to
          decide the same thing (never a separate derivation): both
          seats empty, zero eligible requests, established stage.
        */}
        {(() => {
          const established = stageRound !== null && stageRound.round_number >= 1;
          const bothEmpty = speakers.length === 0;
          const hasRequests = pendingRequests.length > 0;
          const fallbackOpen = established && bothEmpty && !hasRequests;
          const label = !established
            ? "n/a (stage not yet established)"
            : fallbackOpen
              ? "open (both seats empty, no requests)"
              : bothEmpty
                ? "closed (requests exist — selection governs)"
                : "closed (a seat is occupied)";
          return (
            <p data-testid="sim-fallback-status">
              Fallback: {label}
            </p>
          );
        })()}

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
