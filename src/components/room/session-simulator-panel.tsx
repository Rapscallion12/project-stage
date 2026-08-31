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
  fetchDebugSnapshotState,
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

/**
 * Issue #21, fourteenth corrective pass: "FAILED PHASE should be
 * actionable, not just 'Startup did not complete'" — explicit instruction.
 * One shared formatter so every genuinely non-recoverable startup failure
 * (a seat establishment step that exhausted its bounded retries) reports
 * the same six fields, in the same order: which phase, how many attempts
 * out of the budget, what was expected, what the authoritative read
 * actually showed, the last real error, and what to do about it.
 */
function formatFailedPhase(detail: {
  phase: string;
  attempts: number;
  maxAttempts: number;
  expected: string;
  authoritative: string;
  lastError: string;
  recovery: string;
}): string {
  return [
    `FAILED PHASE: ${detail.phase}`,
    `ATTEMPTS: ${detail.attempts}/${detail.maxAttempts}`,
    `EXPECTED: ${detail.expected}`,
    `AUTHORITATIVE: ${detail.authoritative}`,
    `LAST ERROR: ${detail.lastError}`,
    `RECOVERY: ${detail.recovery}`,
  ].join("\n");
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
 * Issue #21, fourteenth corrective pass: bounded retry budget for a
 * Case A (direct initial-formation join) seat seed — see `establishSeat`.
 * Unlike Case B's `MAX_CLAIM_ATTEMPTS` (which waits out a real,
 * in-progress reservation), a genuine Case A failure has exactly two
 * causes worth retrying: (1) a leftover simulator-owned occupant from an
 * earlier incomplete Start in this same tab (cleared, then retried once),
 * or (2) a transient error where the authoritative seat is still
 * genuinely empty despite the throw. Neither needs more than a couple of
 * attempts — this is "recognize and recover," not "wait for something
 * slow," so the budget stays small and each attempt still does a real,
 * authoritative check against actual server state, never a blind
 * sleep-and-hope.
 */
const MAX_SEED_ATTEMPTS = 2;

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
  // Issue #21, ninth corrective pass, Section 12: "Selection Forensics"
  // (below) is deliberately collapsed by default — real per-seat RTS
  // ranking detail is exactly the "huge raw JSON" this section's own
  // instruction says not to dump into the main panel; expandable on
  // demand instead, same discipline the panel-minimize control already
  // established for the whole panel.
  const [forensicsExpanded, setForensicsExpanded] = useState(false);
  // Issue #21, tenth/eleventh corrective passes: "Copy Debug Snapshot" —
  // see `copyDebugSnapshot`'s own doc comment below. `"manual-copy-needed"`
  // (eleventh pass) is distinct from a hard failure — the snapshot text
  // itself was still captured successfully; only the *automatic* clipboard
  // write didn't land, so the fallback panel (`snapshotVisible`) opens
  // instead of losing the capture.
  const [snapshotStatus, setSnapshotStatus] = useState<"idle" | "capturing" | "copied" | "manual-copy-needed">("idle");
  // The full text of the most recent capture — always populated once a
  // capture completes, regardless of whether the automatic clipboard
  // write succeeded, so the fallback panel below always has something
  // real to show.
  const [snapshotText, setSnapshotText] = useState<string | null>(null);
  const [snapshotVisible, setSnapshotVisible] = useState(false);
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
  // Issue #21, tenth corrective pass, Section 27: guards the delayed
  // Reset follow-up sweep's own log update (see `handleReset`) against
  // firing after this panel has unmounted — the sweep's actual DB
  // cleanup runs regardless (harmless even with nobody listening), only
  // the `setLog` call needs this.
  const mountedRef = useRef(true);
  // The follow-up sweep's own timer handle — cleared on unmount (see the
  // cleanup effect below) so a real, still-pending sweep can never fire
  // *after* this panel is gone and call `resetSimulatorSession` a second
  // time nobody asked for (harmless in a real browser tab, which rarely
  // "unmounts" mid-session — but real hygiene, and avoids a stray real
  // timer bleeding a second mock call into an unrelated later test).
  const resetFollowUpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Issue #21, eleventh corrective pass, Section 16: guards
  // `copyDebugSnapshot` against a duplicate concurrent capture — a
  // second tap while one is already in flight is a no-op, not a second
  // overlapping capture.
  const capturingSnapshotRef = useRef(false);
  // Issue #21, fourteenth corrective pass: the synchronous re-entrancy
  // guard `startSimulation` needs — see that function's own doc comment
  // for why `SimButton`'s own executing-disables-itself state (a React
  // re-render, therefore never synchronous with the click that triggered
  // it) cannot, on its own, guarantee a rapid double-tap can't launch two
  // overlapping startup pipelines. Checked and set as the very first
  // statement in `startSimulation`, before any `await` or state update.
  const startupInFlightRef = useRef(false);
  // The Reset-Start completion barrier (Section "RESET MUST HAVE A
  // COMPLETION BARRIER"): true for exactly as long as `handleReset`'s own
  // *primary* delete pass is in flight — never held for the ~2s delayed
  // follow-up sweep, which no longer needs to block anything now that it
  // can't touch the shared `stage_rounds` row either (see
  // `resetSimulatorSession`'s own doc comment on `reconcileStageRound`).
  // Mirrored into state (`resetInFlight`) purely so the Start button can
  // reactively disable itself; the ref is what `startSimulation` actually
  // reads, since a ref read is synchronous and a state read inside an
  // event handler can be one render behind.
  const resetInFlightRef = useRef(false);
  const [resetInFlight, setResetInFlight] = useState(false);
  // A bare counter, bumped once per `handleReset` call — distinct from
  // `startupTokenRef` (which tracks *startup* generations): this is
  // "which Reset generation are we in," surfaced in the debug snapshot's
  // own SIMULATOR STARTUP block so a real-device report can show whether
  // a given startup attempt happened before or after a particular Reset.
  const resetGenerationRef = useRef(0);
  // How many times `startSimulation` has actually proceeded (past the
  // re-entrancy/reset-barrier guards) since the last Reset — the "2/2"
  // half of a FAILED PHASE report's own ATTEMPTS line, and surfaced in
  // the debug snapshot as "Startup attempt."
  const startupAttemptRef = useRef(0);
  // The most recent structured `formatFailedPhase(...)` detail from
  // `establishSeat`, per seat — `establishInitialPairing` reads whichever
  // seat(s) actually ended up failed to give `startupState.error` the
  // real, actionable detail instead of a generic summary. Keyed per seat
  // (not one shared value) because a genuine failure on seat 1 and a
  // genuine success on seat 2 can happen in the same attempt — a single
  // shared ref would have the *successful* seat's own "clear on success"
  // wipe out the *failed* seat's detail before `establishInitialPairing`
  // ever reads it (a real bug caught while writing this pass's own
  // tests). Reset to `{1: null, 2: null}` at the start of every
  // `establishInitialPairing` call.
  const lastSeatFailureRef = useRef<Record<1 | 2, string | null>>({ 1: null, 2: null });
  // Issue #21, twelfth corrective pass: "meaningful transition" log
  // watchers (see the effects below, right after `appendLog`'s own
  // definition) — previous-value refs, one per observed concept, so a
  // real transition can be diffed against what this tab last saw
  // without spuriously logging on mount.
  const prevSpeakersForLogRef = useRef<EventSpeaker[] | null>(null);
  const prevReservationsForLogRef = useRef<Partial<Record<1 | 2, string | null>>>({});
  const prevRoundPhaseForLogRef = useRef<string | null>(null);
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
   * Issue #21, twelfth corrective pass: "OBSERVED" transition logging —
   * a real-device debug snapshot's own activity log ended with startup
   * information, giving no clue why a seat had gone vacant, because
   * this panel's log previously only ever recorded actions *this SIM's
   * own buttons* initiated — never a transition the tab merely
   * *observed* happen (a natural round-boundary replacement via the
   * real per-tab deadline timer, an eviction, or any other production
   * path with no SIM button behind it at all). These three effects log
   * exactly what this tab actually observed, purely from prop diffs,
   * regardless of what caused it — the only thing a client can ever
   * honestly claim to know, and the one thing that's true for *every*
   * vacancy/reservation-creating path uniformly, not just the ones a
   * SIM button happens to cover. Deliberately not logged on mount (the
   * `!== null`/`!== undefined` guards below) and deliberately narrow —
   * occupancy, reservation, and round-phase transitions only, never a
   * vote-count tick or any other high-frequency value (Section 19's own
   * "log meaningful transitions, not every timer tick").
   */
  useEffect(() => {
    const prevSpeakers = prevSpeakersForLogRef.current;
    if (prevSpeakers !== null) {
      for (const seatNumber of [1, 2] as const) {
        const prevOccupant = prevSpeakers.find((s) => s.seat_number === seatNumber);
        const nowOccupant = speakers.find((s) => s.seat_number === seatNumber);
        if (prevOccupant && !nowOccupant) {
          appendLog(`OBSERVED: Seat ${seatNumber} vacated (was ${prevOccupant.display_name})`);
        } else if (!prevOccupant && nowOccupant) {
          appendLog(`OBSERVED: Seat ${seatNumber} occupied (${nowOccupant.display_name})`);
        } else if (prevOccupant && nowOccupant && prevOccupant.id !== nowOccupant.id) {
          appendLog(`OBSERVED: Seat ${seatNumber} occupant changed (${prevOccupant.display_name} → ${nowOccupant.display_name})`);
        }
      }
    }
    prevSpeakersForLogRef.current = speakers;
  }, [speakers]);

  useEffect(() => {
    const prevReservations = prevReservationsForLogRef.current;
    const nextReservations: Partial<Record<1 | 2, string | null>> = {};
    for (const seatNumber of [1, 2] as const) {
      const reserved = pendingRequests.find((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber);
      const name = reserved ? candidateName(reserved) : null;
      nextReservations[seatNumber] = name;
      const prevName = prevReservations[seatNumber];
      if (prevName !== undefined && prevName !== name) {
        if (name) appendLog(`OBSERVED: Seat ${seatNumber} reservation → ${name}`);
        else appendLog(`OBSERVED: Seat ${seatNumber} reservation cleared (was ${prevName})`);
      }
    }
    prevReservationsForLogRef.current = nextReservations;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- candidateName is redefined every render (reads live `messages`/`guestDisplayNames`); listing it would re-run this diff on every unrelated render instead of only when pendingRequests itself changes, defeating the whole point of diffing against the previous value.
  }, [pendingRequests]);

  useEffect(() => {
    const prevPhase = prevRoundPhaseForLogRef.current;
    const nowPhase = stageRound?.phase ?? null;
    if (prevPhase !== null && prevPhase !== nowPhase) {
      appendLog(`OBSERVED: Round phase ${prevPhase} → ${nowPhase ?? "none"}`);
    }
    prevRoundPhaseForLogRef.current = nowPhase;
  }, [stageRound?.phase]);

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
          appendLog(`Seat ${result.seatNumber} → ${name} promoted (reactive, deterministic RTS ranking — #1 by votes)`);
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
    // Issue #21, fourteenth corrective pass: the synchronous re-entrancy
    // guard — see `startupInFlightRef`'s own doc comment for why
    // `SimButton`'s own executing-disables-itself state can't be trusted
    // alone to prevent a rapid double-tap from launching two overlapping
    // startup pipelines (its `disabled` attribute only takes effect after
    // a React re-render commits, which is never synchronous with the
    // click that triggered it). Checked and set as the very first thing
    // this function does, before any `await` or state update, so a
    // same-tick duplicate call is a deterministic no-op regardless of
    // render timing.
    if (startupInFlightRef.current) {
      appendLog("Start already in progress — ignoring duplicate tap");
      return;
    }
    // The Reset-Start completion barrier: Start must not begin seeding
    // while Reset's own primary delete pass is still in flight — see
    // `resetInFlightRef`'s own doc comment and `handleReset` below.
    if (resetInFlightRef.current) {
      appendLog("Reset still in progress — try Start again in a moment");
      return;
    }
    startupInFlightRef.current = true;
    try {
      const token = ++startupTokenRef.current;
      startupAttemptRef.current += 1;
      appendLog("Starting session…");
      appendLog("Reset barrier: clear — proceeding");
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
      appendLog("Audience identities ready");

      // Issue #21, fourth corrective pass: the whole point of this bounded
      // state machine — `running` (and therefore every natural-activity
      // loop below) only ever flips on once the two-speaker pairing has
      // actually been confirmed established, never before. A failure here
      // leaves `running` false and reports why via `startupState`/the log
      // — it does not silently half-start.
      const established = await establishInitialPairing(seedSpeakers, token);
      if (!established) {
        if (startupTokenRef.current !== token) return;
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
      appendLog("Startup READY");

      startNaturalActivity();
    } finally {
      startupInFlightRef.current = false;
    }
  }

  /**
   * Every jittered `schedule(...)` loop that keeps a *running* session
   * moving on its own — split out of `startSimulation` (fourteenth
   * corrective pass) purely so that function's own try/finally reentrancy
   * guard stays readable; no behavior change, same loops, same intervals.
   */
  function startNaturalActivity() {
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
    // whether a seat is open and, only when the current deterministic
    // RTS round's winner is already a known simulated identity, completes
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
    //
    // Issue #21, thirteenth corrective pass: "weighted selection" in the
    // log line below was stale terminology, not stale behavior — audited
    // directly (see DECISIONS.md): the weighted-random draw
    // (`lib/speaker-selection.ts`, `SELECTION_RANK_WEIGHTS`,
    // `Math.random()`) was fully retired in the third corrective pass;
    // that file no longer exists, and every selection path
    // (`freeze_speaker_candidates`'s own `row_number() over (order by
    // count(v.id) desc, sreq.created_at asc, sreq.id asc)`) has been
    // purely deterministic since. This wording just never got updated
    // to match, which real-device evidence showed was genuinely
    // confusing — renamed to say what actually decided it.
    schedule(() => {
      if (realJoinInProgressRef.current) return;
      if (speakersRef.current.length >= 2) return;
      void simulateAdvanceSelection(eventId, Array.from(allSimulatedGuestIdsRef.current), guestDisplayNamesRef.current).then(
        (result) => {
          if (result.claimed) {
            const name = guestDisplayNamesRef.current[result.guestId] ?? "a simulated candidate";
            appendLog(`Seat ${result.seatNumber} → ${name} promoted (deterministic RTS ranking — #1 by votes)`);
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
   *
   * **Issue #21, tenth corrective pass, Sections 26-27: a real-device
   * report found a simulator-generated comment/request still visible
   * after Reset**, with SIM already showing "Round 0 · awaiting
   * pairing / No seats occupied." Reproduced by reading the actual
   * mechanism (never assumed): every scheduled background action
   * (`schedule`, above) already re-checks `runningRef.current`
   * immediately before firing — necessary, but not sufficient. The gap
   * it can't close: a timer can fire and pass that check, dispatching
   * its `simulateComment`/`simulateRequestToSpeak`/etc. call, an instant
   * *before* a same-tick Reset flips `runningRef.current` false and
   * runs its own DELETE — the dispatched call is already in flight by
   * then, uncatchable by any guard checked before it started, and its
   * INSERT can land in the database *after* Reset's DELETE already ran
   * (ordinary network latency is enough of a window; comments alone
   * schedule every 3-8s, so some in-flight call at any given instant is
   * common, not rare). This is genuinely **Case A** (the row really is
   * in the database — not stale client rendering; every DELETE this
   * row's own table performs is already reactively reflected client-side
   * via each hook's existing Realtime DELETE handler, migration
   * 00000000000023) caused by a real ordering race, not by the guest-id
   * list itself being wrong (every button that generates simulated
   * activity draws from `audienceRef.current`, already fully registered
   * in `allSimulatedGuestIdsRef` at Start).
   *
   * **Fix**: a second, delayed sweep — the exact same
   * `resetSimulatorSession` call, same captured `guestIds` snapshot,
   * fire-and-forget ~2s after the first pass. By then any write that was
   * merely in flight at the moment of the first pass has long since
   * landed, so the second pass's own DELETE catches it. Never blocks the
   * UI and never re-confirms anything (Section 29: Reset stays one tap,
   * immediate) — the button's own "executing" state still resolves after
   * the *first* pass; the sweep runs silently afterward and only adds a
   * log line if it actually found something, so the ordinary (no race)
   * case is invisible. Re-running the same deletion against ids that are
   * already gone is a safe no-op (`resetSimulatorSession` itself is
   * idempotent — `count: 0` on every table, same as calling Reset twice
   * in a row already was). Cannot delete a *new* run's own data even if
   * one starts within that 2s window: guest ids are always freshly
   * generated (`crypto.randomUUID()`), so an old run's captured id list
   * can never collide with a new run's.
   */
  async function handleReset() {
    // Issue #21, fourteenth corrective pass: a synchronous duplicate-Reset
    // guard, same reasoning as `startupInFlightRef` — `SimButton`'s own
    // executing-disables-itself state is real but render-timing-dependent,
    // never a substitute for a ref checked before any `await`.
    if (resetInFlightRef.current) {
      appendLog("Reset already in progress — ignoring duplicate tap");
      return;
    }
    resetInFlightRef.current = true;
    setResetInFlight(true);
    resetGenerationRef.current += 1;
    startupAttemptRef.current = 0;
    startupTokenRef.current++; // see `startupTokenRef`'s own doc comment
    runningRef.current = false;
    setRunning(false);
    stopAllTimers();

    try {
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
      lastSeatFailureRef.current = { 1: null, 2: null };
      setLog([
        `${new Date().toLocaleTimeString()} — Reset — cleared ${result.messagesDeleted} comments, ${result.reactionsDeleted} likes, ${result.speakersDeleted} speaker seats, ${result.requestVotesDeleted} request votes, ${result.roundVotesDeleted} round votes`,
      ]);
      onSimulatorReset?.();

      // The barrier itself is released here, once the *primary* pass has
      // actually landed — not in a `finally` around the whole function,
      // and deliberately not held for the delayed follow-up sweep below.
      // See `resetInFlightRef`'s own doc comment for why the follow-up no
      // longer needs to block Start at all now that it can't touch the
      // shared `stage_rounds` row either (`reconcileStageRound: false`).
      resetInFlightRef.current = false;
      setResetInFlight(false);

      if (guestIds.length > 0) {
        resetFollowUpTimerRef.current = setTimeout(() => {
          resetFollowUpTimerRef.current = null;
          void resetSimulatorSession(eventId, guestIds, false).then((followUp) => {
            const strayTotal =
              followUp.messagesDeleted +
              followUp.reactionsDeleted +
              followUp.speakersDeleted +
              followUp.requestVotesDeleted +
              followUp.roundVotesDeleted;
            if (strayTotal === 0 || !mountedRef.current) return;
            setLog((prev) =>
              [
                `${new Date().toLocaleTimeString()} — Reset follow-up — caught ${strayTotal} straggler row(s) from a write that was still in flight when Reset ran`,
                ...prev,
              ].slice(0, 30),
            );
          });
        }, 2000);
      }
    } finally {
      // Safety net: if `resetSimulatorSession` itself threw (network
      // failure, etc.) the barrier above never got a chance to release —
      // this guarantees it always does, so a genuine error can't leave
      // Start permanently blocked.
      resetInFlightRef.current = false;
      setResetInFlight(false);
    }
  }

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      stopAllTimers();
      if (resetFollowUpTimerRef.current !== null) clearTimeout(resetFollowUpTimerRef.current);
    };
  }, []);

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
   * Issue #21, fourteenth corrective pass: a fresh, authoritative read of
   * both seats — never the possibly-stale `speakers` prop, and never
   * inferred from whether a mutation's own promise threw or resolved.
   * This is the one thing that makes `establishSeat`'s Case A branch
   * genuinely idempotent and self-healing rather than trusting client-
   * side promise resolution alone (Section "AUTHORITATIVE CONFIRMATION
   * AFTER EACH SEAT" — explicit instruction not to determine success
   * solely from whether the action promise threw). `event_speakers_active`
   * is the same view every other authoritative read in this file already
   * uses (`fetchDebugSnapshotState`, `listActiveSpeakersForSimulator`).
   */
  async function fetchSeatOccupants(): Promise<Record<1 | 2, { guestId: string | null; profileId: string | null; displayName: string } | null>> {
    const supabase = createClient();
    const { data } = await supabase
      .from("event_speakers_active")
      .select("seat_number, guest_id, profile_id, display_name")
      .eq("event_id", eventId);
    const result: Record<1 | 2, { guestId: string | null; profileId: string | null; displayName: string } | null> = { 1: null, 2: null };
    for (const row of data ?? []) {
      const seatNumber = row.seat_number as 1 | 2;
      result[seatNumber] = { guestId: row.guest_id, profileId: row.profile_id, displayName: row.display_name ?? "(unknown)" };
    }
    return result;
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
  async function establishInitialPairing(seedSpeakers: [SimulatedIdentity, SimulatedIdentity], token: number): Promise<boolean> {
    const [a, b] = seedSpeakers;
    lastSeatFailureRef.current = { 1: null, 2: null };
    setStartupState((s) => ({ ...s, phase: "seeding" }));

    const before = await fetchStageRoundRow();
    const established = (before?.round_number ?? 0) >= 1;
    appendLog(
      established
        ? "Stage already established — seeding via authorized Request-to-Speak selection, not a direct join"
        : "Stage not yet established — seeding via direct initial-formation join",
    );

    if (startupTokenRef.current !== token) return false;
    appendLog("Seeding Seat 1…");
    const seat1Ok = await establishSeat(a, 1, established, token);
    if (startupTokenRef.current !== token) return false;
    appendLog("Seeding Seat 2…");
    const seat2Ok = await establishSeat(b, 2, established, token);

    if (!seat1Ok && !seat2Ok) {
      const detail =
        lastSeatFailureRef.current[1] ??
        lastSeatFailureRef.current[2] ??
        "Could not seed either simulated speaker — see the log above for the real failure.";
      setStartupState((s) => ({ ...s, phase: "failed", error: detail }));
      appendLog("Could not seed simulated speakers — startup failed; no shared round will be started");
      return false;
    }
    if (!seat1Ok || !seat2Ok) {
      const failedSeatDetail = !seat1Ok ? lastSeatFailureRef.current[1] : lastSeatFailureRef.current[2];
      const detail = failedSeatDetail ?? "Only one seat could be established — a shared round requires both, so none was started.";
      setStartupState((s) => ({ ...s, phase: "failed", error: detail }));
      appendLog(`Seeded 1 simulated speaker (${seat1Ok ? a.displayName : b.displayName}) — the other seat could not be established; no shared round will be started`);
      return false;
    }

    appendLog("Pairing detected — both seats authoritatively confirmed");
    setStartupState((s) => ({ ...s, phase: "verifying-pairing", pairing: "established" }));
    if (startupTokenRef.current !== token) return false;

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

    appendLog(`Round active — Round ${round.round_number}`);
    setStartupState((s) => ({ ...s, sharedRound: "active" }));
    appendLog(`Seeded 2 stable simulated speakers — ${a.displayName} → seat 1, ${b.displayName} → seat 2, Round ${round.round_number} active`);
    return true;
  }

  /**
   * One seat's establishment — branches on `established` (see
   * `establishInitialPairing` above), never bypassing authorization once
   * the stage has ever achieved its pairing.
   *
   * **Case A (issue #21, fourteenth corrective pass — rebuilt around a
   * real-device debug snapshot: "Seat 1 seed failed: Minified React
   * error #441" followed, later in the same log, by evidence that a
   * seat had in fact become authoritatively occupied).** React error
   * #441 in a production build is React's own generic "an error
   * occurred in the Server Components render" — the *real* message is
   * deliberately redacted client-side; only a digest survives. Proven
   * (not assumed) by reading `claim_speaker_seat`'s own SQL (migration
   * 00000000000035): `simulateSeedSpeaker` → `claimSpeakerSeat` →
   * `throw new Error(error.message)` on any RPC failure, and the RPC
   * itself `raise exception`s in exactly two ways a bypass claim can
   * reach — 'identity already holds an active seat' or 'seat is already
   * occupied'. Both are real, authoritative, server-side outcomes; #441
   * is simply what *any* Server Action throw looks like once Next.js's
   * production redaction strips the message — never evidence, on its
   * own, that the mutation didn't happen. So a promise throwing here is
   * never sufficient to conclude the seat wasn't claimed, and a promise
   * resolving is never sufficient to conclude it was — every attempt
   * (throw or not) is followed by a fresh, authoritative
   * `fetchSeatOccupants()` read, exactly per this pass's own explicit
   * instruction.
   *
   * The concrete failure mode this closes: an earlier *incomplete*
   * Start (one seat claimed, the other failed, `running` never flipped
   * true — see `establishInitialPairing`'s own failure branches) leaves
   * its successfully-claimed seat sitting in the database, unless Reset
   * is pressed. Because the stage genuinely never finished pairing,
   * `round_number` stays 0, so *every* retry — with or without an
   * intervening Reset race, a double-tap, or simply pressing Start again
   * — is routed back into this same Case A branch, and a fresh
   * `claimSpeakerSeat` bypass call for the *same seat number* collides
   * with that leftover occupant every single time, throwing 'seat
   * already occupied' deterministically. Recognizing that shape (a
   * throw + an authoritative occupant this tab itself generated, per
   * `allSimulatedGuestIdsRef`) and clearing it via the existing
   * `simulateOpenSeat` adapter is what makes startup actually
   * self-healing instead of requiring a manual Reset every time. A seat
   * occupied by anyone this tab did *not* generate is never touched —
   * that could be a real participant (small-room fallback direct join,
   * migrations 00000000000033/34, can seat one before the stage is
   * established too) — startup reports a precise, non-recoverable
   * failure instead.
   *
   * Case B reuses the *exact* real Request-to-Speak → selection →
   * authorized-claim pipeline (`simulateRequestToSpeak` +
   * `simulateAdvanceSelection`) a real candidate's own browser tab would
   * go through — no simulator-only loophole. Bounded retries on the
   * claim step (never a blind sleep): each attempt is a fresh, real
   * `simulateAdvanceSelection` call, which can legitimately need a
   * couple of tries if selection hasn't frozen the just-submitted
   * request yet. `token` (from `startSimulation`/`seedTwoSpeakers`, see
   * `startupTokenRef`'s own doc comment) is checked between awaits in
   * both cases so a Stop/Reset/newer-Start pressed mid-establishment
   * stops promptly rather than continuing to spend retries on a
   * generation nothing cares about anymore.
   */
  async function establishSeat(identity: SimulatedIdentity, seatNumber: 1 | 2, established: boolean, token: number): Promise<boolean> {
    setSeatStartupStatus(seatNumber, "claiming");

    if (!established) {
      for (let attempt = 1; attempt <= MAX_SEED_ATTEMPTS; attempt++) {
        if (startupTokenRef.current !== token) return false;
        appendLog(`Seat ${seatNumber} seed requested (${identity.displayName})${attempt > 1 ? ` — retry ${attempt}/${MAX_SEED_ATTEMPTS}` : ""}`);
        try {
          await simulateSeedSpeaker(eventId, identity.id, identity.displayName, seatNumber);
          appendLog(`Seat ${seatNumber} mutation returned`);
          if (startupTokenRef.current !== token) return false;
          const occupants = await fetchSeatOccupants();
          const occupant = occupants[seatNumber];
          if (occupant?.guestId === identity.id) {
            appendLog(`Seat ${seatNumber} authoritative confirmation: OCCUPIED (${identity.displayName})`);
            setSeatStartupStatus(seatNumber, "occupied");
            lastSeatFailureRef.current[seatNumber] = null;
            return true;
          }
          // Section "AUTHORITATIVE CONFIRMATION AFTER EACH SEAT": a
          // resolved promise alone is never enough — this genuinely
          // shouldn't happen (the RPC either throws or returns the seated
          // row), but if it ever does, don't trust it.
          appendLog(`Seat ${seatNumber} authoritative confirmation: mutation resolved but authoritative state does not show ${identity.displayName} seated`);
          lastSeatFailureRef.current[seatNumber] = formatFailedPhase({
            phase: `Seat ${seatNumber} authoritative confirmation`,
            attempts: attempt,
            maxAttempts: MAX_SEED_ATTEMPTS,
            expected: `Seat ${seatNumber} = ${identity.displayName}`,
            authoritative: occupant ? `Seat ${seatNumber} = ${occupant.displayName}` : `Seat ${seatNumber} empty`,
            lastError: "mutation resolved without throwing, but authoritative state disagreed",
            recovery: "safe to retry Start",
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown error";
          appendLog(`Seat ${seatNumber} mutation threw: ${message}`);
          if (startupTokenRef.current !== token) return false;
          const occupants = await fetchSeatOccupants();
          const occupant = occupants[seatNumber];
          if (occupant?.guestId === identity.id) {
            // See this function's own doc comment on React error #441 —
            // the mutation actually succeeded; the client-visible throw
            // is production error redaction, not a real failure. Never
            // retry here: a second claim for an identity that already
            // holds this exact seat would itself throw.
            appendLog(`Seat ${seatNumber} authoritative confirmation after throw: OCCUPIED by ${identity.displayName} — the mutation succeeded despite the client-visible error; not retrying`);
            setSeatStartupStatus(seatNumber, "occupied");
            lastSeatFailureRef.current[seatNumber] = null;
            return true;
          }
          if (occupant?.guestId && allSimulatedGuestIdsRef.current.has(occupant.guestId)) {
            appendLog(`Seat ${seatNumber} authoritative confirmation after throw: OCCUPIED by a leftover simulator seat (${occupant.displayName}) from an earlier incomplete attempt — clearing`);
            try {
              await simulateOpenSeat(eventId, occupant.guestId);
            } catch (cleanupErr) {
              appendLog(`Seat ${seatNumber}: leftover cleanup failed: ${cleanupErr instanceof Error ? cleanupErr.message : "unknown error"}`);
            }
            lastSeatFailureRef.current[seatNumber] = formatFailedPhase({
              phase: `Seat ${seatNumber} mutation`,
              attempts: attempt,
              maxAttempts: MAX_SEED_ATTEMPTS,
              expected: `Seat ${seatNumber} = ${identity.displayName}`,
              authoritative: `Seat ${seatNumber} was occupied by a leftover simulator seat (${occupant.displayName})`,
              lastError: message,
              recovery: attempt < MAX_SEED_ATTEMPTS ? "clearing the leftover seat and retrying automatically" : "Reset required",
            });
            continue;
          }
          if (occupant) {
            appendLog(`Seat ${seatNumber} authoritative confirmation after throw: OCCUPIED by ${occupant.displayName}, not simulator-owned — will not evict`);
            lastSeatFailureRef.current[seatNumber] = formatFailedPhase({
              phase: `Seat ${seatNumber} mutation`,
              attempts: attempt,
              maxAttempts: MAX_SEED_ATTEMPTS,
              expected: `Seat ${seatNumber} = ${identity.displayName}`,
              authoritative: `Seat ${seatNumber} = ${occupant.displayName} (not simulator-owned)`,
              lastError: message,
              recovery: "a non-simulator occupant already holds this seat — Start cannot proceed without evicting a possibly-real participant, which it will never do automatically",
            });
            break;
          }
          appendLog(`Seat ${seatNumber} authoritative confirmation after throw: EMPTY — transient error`);
          lastSeatFailureRef.current[seatNumber] = formatFailedPhase({
            phase: `Seat ${seatNumber} mutation`,
            attempts: attempt,
            maxAttempts: MAX_SEED_ATTEMPTS,
            expected: `Seat ${seatNumber} = ${identity.displayName}`,
            authoritative: `Seat ${seatNumber} empty`,
            lastError: message,
            recovery: attempt < MAX_SEED_ATTEMPTS ? "retrying automatically" : "safe to retry Start",
          });
        }
      }
      appendLog(`Seat ${seatNumber} seed failed after ${MAX_SEED_ATTEMPTS} attempt(s) — see the FAILED PHASE detail above`);
      setSeatStartupStatus(seatNumber, "failed");
      return false;
    }

    appendLog(`Seat ${seatNumber} request-to-speak requested (${identity.displayName})`);
    try {
      await simulateRequestToSpeak(eventId, identity.id, identity.displayName, randomSpeakerRequestComment());
    } catch (err) {
      appendLog(`Seat ${seatNumber} request-to-speak failed: ${err instanceof Error ? err.message : "unknown error"}`);
      lastSeatFailureRef.current[seatNumber] = formatFailedPhase({
        phase: `Seat ${seatNumber} request-to-speak`,
        attempts: 1,
        maxAttempts: 1,
        expected: `Seat ${seatNumber} authorized for ${identity.displayName}`,
        authoritative: "request-to-speak submission itself failed",
        lastError: err instanceof Error ? err.message : "unknown error",
        recovery: "safe to retry Start",
      });
      setSeatStartupStatus(seatNumber, "failed");
      return false;
    }
    setSeatStartupStatus(seatNumber, "authorized");

    for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
      if (startupTokenRef.current !== token) return false;
      const result = await simulateAdvanceSelection(eventId, [identity.id], { [identity.id]: identity.displayName });
      if (result.claimed) {
        appendLog(`Seat ${seatNumber} authoritative confirmation: OCCUPIED (${identity.displayName})`);
        setSeatStartupStatus(seatNumber, "occupied");
        lastSeatFailureRef.current[seatNumber] = null;
        return true;
      }
      if (attempt < MAX_CLAIM_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_DELAY_MS));
      }
    }
    appendLog(`Seat ${seatNumber}: ${identity.displayName}'s request did not result in an authorized claim within the expected window`);
    lastSeatFailureRef.current[seatNumber] = formatFailedPhase({
      phase: `Seat ${seatNumber} authorized claim`,
      attempts: MAX_CLAIM_ATTEMPTS,
      maxAttempts: MAX_CLAIM_ATTEMPTS,
      expected: `Seat ${seatNumber} = ${identity.displayName}`,
      authoritative: `Seat ${seatNumber} still not claimed after the expected window`,
      lastError: "authorized claim did not complete in time",
      recovery: "safe to retry Start",
    });
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
   * pathway either. Bumps its own startup token (fourteenth corrective
   * pass) so this call is interruptible by Stop/Reset the same way
   * `startSimulation` already is — this button reuses the exact same
   * `establishInitialPairing`/`establishSeat` machinery, so it should
   * honor the exact same interruption contract.
   */
  async function seedTwoSpeakers() {
    const pool = requireAudience();
    const seedSpeakers = seedSpeakersRef.current;
    if (!pool || !seedSpeakers) return;
    const token = ++startupTokenRef.current;
    await establishInitialPairing(seedSpeakers, token);
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

  /**
   * Issue #21, ninth corrective pass, Sections 12-13: the one, shared
   * "why is this seat still waiting" computation — extracted so
   * "Selection Timing" and "Selection Forensics" (below) never show two
   * subtly different reasons for the same seat. More granular than the
   * eighth pass's own version (Section 9 there): distinguishes "still
   * within the intentional 3s Going Live window" from "reserved a while
   * ago and still not occupied," using real, observed elapsed time
   * (`seatTiming`'s own real `Date.now()` timestamps) — never an
   * estimate. Returns `null` only when the seat is occupied (nothing to
   * wait for) — every other case gets a specific reason, never a
   * generic "Selecting…".
   */
  function computeWaitingReason(seatNumber: 1 | 2): string {
    const t = seatTiming[seatNumber];
    const hasEligibleRequests = pendingRequests.length > 0;
    const establishedForFallback = stageRound !== null && stageRound.round_number >= 1;
    const bothEmpty = speakers.length === 0;
    const fallbackOpen = establishedForFallback && bothEmpty && !hasEligibleRequests;
    const reservedForThisSeat = pendingRequests.some((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber);
    const reservedForMs = t.reservedAt !== null && now !== null ? now - t.reservedAt : null;
    const CLAIM_GRACE_MS = 4000;

    if (reservedForThisSeat) {
      return reservedForMs !== null && reservedForMs > PROMOTION_COUNTDOWN_SECONDS * 1000 + CLAIM_GRACE_MS
        ? `authoritative seat claim — reserved ${formatDelta(reservedForMs)} ago, past the intentional ${PROMOTION_COUNTDOWN_SECONDS}s countdown, not yet occupied`
        : `Going Live (up to ${PROMOTION_COUNTDOWN_SECONDS}s, intentional) or candidate client acknowledgement — cannot be distinguished from this vantage point`;
    }
    if (hasEligibleRequests) {
      return "reservation RPC pending, or reservation not yet propagated to this client — cannot be distinguished from this vantage point";
    }
    if (fallbackOpen) return "fallback open — tap to join";
    return "eligible candidate detection — no eligible request observed yet";
  }

  /**
   * Issue #21, eleventh corrective pass, Sections 9, 13-16: two-phase
   * capture — **CAPTURE FIRST, ENRICH SECOND**. The tenth pass's own
   * version awaited the authoritative fetch *before* building the
   * client-state section at all, meaning a slow/hung fetch delayed
   * everything, including the one thing that's always instantly
   * available: this tab's own already-live props. A real-device report
   * confirmed exactly this — the copy "did not give an immediate usable
   * result," and the user had to wait, force another transition, and
   * stop the simulator before a usable snapshot finally came through,
   * which this pass's own instructions explicitly say must never be
   * required again.
   *
   * T0 (this function's own entry, synchronous): the client section is
   * built immediately from already-live closure state (`speakers`,
   * `pendingRequests`, `stageRound`, `running` — no `await` anywhere in
   * this step), and a "DEBUG CAPTURE TAP" marker is appended to this
   * panel's own activity log so a later reader can see exactly what
   * else happened immediately before/after the tap. T1: the bounded
   * (4s) authoritative fetch resolves, times out, or fails — the client
   * section from T0 is never rewritten by anything that happens after
   * it, including a state change mid-capture (detected via
   * `speakersRef`/`pendingRequestsRef`, mirrored live by a separate
   * effect, and reported explicitly as its own line).
   */
  const AUTHORITATIVE_FETCH_TIMEOUT_MS = 4000;
  const CLIPBOARD_WRITE_TIMEOUT_MS = 3000;

  async function copyDebugSnapshot() {
    if (capturingSnapshotRef.current) return; // Section 16: no duplicate concurrent captures
    capturingSnapshotRef.current = true;
    setSnapshotStatus("capturing");

    // --- T0: synchronous, from already-live props. Never delayed by
    // anything below, and never rewritten once captured.
    const t0 = Date.now();
    const t0OccupancyKey = speakers.map((s) => s.id).sort().join(",");
    const t0PendingKey = pendingRequests.map((r) => r.id).sort().join(",");
    const established = stageRound !== null && stageRound.round_number >= 1;
    const clientLines: string[] = [];
    const pushClient = (line = "") => clientLines.push(line);
    pushClient("CLIENT STATE AT TAP (T0)");
    pushClient(`Established mode: ${established ? "yes" : "no"}`);
    pushClient(`Simulator running: ${running ? "yes" : "no"}`);
    pushClient(
      `Client round: #${stageRound?.round_number ?? "—"} ${stageRound?.phase ?? "none"}${sharedRemaining !== null ? ` (${sharedRemaining}s remaining)` : ""}`,
    );
    pushClient(`Seats occupied: ${speakers.map((s) => `${s.seat_number}:${s.display_name}`).join(", ") || "(none)"}`);
    pushClient(`Pending requests: ${pendingRequests.length}`);
    if (pendingRequests.length > 0) {
      const top = pendingRequests[0];
      pushClient(
        `Prospective next: ${candidateName(top)} — ${top.voteCount} votes${
          top.is_current_candidate && top.reserved_seat_number !== null ? ` (reserved Seat ${top.reserved_seat_number})` : " (not reserved)"
        }`,
      );
      if (pendingRequests[1]) pushClient(`Prospective second: ${candidateName(pendingRequests[1])} — ${pendingRequests[1].voteCount} votes`);
    }
    pushClient("Selected / Reserved (client-observed):");
    for (const seatNumber of [1, 2] as const) {
      const reserved = pendingRequests.find((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber);
      pushClient(`  Seat ${seatNumber}: ${reserved ? candidateName(reserved) : "none"}`);
    }
    appendLog("DEBUG CAPTURE TAP");

    // --- T1: bounded authoritative fetch — never lets a slow/hung read
    // lose the T0 capture above.
    let authoritative: Awaited<ReturnType<typeof fetchDebugSnapshotState>> | null = null;
    let authoritativeError: string | null = null;
    let timedOut = false;
    try {
      authoritative = await Promise.race([
        fetchDebugSnapshotState(eventId),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("__snapshot_timeout__")), AUTHORITATIVE_FETCH_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      if (err instanceof Error && err.message === "__snapshot_timeout__") {
        timedOut = true;
      } else {
        authoritativeError = err instanceof Error ? err.message : "unknown error";
      }
    }
    const t1 = Date.now();

    // Section 15: later changes must not rewrite T0 — this only *reports*
    // whether one happened, via the live-mirrored refs (updated by a
    // separate effect regardless of this function), never mutates
    // `clientLines` above.
    const stateChangedDuringCapture =
      speakersRef.current.map((s) => s.id).sort().join(",") !== t0OccupancyKey ||
      pendingRequestsRef.current.map((r) => r.id).sort().join(",") !== t0PendingKey;

    const lines: string[] = [];
    const push = (line = "") => lines.push(line);
    push("VIRTUAL STAGE DEBUG SNAPSHOT");
    push(`Capture tap time (T0): ${new Date(t0).toISOString()}`);
    push(`Event: ${eventId}`);
    push("");
    lines.push(...clientLines);
    push("");

    push("AUTHORITATIVE STATE AT READ (T1)");
    push(`Read completed: ${new Date(t1).toISOString()}`);
    push(`Authoritative fetch latency (T1 - T0): ${t1 - t0}ms`);
    if (timedOut) {
      push("AUTHORITATIVE FETCH: TIMED OUT");
    } else if (authoritativeError) {
      push(`AUTHORITATIVE FETCH: FAILED — ${authoritativeError}`);
    } else if (authoritative) {
      push(`Authoritative round: #${authoritative.round?.round_number ?? "—"} ${authoritative.round?.phase ?? "none"}`);
      push("Authoritative seats:");
      if (authoritative.seats.length === 0) push("  (none occupied)");
      for (const seat of authoritative.seats) {
        push(`  Seat ${seat.seat_number}: ${seat.display_name} (${seat.identity_kind})${seat.disconnected ? " — disconnected" : ""}`);
      }
      push("Live RTS ranking (authoritative):");
      if (authoritative.pendingRequests.length === 0) push("  (none pending)");
      const ranked = [...authoritative.pendingRequests].sort((a, b) => b.vote_count - a.vote_count);
      ranked.forEach((r, i) => {
        push(
          `  #${i + 1} ${r.display_name} — ${r.vote_count} votes${r.selection_failed ? " (not eligible — previously failed)" : ""}${
            r.is_current_candidate ? ` — RESERVED (Seat ${r.reserved_seat_number})` : ""
          }`,
        );
      });
    }
    push("");
    push(`STATE CHANGED DURING CAPTURE: ${stateChangedDuringCapture ? "yes" : "no"}`);
    push("");

    // Issue #21, twelfth corrective pass, Section "ADD INVARIANT
    // DETECTION TO SNAPSHOT": a real-device capture proved the room
    // could sit in established + fillable-vacant + eligible-RTS + no-
    // reservation for at least 591ms with nothing in the snapshot
    // *saying so directly* — the reader had to work it out by eye from
    // several separate sections. This makes that specific invariant
    // explicit, per seat, computed from the authoritative read when it
    // succeeded (the trustworthy source) and falling back to client-
    // observed state with a clear label when it didn't.
    push("VACANCY DIAGNOSTICS");
    const vacancySource = authoritative ? "authoritative" : "client-observed (authoritative fetch did not succeed)";
    for (const seatNumber of [1, 2] as const) {
      const vacant = authoritative
        ? !authoritative.seats.some((s) => s.seat_number === seatNumber)
        : !speakers.some((s) => s.seat_number === seatNumber);
      push(`Seat ${seatNumber} (${vacancySource}):`);
      push(`  vacant: ${vacant ? "yes" : "no"}`);
      if (!vacant) continue;
      push(`  established: ${established ? "yes" : "no"}`);
      const eligibleCount = authoritative
        ? authoritative.pendingRequests.filter((r) => !r.selection_failed).length
        : pendingRequests.filter((r) => !r.selection_failed).length;
      push(`  eligible RTS: ${eligibleCount}`);
      const clientReserved = pendingRequests.find((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber);
      const reservedName = authoritative
        ? authoritative.pendingRequests.find((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber)?.display_name
        : clientReserved
          ? candidateName(clientReserved)
          : undefined;
      push(`  reservation: ${reservedName ?? "none"}`);
      const fillable = established;
      push(`  fillable: ${fillable ? "yes" : "no"}${fillable ? "" : " — stage not yet established"}`);
      if (!fillable) continue;
      const violation = eligibleCount > 0 && !reservedName;
      push(`  INVARIANT STATUS: ${violation ? "VIOLATION" : "OK"}`);
      if (violation) {
        push("  WAITING AT: selection reconciliation");
        push(`  BLOCKED BECAUSE: established room has a fillable vacant seat and ${eligibleCount} eligible RTS candidate(s) but no valid reservation`);
      } else if (eligibleCount === 0) {
        push("  (no eligible RTS candidates — nothing to reserve; not a violation)");
      }
    }
    push("");

    push("STATE MISMATCHES");
    const mismatches: string[] = [];
    if (authoritative) {
      const authSeatNums = new Set(authoritative.seats.map((s) => s.seat_number));
      const clientSeatNums = new Set(speakers.map((s) => s.seat_number));
      for (const n of [1, 2] as const) {
        if (authSeatNums.has(n) !== clientSeatNums.has(n)) {
          mismatches.push(`Seat ${n}: client says ${clientSeatNums.has(n) ? "occupied" : "vacant"}, database says ${authSeatNums.has(n) ? "occupied" : "vacant"}`);
        }
      }
      if (authoritative.pendingRequests.length !== pendingRequests.length) {
        mismatches.push(`Pending request count: client=${pendingRequests.length}, database=${authoritative.pendingRequests.length}`);
      }
      if ((authoritative.round?.round_number ?? null) !== (stageRound?.round_number ?? null)) {
        mismatches.push(`Round number: client=${stageRound?.round_number ?? "none"}, database=${authoritative.round?.round_number ?? "none"}`);
      }
    }
    if (mismatches.length === 0) {
      push(authoritative ? "  none detected" : "  unknown — authoritative fetch did not succeed, see above");
    } else {
      for (const m of mismatches) push(`  - ${m}`);
    }
    push("");

    // Issue #21, twelfth/thirteenth corrective passes: a real-device
    // capture showed the client's own Realtime-accumulated vote count
    // disagreeing with a fresh authoritative count for the *same*
    // candidate (4 vs 3, later 1 vs 2) while STATE MISMATCHES still said
    // "none detected" — that section never looked at vote counts at
    // all. Fixed (twelfth pass), then made more useful (thirteenth
    // pass, Section 14): a dedicated block per mismatched candidate with
    // both counts, the signed delta, and both ranks — cheap to compute
    // (the client's own `pendingRequests` is already sorted the way
    // `useActiveSpeakerRequests` ranks it; the authoritative list is
    // sorted the same way, by vote count, immediately above) — matched
    // by request id, never display name (two different requests can
    // legitimately share a name). Called out prominently as its own
    // "PROSPECTIVE RANKING MISMATCH" line when the rank itself differs,
    // not just the raw count — that's the case that could eventually
    // change who's actually shown as Next Speaker Candidate.
    if (authoritative) {
      const clientRankById = new Map(pendingRequests.map((r, i) => [r.id, i + 1]));
      const authRankById = new Map(
        [...authoritative.pendingRequests].sort((a, b) => b.vote_count - a.vote_count).map((r, i) => [r.id, i + 1]),
      );
      let anyCountMismatch = false;
      for (const authReq of authoritative.pendingRequests) {
        const clientReq = pendingRequests.find((r) => r.id === authReq.id);
        if (!clientReq || clientReq.voteCount === authReq.vote_count) continue;
        anyCountMismatch = true;
        const clientRank = clientRankById.get(authReq.id) ?? null;
        const authRank = authRankById.get(authReq.id) ?? null;
        push("RTS COUNT MISMATCH");
        push(`Candidate: ${authReq.display_name}`);
        push(`Client votes: ${clientReq.voteCount}`);
        push(`Database votes: ${authReq.vote_count}`);
        push(`Delta: ${clientReq.voteCount - authReq.vote_count >= 0 ? "+" : ""}${clientReq.voteCount - authReq.vote_count}`);
        push(`Client rank: ${clientRank !== null ? `#${clientRank}` : "—"}`);
        push(`Database rank: ${authRank !== null ? `#${authRank}` : "—"}`);
        if (clientRank !== authRank) {
          push("PROSPECTIVE RANKING MISMATCH");
        }
        push("");
      }
      if (!anyCountMismatch) {
        push("RTS COUNT MISMATCH: none detected");
        push("");
      }
    }

    // Issue #21, fourteenth corrective pass, Section "DEBUG SNAPSHOT:
    // STARTUP STATUS": a real-device report showed a startup failure
    // (Seat 1 seed failed, React #441) followed, later in the *same*
    // activity log, by evidence the seat had actually become
    // authoritatively occupied — with nothing in the snapshot surfacing
    // the run/generation, retry count, or per-seat intended-vs-
    // authoritative state that would have made that contradiction
    // immediately legible. This block makes every one of those fields
    // explicit, computed the same way the rest of this snapshot already
    // is: "intended" from this tab's own local bookkeeping
    // (`seedSpeakersRef`), "authoritative" from the same fresh
    // `fetchDebugSnapshotState` read every other authoritative section
    // above already uses — never inferred from whether a mutation's own
    // promise threw or resolved.
    push("SIMULATOR STARTUP");
    const startupStatusLabel = running ? "ready" : startingUp ? "starting" : startupState.phase === "failed" ? "failed" : "idle";
    push(`State: ${startupStatusLabel}`);
    push(`Current phase: ${startupPhaseLabel(startupState.phase)}`);
    push(`Run/generation ID: ${startupTokenRef.current}`);
    push(`Reset in progress: ${resetInFlightRef.current ? "yes" : "no"}`);
    push(`Reset generation: ${resetGenerationRef.current}`);
    push(`Startup attempt: ${startupAttemptRef.current}`);
    const intendedSeat1 = seedSpeakersRef.current?.[0]?.displayName ?? "—";
    const intendedSeat2 = seedSpeakersRef.current?.[1]?.displayName ?? "—";
    const authSeat1 = authoritative?.seats.find((s) => s.seat_number === 1)?.display_name ?? "vacant";
    const authSeat2 = authoritative?.seats.find((s) => s.seat_number === 2)?.display_name ?? "vacant";
    push(`Seat 1 intended: ${intendedSeat1}`);
    push(`Seat 1 authoritative: ${authSeat1}`);
    push(`Seat 2 intended: ${intendedSeat2}`);
    push(`Seat 2 authoritative: ${authSeat2}`);
    push(`Last startup error: ${startupState.error ? startupState.error.replace(/\n/g, " / ") : "none"}`);
    push(`Pending cleanup from previous generation: ${resetFollowUpTimerRef.current !== null ? "yes" : "no"}`);
    push("");

    push("RESET / SIMULATOR OWNERSHIP");
    push(`  Guest ids tracked this run: ${allSimulatedGuestIdsRef.current.size}`);
    push("");

    push("RECENT ACTIVITY (see this panel's own log — most recent first)");
    for (const line of log.slice(0, 15)) push(`  ${line}`);

    const text = lines.join("\n");
    setSnapshotText(text);

    // Section 16: bounded — a hung clipboard permission prompt (a real,
    // previously-observed failure mode) must not leave this stuck
    // "Capturing…" forever. On any failure or timeout, the text is
    // still available via the fallback panel below (Section 16: "do not
    // lose the T0 capture just because ... slow") — this is not merely
    // a courtesy, it's the actual fix for "did not give an immediate
    // usable result": a clipboard write that only starts *after* an
    // async gap since the tap's own user gesture is exactly the kind of
    // write real mobile browsers can silently refuse or hang on.
    try {
      await Promise.race([
        navigator.clipboard.writeText(text),
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("__clipboard_timeout__")), CLIPBOARD_WRITE_TIMEOUT_MS);
        }),
      ]);
      setSnapshotStatus("copied");
      setTimeout(() => setSnapshotStatus("idle"), 2000);
    } catch {
      setSnapshotStatus("manual-copy-needed");
      setSnapshotVisible(true);
    } finally {
      capturingSnapshotRef.current = false;
    }
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
        <SimButton
          data-testid="sim-start"
          onClick={startSimulation}
          // Issue #21, fourteenth corrective pass: `resetInFlight` closes
          // the Reset→Start race at the UI layer too — `startSimulation`'s
          // own `resetInFlightRef` check is the actual, render-timing-
          // independent guarantee; this just keeps the button's own
          // visible state honest with it.
          disabled={running || startingUp || resetInFlight}
          className="rounded bg-emerald-600 px-2 py-1 font-medium"
        >
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
        {/*
          Issue #21, tenth corrective pass, Sections 1, 25: a real-device
          bug report is far more useful as pasteable text than a
          screenshot — see `copyDebugSnapshot`'s own doc comment. Kept in
          the same compact button row (not a separate modal) so the panel
          stays usable one-handed on a phone.
        */}
        <SimButton data-testid="sim-copy-debug-snapshot" onClick={copyDebugSnapshot} className="rounded bg-teal-700 px-2 py-1 font-medium">
          {snapshotStatus === "capturing"
            ? "Capturing…"
            : snapshotStatus === "copied"
              ? "Copied ✓"
              : snapshotStatus === "manual-copy-needed"
                ? "See below to copy"
                : "Copy Debug Snapshot"}
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
            // Issue #21, fourteenth corrective pass: `formatFailedPhase`
            // produces a multi-line FAILED PHASE / ATTEMPTS / EXPECTED /
            // AUTHORITATIVE / LAST ERROR / RECOVERY report — `whitespace-
            // pre-wrap` is what actually keeps that legible instead of a
            // `<p>`'s default whitespace collapse squashing it onto one line.
            <p data-testid="sim-startup-error" className="mt-0.5 whitespace-pre-wrap text-red-400">
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
          Issue #21, eleventh corrective pass, Sections 1-4: "Next Speaker
          Candidate" — the PROSPECTIVE #1-ranked eligible RTS requester,
          reactive to live vote changes, visible during an active round
          with nothing reserved. A real-device report found the prior
          "Next Speaker" section only ever answering this from
          `frozenCandidates` (which stays empty — correctly — for as long
          as both seats are occupied, since freezing only ever happens
          once a seat is actually open, see `ensureActiveSelectionRound`'s
          own doc comment), leaving no way to see "who's currently first
          in line" without an actual vacancy. This section answers that
          directly from the same live `pendingRequests` ordering
          `useActiveSpeakerRequests` already sorts by (most votes, tie →
          earliest active request) — never a second, differently-derived
          ranking, and never a reservation: nothing here freezes or
          reserves anything by being displayed (see `ensureActiveSelectionRound`'s
          own "do not reserve early" behavior, unchanged). When the #1
          candidate genuinely *is* already reserved (a real vacancy exists
          and reconciliation has run), that fact is shown alongside it
          rather than hidden — "prospective" and "reserved" are not
          mutually exclusive, only "reserved" is authoritative.
        */}
        <div className="border-t border-white/10 pt-1 font-semibold text-white/70">Next Speaker Candidate</div>
        {pendingRequests.length === 0 ? (
          <p className="text-white/40" data-testid="sim-prospective-next">
            No eligible RTS candidates
          </p>
        ) : (
          <>
            <p data-testid="sim-prospective-next" className="font-medium text-emerald-300">
              {candidateName(pendingRequests[0])} — {pendingRequests[0].voteCount} votes
              {pendingRequests[0].is_current_candidate && pendingRequests[0].reserved_seat_number !== null ? (
                <span className="text-white/60"> · reserved (Seat {pendingRequests[0].reserved_seat_number})</span>
              ) : (
                <span className="text-white/60"> · prospective — not reserved</span>
              )}
            </p>
            {pendingRequests[1] && (
              <p data-testid="sim-prospective-second" className="text-white/60">
                Second in line: {candidateName(pendingRequests[1])} — {pendingRequests[1].voteCount} votes
              </p>
            )}
            {pendingRequests[1] && (
              <p data-testid="sim-prospective-both" className="text-white/50">
                If both replaced: {candidateName(pendingRequests[0])} + {candidateName(pendingRequests[1])}
              </p>
            )}
          </>
        )}

        {/*
          Issue #21, third corrective pass: makes deterministic selection
          legible — "did #1 legitimately not win, or did something
          actually fail" is answerable from the same frozen ranking the
          real resolver used. See `frozenCandidates`' own doc comment
          above. No weighted odds anymore — highest votes wins, ties
          break on earliest request.

          Issue #21, eleventh corrective pass: renamed from "Next
          Speaker" (now the prospective section's own name, above) to
          "Selected / Committed" — this section only ever answers "what
          has actually been frozen/reserved at a real replacement
          boundary," a *different* question from "who's currently next,"
          and conflating the two under one ambiguous header was Section
          1's own explicit complaint.
        */}
        <div className="border-t border-white/10 pt-1 font-semibold text-white/70">Selected / Committed</div>
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
          Issue #21, ninth corrective pass, Sections 12-13: "Selection
          Forensics" — if the boundary→reservation bug in this pass's own
          report ever recurs, this is what should make it immediately
          diagnosable from a real device: the exact RTS ranking *at the
          selection boundary* (frozen_rank/frozen_vote_count — captured
          once, when the round was frozen) shown separately from the
          *current* live ranking (voteCount, which can keep changing
          afterward — Section 10's "later votes must not retroactively
          change an already-resolved winner") — the only way to actually
          answer "did the correct candidate win" instead of guessing from
          whichever comment happens to be visible. Collapsed by default;
          Section 12 explicitly asks this not be dumped into the main
          panel unconditionally.
        */}
        <button
          type="button"
          data-testid="sim-forensics-toggle"
          onClick={() => setForensicsExpanded((v) => !v)}
          className="mt-1 w-full border-t border-white/10 pt-1 text-left font-semibold text-white/70"
        >
          Selection Forensics {forensicsExpanded ? "▾" : "▸"}
        </button>
        {forensicsExpanded && (
          <>
            {/*
              Issue #21, tenth corrective pass, Sections 1-6, 32: "during
              an active round, the system already knows who's requesting,
              who's eligible, and their current vote ordering — the
              diagnostics just never labeled that ordering as anything."
              This IS the live replacement queue Section 4 asks to expose
              — not new selection logic (nothing here is reserved by
              being shown here; see `computeWaitingReason`'s own "do not
              reserve early" invariant, unchanged), just the same
              already-live `pendingRequests` ordering (most votes, tie →
              earliest active request — `useActiveSpeakerRequests`' own
              sort, identical to `freeze_speaker_candidates`' SQL order)
              under an explicit label, shown once here rather than
              silently re-derived and duplicated inside every seat's own
              block below the way an earlier cut of this section did.
            */}
            <p className="mt-1 text-white/70" data-testid="sim-established-mode">
              Established mode: {stageRound !== null && stageRound.round_number >= 1 ? "yes" : "no"}
            </p>
            <p className="mt-1 text-white/50">Live Replacement Queue (not a reservation — current order only):</p>
            {pendingRequests.length === 0 ? (
              <p className="pl-2 text-white/40">none</p>
            ) : (
              pendingRequests.map((r, i) => (
                <p key={r.id} data-testid="sim-queue-row" className="pl-2 text-white/70">
                  #{i + 1} {candidateName(r)} — {r.voteCount}
                  {r.selection_failed && <span className="text-white/40"> (not eligible)</span>}
                </p>
              ))
            )}
            <p className="mt-1 text-white/50">Selected / Reserved:</p>
            {([1, 2] as const).map((seatNumber) => {
              const reserved = pendingRequests.find((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber) ?? null;
              return (
                <p key={seatNumber} className="pl-2 text-white/70" data-testid={`sim-selected-reserved-${seatNumber}`}>
                  Seat {seatNumber}: {reserved ? candidateName(reserved) : "none"}
                </p>
              );
            })}
            {([1, 2] as const).map((seatNumber) => {
              const vacant = !seatIsOccupied(seatNumber);
              // RANKING AT BOUNDARY: frozen_rank/frozen_vote_count — set
              // once, by the real freeze RPC, never recomputed here.
              // Deliberately still shown per seat (unlike the queue
              // above, now shown once): the boundary ranking is a
              // one-time historical snapshot, not the live queue, so
              // it's the thing worth comparing seat-by-seat against
              // "what actually got reserved."
              const atBoundary = pendingRequests
                .filter((r) => r.frozen_rank !== null)
                .sort((a, b) => (a.frozen_rank ?? 0) - (b.frozen_rank ?? 0));
              const expectedWinner = atBoundary[0] ?? null;
              const reserved = pendingRequests.find((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber) ?? null;
              return (
                <div key={seatNumber} data-testid={`sim-forensics-${seatNumber}`} className="mt-1 rounded bg-white/5 p-1.5">
                  <p className="font-medium text-white/80">Seat {seatNumber}</p>
                  <p className="text-white/70">Vacant: {vacant ? "yes" : "no"}</p>
                  <p className="text-white/70">Round: #{stageRound?.round_number ?? "—"}</p>
                  <p className="mt-1 text-white/50">RTS ranking at boundary:</p>
                  {atBoundary.length === 0 ? (
                    <p className="pl-2 text-white/40">none frozen yet</p>
                  ) : (
                    atBoundary.map((r) => (
                      <p key={r.id} className="pl-2 text-white/70">
                        #{r.frozen_rank} {candidateName(r)} — {r.frozen_vote_count}
                      </p>
                    ))
                  )}
                  <p className="mt-1 text-white/70" data-testid={`sim-forensics-expected-${seatNumber}`}>
                    Expected winner: {expectedWinner ? candidateName(expectedWinner) : "none"}
                  </p>
                  <p className="text-white/70" data-testid={`sim-forensics-reserved-${seatNumber}`}>
                    Reserved: {reserved ? candidateName(reserved) : "none"}
                    {reserved && expectedWinner && reserved.id !== expectedWinner.id && (
                      <span className="font-semibold text-red-400"> — different from expected winner</span>
                    )}
                  </p>
                  <p className="text-white/70">Occupied: {vacant ? "no" : "yes"}</p>
                  {vacant && (
                    <p data-testid={`sim-forensics-blocked-${seatNumber}`} className="font-semibold text-amber-400">
                      WAITING AT / BLOCKED BECAUSE: {computeWaitingReason(seatNumber)}
                    </p>
                  )}
                </div>
              );
            })}
          </>
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

          const waitingReason = t.occupiedAt !== null ? null : computeWaitingReason(seatNumber);

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

        {/*
          Issue #21, eleventh corrective pass, Section 16: the fallback
          for "did not give me a usable result" — a mobile browser's
          clipboard write can silently fail or hang (a real, previously-
          observed failure mode; see `copyDebugSnapshot`'s own doc
          comment), so the captured text is *always* available here too,
          not just via the clipboard. Opens automatically when the
          automatic copy didn't land; otherwise stays collapsed, same
          "don't dump raw text into the main panel unconditionally"
          discipline Selection Forensics already established.
        */}
        {snapshotText && (
          <div className="border-t border-white/10 pt-1">
            <button
              type="button"
              data-testid="sim-snapshot-toggle"
              onClick={() => setSnapshotVisible((v) => !v)}
              className="w-full text-left font-semibold text-white/70"
            >
              Last Debug Snapshot {snapshotVisible ? "▾" : "▸"}
              {snapshotStatus === "manual-copy-needed" && (
                <span className="ml-1 font-normal text-amber-400">— automatic copy didn&apos;t land, select text below</span>
              )}
            </button>
            {snapshotVisible && (
              <textarea
                data-testid="sim-snapshot-text"
                readOnly
                value={snapshotText}
                onFocus={(e) => e.currentTarget.select()}
                className="mt-1 h-32 w-full rounded bg-white/5 p-1.5 font-mono text-[10px] text-white/80"
              />
            )}
          </div>
        )}
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
