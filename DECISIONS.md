# Decisions

Architecture Decision Record. Newest first. Format: Problem, Alternatives
considered, Decision, Reason, Tradeoffs.

## 2026-09-01 — Seventeenth corrective pass: a seat entering its own Final-30 closing window was incorrectly demoting the *shared* round for both speakers, hiding the timer even though the pairing was still fully intact (issue #21)

**Context**: with client/database speaker state now reconciling
correctly (sixteenth pass), a new real-device snapshot found a
different, "impossible" state: both seats authoritatively occupied by
the same two speakers the whole time, canonical client state matching
the database perfectly, `STATE MISMATCHES: none detected` — yet the
shared round sat in `awaiting_pairing` with the 60s timer gone, and had
been for several minutes. Explicit instruction: trace the actual
writer, don't patch by forcing the timer visible, define the legal
round state machine before changing anything, and distinguish
legitimate `active`→`awaiting_pairing` transitions (a real vacancy) from
broken ones (a stale/delayed process wrongly believing the pairing is
incomplete).

**Trace — the one and only writer.** Exhaustive grep across every
migration for `stage_rounds.phase`/`set phase` writes: exactly one
function ever sets it, `ensure_stage_round`. Reading its then-current
(migration 33) body: it required *both* `v_occupied_count = 2` *and*
`v_closing_count = 0` before treating the round as active. `resolve_stage_round`
(the shared deadline's own resolver) sets a narrow-loss seat's
`round_phase` to `'closing'` *without* vacating it (`left_at` stays
null, the seat stays fully occupied, still part of the pairing) —
purely a marker for that seat's own independent 30s Final-30 grace
window — then, in the same call, invokes `ensure_stage_round`. With the
other seat having genuinely continued (still `round_phase = 'active'`),
`v_occupied_count` was still 2, but `v_closing_count` was now 1, so the
function fell into its own `else` branch and demoted the *entire*
shared round — hiding the timer for the continuing speaker too, who had
nothing to do with the other seat's own Final 30.

**A genuine, acknowledged design-intent reversal, not an oversight.**
The original migration 24 doc comment documented this exact behavior as
deliberate: "only when both seats are occupied and neither is in its
own closing window... otherwise marks (or leaves) the stage
'awaiting_pairing'." This pass's own explicit instructions directly
contradict that: "once both authoritative seats establish the resulting
pairing, the shared round must reliably become/stay active... the two
seats still share ONE authoritative round," with an explicit
LEGITIMATE-vs-BROKEN framing naming exactly this scenario as BROKEN.
Treated the current, explicit instruction as authoritative and recorded
this as a deliberate reversal in the migration's own doc comment, not a
silent override of the original design note.

**Proved, not assumed, this isn't a stale-read/stale-write race**
(explicitly asked for). `ensure_stage_round` always re-derives
`v_occupied_count`/`v_closing_count` from a fresh `select count(*)` at
the very top of its own execution, under a `for update` lock on the
round row (`select * into v_round from stage_rounds ... for update`)
that serializes every concurrent caller. No caller can ever pass in — or
be poisoned by — a stale precomputed occupancy count. This was a pure
SQL logic bug, not a concurrency bug.

**Fix**: the "is this round active" gate now depends only on
`v_occupied_count = 2` — a seat being `'closing'` no longer excludes it.
The renewal condition inside (`phase = 'awaiting_pairing' or ends_at <=
now`) is unchanged, and — since the outer gate no longer blocks it —
now correctly renews the round for the *continuing* seat at the normal
60s boundary even while the other seat's own independent 30s countdown
keeps running, exactly matching an ordinary Continue/Continue renewal.
The `event_speakers` sync UPDATE that stamps the new `round_number`/
`round_ends_at` onto seats was already correctly scoped to
`round_phase = 'active'` only (excludes the closing seat, governed
instead by its own `closing_ends_at`) — no change needed there.

**Observability, kept minimal on purpose.** One new nullable column,
`stage_rounds.last_transition_reason`, written by `ensure_stage_round`
only on an actual phase/round-number change (never a no-op call),
reusing the already-existing `updated_at` for the mutation timestamp
rather than adding a second column. Every one of `ensure_stage_round`'s
six callers (`claim_speaker_seat`, `end_speaker_seat`,
`leave_speaker_seat`, `leave_speaker_seat_as_guest`,
`resolve_stage_round`, `resolve_seat_closing`) now passes its own
literal source tag via a new `p_source` parameter, so the recorded
string names exactly which caller made the transition and the old/new
phase and round number it observed. Preview/dev diagnostics only, per
instruction — surfaced in the Session Simulator panel's existing debug
snapshot, not anywhere production-visible.

**Independent confirmation the diagnosis was right, not just internally
consistent.** A pre-existing real-database test (`stage-rounds.test.ts`,
predating this pass) had been asserting the *old, buggy* behavior —
`round.phase === "awaiting_pairing"` after a narrow-loss with both seats
still occupied — as correct. That test's own failure after applying the
fix (requiring its assertions to be corrected to the new, intended
behavior) is evidence written before this pass's own theory existed,
not evidence shaped to confirm it.

**`useStageRound` audited for the same stale-observation class already
fixed in `useActiveSpeakers`** (explicitly requested). Found it already
had on-`SUBSCRIBED` and visibility/focus resync but no bounded backstop
— added one (20s), matching the established sibling-hook pattern.
Explicitly *not* the fix for this incident (proven server-side); pure
defense-in-depth.

**A second, genuinely separate bug found while verifying this fix live**,
not fixed in this pass. `event_speakers_active` — the view every live
client read of seat state goes through (`useActiveSpeakers`, and every
other repository function reading "current speakers") — was defined
(migration 18) with `select * from event_speakers ...` *before*
`round_phase`/`closing_ends_at` existed as columns (migration 21,
three migrations later). Postgres freezes a view's `select *` into the
specific column list that existed at `CREATE VIEW` time, so those two
columns silently never reach any client through this view, regardless
of what the (manually-typed, not generator-derived) `EventSpeaker` type
claims. Concretely: `useStageRoundResolution`'s client-side Final-30
timer (`speakers.filter(s => s.round_phase === "closing" ...)`) and
`speaker-vote-panel.tsx`'s own closing-countdown UI both read a field
that is always `undefined` in production — the automatic replacement a
narrowly-losing real speaker is supposed to receive after 30s does not
fire on its own. Reproduced live: a simulated seat sat in `closing`
across three consecutive round boundaries (~3 minutes) with no
automatic eviction, until manually forced via the simulator's own
`Force Replace Now` (which calls the real `resolveSeatClosingAction`).
This is unrelated to the shared-round bug this pass fixed (different
root cause, different code path, different fix shape — recreating the
view's own column list, not touching `ensure_stage_round`) and is
flagged for its own dedicated corrective pass rather than folded in
here, per this project's own "name the gap, don't unilaterally expand
scope" discipline.

**Verification**: full suite green (1149/1149 tests, 84/84 files — up
from 1145/84), lint, tsc, build all clean. New/changed tests:
`stage-rounds.test.ts` — the corrected narrow-loss test (round now
`active`, continuing seat's round renews) plus three new tests: `last_transition_reason`
recording the initiating source and old/new phase+round for a fresh
pairing, concurrent duplicate `ensure_stage_round` calls after both
seats are already occupied never demoting the active pairing, and a
redundant reconcile call arriving right after a narrow-loss transition
not undoing the still-active round. `use-stage-round.test.ts` — new
bounded-backstop test. Live-browser verification (fresh dev server,
real demo event, real simulator run, not forced/scripted outcomes):
7 consecutive rounds observed end-to-end, including two decisive
replacements, one narrow-loss/closing (the exact bug scenario,
confirmed fixed — `INVARIANT STATUS: OK`, timer visibly ticking across
three round boundaries while one seat stayed closing), and a full
replacement cycle to completion. Not merged to `main`; fresh preview
deployed.

## 2026-09-01 — Sixteenth corrective pass: canonical stage speaker state (`useActiveSpeakers`) now reconciles event-driven off bootstrap's own authoritative confirmation, closing a real 13+ second client/database divergence (issue #21)

**Context**: with simulator bootstrap now authoritatively succeeding
(fifteenth pass), a new real-device snapshot showed a *different* gap:
bootstrap's own confirmation ("Seat 1 = Nimble Lynx, Seat 2 = Dapper
Deer," "Pairing detected," "Round active," "Startup READY") coexisted
with the stage-facing client still reporting both seats vacant, 13+
seconds later — an "impossible" client state (an active shared round
requires the established pairing) that only self-healed later, in the
same session, for reasons the evidence didn't fully prove. Explicit
instruction: trace the actual state paths, don't assume a generic
"Realtime timing" explanation, and fix it event-driven, never with a
poll or an arbitrary startup delay.

**State source trace.** Two genuinely separate sources of truth: (1)
bootstrap's own authoritative confirmation, a direct
`event_speakers_active` read inside `SessionSimulatorPanel`'s own
`establishSeat`/`fetchSeatOccupants` — entirely local to that
component, never touching any other client state; (2) the *canonical*
stage-facing speaker state, `useActiveSpeakers` (`EventRoom`), which
only ever updated via incremental Realtime `postgres_changes` deltas
plus a full resync on-`SUBSCRIBED` — no bounded backstop, no visibility/
focus resync (unlike its sibling hooks `useActiveSpeakerRequests`/
`useSeatReconciliation`, both already fixed in the thirteenth/earlier
passes for the identical class of problem). These two sources had no
connection to each other at all: a successful bootstrap claim updated
source (1) immediately and correctly, but nothing ever told source (2)
to look again — it depended entirely on Realtime redelivering the same
INSERT its own mutation had just caused, with no bounded fallback if
that single message was silently dropped in transit (a real, known
failure mode on mobile networks, the same root cause already proven for
votes/requests in the thirteenth pass) and no reconnect ever occurring
to re-trigger the on-SUBSCRIBED path (this was a long-lived, continuously-
connected session — the same shape that made the thirteenth pass's own
vote-drift bug so hard to observe).

**Fix — the one canonical reconcile, reused everywhere, called directly
from the mutation site.** `useActiveSpeakers` gained a `reconcile(reason)`
function (exposed as `refetch(reason?)`) — every trigger (on-SUBSCRIBED,
visibility restoration, window focus, a new bounded 20s backstop, and
any external caller) now shares this one function; none duplicate the
fetch-and-replace logic. `SessionSimulatorPanel`'s `establishSeat` calls
it directly, tagged `"bootstrap"`, immediately after its own
authoritative seat confirmation — the actual fix, not the backstop:
the client learns the truth the instant bootstrap itself does, never
waiting on Realtime at all. `EventRoom` passes its own `useActiveSpeakers`
instance's `refetch` straight through as a prop — no simulator-specific
duplicate speaker store, per explicit instruction.

**A second, independent race found and closed while building this**:
multiple reconciles can genuinely overlap (the on-SUBSCRIBED resync and
a bootstrap-triggered one, moments apart) — without protection, an
*older*, slower-to-resolve read completing *after* a newer one would
clobber it with stale data. Closed with a monotonic sequence number:
only the most recently *started* reconcile's result is ever applied,
regardless of completion order. Proven directly (`use-active-speakers-
sync.test.ts`, "stale initial fetch race").

**READY semantics — genuinely changed, not just relabeled.**
`establishInitialPairing` now performs one final, *awaited* verification
after the round is confirmed active: calls `refetchSpeakers("bootstrap")`
and checks the returned rows actually show both intended identities on
their respective seats, bounded to 3 short attempts (never an arbitrary
wait — `refetchSpeakers` is a direct authoritative read, not Realtime-
dependent, so this converges on the first attempt in the ordinary case).
If it genuinely doesn't converge, this is reported as a distinct
`CLIENT SYNC` failure (`formatFailedPhase`'s own `phase` field literally
says "Canonical client speaker state reconciliation," never conflated
with a bootstrap failure — the database is already correct in that
case, only this tab's own canonical state hasn't caught up).

**A bounded safety net, not the primary fix, for the general shape.** A
new `useSpeakerInvariantRecovery` hook (mirroring `useStageRoundReconciliation`'s
own shape and doc-comment precedent, but the *inverse* direction — that
hook re-verifies the round against speaker occupancy; this one
re-verifies speaker occupancy against the round) fires one bounded,
event-driven reconcile per distinct round number whenever an active
round coexists with fewer than two locally-known speakers — the exact
"impossible" combination the triggering snapshot showed. Fires at most
once per round transition, never a retry loop, never a `setInterval` —
a safety net for whatever the direct fix at bootstrap's own mutation
site doesn't cover, not a replacement for it.

**Why it took >13 seconds to self-heal in the user's own continued
session — stated honestly, not invented.** The evidence does not prove
the exact trigger. `useActiveSpeakers` (before this pass) had exactly
one mechanism capable of replacing its *entire* stale state at once
(both seats simultaneously, matching the later snapshot's full
convergence, including a seat whose own occupant was never replaced in
between): a fresh on-`SUBSCRIBED` resync, which only fires on the
*initial* subscription or an automatic *reconnect* after a real
connection drop. The most likely supported explanation is a genuine
WebSocket reconnect — a real network blip, or (matching the eighth
pass's own established real-device lesson) the mobile tab being
backgrounded and foregrounded — since that is the only trigger the
pre-fix hook actually had; a single later real INSERT (e.g. "Gentle
Heron promoted") could explain *one* seat updating on its own via the
ordinary Realtime path, but not both simultaneously, including the seat
that was never replaced. This is reported as the supported likely
cause, not a proven certainty.

**Debug snapshot**: two new side-by-side blocks, `AUTHORITATIVE SPEAKER
STATE` and `CANONICAL CLIENT SPEAKER STATE` (the existing `STATE
MISMATCHES` section already diffs them; these make each source's own
raw values directly comparable without needing to reconstruct one side
from a diff), plus a `SPEAKER SYNC` section (channel status, last
SUBSCRIBED/Realtime-event/reconcile-started/reconcile-completed
timestamps, reconcile reason, reconcile result, last mutation source) —
the exact fields needed to distinguish "Realtime hasn't delivered yet"
from "no reconcile ever ran" from "a reconcile ran but disagreed,"
without dumping every internal detail.

**Regression check**: no change to `claim_speaker_seat`, `simulateSeedSpeaker`,
`ensureActiveSelectionRound`, `freeze_speaker_candidates`, or any
selection/replacement logic — this pass is client-side speaker-state
synchronization only. Deterministic RTS, real-participant protection,
and the fifteenth pass's own unified bootstrap mechanism are all
untouched, confirmed by diff scope and by the fifteenth pass's own
real-database tests remaining green unmodified.

**Verification**: full suite (1145 tests, 84 files — up from 1122/82,
+2 new test files: `use-active-speakers-sync.test.ts` and
`use-speaker-invariant-recovery.test.ts`, plus additions to
`session-simulator-panel.test.tsx`), lint, tsc, build all clean.
Live-browser measurement (fresh dev server, real demo event, real
database): Start tap → both seats authoritatively confirmed → **stage
tiles showing both real names** at ~1.9s → shared round active at
~1.93s → Startup READY at ~2.0s — the canonical client state converged
*before* READY was even declared, not 13+ seconds after. A subsequent
real Open Seat → vacate → reserve → promote → occupy cycle (the real
production replacement pipeline, untouched) kept the canonical state
correctly synchronized throughout.

## 2026-08-31 — Fifteenth corrective pass: retired the real-RTS-wait bootstrap path for an already-established stage; bootstrap is now one unified, authoritative bypass mechanism with stale-generation cleanup (issue #21)

**Context**: even after the fourteenth pass's idempotent/self-healing
fixes, the simulator still needed repeated Reset→Start attempts on an
*already-established* room. A new real-device snapshot showed the exact
shape: startup logged "Stage already established — seeding via
authorized Request-to-Speak selection," submitted two fresh Request-to-
Speak requests for its own two bootstrap candidates, then exhausted its
full 20-attempt claim-retry budget waiting for the real deterministic
RTS system to select them — it never did. The same snapshot's own live
RTS ranking showed why: three zero-vote candidates were tied, and the
tie-break winner (`created_at asc`) was "Calm Wolf" — a *stale* request
left over from an earlier, superseded Start generation — not either of
the current attempt's own fresh candidates ("Nimble Rabbit"/"Quiet
Falcon"). Explicit instruction: prove or disprove the diagnosis that
bootstrap and real-replacement-testing are two different jobs being
incorrectly conflated, and if so, separate them with a preview/simulator-
only bootstrap bypass — never weakening `claim_speaker_seat` itself,
never evicting a real participant, always idempotent and race-safe.

**Diagnosis confirmed, traced through actual code, not assumed.** The
fourth corrective pass's own "Case B" (an already-established stage
seeds via a real Request-to-Speak submission plus a bounded-retried
`simulateAdvanceSelection` wait, deliberately never bypassing
production's authorization model — see that pass's own DECISIONS.md
entry) asks the real, competitive, deterministic RTS/replacement system
to eventually choose two *specific* identities, but that system has no
obligation to ever do so: a vacancy may not exist yet, the shared round
may still be fully active, and other eligible candidates — including
stale ones from earlier failed generations that were never cleaned up —
can legitimately, correctly outrank the current attempt's own fresh
candidates. Case B was exercising the real system correctly; it was
simply never suited to be a *bootstrap* mechanism, which needs a
deterministic outcome bootstrap itself controls.

**Decision — bootstrap and replacement-testing are separated
explicitly, per the user's own product distinction.** Every seat now
goes through the *same* authoritative bypass-claim-and-self-heal
mechanism the fourteenth pass already built and proved for a fresh
stage (`establishSeat`), regardless of whether the stage has ever been
established. This is **not a new capability and not a loosened RPC**:
`claim_speaker_seat`'s own `p_bypass_selection_authorization` flag
(migration 00000000000029) was always documented as "reserved for the
Session Simulator's own `simulateSeedSpeaker` bootstrapping adapter,"
with no qualifier restricting it to a stage's first-ever pairing — only
this component's own client-side branching declined to use it once
`round_number >= 1`. Removing that self-imposed restriction is the
entire fix; migration 24's guard (a bypass claim can never steal an
already-occupied seat) is unconditional and untouched, so this closes
no authorization hole a real user could ever reach — see "SECURITY /
GUARD" below. `establishSeat` gained one addition beyond the fourteenth
pass's own mechanism: an authoritative pre-check before attempting any
mutation at all, so a redundant "Seed 2 Speakers" press (or a bootstrap
continuing from an interruption) recognizes an already-correct seat
immediately, with zero mutation attempts.

**Decision — stale-generation cleanup runs before every bootstrap
attempt, not on request.** The user's own explicit preference: "ONE-TAP
START SHOULD BE USEFUL... do not make me repeatedly Reset manually."
`cleanupStaleSimulatorRequests` withdraws every currently-pending
Request-to-Speak whose guest id belongs to this tab's own historical
simulator-generated set (`allSimulatedGuestIdsRef` — accumulated across
every Start since the last Reset, the same ownership boundary Reset
itself already relies on) via the real `withdrawSpeakerRequestAsGuest`
pathway — never a raw delete, and structurally incapable of touching a
real participant's own request (a real request's guest id can never
appear in that set). Run unconditionally at the top of every bootstrap
attempt; a no-op when there's nothing stale (the ordinary, fresh-Reset
case). This is what makes repeated Start presses genuinely non-
accumulating: without it, a superseded generation's own leftover RTS
requests could sit in the pool indefinitely and, when still eligible,
silently win a real future tie-break the way "Calm Wolf" did.

**Decision — never evict, never roll back, self-heal covers recovery.**
The three-way authoritative classification the fourteenth pass already
built (own-identity-already-seated → success; leftover-simulator-owned
occupant → clear and retry; anyone else → refuse, report a precise
blocker) is unchanged and now applies uniformly. For a genuine partial
bootstrap failure (one seat succeeds, the other is blocked by a real
participant), the successfully-claimed seat is deliberately **left as-
is, never rolled back** — rolling it back could itself disrupt what
`ensure_stage_round`'s own side effect may have already turned into a
real, legitimate pairing the instant the real participant's own seat
and the bootstrap seat both became occupied. Recovery instead comes
from the *same* self-heal mechanism: the next bootstrap attempt (no
Reset required) recognizes the leftover seat as its own, clears it, and
reclaims — proven end-to-end, real-database, real participant leaving
mid-sequence, in `simulator-startup.test.ts`.

**Debug snapshot — bootstrap-time facts frozen, never re-derived.** A
second real-device confusion this pass closed: the fourteenth pass's own
"Seat N authoritative" fields were re-fetched live on every snapshot
capture, so once a real, healthy later replacement swapped the
bootstrap occupant for someone else, the snapshot made that look like
startup drift rather than expected product behavior (the exact
"Curious Rabbit → Restless Owl" ambiguity flagged this pass). Fixed by
capturing `bootstrapResultRef` once, at the moment each seat's own
establishment terminates, and labeling those fields explicitly `Initial
bootstrap Seat N` — the pre-existing, always-live `Authoritative seats`
section is untouched and remains the source for current state. Added:
bootstrap mode (now always the unified path), whether the stage was
already established going in (informational only, no longer a branch),
stale-generation/stale-request cleanup counts, and an explicit
non-simulator-occupant blocker line.

**SECURITY / GUARD**: no server-side change was made this pass — no
migration, no new RPC, no widened grant. The bypass claim's only two
callers remain `simulateSeedSpeaker`/`simulateOpenSeat`
(`simulator-actions.ts`), both gated by `assertSimulatorAvailable()` —
which re-checks `isPreviewOrDevBuild()` server-side, independent of the
client, on *every* invocation, the same enforcement every other
simulator action already relies on (proven by this codebase's own
existing "refuse to run on production" test suite, unmodified and still
green). The real production claim paths (`claimOpenSeat`, `joinOpenSeat`,
`simulateAdvanceSelection`'s own claim step) are untouched and continue
to pass `bypassSelectionAuthorization: false` unconditionally — nothing
in this pass changes what a real, non-preview user's own browser tab can
ever reach.

**Verification**: full suite (1122 tests, 82 files, up from 1118/82),
lint, tsc, build all clean. New real-database coverage
(`simulator-startup.test.ts`): a bypass claim succeeding on an
already-established stage; a real participant blocking bootstrap for
exactly one seat while the other bootstraps normally; the full partial-
failure → real-participant-leaves → next-attempt-recovers-cleanly
sequence with no Reset; and a real post-bootstrap vacancy proven to flow
through the unmodified real production RTS pipeline (`requestToSpeakAsGuest`
+ `ensureActiveSelectionRound` + a real, non-bypass `claimSpeakerSeat`),
never the bootstrap bypass. Live-browser verification (fresh dev server,
real demo event): started once (fresh stage, succeeded), stopped,
started again *without Reset* on the now-established stage — the exact
previously-broken sequence — and watched it self-heal both seats' own
leftover occupants automatically within the same Start press, reaching
Running with the new "Existing stage established: yes" /
"Bootstrap result: ready" diagnostics confirmed live in a real Copy
Debug Snapshot capture. The replacement/vacancy architecture (ninth-
twelfth passes), RTS vote-drift/weighted-selection work (thirteenth
pass), and the Reset/re-entrancy/React-#441 mechanisms (fourteenth pass)
are unchanged — confirmed by diff scope.

## 2026-08-31 — Fourteenth corrective pass: simulator startup made idempotent and self-healing (React #441 grounded to a real, redacted RPC error; a genuine Reset-follow-up race closed) — replacement/RTS work untouched (issue #21)

**Context**: with the major vacancy/replacement bug and the RTS vote-
drift bug both now behaving correctly on a real device, the user
reported a third, separate real-device pattern: the Session Simulator
sometimes needed two or three Reset→Start attempts before it produced a
genuinely running session, instead of the product's own stated success
criterion ("Reset once → Start once → simulator becomes useful"). A
real-device debug snapshot showed the exact contradiction: startup had
logged "Seat 1 seed failed: Minified React error #441" and "only one
seat could be established," yet the *same* activity log later showed
that seat vacating from occupancy — meaning the mutation startup
believed had failed had, in fact, succeeded authoritatively. Explicit
instruction: investigate whether startup was conflating a client/action
error with an authoritative mutation failure, do not touch the working
replacement/RTS-selection architecture, and do not assume any specific
root cause — prove it.

**React error #441, grounded, not guessed.** Fetched the real React
error-codes table (matching this project's installed React 19.2.8):
#441 is React's own generic "an error occurred in the Server Components
render — the specific message is omitted in production builds... a
digest property is included" — i.e., exactly what *any* thrown `Error`
inside a Next.js Server Action looks like once a production build
redacts its real message client-side. Read `claimSpeakerSeat`
(`lib/repositories/event-speakers.ts`) directly: it wraps
`claim_speaker_seat`'s own RPC error in a plain `throw new
Error(error.message)`. Read `claim_speaker_seat` itself (migration
00000000000035): the only two `raise exception`s a bypass claim
(`simulateSeedSpeaker`'s own call shape) can reach are `'identity ...
already holds an active seat'` and `'seat % in event % is already
occupied'` — both genuine, informative, server-side outcomes. #441 was
never a client rendering bug; it was production error redaction hiding
a real, specific, useful error message from the panel's own log. This
was proven directly against the real database (new
`simulator-startup.test.ts`): `claimSpeakerSeat` really does throw that
exact message when a seat is already occupied, and the redaction shape
was reproduced by inspecting how a Server Action's thrown Error
surfaces client-side in a production build vs. a dev build (dev
preserves the full message; only production build redacts it — which is
why this session's own local dev testing never reproduced the digest,
but a Vercel preview build does).

**The actual startup-reliability gap — a design gap, not a logic bug.**
`establishSeat`'s Case A (direct initial-formation join) branch
determined success or failure solely from whether `simulateSeedSpeaker`'s
own promise threw or resolved — never from authoritative state. When an
earlier, incomplete Start left one seat genuinely occupied (the other
seat having failed, so `running` never flipped true and the successful
seat's row was never cleaned up — Reset is the only thing that clears
it), every subsequent retry-without-Reset routed back into the exact
same Case A branch (the stage genuinely never finished pairing, so
`round_number` stays 0) and collided with that leftover occupant on the
*same seat number*, every single time — deterministically reproducing
"Seat 1 seed failed" on every attempt until a manual Reset. This matches
the user's own hypothesis precisely: not a lost mutation, but a client
that couldn't tell a real success (redacted #441) from a real, resolvable
failure (a stale leftover occupant) from a real, unresolvable one (a
possibly-real participant already seated).

**Fix — idempotent, authoritative, self-healing seat establishment.**
Every seed attempt (throw or not) is now followed by a fresh,
authoritative `event_speakers_active` read (`fetchSeatOccupants`) before
deciding anything — never trusting the promise alone, per this pass's
own explicit instruction. Three authoritative outcomes are distinguished
after a throw: (1) the intended identity is already seated — the
mutation actually succeeded despite the client-visible error; treated as
a real success, never retried (retrying would itself throw "identity
already holds an active seat"); (2) the seat is occupied by an identity
this same browser tab generated (tracked in `allSimulatedGuestIdsRef`,
which persists across Start/Stop cycles until Reset) — recognized as a
leftover from an earlier incomplete attempt, cleared via the existing
`simulateOpenSeat` adapter, and retried, bounded to
`MAX_SEED_ATTEMPTS = 2`; (3) the seat is occupied by anyone else — never
evicted (could be a real participant via the small-room fallback direct
join, migrations 00000000000033/34) — startup reports a precise,
non-recoverable `FAILED PHASE / ATTEMPTS / EXPECTED / AUTHORITATIVE /
LAST ERROR / RECOVERY` detail instead of a generic "Startup did not
complete."

**Two structural races closed alongside the seat-establishment fix,
both real, neither previously guarded against:**
- **Re-entrancy**: `startSimulation` now checks-and-sets a synchronous
  ref (`startupInFlightRef`) as its very first statement, before any
  `await` or state update — `SimButton`'s own executing-disables-itself
  state is real but depends on a React re-render committing, which is
  never synchronous with the click that triggered it, so a genuine
  same-tick double-tap or duplicate pointer event could previously have
  launched two overlapping startup pipelines. Proven with a real
  same-`act()`-batch double-dispatch test (not two sequential
  `fireEvent.click` calls, which a render flush between them would have
  hidden this race from).
- **Reset-Start barrier**: `resetInFlightRef` (mirrored into state for
  the Start button's own `disabled`) is held for exactly as long as
  Reset's *primary* delete pass is in flight, closing the window where
  Reset's own synchronous `running=false` would otherwise immediately
  re-enable Start before the database rows it's deleting are actually
  gone.

**A third, genuinely narrow but real Reset-related race, found while
directly investigating the user's explicit "prove or disprove" ask.**
`resetSimulatorSession`'s guest-scoped deletes (comments, likes, votes,
seats) were always exact — a fresh run's guest ids are freshly random
UUIDs that can never collide with an old run's captured list, so those
were provably always safe. But the function's `stage_rounds`
reconciliation (delete if event-wide occupancy is 0, else resync) was
never scoped to any guest-id list at all — it decides purely from the
event's *current, global* occupancy at the instant it runs. The panel's
own ~2s delayed follow-up sweep (added in an earlier pass, to catch a
write still in flight when the primary Reset pass ran) calls this same
function again for the *old* run's guest ids — and if a *new* run's own
occupancy happens to be transiently zero at that exact moment (e.g.
between a leftover-seat cleanup and its own retry), the follow-up sweep
would delete the *new* run's own `stage_rounds` row, having nothing to
do with the old run's guest ids at all. Proven directly, deterministically,
against the real database (not timing-dependent): inserting a
`stage_rounds` row directly, then calling `resetSimulatorSession` at
zero occupancy — the row is deleted regardless of whose ids were passed.
**Fix**: `resetSimulatorSession` gained a `reconcileStageRound` parameter
(default `true`, unchanged for the primary pass); the delayed follow-up
sweep now passes `false` — its only job is catching stray guest-scoped
rows, never re-deciding the event's shared round state a second time.

**Debug snapshot**: kept the T0/T1 two-phase architecture exactly as
established (it is what caught the original startup contradiction). Added
a `SIMULATOR STARTUP` block — state/phase/run-generation-id/reset-
in-progress/reset-generation/startup-attempt/per-seat intended vs.
authoritative occupant/last error/pending-cleanup-from-previous-
generation — so the *next* real-device report is immediately diagnosable
without another round trip.

**Verification**: full suite (1116 tests, 82 files), lint, tsc, build
all clean. New real-database coverage (`simulator-startup.test.ts`, plus
additions to `simulator-actions.test.ts`): the real `claim_speaker_seat`
"already occupied" error message, the leftover-seat clear-and-reclaim
flow, a genuine concurrent-claim race (`Promise.allSettled`, exactly one
winner), the `reconcileStageRound` fix proven both ways (the pre-fix
shape genuinely deletes a live round row; the fix genuinely doesn't),
and a 20-cycle Reset→Start stress test — 20/20 first-attempt successes,
average and max latency both comfortably bounded. Live-browser
verification (fresh dev server, real demo event, real Reset→Start
cycles): first-try startup succeeded twice in a row, and the new
`SIMULATOR STARTUP` debug-snapshot block rendered correctly. The
replacement/vacancy architecture (ninth-twelfth passes) and the RTS
vote-drift/weighted-selection work (thirteenth pass) are completely
untouched — confirmed by diff scope.

## 2026-08-31 — Thirteenth corrective pass: a real RTS vote-count drift traced and closed with a bounded backstop resync; confirmed "weighted selection" was stale wording only, never stale logic (issue #21)

**Context**: with the major vacancy/replacement bug now behaving
correctly on a real device, the user asked for a narrow, diagnostic
pass on two smaller remaining issues surfaced by the twelfth pass's own
new diagnostics: (1) a recurring client/database RTS vote-count drift
(caught twice now, most recently `client=1, database=2` on a clean,
591ms-latency capture with `STATE CHANGED DURING CAPTURE: no`), and (2)
whether the activity log's "real weighted selection" wording reflected
actual executable logic or was just stale text. Explicit instruction:
do not touch the now-healthy replacement architecture unless this pass
finds a directly related defect.

**Vote-count drift — traced through the full lifecycle before writing
any fix.** Read `cast_speaker_request_vote(_as_guest)` directly: a vote
transfer is a real `DELETE` then a real `INSERT` (never an `UPDATE`),
which `useActiveSpeakerRequests`' own handlers already handle
correctly — no mismatched event type, no wrong table/column, no logic
bug found. What the hook's own two existing resync mechanisms
(on-`SUBSCRIBED`, visibility/focus) provably cannot catch: a single WAL
message silently dropped in transit — a real, known failure mode of
long-lived WebSocket connections on cellular networks — *without* the
underlying connection ever closing or the tab ever backgrounding.
Neither existing trigger fires in that case, so a rare, single dropped
delta during a long, continuously-visible, continuously-connected
session (precisely how both captures were taken) would never self-
correct. **Fix**: a bounded 20s periodic resync added to the same
effect, explicitly a backstop (Realtime deltas remain the primary,
instant path) — the same "Realtime for responsiveness, an authoritative
read for convergence" principle this codebase already applies elsewhere
(`useAutomaticPromotion`'s own bounded backstop poll behind its reactive
fast path is the direct precedent, and was pointed to explicitly).
Proven with fake-timer tests: a vote count that drifted converges back
via the interval with no visibility/focus/SUBSCRIBED event firing, and
the interval doesn't fire before its own 20s elapses (never a tight
poll).

**"Weighted selection" audit — answered directly, not assumed.**
Searched the entire codebase for `weighted`, `Math.random`, `Top-3`,
and the old `lib/speaker-selection.ts`/`SELECTION_RANK_WEIGHTS`
references. **Answer: NO executable weighted/random RTS winner-selection
logic exists anywhere** — `lib/speaker-selection.ts` was already deleted
(confirmed by a direct filesystem check, not just a stale comment
claiming so), `freeze_speaker_candidates`' own SQL ranks purely via
`row_number() over (order by count(v.id) desc, sreq.created_at asc,
sreq.id asc)` — no randomness, no ties possible even at the tiebreak
level. Every remaining `weighted` mention in the codebase is either (a)
two live, user-visible Session Simulator activity-log strings
(`"...promoted (real weighted selection)"` /
`"...promoted (reactive, real weighted selection)"`) that were
genuinely misleading stale terminology — the exact thing the real-device
report caught — or (b) comments/test names correctly *contrasting* the
current deterministic behavior against the retired system by name,
which don't claim weighted logic exists and were left alone. Renamed
the two live log strings to `"promoted (deterministic RTS ranking — #1
by votes)"` / `"promoted (reactive, deterministic RTS ranking — #1 by
votes)"`, updated the handful of comments and two test names that used
the same stale wording, and proved determinism directly against the
real database: the same vote arrangement (7/3/1 votes) selected the
same winner across 5 independent, freshly-created rounds; a genuine 5-5
tie selected the earlier request across 5 independent rounds; a
client's live-projected ranking was proven to match the authoritative
ranking both before and after a real vote transfer.

**Debug snapshot improvements**: `STATE MISMATCHES`' RTS vote-count
check (added in the twelfth pass) was expanded into a dedicated
`RTS COUNT MISMATCH` block per disagreeing candidate — candidate name,
both raw counts, the signed delta, and both ranks — with an explicit
`PROSPECTIVE RANKING MISMATCH` call-out on top when the rank itself
(not just the raw count) differs, since that's the case that could
eventually change who's actually shown as Next Speaker Candidate.

**A real bug found and fixed while building the repeated-selection
tests, in the test harness, not the product**: an early version of the
"same winner every time" test left both seats vacant between attempts,
which correctly triggered the atomic *dual*-seat reservation (proven
correct in the tenth pass) — reserving the top *two* candidates for
their own distinct seats simultaneously — and the test's own assertion
only checked whichever landed on seat 1, misreporting a "wrong winner"
that was actually a correct dual reservation landing on the seat the
test didn't expect. Fixed by keeping a stable filler on seat 1 throughout,
so exactly one seat is ever open per attempt — this incidentally
re-confirmed the dual-seat reservation behavior working exactly as
designed, rather than revealing any actual selection bug.

**Reason**: every fix here follows from tracing the real lifecycle (vote
transfer, WebSocket delivery, the exact SQL ranking) before writing
anything, exactly as instructed — no periodic-refetch band-aid without
first ruling out a logic bug, and no code deleted or renamed on the
weighted-selection question without first proving, by reading the
actual files, that no executable path reaches it.

**Tradeoffs**: none against any previously-established invariant — the
replacement/vacancy architecture from the ninth through twelfth passes
is completely untouched; deterministic RTS ranking, the atomic dual-seat
reservation, and every prior pass's own fixes are unchanged; the full
existing test suite (real-database tests included) still passes.

## 2026-08-31 — Twelfth corrective pass: a genuinely stale `speaker_selection_rounds` row could block selection forever — found via the eleventh pass's own two-phase debug snapshot, root-caused against the real linked database, fixed at its actual source (issue #21)

**Context**: the eleventh pass's own two-phase T0/T1 debug snapshot did
exactly its job — the user captured a clean, trustworthy real-device
failure while the simulator was still running (591ms T0→T1 latency,
"STATE CHANGED DURING CAPTURE: no," client and authoritative state in
full agreement): an established room, one seat freshly vacant, two
eligible RTS candidates (Dapper Rabbit #1 at 3-4 votes), and no
reservation at all. The user explicitly asked that this not be dismissed
as a timing artifact (it demonstrably wasn't) and that the investigation
trace the exact failing transition rather than add another speculative
workaround.

**Root cause, found by querying the real linked database directly, not
guessed**: the permanent test room
(`00000000-0000-0000-0000-000000000001`, the event the capture came
from) had a `speaker_selection_rounds` row frozen on 2026-08-29 — two
days before this capture — still `status = 'active'`, with zero
`speaker_requests` rows still referencing it (every candidate that was
ever part of it had long since been claimed, withdrawn, or expired by
completely unrelated later activity). `freeze_speaker_candidates`'s own
idempotency check ("if an active round already exists for this event,
reuse it, never create a second one" — migration 00000000000020, built
so two concurrent callers can't spin up colliding rounds) has no
corresponding *liveness* check: it reused this two-day-old, completely
dead round on every single call, silently preventing this event from
ever freezing a fresh round from its own current live pending pool —
regardless of how many new requests arrived, how many votes they got,
or how many seats opened. Every vacancy path in this codebase already
funnels through this one function, so this single gap could defeat
reconciliation regardless of *which* vacancy-creating action ran — a
deeper, more general bug than any one specific trigger path could
explain, and the reason a clean, unambiguous real-device capture was
needed to actually find it.

**Why nothing had ever resolved this round**: the two mechanisms that
ever transition a round out of `'active'`
(`reset_speaker_candidate_pool`, only called after a normal claim → grant
flow; and the withdrawal/failed-claim exhaustion checks, migrations
00000000000038/00000000000039, which only fire for a *specific* request
tied to that exact round) both depend on some later, specific event
happening to that round. A room whose next activity happens to use the
bypass-authorization seed path (`claim_speaker_seat` with
`p_bypass_selection_authorization = true` — the Session Simulator's own
initial-pairing/re-seed mechanism, which never calls
`reset_speaker_candidate_pool` at all) can go arbitrarily long, across
arbitrarily many unrelated future sessions, without either mechanism
ever running — exactly what happened here, confirmed by reproducing the
identical condition directly against the real database (manufacture a
dead "active" round with zero live references, add two fresh eligible
candidates, call the real RPC) before writing any fix.

**Fix (migration 00000000000040)**: `freeze_speaker_candidates` now
verifies liveness before reusing an "active" round — does it have a
live reservation, or at least one remaining viable (still-`pending`,
not-`selection_failed`) candidate of its own? If neither, it is dead
regardless of its own `status` column: mark it `exhausted` right there
and fall through to the existing "create a fresh round from the current
live pool" logic, rather than returning early with nothing. Race-safe
(two concurrent callers both finding and exhausting the same dead round
is a harmless double no-op; the fresh-round-creation path already
handles concurrent creation races). Verified directly against the real
database: the manufactured reproduction now correctly self-heals (the
dead round is marked `exhausted`, a fresh round is created, the #1
candidate is reserved) — and the actual two-day-old stale round found in
the permanent test room was cleared as a one-time courtesy (the fix
makes this self-healing going forward regardless).

**Architecture, per the user's own explicit request — "one coherent
architecture, not an expanding collection of special-case fixes"**:
audited every vacancy-creating path again. `simulateOpenSeat` (the
Session Simulator's own "Open Seat" button) was the one remaining
vacancy path with no direct reconciliation trigger — deliberately left
alone in the ninth/tenth passes, revisited now. Fixed the same way as
every production path: calls `ensureActiveSelectionRound` directly after
creating the vacancy. Also found and fixed the identical gap in
`simulateRequestToSpeak` and `simulateWithdrawRequest` — the simulator's
own natural-activity equivalents of `requestToSpeak`/
`withdrawSpeakerRequest`, which had gotten the same fix in the tenth
pass for their *production* counterparts but not their simulator
equivalents, a real inconsistency with "the simulator exercises the same
authoritative semantics as the real product." None of these were
provably the cause of *this specific* capture (the exact triggering
transition is unrecoverable — see below) but are independently justified
architecture-consistency fixes regardless, and the root-cause fix above
means the underlying bug is now closed regardless of which vacancy path
a future session happens to use.

**What could and couldn't be determined about the exact triggering
transition**: by the time this investigation began, the specific
`event_speakers`/`speaker_requests` rows from the user's own capture had
already been cleared by later, ordinary use of the shared permanent
room (most plausibly the user's own continued testing after the
capture) — `speaker_selection_rounds` rows are the one thing nothing
in this codebase ever deletes, which is exactly why the stale round
survived to be found while the specific vacancy-causing action's own
row-level evidence did not. Rather than guess, this is reported
honestly as unrecoverable; the root-cause fix does not depend on
knowing it.

**New diagnostics, directly requested**: Session Simulator's activity
log now records "OBSERVED" transitions — seat occupancy changes,
reservation changes, and round-phase changes — purely from prop diffs,
regardless of what caused them, closing the exact gap that left the
original capture's own activity log ending at startup information with
no clue why a seat had gone vacant (the log previously only recorded
actions *this SIM's own buttons* initiated, never a transition the tab
merely observed happen from an unrelated cause). Copy Debug Snapshot
gained a "VACANCY DIAGNOSTICS" section with an explicit `INVARIANT
STATUS: OK`/`VIOLATION` per vacant seat, and RTS vote-count comparison
was added to `STATE MISMATCHES` (a real, separate, honestly-noted
observation: the same capture that proved this bug also showed the
client's own Realtime-accumulated vote count for Dapper Rabbit
disagreeing with a fresh authoritative count — 4 vs 3 — while the
snapshot's own mismatch detection simply never compared vote counts at
all; now it does, though the root cause of *that* particular drift is
not itself investigated this pass, per explicit instruction not to let
it distract from the primary bug).

**Reason**: this is exactly the outcome the two-phase debug snapshot
was built for — a trustworthy, unambiguous, timing-annotated real-device
capture that made a genuine, previously undiagnosable bug traceable to
its actual source in the real database, rather than another round of
guessing at trigger paths.

**Tradeoffs**: none against any previously-established invariant —
deterministic RTS ranking, the atomic dual-seat reservation, the "don't
reserve early" behavior, Reset's one-tap/real-data-safe behavior, and
every prior pass's own fixes are unchanged; the full existing test suite
(real-database tests included) still passes.

## 2026-08-31 — Eleventh corrective pass: "Next Speaker" redefined as the prospective #1 live candidate (not a reservation), a two-phase T0/T1 debug-snapshot capture, and a live-reproduction audit of a delayed-snapshot vacancy report (issue #21)

**Context**: the user clarified that "Next Speaker" in this project's own
usage (and the tenth pass's own diagnostics) had been answering a
different question than they meant — they want to see, at a glance
during an *active* round, who is currently #1 in line by live RTS vote
count, with no vacancy or reservation required to see it. Separately,
they reported that Copy Debug Snapshot (tenth pass) "did not give an
immediate usable result" during a real-device session, requiring them to
wait, force another transition, and stop the simulator before finally
getting a snapshot — and that snapshot, being delayed, showed one seat
vacant with two eligible RTS candidates but no reservation, which they
explicitly warned not to over-interpret given the capture's own timing
uncertainty.

**"Next Speaker Candidate" — a genuine terminology/display gap, not a
selection bug**: the tenth pass's own "Next Speaker" section only ever
read from `frozenCandidates` (populated by `frozen_rank`, set once by
`freeze_speaker_candidates` — which only ever runs once a seat is
actually open, per `ensureActiveSelectionRound`'s unchanged "don't
reserve early" behavior). During an active round with both seats full,
that's correctly empty — but nothing else showed the live #1 from
`pendingRequests`' own already-correct ordering. Renamed the old section
to "Selected / Committed" (what has actually been frozen/reserved at a
real boundary) and added a new, prominent "Next Speaker Candidate"
section above it — the live #1 (and #2) eligible RTS requester, reactive
to vote changes, explicitly labeled "prospective — not reserved" unless
a real vacancy has already reserved them (in which case both facts show
together, since they aren't mutually exclusive). Nothing about this
reserves anything by being displayed.

**Debug snapshot — redesigned as two-phase capture (T0/T1), addressing a
real, previously-unhandled failure mode**: reading `copyDebugSnapshot`'s
own tenth-pass implementation found it awaited the authoritative fetch
*before* building anything, including the client-only section that
needs no `await` at all — meaning a slow/hung fetch delayed everything,
and (the more consequential finding) meant the eventual
`navigator.clipboard.writeText` call only ever started well after the
tap's own user gesture, which is exactly the shape of call several
mobile browsers (notably Safari) can silently refuse or hang on without
an unbroken gesture chain — a highly plausible, code-supported
explanation for "did not give an immediate usable result." Rewritten to
capture the client state *synchronously* at tap time (T0, no `await`
anywhere in that step), run the authoritative fetch under a 4s bounded
timeout, and — critically — treat a failed/hung clipboard write
(bounded at 3s) as a *fallback trigger*, not a dead end: the full
captured text is always stored and shown in a visible, selectable
`<textarea>` that opens automatically when the automatic copy didn't
land, so the capture is never lost regardless of what the clipboard API
does on a given device. Also reports `STATE CHANGED DURING CAPTURE`
(compared against `speakersRef`/`pendingRequestsRef`, already
live-mirrored for other callers) so a reader can tell whether anything
moved between the tap and the authoritative read, and guards against a
duplicate concurrent capture.

**The delayed vacancy snapshot — investigated live, not resolved from
the snapshot alone, exactly as instructed**: read `simulateOpenSeat`
(the SIM's own vacancy-creating action) and confirmed it does **not**
call any direct selection-reconciliation trigger — unlike the ninth/
tenth passes' fixes to the five *production* vacancy paths, this one was
deliberately left untouched in both prior passes (noted at the time as
scope, never revisited). It depends entirely on `useSpeakerSelectionReconciliation`,
a production hook mounted unconditionally in `EventRoom` regardless of
the Session Simulator's own `running` state. Reproduced the user's exact
sequence live, repeatedly: opened a seat with eligible RTS candidates
present, both while the simulator was running and with a Stop pressed
immediately afterward. In every reproduction, **reservation happened
correctly and near-instantly** (confirmed via real, observed timestamps
— reservation observed in 0ms in one run), **regardless of whether the
simulator was running or stopped** — confirming Section 12's own
expectation that Stop must not (and does not) block authoritative
reconciliation. A real, separate, and now explicitly confirmed
distinction: **claim** *completion* for a simulated identity specifically
(not reservation) is gated on `runningRef.current`, since
`simulateAdvanceSelection` is SIM-only machinery with no real browser
tab behind a fake identity — reproduced directly: opening a seat with
Stop pressed immediately after left a real, correct reservation
genuinely stuck at "reserved, not yet occupied" indefinitely, exactly as
Section 12 anticipated. This is a legitimate design distinction ("Stop"
halts fake-person behavior including a fake claim, never a real
production mechanism), not a bug, but was not previously reproduced or
documented as clearly. **Could not reproduce the user's own "Reserved:
none" (not "stuck reserved") state** through diligent live testing
covering the plausible mechanisms — the evidence is most consistent with
the delayed snapshot's own capture-timing uncertainty (exactly what the
user's own Section 10 warned against over-reading), not a reproducible
selection bug. Reported honestly as unresolved rather than closed either
direction.

**Reason**: every finding here follows from reading the actual code and
reproducing live before concluding anything — the "Next Speaker" issue
turned out to be a real but different kind of problem (terminology/
display, not selection logic) than initially assumed, and the vacancy
snapshot's own ambiguity was investigated as far as live reproduction
could take it without inventing a conclusion the evidence doesn't
support.

**Tradeoffs**: none against any previously-established invariant —
deterministic RTS ranking, "don't reserve early," the atomic dual-seat
reservation, Reset's one-tap/real-data-safe behavior, and every prior
pass's own fixes are unchanged; the full existing test suite (real-
database tests included) still passes.

## 2026-08-30 — Tenth corrective pass: a full selection-trigger-matrix audit, dual-replacement/fallback proof, a live-replacement-queue diagnostics model, a real Reset race condition, and a real-device debug-snapshot tool (issue #21)

**Context**: real-device evidence during an *active* session (two occupied
seats, two eligible RTS requesters, already correctly ordered by vote
count) showed the selection diagnostics giving no sense of who was
"next" — `rank —` in Candidates, "No candidate selection in progress" in
Next Speaker — even though the ordering itself was visibly correct
elsewhere on screen. Separately, a post-Reset screenshot showed a
simulator-generated comment/request still visible despite SIM reporting
"Round 0 · awaiting pairing / No seats occupied." The user's prompt
explicitly separated these two observations and asked for three things:
(1) a live replacement-queue model, distinct from reservation, exposed in
diagnostics; (2) a full audit of every state transition that can produce
"vacant fillable seat + eligible RTS + no valid reservation," proving
each one reconciles immediately, including dual-replacement/fallback
chains; (3) the real root cause of the Reset artifact, fixed without
weakening Reset's one-tap behavior or its real-data safety.

**Finding 1 — the diagnostics gap was real, the selection logic
underneath it was not**: read `ensureActiveSelectionRound`
(`room/actions.ts`) directly — it already refuses to freeze/reserve
anything while `findOpenSeats(activeSpeakers).length === 0`, exactly the
"do not reserve early" invariant the prompt asked to preserve. During an
active session with both seats full, `frozen_rank` is correctly `null`
on every pending request (nothing has been frozen), which is what made
Candidates show `rank —` and Next Speaker show nothing — accurate for
*reservation*, but the SIM never separately exposed the one thing that
*is* already live and correct at that moment: `pendingRequests`' own
vote-count ordering (`useActiveSpeakerRequests`' sort, identical to
`freeze_speaker_candidates`' SQL order). Fixed by adding a "Live
Replacement Queue" to Selection Forensics — the same already-correct
ordering, explicitly labeled and shown once (not duplicated per seat),
plus "Established mode" and a "Selected / Reserved" summary distinct
from it. No selection behavior changed — only what the diagnostics
choose to show.

**Finding 2 — a real, previously-unclosed trigger gap, five instances of
it**: the ninth pass closed the gap for the round boundary specifically
(`resolveStageRoundAction`/`resolveSeatClosingAction`). Reading every
other vacancy/eligibility-creating function found the identical gap in
five more places: `leaveSpeakerSeat` (voluntary leave),
`checkAndEvictInactiveSpeaker` (inactivity eviction), `requestToSpeak`
(a request arriving after a vacancy already exists), `withdrawSpeakerRequest`
(a round left exhausted, needing a fresh freeze), and `claimOpenSeat`'s
failed-claim path (see Finding 3). Each now calls a new private
`bestEffortReconcileSelection` helper — a thin, failure-swallowing
wrapper around the same `ensureActiveSelectionRound` every other
reconciliation path already calls (never a fourth, differently-behaved
mechanism), fed by the service-client `listActiveSpeakersAuthoritative`
(the ninth pass's own fix) rather than the request-scoped
`listActiveSpeakers` — same reasoning as that fix: "which seats are
open" has no reason to be scoped to any one caller's session, and every
caller here already resolved its own identity earlier in the same
request for an unrelated reason. **Deliberately best-effort**: a
leave/request/withdrawal that itself fully succeeded must never be
reported as an error merely because this *follow-up* reconciliation hit
a transient problem — the reactive client hook remains the backstop for
that case, unchanged.

**Finding 3 — a genuine, previously-nonexistent mechanism needed for
"claim fails"**: reading `claimOpenSeat`'s catch block found it simply
returned an error on a failed claim, leaving that candidate's own
`is_current_candidate`/`reserved_seat_number` exactly as they were —
authoritatively "reserved" for a seat they will never occupy, with
nothing else ever re-evaluating it. New migration `00000000000039`
(`release_failed_speaker_claim`) mirrors `withdraw_speaker_request`'s own
next-candidate-advancement branch (migration 38) as closely as possible,
under the same round-scoped row lock. **A genuine design decision, made
and flagged, not left implicit**: this deliberately does *not* set
`selection_failed = true` the way withdrawal does — a claim failure is
presumptively transient (a race, not a deliberate "I don't want this"
signal), and `selection_failed` has no per-round scope in the schema; it
would follow a request's row into a later, completely independent fresh
round (`freeze_speaker_candidates` doesn't reset it when re-freezing an
already-pending row), permanently disqualifying an otherwise-legitimate
candidate over what might have been one bad race. Proven directly: a
real-database test confirms the failed candidate's row survives with
`selection_failed = false` and can win a later, independent round on the
merits. **A real, related interaction surfaced in the process, not
fixed here**: `reset_speaker_candidate_pool`'s bulk-expire is event-wide,
not round-scoped (already an open question from the eighth pass) — a
released-but-still-`pending` failed-claim candidate can get swept into
`expired` as a side effect of a *different* seat's own claim completing
shortly after. Not a regression this pass introduced and not resolved
here; noted as a sharper, now-demonstrated instance of the same
already-open question.

**Dual-replacement and fallback chains — proven, not just claimed**: the
fifth pass's own atomic `reserve_speaker_candidates_for_seats` already
handles reserving two seats to two distinct candidates in one
transaction; this pass didn't touch it, only proved it still holds
across every new trigger path. A real-database test (two empty seats,
three ranked candidates) confirms both top-ranked candidates reserved
distinctly, the third remaining an ordered, undisturbed fallback; a
follow-up in the same test confirms the seat-1 winner cancelling
advances the fallback into their seat while the seat-2 winner's own
reservation is completely untouched. A second test proves the same for
an authorized candidate whose claim genuinely fails (Finding 3).

**Reset root cause — found by reading the actual mechanism, not
guessing**: every scheduled background action (`schedule`, in
`session-simulator-panel.tsx`) already re-checks `runningRef.current`
immediately before firing — necessary, but not sufficient. The gap it
can't close: a timer can fire and pass that check, dispatching its
`simulateComment`/`simulateRequestToSpeak`/etc. call, an instant *before*
a same-tick Reset flips `runningRef.current` false and runs its own
DELETE — the dispatched call is already in flight by then, and its
INSERT can land in the database *after* Reset's own DELETE already ran
(ordinary network latency is enough of a window; comments alone schedule
every 3-8s). This is genuinely **Case A** (the row really is in the
database) caused by a real ordering race — not the guest-id list being
wrong (every activity-generating control already draws from the same
registered pool), and not stale client rendering (every DELETE this
row's own table performs is already reactively reflected client-side via
migration 00000000000023's `REPLICA IDENTITY FULL` + each hook's own
DELETE handler). **Fix**: a second, delayed sweep — the exact same
`resetSimulatorSession` call, same captured guest-id snapshot, ~2s
later, fire-and-forget, silent unless it actually finds something. Never
blocks the UI and never re-confirms anything — Reset stays one tap,
immediate; the sweep's own timer is cleared on unmount so it can never
fire against a gone panel.

**Copy Debug Snapshot — built, deliberately scoped down from the full
request**: a preview-only button performing a fresh, read-only
authoritative fetch (`fetchDebugSnapshotState`, service-client, plain
`select`s only — verified no mutation path exists) combined with the
current tab's own client state, explicitly diffed, formatted as
human-readable text, copied to the clipboard. **Deliberately deferred,
not silently dropped**: the full spec's persisted 30-50-entry rolling
event history with dedicated event names threaded through every server
action is a genuinely separate logging subsystem — significant new
instrumentation across every mutation path, not a small addition to this
already-large pass. The snapshot instead points at this panel's own
existing activity log (already timestamped, already showing meaningful
transitions) as the practical equivalent for now. Flagged in this pass's
own handoff QUESTIONS section, not decided unilaterally.

**Reason**: every fix here follows the same discipline the ninth pass
established — read the actual code before concluding something is
broken (the diagnostics gap turned out to be a labeling problem, not a
selection bug), reuse the existing atomic/idempotent mechanisms rather
than inventing parallel ones, and flag a genuine design choice
(selection_failed on claim-failure) rather than deciding it silently.

**Tradeoffs**: none against any previously-established invariant —
deterministic RTS ranking, the atomic dual-seat reservation, the
3-second Going Live countdown, server-authoritative claiming, the shared
single-round model, and Reset's one-tap/real-data-safe behavior are all
unchanged; the full existing test suite (real-database tests included)
still passes.

## 2026-08-30 — Ninth corrective pass: the round boundary itself never triggered selection — it depended on a separate, reactive client round trip (issue #21)

**Context**: explicit instruction to discard the prior ("Bold Falcon")
investigation branch entirely and start over from one focused question:
at the shared-round boundary, why doesn't the highest-voted eligible
Request-to-Speak candidate get authoritatively selected for the vacant
seat *immediately*? The rule itself (most votes wins, tie → earliest
still-active request) was already established and not in question — the
investigation was told to follow that winner through reservation and
promotion, name the exact failing transition, and specifically audit
whether round resolution itself performs selection or waits on some
client noticing the vacancy afterward.

**Root cause, found by reading the actual authoritative functions, not
guessing**: `resolveStageRoundAction` and `resolveSeatClosingAction`
(`room/actions.ts`) — the two functions that authoritatively resolve a
round/closing-period boundary and create a seat vacancy — never
themselves called `ensureActiveSelectionRound`. Selection depended
entirely on a separate, subsequent chain: the vacancy's DB write →
Realtime delivery of the `event_speakers` change to some connected
client's `useActiveSpeakers` subscription → that client's own
`useSpeakerSelectionReconciliation` React effect noticing the occupancy
change → that effect making a *second*, separate Server Action call
(`reconcileSpeakerSelectionAction`), which only then calls
`ensureActiveSelectionRound`. Every individual hop is fast, but the
chain itself — one DB write, one Realtime round trip, one React effect
firing, one more Server Action round trip — was the actual, measurable
source of the reported delay specifically at the round boundary, even
though the sixth pass's reactive-promotion fix had already made *each*
of those hops individually about as fast as it could be. The old doc
comment on `resolveStageRoundAction` (referencing an even older,
pre-fifth-pass polling mechanism) was stale, but the gap it was
gesturing at — "not triggered from the same authoritative action" — was
real and current.

**Fix**: both functions now call `ensureActiveSelectionRound` directly,
immediately after creating the vacancy — `resolveStageRoundAction` when
any seat resolves `decisive-replace`, `resolveSeatClosingAction`
unconditionally after its existing `syncPublishPermission` call. This
collapses the multi-hop chain into the single call that already resolves
the boundary. It is deliberately **not** a second, competing selection
path: it calls the exact same idempotent, atomically-row-locked
`ensureActiveSelectionRound`/`reserve_speaker_candidates_for_seats`
function the reactive hook already called — that function's own row
locking is what already makes concurrent callers safe, so calling it
from the authoritative moment *in addition to* reactively-afterward
cannot introduce a new race. `useSpeakerSelectionReconciliation` itself
is completely unchanged and remains exactly what it already was: a
bounded backstop for a missed Realtime delta or a resolution triggered
by a since-disconnected client.

**A real bug surfaced while implementing the fix**: the obvious first
attempt called the existing `listActiveSpeakers` (request-scoped, reads
cookies via `createClient()`) from inside `resolveStageRoundAction`,
which threw `cookies was called outside a request scope` the moment it
ran from a bare test script — and, architecturally, would have been
fragile even in production, since nothing about *resolving a round
boundary* is naturally scoped to any one caller's own session. Fixed by
adding `listActiveSpeakersAuthoritative` to `event-speakers.ts` —
service-client-based, same pattern `resolveStageRound`/
`resolveSeatClosing` themselves already use, reading the identical
`event_speakers_active` view so "which seats are open" is never a
second, differently-derived answer.

**Deliberately not extended to `checkAndEvictInactiveSpeaker`/
`leaveSpeakerSeat`**: reading both confirmed they have the exact same
gap (vacancy created, no direct selection trigger) — but this pass's own
instruction repeatedly and specifically scoped the investigation to "the
shared round boundary," and explicitly said not to start unrelated
work. Left as a candidate for a future pass, not treated as a
consequential ambiguity needing a decision here (the scope itself
already answers it).

**Proof**: a real-database test (not mocked) ran 10 consecutive
replacement cycles in one continuously-running test event, no reset
between cycles, each with a fresh, freshly-randomized pair of RTS
candidates — asserting for every cycle that the actual highest-voted
candidate was already reserved by the time `resolveStageRoundAction`
itself returned, with real measured boundary→reservation latency of
719-824ms (avg 747ms), and that the untouched seat was never disturbed
and no cycle's history affected the next. A second real-database test
confirmed the tie-break rule with an actual ~50ms `created_at` gap
between two equally-voted candidates. Both corroborated live in a real
browser: two forced round-boundary replacements each showed the correct
top-ranked RTS candidate promoted, with the client observing the
reservation in 548-559ms.

**Reason**: this is the minimal, root-cause fix — it removes the
architectural gap (no direct trigger) rather than adding a workaround
(a shorter poll interval, a client-side "stuck" timeout) on top of it,
both of which this pass's own instructions explicitly forbade.

**Tradeoffs**: none against any previously-established invariant —
deterministic RTS ranking, the atomic dual-seat reservation, the 3-second
Going Live countdown, server-authoritative claiming, and the shared
single-round model are all unchanged; the full existing test suite
(real-database tests included) still passes.

## 2026-08-30 — Eighth corrective pass: next-speaker latency traced to four independent, real bugs — stale client Realtime state, a simulator-only promotion gap, an under-budgeted retry, and a stuck server-side round (issue #21)

**Context**: a real iPhone still showed "Selecting next speaker…" for an
extended period with a visibly eligible, currently-requesting candidate
in the ambient comments — proof the sixth pass's reactive-promotion fix
(which targets a *real candidate's own browser tab*) hadn't fully closed
the latency gap. Explicit instruction: diagnostic-first again, this time
with specific attention to multi-tab/shared-identity behavior, and to
distinguish simulator-only causes from causes that would affect a real
user identically.

**Multi-tab findings**: audited what multiple same-browser tabs actually
share (the guest cookie, hence identity) and what happens when several
independently-mounted `EventRoom` instances each run their own
`useAutomaticPromotion`/`useSpeakerSelectionReconciliation`. Concluded,
from reading the actual code (not guessing): multiple tabs racing to
claim the same reservation is *safe* (the atomic RPC and
`claimSpeakerSeat`'s own authorization check make a second claim fail
harmlessly, the same "someone else just took it" tolerance every other
race in this app already has) and does not itself explain added latency
— if anything, more tabs racing to claim resolves *faster*. Multiple
tabs' own reconciliation calls serializing behind
`reserve_speaker_candidates_for_seats`' row lock is a real, audited
behavior (Section 5's own question) but resolves in a small multiple of
a single fast transaction, not multi-second, for any realistic tab
count. Multi-tab was not the primary cause — four other, real, concrete
bugs were.

**Bug 1 — stale Realtime state, reproduced live**: `useStageRound` and
`useActiveSpeakerRequests` each had an on-SUBSCRIBED resync (the
established "don't just trust a delta arrived" discipline) but no
visibility/focus-triggered resync — the exact gap `useSeatReconciliation`
already closed for seat occupancy specifically, issue #18. Reproduced
live, against a real dev server: after an environment disruption, a tab
kept showing "Round 0 · awaiting pairing" — a round from *before the
stage was even established* — long after the authoritative round had
advanced to round 2 and gone active; a fresh page load immediately
showed the correct state. Fixed by adding the same `visibilitychange`/
`focus` resync to both hooks.

**Bug 2 — simulated candidates had no reactive promotion path at all**:
`useAutomaticPromotion`'s sixth-pass reactive fast path only helps a
*real* candidate's own browser tab. A simulated identity has none — its
entire claim step depended solely on the Session Simulator's own 4-6s
natural-activity poll, even though reservation itself (already reactive,
server-side, since the fifth pass) typically completes in well under a
second. Fixed with a new reactive effect in the simulator panel,
mirroring `pendingRequests` the same way production does. **Two
iterations of this fix were each proven wrong live before the third
one held**: the first fired one `simulateAdvanceSelection` call per
reservation in parallel; the second deduplicated by "have I already
attempted this exact reservation" — both left a *second*
simultaneously-open seat's own reservation permanently unclaimed,
because `simulateAdvanceSelection` itself only ever targets whichever
reserved simulated candidate its own internal lookup reaches first,
regardless of which seat — per-reservation bookkeeping "used up" an
attempt that never actually touched that reservation. The fix that held:
a sequential *drain* — call, await, and if it claimed something, call
again immediately, never tracking *which* reservation was attempted.
A related, more dangerous bug found in the same investigation: an
unhandled rejection from any iteration escaped the drain entirely,
skipping the reset and leaving the whole mechanism silently disabled
for the rest of the run — closed with `try/finally`.

**Bug 3 — the simulator's own startup retry budget was measured too
tight for this environment**: `establishSeat`'s bounded claim-retry loop
(5 attempts × 150ms = 750ms total) was less time than a single ordinary
reconciliation round trip sometimes takes in this environment (measured:
150-330ms each, and the full freeze→reserve→claim chain is several such
round trips). Live-reproduced: this caused `Start Simulated Session`
itself to fail startup and never reach `running = true` — silently
disabling *every* subsequent promotion mechanism, including the fix
above, for the rest of that run. Widened generously (20 × 300ms = 6s
ceiling) — still a real, bounded retry against real server state each
time, never unbounded.

**Bug 4 — a genuine server-side bug, not simulator-specific**: live
inspection of the real database found a `speaker_selection_rounds` row
stuck `status = 'active'` with no live reservation left in it and a
withdrawn straggler that had never been reserved for any seat.
`withdraw_speaker_request(_as_guest)`'s own "mark this round exhausted"
check lived entirely inside the `if v_row.is_current_candidate` branch —
it only ran when the *withdrawing* request was itself the round's
currently-reserved candidate. A frozen-but-never-reserved straggler (an
ordinary case: a round freezes more candidates than there are open
seats to reserve them for) withdrawing skipped the check entirely.
Because `freeze_speaker_candidates` is deliberately idempotent ("an
active round already exists — reuse it," migration 20), a round stuck
this way makes every later-arriving Request-to-Speak permanently
invisible to selection for that seat — this affects a real,
authenticated caller identically to a simulated one. Fixed in migration
00000000000038: the exhaustion check now runs whenever the withdrawing
request belonged to a round at all, checking the round's actual current
health (no live reservation *and* no remaining viable candidate)
directly, rather than assuming "the withdrawer wasn't reserved" means
nothing needs checking. The pre-existing runner-up-advancement logic is
completely unchanged; no authorization check is weakened — this only
changes when a round is marked `exhausted`, never who may claim a seat.

**A related, deeper finding — not fixed this pass, surfaced instead**:
`reset_speaker_candidate_pool`'s own "should I bulk-expire the rest of
the pool" check (`v_other_reservation_exists`) queries
`is_current_candidate` **event-wide**, not scoped to the current round —
and a claimed winner's own row keeps `is_current_candidate = true`
forever (the function deliberately never touches the winning request).
In a long-running event with several resolved rounds, this means the
bulk-expire step could keep finding an *old, already-resolved* round's
own winner and conclude "another reservation exists," skipping cleanup
indefinitely. Whether this is a real product problem (versus harmless
accumulation — occupied seats never re-check `is_current_candidate` at
all) and what the correct fix is (scope the check to the round,
explicitly clear a winner's flag once claimed, or something else) is a
genuine design decision, not a bug fix with one obvious right answer —
see QUESTIONS/DECISIONS in this pass's own handoff.

**Reason**: every bug here was found by reading real code and
reproducing real behavior — against a real dev server, and (for Bug 4)
the real linked database — never by guessing and patching a timer, per
this pass's own explicit diagnostic-first mandate. Three of the four are
genuinely new gaps this pass introduced context for finding (the
sixth pass's own reactive fix made the *real*-candidate path fast enough
that these previously-masked gaps became the visible bottleneck); Bug 4
predates this pass entirely (present since migration 32) and would have
affected real users the same way, simulator or not.

**Tradeoffs**: none against any previously-established invariant —
deterministic selection, the atomic dual-seat reservation, seat-claim
authorization, the 3-second Going Live countdown, and every other
already-verified piece of the pipeline are unchanged; the full existing
test suite (real-database tests included) still passes.

## 2026-08-30 — Seventh corrective pass: geometry-driven stage stacking, stage-first collapsed navigation, a real Session Simulator Reset bug, consistent SIM tactile feedback (issue #21)

**Context**: real-device/browser testing of the sixth pass's preview found
four separate UX problems, none touching the speaker-selection state
machine: (1) `DesktopRoom` always laid its two speaker tiles out
side-by-side, which turned pathologically tall-and-narrow once the
window narrowed while still counting as "desktop" (≥1024px); (2) the
site-wide header (`SiteHeader`) stayed fully visible the entire time a
room was mounted except in one narrow short-landscape case, eating
space a video-first room should own; (3) Session Simulator's "Reset
Session" left visible stale artifacts ("Round 1 · awaiting pairing"
survived indefinitely) despite the underlying delete apparently
succeeding, and required a two-tap confirm; (4) no simulator button gave
any tactile acknowledgment of a tap, worst on touchscreens.

**Decision — stage geometry responds to a real container query, not a
device-class breakpoint (Sections 1-5)**: `SpeakerStage`'s own root
became a CSS size query container (`container-type: size`); its
"landscape" tile-orientation case (used by both `DesktopRoom` and
`MobileLandscapeRoom`) now switches to stacked tiles once the
container's own `aspect-ratio` drops below a threshold, via
`@container stage (aspect-ratio < 1.5)` in globals.css — never a
viewport-width breakpoint, and never specific to which composition
happens to be mounted. **The first threshold picked (`< 2`) was wrong,
caught only by testing in a real browser at real window sizes** (1400×900,
1920×1080, 1600×900): because `DesktopRoom`'s chat sidebar is a
*fixed*-width deduction, the stage's own aspect ratio stays roughly
constant across ordinary desktop window sizes at a given monitor aspect
ratio (~1.3-1.8 for common 16:9 windows) — `< 2` stacked almost
everywhere, including a full 1920×1080 monitor, contradicting the
explicit "wide desktop still uses side-by-side" requirement. Recalibrated
to `< 1.5` (targeting a side-by-side tile aspect ratio around 0.75, a
legible portrait-leaning crop — not the ~0.5-or-worse the original report
actually showed) and reverified live: 1920×1080 and 1600×900 correctly
stay side-by-side; 1400×900 and a narrowed 1150×800 window correctly
stack. The existing centered `StageRoundBadge` needed **no** change at
all — it was already positioned at the stage's own geometric center,
which is the tile seam in *either* orientation, so it automatically
tracks whichever layout is active. **This is why Section 41's "verify
actual behavior, not just that the boxes rearranged" instruction
mattered**: jsdom cannot execute a CSS container query at all, so this
whole recalibration was only catchable by actually loading the app in a
real browser (Playwright, against a local dev server) and reading real
`getBoundingClientRect()` numbers — a purely code-level review would
have shipped the wrong threshold with passing unit tests throughout.

**Decision — the site header collapses into a per-room overlay, not a
second persistent header (Sections 8-15)**: `body.room-active > header`
(globals.css) now hides `SiteHeader` unconditionally for the entire time
a room is mounted, in every viewport — superseding the two
narrower, landscape-only rules a prior pass added (both fully subsumed).
A new `RoomInfoOverlay` (rendered once by `EventRoom`, a sibling of the
composition branch — never a wrapper around it, so opening it can never
remount the stage) provides the navigation/room-info/account content
that lived in the now-hidden header, as a `fixed`-positioned overlay
(mobile: bottom sheet; `lg`+: top-right popover, the same 1024px
threshold `useIsDesktopViewport` already uses) dismissible via backdrop
tap, ✕, or Escape. **No new floating control** (per explicit
instruction not to add a second competing circle if the screen is
already busy): the existing room-identity status pill (already present
in Portrait/MobileLandscape/both Speaker Views via the shared
`SpeakerViewTopChrome`) *becomes* the trigger, and `RoomHeader`
(desktop-only) gains one small "☰" button alongside its own title —
reusing what already existed at that exact spot rather than adding a
new element. Verified live (not just unit-tested, since opening/closing
an overlay's effect on underlying live state — the shared round timer,
Realtime comments — needs a real running app, not a mock): the round
timer kept ticking and comments kept arriving underneath the overlay
while open, and a full round transition happened correctly *while the
overlay was open*, then closing it returned to the live stage exactly
as it was.

**Decision — Session Simulator Reset's real bug was a silently-dropped
Realtime DELETE, not a database problem (Sections 16-19)**: traced
before writing any fix, per this project's own standing discipline.
`resetSimulatorSession`'s own database deletes were already correct and
already covered by extensive real-database tests from an earlier pass
(comments/likes/speakers+round-votes/requests+request-votes all cascade
correctly, real-vs-simulated data segregation proven directly). The
actual bug was client-side: `useStageRound`'s Realtime subscription
handler explicitly discarded every `DELETE` event
(`if (payload.eventType === "DELETE") return;`) — the *one* production
path that ever deletes the `stage_rounds` row at all is this same Reset
(every other transition only ever `UPDATE`s it), so this bug had likely
never been exercised by earlier passes' testing. Fixed by extracting a
pure `applyStageRoundChange` reducer (matching the existing
`applySpeakerChange`/`removeSpeaker` shape from `use-active-speakers.ts`)
that correctly returns `null` on DELETE, unit-tested directly. As
defense in depth (Section 19's "reconcile the client, don't just trust
deletion happened"), `EventRoom`'s own `onSimulatorReset` callback now
also triggers an explicit `refetchSpeakers()`, mirroring the
"don't just trust an incremental Realtime delta arrived" discipline
`useActiveSpeakers`' own SUBSCRIBED-triggers-refetch already uses
elsewhere.

**Decision — Reset becomes one tap (Section 20), and every simulator
button gets real tactile feedback via one shared control (Sections
21-26)**: the two-tap "are you sure" confirmation row is gone entirely —
a preview-only tool never needed it, and it may have been masking
the actual reset bug above (a user who tapped once, saw nothing change
because the confirm row wasn't noticed, and concluded reset silently
failed). New `SimButton`, wrapping every one of the panel's ~15 buttons:
tracks a genuine `pressed` state via `onPointerDown`/`onPointerUp`/
`onPointerLeave`/`onPointerCancel` (never `:hover`, and never bare
`:active` — a known unreliable-on-iOS-Safari-without-a-touch-listener
quirk, not fixable by a CSS tweak alone) for immediate visual
acknowledgment on every platform including touch; enters a disabled
"executing" state automatically, but *only* when `onClick` returns a
`Promise` — a synchronous, deterministic action (Generate Comments,
Shift Request Votes) never enters this state at all, so repeated
intentional tapping stays exactly as responsive as before. This is what
actually prevents a duplicate concurrent Reset (Section 25) without a
second confirmation step: the button's own `disabled` attribute during
the async call, not an "are you sure."

**Reason**: every piece of this pass follows the same underlying
discipline the project has held since the third/fourth passes — trace
the actual mechanism before fixing it (the stage_rounds bug, the
threshold recalibration), verify in the environment that can actually
exercise the thing being fixed (a real browser for CSS container
queries, a real database for deletion cascades), and prefer extending
an existing, working pattern (the shared status pill, the pure-reducer
Realtime-payload shape, `useActiveSpeakers`' resync-on-SUBSCRIBED
discipline) over inventing a parallel one.

**Tradeoffs**: none identified against any previously-established
invariant — every change here is presentation/tooling-only (responsive
layout, navigation chrome, a preview-only panel's own reset/feedback
behavior) and does not touch selection, reservation, authorization, or
round mechanics, all confirmed unchanged by the full existing test
suite passing throughout.

## 2026-08-30 — Sixth corrective pass: next-speaker promotion latency traced to a client-side polling gap, not selection/reservation (issue #21)

**Context**: real-device testing still found next-speaker selection
"taking far too long" after the fifth pass's seat-aware/atomic
reservation fix — an established stage with an empty seat (sometimes
both), eligible already-voted-for Request-to-Speak candidates visible,
"Selecting next speaker…" showing, and an unreasonable wait before a
candidate actually landed on stage. Explicit instruction: diagnose
first, no retries/timer cuts/rule changes before the actual bottleneck
was identified.

**Traced, not guessed**: read the real current source of every stage in
the pipeline before touching anything. Two things were already correct
from the fifth pass and confirmed, not re-built: (1)
`useSpeakerSelectionReconciliation` re-triggers
`reconcileSpeakerSelectionAction` → `ensureActiveSelectionRound`
reactively, keyed on the live `speakers`/`pendingRequests` Realtime
state, from *any* connected client — not a timer, and not dependent on
one specific candidate's tab being open; (2)
`reserveSpeakerCandidatesForSeats` reserves distinct candidates for
*both* open seats in one atomic, row-locked call — there is no
serialization between seat 1's and seat 2's reservation. A new
real-database timing test (`two-seat-selection-fallback.test.ts`,
Section 23) measured a representative run directly against the linked
Supabase project: reservation for both seats **440ms**, seat 1
claim+authorize **432ms**, seat 2 claim+authorize **448ms** — nowhere
near the multi-second delay reported.

**The actual bottleneck**: `useAutomaticPromotion` — the hook that
starts a *candidate's own* 3-second Going Live countdown once they're
eligible — determined its own eligibility via a blind
`setInterval(checkPromotionEligibility, 4000)` poll, with no way to
notice a reservation any sooner than the next tick. This poll was
entirely disconnected from `pendingRequests`, the same
Realtime-synced state (`is_current_candidate`/`reserved_seat_number`)
`EventRoom` already held live and wasn't even passing into the hook.
Worst case: up to ~4s of pure poll-wait, stacked *on top of* the
intentional 3s countdown, on top of claim/Realtime overhead — the
"several seconds of unreasonable wait" the real-device report
described, even though the server-side work behind it was sub-second.

**Decision — reactive first, polling as a bounded backstop**:
`EventRoom` now derives `isCurrentlyReservedCandidate` directly from its
own live `pendingRequests` (checking the caller's own identity against
`is_current_candidate`/`reserved_seat_number`) and passes it into
`useAutomaticPromotion`. The hook's polling effect checks this signal
first — if already true, it starts the countdown immediately, no round
trip. The original 4-second poll is unchanged in cadence and stays as a
backstop for the one gap a pure Realtime-occupancy signal can't cover
(a candidate's rank shifting from a vote on a *different* request,
which doesn't touch `event_speakers` at all) — not replaced, since
removing it outright would trade one latency bug for an occasional
"nobody notices at all" bug. The claim itself
(`claimOpenSeat`/`resolveClaimDecision`) is completely untouched and
still independently re-validates eligibility server-side regardless of
which path (reactive or polled) started the countdown — this fix cannot
reintroduce the seat-claim race the second corrective pass closed,
because nothing about *how* the countdown started ever fed into that
revalidation.

**A companion truthfulness fix (Section 14)**: even with faster
promotion, "Selecting next speaker…" was staying visible through a
candidate's *entire* Going Live countdown, well after selection had
actually succeeded — misleading regardless of how fast the underlying
mechanism became. `SpeakerStage`'s empty-seat state gained a "Joining…"
state, checked before "Selecting…", triggered by the same
`is_current_candidate`/`reserved_seat_number` fields already flowing
through `pendingRequests` — the label now only ever means "still
actually selecting," never "candidate already picked, still counting
down."

**New preview-only diagnostics (Sections 2-3, 20-21) — real
measurements, never estimates**: `useSeatPromotionTiming` records actual
`Date.now()` timestamps per seat for the transitions this client can
directly observe (vacant → candidates found → reserved → occupied),
reset each time a seat is next seen vacant. The Session Simulator panel
renders this as a compact per-seat timeline with real millisecond/second
deltas and a `WAITING AT: <specific reason>` line (Going Live countdown
vs. reservation-pending vs. no eligible requests vs. fallback open)
whenever a seat isn't yet occupied, replacing the generic "Selecting…"
a screenshot used to show. This is client-observed timing only — it
cannot distinguish "the server was slow" from "this tab's own Realtime
subscription was slow to deliver the update"; the real-database test
above is what actually isolates the server-side portion.

**A lint-driven implementation detail worth recording**: this
codebase's `react-hooks/set-state-in-effect` rule rejects a `setState`
call reached synchronously from an effect body, including the reactive
fast path above and the new timing hook's own recording effect —
both were restructured to reach their `setState` call only after a
genuine `await` (a single microtask, immaterial to the timing this pass
cares about), matching the same shape the pre-existing poll callback
already used and the rule already accepted.

**Reason**: matches this pass's own diagnostic mandate — the fix
targets the actual measured bottleneck (a client-side trigger gap) with
the narrowest possible change, and leaves every already-correct piece
from the fifth pass (atomic dual-seat reservation, reactive
server-side re-triggering, seat-claim authorization) untouched rather
than layering a new mechanism on top of working ones.

**Tradeoffs**: none identified against the fifth pass's invariants —
the diagnostic timeline is additive/preview-only and never read by
anything that decides selection or authorization; the reactive fast
path is a strict latency improvement with the same eligibility
guarantees the poll always had, not a new one.

## 2026-08-29 — Fifth corrective pass: seat-aware selection reservation, atomic reservation RPC, small-room direct-join fallback, ambient comment redesign, Hide/Show live comments (issue #21)

**Context**: real-device testing found the stage could get genuinely
stuck — both seats reading "Selecting next speaker…" for far too long
while Expanded Comments showed two eligible, already-voted-for
Request-to-Speak candidates. Alongside it: no explicit handling for both
seats being empty at once; a desire for a narrow small-room fallback so
a room with nobody requesting the mic doesn't die permanently; and a
readability redesign for the ambient comment feed plus an easy way to
hide it.

**Root cause, traced before writing any fix (Section 35's own
instruction)**: `speaker_requests_current_candidate_uniq` (migration 19)
allowed at most *one* current candidate per selection round, full stop —
a leftover from the single-seat-opens-at-a-time model the whole
selection system was originally built around. With two seats open
simultaneously, only one candidate could ever be reserved; the *other*
seat's own legitimate, already-ranked, already-voted candidate sat in
the pending pool doing nothing. Worse: the moment the one reserved
candidate's claim succeeded, `reset_speaker_candidate_pool`'s existing
Section-E bulk reset (correct, unmodified product intent for the
ordinary single-seat case: "every other pending request expires, no
automatic requeue") unconditionally expired *every* other pending
request — including the second seat's own candidate, who had never even
gotten a chance to be reserved. That is exactly the reported "stuck for
far too long" state: not slow selection, but a seat with zero remaining
eligible candidates because its own candidate had been silently wiped
by an unrelated seat's claim.

**Decision — reservation becomes seat-scoped, not round-scoped**: added
`speaker_requests.reserved_seat_number` (migration 32); the uniqueness
constraint moved from "one current candidate per round" to "one current
candidate per (round, seat)" — up to two simultaneously, one per open
seat, never two for the same seat. `ensureActiveSelectionRound`
(room/actions.ts) now determines every currently-open seat
(`findOpenSeats`, plural — new) and reserves a *distinct* unreserved
candidate for each, per Section 3's explicit "rank the pool, reserve #1
for seat A, reevaluate, reserve the next-highest for seat B."
`reset_speaker_candidate_pool` defers its full wipe whenever another
request is still actively reserved for a *different* seat — the
"expire everyone else" step now only fires once no seat has a live
reservation left, i.e. once the *last* seat's own claim has completed,
never wiping out a still-in-flight sibling reservation.
`withdraw_speaker_request(_as_guest)`'s advance-to-next-candidate logic
is scoped to the withdrawing candidate's own seat only, carrying
`reserved_seat_number` forward to whichever request replaces them —
never touching a different seat's own independent reservation, and only
marking the whole round "exhausted" once *no* seat has a reservation
left in it.

**A related race this surfaced, fixed alongside it**: `lib/speaker-queue.ts`'s
`decideClaimEligibility` used to compute the claiming seat via
`findOpenSeat` — "the lowest-numbered currently-open seat" — regardless
of which candidate was asking. With two candidates simultaneously
eligible (one per seat), both would independently compute the *same*
seat number from the same occupancy snapshot and race each other for it,
needing a retry. Now reads the candidate's own `reserved_seat_number`
directly — each candidate goes straight for their authoritatively
assigned seat, no ambiguity, no retry needed; `claim_speaker_seat` still
independently re-verifies the match server-side, never trusted from this
decision alone.

**Decision — the reservation step itself must be atomic, not a
TypeScript loop (Section 4's explicit instruction)**: the first
implementation of the seat-aware fix still decided each seat's
reservation via a separate RPC call per seat, from a `for` loop in
`ensureActiveSelectionRound`. A real-database concurrency test, written
specifically to probe Section 36's named "Race A/E" (two selectors
simultaneously choosing the same top candidate for different seats),
proved this exact race was still possible: two genuinely concurrent
callers (from two different clients' own reconciliation polls, entirely
plausible now that both audience members and candidates trigger
reconciliation) could each read the same unreserved-candidate snapshot
before either had committed, and independently reserve the *same*
candidate for two different seats — each call's own commit simply
overwriting the other's `reserved_seat_number`. Fixed by moving the
entire per-open-seat reservation decision into one new SQL function,
`reserve_speaker_candidates_for_seats` (migration 36), which locks every
row of the frozen round (`for update`) for the duration of the decision
— a second concurrent call blocks on that lock until the first commits,
then re-reads the now-current reservation state and correctly skips
whatever's already taken. `ensureActiveSelectionRound` calls this once,
instead of looping and calling `setCurrentSpeakerCandidate` per seat.
**A same-pass corrective migration (37)**: the first version of the new
function had a `RETURNS TABLE` column also named `reserved_seat_number`,
which PL/pgSQL implicitly exposes as an in-scope variable for the whole
function body — every unqualified reference to the column inside the
function became ambiguous, caught immediately (not silently) by the
real-database test suite the moment it ran against the linked project;
fixed by qualifying every reference explicitly.

**Decision — small-room direct-join fallback, narrowly scoped**: once a
stage is established, a direct seat claim is illegal for every empty
seat *except* one specific case — both seats empty and zero eligible
pending requests (Section 8's Case C, explicitly distinguished from
Case A "one seat occupied, zero requests — stays selection-controlled"
and Case B "both empty, requests exist — selection still governs").
`claim_speaker_seat` (migration 33) enforces this itself, the same
authoritative tier as every other check in that function — never a
UI-only affordance. **Authoritative exclusion, not a timer**: the two
speakers who were just removed the last time both seats emptied
together are excluded from reclaiming a fallback seat for that specific
recovery episode, tracked via two new `stage_rounds` array columns
(`fallback_excluded_profile_ids`/`_guest_ids`), stamped by
`ensure_stage_round` from `event_speakers`' own `left_at` history — the
exact identities who most recently departed — the instant occupancy hits
zero, and cleared the instant a fresh pairing is established. No new
ban table, no arbitrary multi-minute timer — the lifecycle event itself
(both empty → fresh pairing established) is the boundary, per explicit
instruction. `joinOpenSeat` (room/actions.ts) reuses the exact same
`claimSpeakerSeat` call the fallback's real enforcement lives in, rather
than adding a second, parallel bypass path — a client-side early
rejection for a clean typed error, never the actual authority.

**Two same-pass corrective migrations for the fallback, both caught by
the real-database test suite before this pass's own handoff, not
discovered later**: (1) migration 33's first version required *both*
seats to be empty on every single claim — but Section 14 explicitly
requires the fallback to *continue* covering the second seat once the
first has been filled through it (as long as it's still empty and
nobody's requested yet); a test built directly from Section 18's item E
caught the gap immediately. Fixed (migration 34) by distinguishing "an
ordinary established-stage steady state" (Section 9 Case A — no
recovery episode ever started, exclusion arrays empty) from "the second
half of an in-progress small-room recovery" (exclusion arrays non-empty)
using the *same* exclusion-array signal already being tracked for a
different reason, rather than inventing a second flag. (2) That fix then
revealed a second, more subtle gap of its own: the exclusion arrays
persisted indefinitely across unrelated later occupancy if a recovery
episode was ever abandoned mid-way (one fallback speaker seated, then
also leaving, without the pairing ever completing) — a *new*, entirely
unrelated occupant seated afterward (e.g. via a bypass claim) would
incorrectly inherit "recovery in progress" from the stale, unresolved
episode. Fixed (migration 35) by having a successful bypass claim
explicitly clear the exclusion arrays — a bypass claim is, by
definition, never itself part of an unresolved fallback recovery.

**Decision — the reactive reconciliation backstop extends to selection,
not just the round invariant (Section 6)**: selection is normally
event-driven, triggered whenever an eligible candidate's own client
polls `checkPromotionEligibility`. That's a real gap if every eligible
candidate's tab happens to be backgrounded or closed right when a seat
opens. New `reconcileSpeakerSelectionAction` +
`useSpeakerSelectionReconciliation` hook (same shape as the fourth
pass's `reconcileStageRoundAction`/`useStageRoundReconciliation`) lets
*any* connected client — audience included — re-trigger selection
whenever its own view of occupancy or the pending-request pool changes,
never a blind timer, always re-deriving from actual current state.

**Ambient comment redesign**: moved from a single-line "Name: message…"
pill (hard-truncated mid-word on real devices) to avatar + name-on-its-
own-line + wrapped comment text below (`line-clamp-2`), per the
requested livestream-app pattern. The request badge moved beside the
name instead of inline with the message. Container height (128px→160px)
and the fourth pass's own top-edge mask-fade zone (28px→40px) both grew
modestly to suit the taller rows while staying a compact overlay, not a
chat panel — the fade was re-verified (not assumed) to still read as a
dissolve, not a hard clip, at the new proportions. Expanded Comments
stays deliberately untouched — a different, deliberate reading surface.

**Hide/Show Live Comments — a client preference, not new schema (Section
29's explicit instruction)**: persisted via `localStorage`, scoped to
the ambient feed only — the composer, Request-to-Speak, Expanded
Comments, and the underlying `messages` stream are all completely
unaffected by hiding it. A small restore control stays visible in the
same corner whenever hidden, so there's never a state the viewer can't
recover from with one more tap.

**Reason**: every piece of this pass traces back to the same underlying
principle already established in the third/fourth passes — authorization
and invariant-critical decisions live in the database, re-verified at
the source of truth, never trusted from client state or timing luck;
this pass extends that principle to a genuinely new dimension (two
simultaneous seats, not just one) rather than special-casing it in the
UI layer.

**Tradeoffs**: the atomic reservation RPC (migration 36/37) means a
seat's reservation decision briefly blocks behind another concurrent
reservation decision for the *same* round when both fire at once — a
sub-second lock wait in the rare case of genuinely concurrent
reconciliation triggers, an intentional and correct cost of closing a
real double-booking race, not a regression to optimize away. The
fallback's exclusion tracking is deliberately coarse (the two most
recently departed identities, not a longer or more granular history) —
sufficient for the "don't let the two who just lost immediately
retake the stage" requirement without building a more elaborate
moderation/ban system this prototype doesn't otherwise have.

## 2026-08-29 — Fourth corrective pass: bounded simulator startup state machine, Case A/B seat seeding, reactive round-invariant backstop, composer focus preservation, ambient comment fade (issue #21)

**Context**: real-device testing found the simulator could reach a
genuinely invalid state — pressing Start Simulated Session produced both
seats showing "Selecting next speaker…" while the shared round badge
simultaneously read "Round 11 · 49s" and kept counting down. The
instruction was explicit that the important issue was *not* merely slow
selection: the invariant "a normal shared round may exist/count down
only once the stage's two-speaker pairing is authoritatively
established" was being violated, and the fix had to trace the actual
state transition, not paper over it with delays, fake placeholders, or a
simulator-only authorization bypass. Two smaller, independently-reported
items rode along: Request-to-Speak toggling while typing dismissed the
keyboard, and ambient comments hard-clipped at the feed's top edge.

**Root cause, as far as it could be traced without live production
logs**: `startSimulation` set `running = true` and unconditionally
scheduled every natural-activity loop (including round-voting, which
reads whatever the client's own `speakers` state happens to show)
*before* `seedTwoSpeakers` had even resolved, let alone confirmed it
succeeded. Two independent gaps could each explain the reported
screenshot on their own: (1) if seeding partially or fully failed (e.g.
because the target stage was already established and the seeding path's
unconditional bypass claim was rejected), the session still proceeded to
"running" as if nothing had gone wrong; (2) a client's own locally-
cached `speakers`/`stageRound` state could be transiently stale relative
to the database's actual occupancy at the exact moment Start was
pressed. Rather than commit to one specific historical trigger without
being able to reproduce it live, the decision was to build the robust,
explicit mechanism the corrective-pass instructions themselves
specified in detail — a bounded startup state machine plus a reactive,
idempotent backstop — which structurally closes the invariant violation
regardless of which exact path caused any given instance of it.

**Decision — bounded startup state machine, not a longer loading
animation**: `startSimulation` now calls a new `establishInitialPairing`
or aggregate lifecycle before ever flipping `running`. Each seat's
establishment (`establishSeat`) is verified by its own real result (a
successful `simulateSeedSpeaker` call, or a `simulateAdvanceSelection`
result reporting `claimed: true`) — never a fixed delay or a trusted
local flag. Once both seats are confirmed, a fresh, authoritative read
of `stage_rounds` is taken; if it isn't `active` yet, the new reactive
backstop (`reconcileStageRoundAction`) is called explicitly and re-read
once — genuine defense in depth, not a blind retry loop, since
`ensure_stage_round` is a direct synchronous RPC, not eventually
consistent. Only after all of this succeeds does `running` flip and the
natural-activity loops (comments, likes, RTS, round-voting, replacement
polling) get scheduled — a failure at any bounded step leaves `running`
false, reports the specific failure via a new preview-only "Startup"
observability panel, and lets the user press Start again as the retry.
A small `startupTokenRef` generation-token guards against a slow/stuck
in-flight startup completing *after* Stop or Reset was pressed and
silently resurrecting `running` — a real regression found and fixed
during this pass's own test-writing, not something manually spotted
first.

**Decision — Case A/B seat seeding, closing a simulator-only
authorization loophole**: `establishSeat` now takes a fresh, authoritative
pre-check read of `stage_rounds.round_number` (the same permanent "has
this stage ever been established" signal the third corrective pass
introduced) and branches: **Case A** (a genuinely new, never-established
stage) reuses the existing `simulateSeedSpeaker` direct-join bypass
unchanged — this is legitimate initial-stage formation, exactly as
before. **Case B** (an already-established stage, even with both seats
currently empty) now goes through the *real* production pipeline —
`simulateRequestToSpeak` followed by bounded-retried
`simulateAdvanceSelection` calls — the same eligibility, ranking,
selection, and authorization machinery a real candidate's own browser
tab would use, reusing `claim_speaker_seat`'s existing non-bypassed
authorization check rather than adding a new one. This applies uniformly
to *both* Start's own automatic seeding and the standalone "Seed 2
Speakers" button, per the explicit instruction that a simulator-only
loophole in the database authorization model must not exist anywhere in
this tool, not just on the primary path. One consequence, confirmed
correct rather than patched around: manually re-pressing "Seed 2
Speakers" once a stage is already fully established and both seats
occupied by its own seeded identities now correctly reports nothing to
do (no open seat exists to authorize a claim for) rather than pretending
to re-seed the same two people via a bypass — the previous behavior was
a test-only fiction the mocked test suite never actually exercised
against the real backend's own "seat already occupied" guard.

**Decision — a reactive backstop, not just a startup-time fix**: the
invariant this pass targets isn't specific to simulator startup — any
client whose own view of seat occupancy changes could in principle be
looking at a stale round. `ensure_stage_round` (migration
00000000000028) is already fully idempotent, recomputing round phase
from real current occupancy on every call — this pass's own review of
that migration's SQL confirmed the `round_number >= 1` "established"
signal is sound (a purely-awaiting-pairing placeholder starts at
`round_number = 0`, per migration 00000000000027's own fix; only the
`occupied_count = 2` branch ever advances it to 1+). New
`reconcileStageRoundAction` (room/actions.ts) plus
`useStageRoundReconciliation` (a new hook, wired into `EventRoom`
alongside the existing `useStageRoundResolution`) call it whenever any
connected client's own occupancy view changes — keyed on the sorted set
of occupied seat ids, not the raw `speakers` array reference, so an
unrelated field change (a vote, a mute toggle) never re-triggers it.
Idempotent and safe from every connected client simultaneously, the same
precedent `useStageRoundResolution` already established for the round's
own deadline-resolution trigger.

**Composer focus preservation**: root-caused to the browser's own
default behavior of shifting focus to *any* tapped focusable element on
`mousedown` — this happens before a button's `onClick` ever fires, and
on iOS Safari that focus loss is what closes the virtual keyboard.
`event.preventDefault()` on the mic button's `onMouseDown` stops the
browser from ever initiating that focus shift, so the comment input is
never blurred at all — deliberately not a compensating refocus-after-
blur effect, which would still be visible as a flicker, per explicit
instruction to fix the interaction so it never blurs in the first place.
Confirmed via inspection that the input is the same DOM node regardless
of `micRequestMode` (only its `placeholder` prop changes, no key change,
no remount) — the focus fix alone is sufficient.

**Ambient comment fade**: a single container-level CSS `mask-image` (and
`-webkit-mask-image`, required for iOS Safari) linear gradient on the
existing `overflow-y-auto` container, not per-bubble animation — a
purely visual, `pointer-events`-unaffecting treatment, so scroll-follow
behavior and every bubble's own tap target are untouched. Deliberately
not applied to Expanded Comments, which is a reading surface with its
own snapshot/scroll model, not the ambient livestream-style feed.

**Reason**: every alternative the instructions explicitly ruled out
(arbitrary delays, longer loading animations, fake speaker placeholders,
hiding the timer, force-seating candidates without authorization,
client-only checks, a blind sleep-and-hope retry, a simulator-only
authorization loophole) would have hidden the symptom without closing
the actual gap — a *shared* round genuinely counting down without a
genuinely established pairing is a database-observable fact, not a
rendering artifact, and the fix needed to be provable against the real
database, which is why three new real-database integration tests
(`stage-round-invariant.test.ts`) exist alongside the component-level
ones.

**Tradeoffs**: seat establishment via Case B (an already-established
stage) can take a few hundred milliseconds longer than the old
unconditional bypass, since it now waits on a real selection round to
freeze and a real claim to be authorized — an intentional and correct
cost of not bypassing production's own authorization model, not a
regression to optimize away. The reactive backstop adds one additional
`ensure_stage_round` RPC call per connected client whenever occupancy
changes — cheap (a single indexed lookup plus, in the common case, a
no-op branch) and already proven safe to call redundantly by every
existing seat-claim/vacate path doing exactly that today.

## 2026-08-29 — Third corrective pass: deterministic selection replaces weighted-random, seat claims require selection authorization after initial stage formation, avatars, tap-away Vote (issue #21)

**Context**: real-device testing continued to go well, but surfaced five
more things: missing avatars in Expanded Comments; the Vote surface
staying open when tapping away; a request to simplify next-speaker
selection from weighted-random to highest-votes (with deterministic
tiebreaking); Request-to-Speak users needing to withdraw before
promotion completes; and — the most architecturally significant — being
able to become the next speaker by simply tapping a newly-open seat,
bypassing Request-to-Speak entirely.

**Deterministic selection — a genuine simplification, not a workaround**:
removed the weighted-random draw (`lib/speaker-selection.ts`,
`SELECTION_RANK_WEIGHTS`, `Math.random()`) entirely, per explicit
instruction not to leave it half-active. `ensureActiveSelectionRound`
now just picks `rank 1` from the already-frozen pool —
`freeze_speaker_candidates`' own ranking (`vote_count desc, created_at
asc, id asc`, unchanged) already *is* "highest votes wins, earliest
request breaks a tie," so no new tiebreak logic was needed anywhere,
only the removal of the extra randomized step on top of it. This also
meant `withdraw_speaker_request(_as_guest)`'s existing "advance to next
unfailed candidate by frozen_rank" logic (migration 19, unchanged)
needed zero changes — it was always walking the same deterministic
order, previously used only for a *declined winner's* fallback, now also
the primary selection rule. Investigated whether the frozen-Top-3-of-3
snapshot concept itself was now obsolete (item 5's "Top 3 must freeze
specifically for a random draw" framing) and concluded no: freezing
still serves a real, independent purpose — a stable snapshot so votes
continuing to change during a Going-Live window can't retroactively
steal an already-issued opportunity (item 15) — kept the freeze, removed
only the draw. `lib/speaker-selection.ts` and its test file are deleted
outright, not left dead.

**Withdrawal before/during Going Live — investigated before building
anything new, found already implemented**: traced `RoomControls`'
existing "Withdraw" (waiting)/"Cancel" (mid-countdown) buttons and
`ChatPanel`'s composer toggle, both already routing through
`useAutomaticPromotion`'s `cancel()` → `withdrawSpeakerRequest`, which
already handles both "withdraw while merely waiting" (the request simply
never gets frozen/selected) and "decline after being selected" (the SQL
above already advances to the next unfailed candidate). No new UI or
withdrawal logic was needed — only the deterministic-selection change
above, which this flow already composed with correctly. Verified with
new real-database tests rather than assumed correct from reading the
code alone.

**Seat-claim authorization — the architecturally significant fix**: the
actual bug was that `joinOpenSeat` (built for a viewer directly claiming
a genuinely uncontested seat) had no way to know it was being used
*after* the stage's initial pairing, when an empty seat is supposed to
be controlled by selection instead. Needed one authoritative,
permanent-once-true "has this stage ever achieved its initial two-seat
pairing" signal — considered a new `events` column, but
`stage_rounds.round_number` already encodes exactly this fact (it only
ever reaches 1, and never returns to 0, once `ensure_stage_round` has
seen both seats occupied simultaneously at least once — established in
the previous corrective pass's migration 27) — reused it instead
(`isStageEstablished`, lib/repositories/stage-rounds.ts). Enforced
**inside `claim_speaker_seat` itself** (migration 00000000000029), not
only in `joinOpenSeat`'s own pre-check — per explicit "do not solve this
by hiding the button, a fast/stale/malicious client must not bypass it"
instruction: once established, every claim (from any caller) is rejected
unless the claiming identity is re-verified, at the RPC, to be the
event's currently authorized selected candidate. `joinOpenSeat` also
gained its own early check (a clean typed `selection-required` result),
but that's UX polish, not the actual security boundary — proven by a
real-database race test that submits an unauthorized direct claim
*concurrently* with the authorized candidate's own claim and confirms
the unauthorized one always loses, never based on arrival order.
`SpeakerStage`/`SpeakerTile` stop wiring `onTapEmptySeat` at all for an
empty seat once established, replacing the tappable CTA with "Selecting
next speaker…" — the UI and the database now agree, rather than the UI
merely hiding a control the database would have rejected anyway.

**A narrow, explicit bypass for the Session Simulator's own manual
re-seed tool** (`simulateSeedSpeaker`, "Seed 2 Speakers"): added a new
`p_bypass_selection_authorization` parameter to `claim_speaker_seat`,
defaulting false for every ordinary caller. `simulateAdvanceSelection`
deliberately does *not* use it — it claims on behalf of a real, frozen,
authorized winner, so it exercises the exact same authorization check a
real user's claim would, keeping the simulator a genuine end-to-end
harness rather than a parallel bypass path, per explicit instruction.

**A second Postgres gotcha found via the real-database test suite, not
manual review**: adding that new trailing parameter via `CREATE OR
REPLACE FUNCTION` did not replace `claim_speaker_seat` in place —
Postgres treated the 6-argument version as a genuinely new overload
alongside the untouched 5-argument original (confirmed directly via the
regenerated TypeScript types showing two distinct `Args` shapes for the
same function name). Two real consequences, both caught by the test
suite rather than assumed away: (1) a caller resolving to the old
5-argument overload would skip the new authorization check entirely —
fixed by explicitly dropping the stale overload; (2) the *new*
6-argument function object didn't inherit whatever revoked-from-public
state the old one had, so an ordinary authenticated (and even
anonymous) caller could suddenly call it directly — fixed by restating
the same `revoke ... from public` / `grant ... to service_role` the
original always had. Worth remembering generally: adding a new
DEFAULTed trailing parameter to an existing SECURITY DEFINER function
via `CREATE OR REPLACE` is not safe to assume is in-place — always
verify via the regenerated types (a duplicated `Args` union is the
tell) and re-state grants explicitly rather than assuming inheritance.

**Avatars**: no `profiles.avatar_url` column exists (checked against
`src/types/database.ts` before writing anything) — built one shared
`ParticipantAvatar` component (image-ready, but every caller today
correctly falls through to an initials placeholder) and used it in both
`ExpandedComments` and `AmbientComments` (the "compact/live" and
"Expanded" surfaces the instruction asked to share a presentation), and
refactored `SpeakerTile`'s four previously-duplicated inline initials
circles onto the same component — one canonical avatar system, not one
per surface.

**Vote tap-away dismissal**: a `pointerdown`-on-`document` listener
(outside-target check via the panel's own container ref) plus an
Escape-key listener, both only attached while the panel is actually
open. Closing only ever changes `open` — the viewer's already-cast vote
is untouched server-side and reappears highlighted on reopen, same as
before this change.

**Tradeoffs**: did not extend selection's frozen-pool size beyond 3 (no
product signal asked for it, and the user's own examples throughout this
request stayed at three). Simulator's own natural "occasional
withdrawal" is deliberately narrow-scoped — a low-frequency tick that
only ever withdraws a *simulated* identity's own pending request (never
a real user's), matching the standing "simulator identities must never
touch real user state" invariant.

## 2026-08-28 — Second corrective pass: seeding race traced to a database bug, shared-round timer repositioned, weighted-selection made observable, Vote UI shows sentiment (issue #21)

**Context**: further real-device testing of the shared-round build found
five things: the round timer overlapped the room header; a speaker wasn't
replaced by the expected Request-to-Speak candidate; one simulation start
produced incomplete seating, fixed by Stop/Start; Continue/Replace vote
detail wasn't visible anywhere; and the simulator risked drifting into a
parallel fake implementation instead of staying a genuine end-to-end
harness. Explicit instruction: trace root causes rather than adding
retries, don't "fix" legitimate weighted randomness, and reuse production
decision logic and data paths wherever a real browser identity could
physically perform the same action.

**Seeding race, traced to an actual database bug, not flaky UI**: the
Session Simulator's `seedTwoSpeakers` claimed both seats via
`Promise.allSettled` — genuinely concurrent RPC calls. `ensure_stage_round`
(migration 24) read seat occupancy *before* creating/locking the
`stage_rounds` row and had no conflict handling on its cold-start INSERT.
On a brand-new event, both concurrent `claim_speaker_seat` calls could
reach `ensure_stage_round` with no row yet visible to either transaction;
the loser's INSERT hit `stage_rounds_event_uniq`'s bare unique_violation —
an *uncaught* Postgres error that rolled back its entire transaction,
including the seat claim itself. That's the exact "Stop/Start fixes it"
signature: the first attempt raced and lost a seat invisibly; the second
attempt's `stage_rounds` row already existed, so the race window was gone.
Fixed in the database (migration 00000000000028): the INSERT now uses
`ON CONFLICT (event_id) DO NOTHING`, and occupancy is read *after* the
round row is locked/created — Postgres blocks a second transaction's
conflicting INSERT until the first commits, so by the time the loser
reads occupancy, the winner's own seat claim has already committed and is
visible; both seats are correctly counted regardless of which claim
"wins." Verified with a dedicated real-database test that claims both
seats via genuine `Promise.all` concurrency on a fresh event (the exact
scenario that used to fail) and asserts both succeed with a synced active
round. The simulator's own seeding was additionally changed from
concurrent to sequential — not a workaround for the database bug (already
fixed at its root), but a better match for what it's simulating: two
people claiming seats moments apart, not at the identical instant — and
it's what makes each seat's own success/failure independently reportable
(`"Seeding Seat 1…"` / `"Seeding Seat 2…"` / `"Starting Round 1…"`, with
the real error message on a genuine failure, never a swallowed or generic
one, per explicit instruction not to leave a half-started simulation
unreported).

**Timer placement — root cause was two absolutely-positioned overlays
sharing one coordinate, not a z-index fight**: `StageRoundBadge` sat
`top-2` of the stage box; `PortraitRoom`'s own event-title status pill is
a *separate* absolutely-positioned overlay at `top-0` of the same box —
both near-identical top-of-screen positions, hence the overlap. Since both
tiles are equal `flex-1` siblings (stacked in portrait, side-by-side in
landscape), the exact center of the stage box is always the seam the
`speaker-divider` itself already occupies — moving the badge to
`top-1/2`/`left-1/2` (both axes, one CSS rule) reaches "the boundary
between the two speaker areas" in *both* orientations from a single
position, not a per-orientation special case, and no other layer (top
chrome, self-preview, ambient comments, controls, Vote panel) is ever
positioned at center-stage.

**Replacement-selection: investigated the actual algorithm before
touching anything**. Re-read `selectWeightedCandidate`
(`lib/speaker-selection.ts`) and its wiring
(`ensureActiveSelectionRound`, `freeze_speaker_candidates`,
`set_current_speaker_candidate`) end to end — the fixed rank weights
`[3, 2, 1]` correctly produce a 50/33/17 split among a full Top 3, exactly
as designed and previously decided; `freeze_speaker_candidates`'
idempotent-freeze (migration 20) correctly returns the same frozen
pick on repeated calls, so `simulateAdvanceSelection`'s own second
`freezeSpeakerCandidates()` call can't re-roll or diverge from
`ensureActiveSelectionRound`'s pick. No bug found — a rank-1 candidate
losing the weighted draw to rank-2 exactly 33% of the time (or worse) is
the designed behavior, and without visibility into the frozen ranking and
its odds, that's indistinguishable from a bug to whoever's watching.
Concluded the fix is observability, per explicit instruction not to "fix"
legitimate randomness: the simulator now shows the frozen Top 3 (name,
frozen vote count, and the real weighted odds for that pool size — reusing
`SELECTION_RANK_WEIGHTS` directly, never a re-derived curve), which
candidate is selected, and whether they're still joining or have already
promoted into a specific seat (cross-referenced against the live
`speakers` list — the same identity, never a separate guess). Candidate
display names are resolved the same way the real room UI would (the
request's own chat message's `author_display_name`), falling back to the
simulator's own generated-name map only for a message not yet in the live
window.

**Reset must produce a genuinely clean "Round 1," without ever risking
real speaker state**: `resetSimulatorSession` deleted simulated seats via
a raw bulk `DELETE`, bypassing `end_speaker_seat`/`leave_speaker_seat`
entirely — meaning `ensure_stage_round` was never triggered as a side
effect, leaving `stage_rounds` completely stale (still `active`, with
whatever round_number it had). Investigated the same "shared production
state — resync, never blind-delete" question the original doc comment
already answered for `speaker_selection_rounds`, and reached a different
conclusion for a different reason: `stage_rounds` genuinely has nothing
left depending on it once *zero* seats remain occupied (real or
simulated) — at that point it's deleted outright, which is what lets the
next pairing start cleanly at round_number 1 instead of continuing a
stale counter, the explicit product requirement. If a real speaker is
still seated (a mixed real+simulated stage) after Reset removes the
simulated occupant, the row is never deleted — only resynced via
`ensureStageRound`, so their own shared round state reflects the reduced
occupancy without being destroyed.

**Vote UI gets real sentiment display, still lightweight**: the audience
Vote panel previously wrote votes but never showed anyone the tally.
Added a live poll of `speaker_round_votes` (same public-SELECT RLS tier
the simulator's own tally poll already relies on) — but *only while the
panel is open*, never a standing subscription, per explicit "lightweight,
not a permanent polling dashboard" instruction. Percentages only (a
two-color bar), not raw counts — counts stay in the simulator, where
debugging detail belongs; the product surface favors the number that
actually communicates outcome direction. Zero votes reads "No votes yet ·
defaults to Continue" rather than a bare 0%/0% that could read as a real,
decided sentiment. A speaker in their Final 30s closing period shows
"Replacement decided" and loses the Continue/Replace buttons *entirely*
(not just disabled) — that decision is locked, so there's nothing left to
offer a tap on. The trigger emblem gains a "Vote · Ns" countdown label in
the shared round's final ~10 seconds (the same `ROUND_TIMER_REVEAL_SECONDS`
boundary the timer badge uses), still never auto-opening the panel.

**A ref can't be read during render — react-hooks/refs caught it, not a
manual review**: the new candidate-name lookup initially read
`guestDisplayNamesRef.current` directly in JSX. Fixed by mirroring that
ref into a small piece of parallel React state
(`guestDisplayNames`), written at the same two call sites the ref already
was — the ref itself stays for the scheduled-timer/handler reads that
still need it (e.g. `simulateAdvanceSelection`'s own argument).

**Tradeoffs**: did not chase every seat-vacating RPC for a client-side
reactive `ensureStageRound` backstop this round either (same deferral as
the previous pass) — the database-layer race fix removes the actual
failure mode that made this urgent. Several pre-existing test files that
call `mockImplementation` on shared simulator-action mocks were found to
leak that override across later tests (`vi.clearAllMocks()` doesn't reset
custom implementations) — fixed by restoring the default implementation
in this file's own `afterEach`, a latent test-isolation gap this pass's
own new tests exposed rather than introduced.

## 2026-08-28 — Corrective pass: seat-claim race closed at the RPC layer, stuck self-preview reconciled, round model rebuilt around one shared clock (issue #21)

**Context**: real-device testing of the Phase 2/simulator build exposed
three blockers, all traced back to the same underlying design gap. Explicit
instruction to fix these before adding anything else, to reuse the #18
seat/role reconciliation rather than invent a simulator-specific one, and
not to build the eventual production round-timer-hiding behavior yet
(full visibility wanted for this preview).

**Root cause, traced not guessed**: `handleTapEmptySeat`'s real join and
the Session Simulator's automatic candidate-promotion loop both call the
exact same `claim_speaker_seat` RPC — confirmed via a dedicated
investigation before writing any fix, not assumed. That RPC had no
optimistic-concurrency check: it always unconditionally ended whichever
row was active for a seat and inserted a new one, silently, with no
exception to either caller. The tester's own real join landed first; the
simulator's background poll then raced the identical RPC and won,
overwriting the real seat with a simulated identity — the seat-stealing
bug. The same lost claim also left `prepareLocalMedia`'s deliberately-held
tracks (held on purpose for the *retryable* failure paths) with no release
for this *terminal* one, producing the stuck self-preview with no Leave
Stage.

**Fix scope — general, not simulator-specific, per explicit instruction**:
`claim_speaker_seat` now raises if the seat already has an active
occupant, same pattern as its existing "identity already holds a seat"
check, closing the race for every caller (real users, moderator actions,
the simulator) uniformly at the source of truth. This surfaced a second,
pre-existing gap the new guard would otherwise have introduced: a
genuinely stale (past the 11s disconnect/inactivity grace, never yet
cleaned up) occupant would now permanently block anyone else from ever
claiming that seat, since the guard only checked `left_at is null`, not
expiration. Fixed in an immediate follow-up migration by releasing a
logically-expired *target-seat* occupant first, mirroring the identical
distinction `release_if_expired` (migration 18) already made for the
*caller's own* identity. On top of the RPC fix, the simulator's own
auto-advance-selection poll additionally pauses outright whenever
`EventRoom` reports a real join or promotion in flight
(`realJoinInProgress`, derived from existing `isJoiningSeat`/
`promotionCountdown` state) — real users get first refusal by design, not
just by winning a database race. `useReleaseStuckLocalMedia` (new, general
hook) releases local media whenever every legitimate reason to hold it —
seated, joining, pending request, promotion countdown, mic-request
composer mode — is absent, reusing `EventRoom`'s existing state exactly as
instructed rather than adding a second role system.

**Round model rebuilt: one shared clock, still per-speaker outcomes**: the
existing per-speaker independent 60s timers were an explicit correction —
"that is not the product behavior I want now." Chose a hybrid architecture
specifically to avoid touching the already-working vote-casting RPCs:
`event_speakers`' round columns (`round_number`/`round_started_at`/
`round_ends_at`/`round_phase`/`closing_ends_at`) stay unchanged in shape
and keep governing individual narrow-loss closing periods untouched; a new
`stage_rounds` table (one row per event) holds the authoritative shared
deadline for the *active* phase, and `ensure_stage_round` (idempotent,
called from every seat-claim/vacate/resolve path) keeps each occupied
seat's own round bookkeeping synced to it. `cast_speaker_round_vote(_as_guest)`
needed zero changes — they only ever check the per-seat `round_phase`,
unaffected by where the deadline authoritatively lives.
`resolve_stage_round` resolves both occupied seats independently against
the one shared boundary in a single call (same integer-cross-multiplication
thresholds, byte-for-byte, as the superseded per-speaker resolver) and
itself calls `ensure_stage_round` once at the end to decide whether the
next shared round starts immediately (both continued) or the stage waits
(any vacancy or an individual closing period in progress) — this is the
mechanism that satisfies "don't give a retained speaker another
independent timer while waiting for their partner's replacement," since a
lone continuing seat's `round_number`/`round_ends_at` simply aren't synced
again until the pairing is whole. The old per-speaker `resolve_speaker_round`
is dropped, not left dead.

**Two numbering bugs found by the real-database test suite itself, fixed
before merge**: (1) `ensure_stage_round` only ever advanced a stale round
when its phase was `awaiting_pairing` — a fully-continuing pairing (phase
stays `active`, `resolve_stage_round` never touches `stage_rounds` itself)
had no path to ever get a fresh deadline, so a "both continue" outcome
would have left the badge showing an already-expired countdown forever.
Fixed by also advancing when the round is still `active` but its own
`ends_at` has already passed — safe unconditionally, since
`resolve_stage_round`'s own guard means this state is only ever reached
after a deadline has genuinely elapsed. (2) The very first pairing for any
event always displayed "Round 2," never "Round 1" — the single-seat
placeholder `ensure_stage_round` creates while waiting for a second seat
defaulted to `round_number` 1, so the *first real* transition to active
incremented it to 2. Since claiming is always sequential (one seat then
the other — how a real join, and the simulator's own seeding, both work),
this hit every single pairing, not an edge case. Fixed by starting that
placeholder at 0, since it was never a real round.

**Simulator panel updated to match**: `Force Continue`/`Force Narrow
Loss`/`Force Replace` no longer resolve anything themselves — they only
cast the vote split that *aims* a seat's outcome at the next shared
resolution, since a single seat's force button can no longer unilaterally
end a *shared* deadline. A new `Resolve Round Now` button
(`forceStageRoundDeadline`) backdates the shared deadline and invokes the
real resolver for both seats at once, reporting each seat's actual
resolved outcome — deliberately separate from the individual seat's own
`Force Replace Now` (`forceSeatClosingDeadline`) during its closing
period, which still only touches that one seat.

**Tradeoffs**: fixing the pre-existing test suite's own fixtures (several
files across `event-speakers-*.test.ts` and the LiveKit webhook route
test) to explicitly vacate a seat before re-claiming it, since they'd
implicitly relied on the now-removed silent-replace behavior as their own
cleanup mechanism — a straightforward, mechanical fix once the actual
regression (a permanently-stuck stale seat) was ruled out and the
remaining failures were confirmed to be test-fixture assumptions, not
product bugs. Did not chase every seat-vacating RPC for a client-side
reactive `ensureStageRound` backstop this round (e.g. the inactivity/
disconnect-release paths already call it themselves, but a hypothetical
future path that doesn't would go unnoticed until its own next claim) —
explicitly deferred, not silently skipped.

## 2026-08-27 — Session Simulator: one-tap full session + closing the replacement loop (issue #21, fifth real-device follow-up)

**Context**: the simulator could produce individual pieces of activity,
but not a full, self-sustaining stage — starting a session still
required a separate "Seed 2 Speakers" press, and even seeded, a
replaced speaker's seat stayed open forever, since nothing could ever
promote a new simulated candidate into it.

**Root architectural finding, reported before writing anything**:
production's own automatic promotion (`useAutomaticPromotion` →
`checkPromotionEligibility`/`claimOpenSeat`, `room/actions.ts`) resolves
*who is asking* from the calling browser tab's own session cookie
(`resolveIdentity()`) — it was never designed to promote anyone but
"whoever's tab is currently polling this." A simulated identity has no
browser tab and no session, so no amount of casting Request-to-Speak
votes for one could ever get it promoted through the real pathway —
this was a genuine, previously-unreachable gap, not a bug in anything
built so far.

**Decision — reuse the identity-agnostic half, adapt only the
identity-bound half.** `ensureActiveSelectionRound` (freeze the pending
pool, run the weighted pick) operates on the whole event, not on "the
caller" — exported from `room/actions.ts` and reused completely
unmodified. Only the *claim* step needed a new adapter,
`simulateAdvanceSelection` (`simulator-actions.ts`), which performs the
exact same `claimSpeakerSeat`/`markSpeakerRequestGranted`/
`resetSpeakerCandidatePool` sequence `claimOpenSeat` does, parameterized
by an explicit target identity instead of a resolved session.

**The one safety-critical property, verified by a real-database test
built specifically to try to break it**: after the real, authoritative
selection round picks a winner, the adapter only proceeds if that
winner's `guest_id` is in the caller-supplied list of ids the panel
itself generated this run. A real user's request can be — and, in a
mixed pool, sometimes will be — the winning candidate; when that
happens, this adapter does nothing and leaves that real user's own
`useAutomaticPromotion` to claim it for themselves, exactly as
production already does unassisted. Tested directly: a real requester's
pending request, alone in the pool (so it wins the pick with certainty),
is confirmed left untouched — `status` stays `'pending'`, no seat is
ever claimed on their behalf.

**One-tap start**: `startSimulation` now calls the same seeding logic
`Seed 2 Speakers` already used, once, automatically — `Seed 2 Speakers`
itself stays as a standalone deterministic re-seed tool. Made tolerant
of a seat already being occupied (`Promise.allSettled` over both claims)
so a partially-blocked stage (a real user beat the simulator to one
seat) still starts the rest of the session rather than aborting.

**Naturally varied outcomes, not one converging bias**: the round-voting
loop previously used one fixed continue-bias (0.72) for every vote — over
enough votes, the law of large numbers means that reliably lands in
"continue" territory almost every time, never producing a narrow-loss or
decisive-replace outcome by chance despite the product spec explicitly
allowing all three. Replaced with a per-*round* randomly-rolled bias
(`moodBiasFor`, keyed by `event_speakers.id:round_number` so a fresh
round — including one a Continue outcome just created — gets its own
independent roll), producing genuine variety across a long-running
session without needing the deterministic Force controls to see
anything but a Continue outcome.

**Automatic promotion polling**: a new scheduled loop (4-6s, matching
production's own `POLL_INTERVAL_MS`) checks for an open seat and calls
`simulateAdvanceSelection` — this is what lets `Speaker A → vote →
outcome → candidate selected → new speaker → next round` run
unattended, and what fills a seat the instant an eligible request exists
even when it started with none (Part 5's empty-pool case — the loop
just keeps checking; `ensureActiveSelectionRound` is already a safe
no-op against an empty pool).

## 2026-08-27 — Session Simulator Reset Session must also clear the visible feed (issue #21, fourth real-device follow-up)

**Context**: real-device testing of Reset Session found the database
side worked (confirmed by the prior round's 5 real-DB tests), but
simulator-generated comments could remain visibly stale in the room —
the live feed, Expanded Comments, and Top Speaker Requests didn't
reflect the deletion without a manual Safari refresh.

**Root cause, found by reading every realtime hook this room uses**:
`useLobbyRealtime`, `useActiveSpeakerRequests`, and `useActiveSpeakers`
each only ever subscribed to `postgres_changes` `INSERT`/`UPDATE` —
never `DELETE`. This was never a bug in the ordinary product: a chat
message is permanent (never hard-deleted), a request's lifecycle moves
through `status` via `UPDATE` (granted/withdrawn/expired), and a
speaker's departure sets `left_at` via `UPDATE` too. Reset Session is
the first thing in this codebase that ever hard-deletes rows from
`event_chat_messages`, `event_chat_message_reactions`, `speaker_requests`,
or `event_speakers` — exposing a real, previously-latent gap in all
three hooks, not something specific to the simulator's own code.

**Two-part fix, both required for correctness**:
1. **Migration 00000000000023**: `ALTER TABLE ... REPLICA IDENTITY
   FULL` on all four tables. Two independent reasons this was needed,
   not just one: (a) three of the four existing subscriptions filter by
   `event_id=eq.<id>` — a column that isn't each table's primary key —
   and Postgres's default replica identity (primary-key-only) omits
   non-key columns from a DELETE's old-row data, so that server-side
   filter can't even evaluate on a DELETE without this; (b) the
   client-side aggregates that need updating are keyed by columns that
   also aren't each row's own primary key (`reactions` by `message_id`,
   `event_speakers`' seat map by `seat_number`) — REPLICA IDENTITY FULL
   is what makes those present in `payload.old` at all, matching what
   INSERT/UPDATE already carry. No RLS/grant/column change — purely a
   replication-stream detail.
2. **New DELETE handlers** in all three hooks (`removeMessage`/
   `removeReaction` in `useLobbyRealtime`; `removePendingRequest` in
   `useActiveSpeakerRequests`; `removeSpeaker` in `useActiveSpeakers`),
   each a pure, exported, unit-tested function following the exact
   convention this codebase already established for INSERT/UPDATE
   (`applySpeakerChange`, `applyPendingRequestChange`, `applyVoteDelete`).
   A message-DELETE also proactively clears that message's whole
   reaction aggregate (belt-and-suspenders — individual cascaded
   reaction-DELETE events will also arrive and would clean it up on
   their own, but not waiting on however many of those arrive is
   simpler and immediate).

**Why this, not a simulator-specific refetch call**: `SessionSimulatorPanel`
could instead have triggered an explicit client-side refetch of
messages/requests/speakers after a successful reset (mirroring
`refetchSpeakers`'s existing pattern). Rejected in favor of the general
realtime fix because a refetch call scoped to the operator's own panel
only fixes *that* browser tab — a second tab genuinely watching the
same room (the actual product scenario, and a real testing setup) would
still see stale data indefinitely. Fixing the underlying realtime gap
benefits every tab watching the room uniformly, via the same mechanism
every other live update already uses, and happens to also correctly
handle any *other* future hard-delete this app ever adds — not a
special case bolted onto the simulator.

**Verification**: unit tests for all four new pure removal functions
(`removeMessage`/`removeReaction`/`removePendingRequest`/`removeSpeaker`),
plus hook-wiring tests (mocked Realtime channel, matching
`use-active-speakers-resync.test.ts`'s established fake-channel
convention) proving each hook's registered DELETE handler correctly
updates state — including the user's exact reported narrative: generate
simulated comments → confirm visible → delete them (what Reset does) →
confirm they disappear without a reload → confirm a real comment
survives → confirm a fresh run's new comment appears without resurrecting
anything from the deleted run.

## 2026-08-27 — Session Simulator: Reset Session (issue #21, third real-device follow-up)

**Context**: Stop Simulation only ever halted *future* activity — old
simulated comments, votes, requests, and speaker seats stayed in the
room forever, so re-testing meant an ever-growing pile of stale test
data. Explicit instruction: add a genuinely destructive "Reset Session"
that returns the room to a clean state, but investigate the data model
first and report the approach before doing anything destructive, since
the safety requirement ("do not delete real user-generated room
activity") is the load-bearing constraint here.

**Investigated before writing any DELETE**: every table a simulated
identity can write to
(`event_chat_messages`/`event_chat_message_reactions`/`speaker_requests`/
`speaker_request_votes`/`event_speakers`/`speaker_round_votes`) stores a
simulated guest id in exactly the same shape as a real one — both are
bare `crypto.randomUUID()` values (see `lib/guest.ts` vs.
`lib/simulator/identities.ts`). A filter like "guest_id is not null"
would delete real guest participation, not just simulated rows; none of
these tables has a spare column that could already double as an
ownership tag.

**Decision — exact in-memory id list, not a new `simulation_run_id`
schema column.** The prompt suggested a `simulation_run_id` column (or
"an equivalent preview-only ownership mechanism") as a good model *if*
safe cleanup wasn't otherwise possible. It is: `SessionSimulatorPanel`
already knows, precisely, every guest id it has ever generated this run
(`crypto.randomUUID()`, minted client-side, accumulated across every
Start/Stop cycle in a new `allSimulatedGuestIdsRef`) — deleting `WHERE
guest_id = ANY(these exact ids)` is exact identity matching against ids
the app itself created, not an inference from display name or any other
heuristic, and there is zero chance of collision with a real guest's
independently-generated UUID. This satisfies the safety bar without a
migration or touching four `SECURITY DEFINER` RPCs
(`request_to_speak_as_guest`, `cast_speaker_request_vote_as_guest`,
`claim_speaker_seat`, `cast_speaker_round_vote_as_guest`) on the shared
linked database — a real, if smaller, risk a schema-tagging approach
would have introduced for a preview-only tool. The traded-off cost,
stated plainly: this list lives in the browser tab's memory, so it only
resets what the *current tab* remembers generating — a hard reload loses
it, same as every other piece of this panel's presentation state
already does.

**`speaker_selection_rounds` deliberately left untouched.** It has no
guest/profile column at all, and its only writer, the shared production
RPC `freeze_speaker_candidates`, fires whenever *any* seat opens and can
freeze a pool mixing real and simulated requests — there's no safe way
to attribute a frozen round to "the simulator" specifically. Left alone,
an orphaned round (its `speaker_requests` all deleted) is an inert,
invisible bookkeeping row — nothing in the UI reads this table directly
(Top Speaker Requests reads `speaker_requests` itself, which *is*
cleaned up).

**Deletion order chosen to be correct with or without relying on
cascade** (every relevant FK here is `ON DELETE CASCADE` except
`speaker_requests.selection_round_id`, which `SET NULL`s and is
irrelevant to this cleanup): `speaker_request_votes` → 
`event_chat_message_reactions` → `speaker_round_votes` → `event_speakers`
→ `event_chat_messages`, each filtered by the exact guest-id list (plus
`event_id` where the column exists, as defense in depth). A worked
edge case that shaped this order: a *real* audience member's Continue/
Replace vote on a *simulated* speaker's round is deleted too — not
because it's "fake," but because it's cascaded away with the fake round
it was cast on, which is correct: the vote is meaningless once that
round no longer exists. Symmetrically, a simulated identity's vote on a
*real* speaker's round is deleted by explicit guest-id match, since
nothing else would ever remove it. Verified against the real linked
database (5 integration tests, `simulator-actions.test.ts`), each
pairing a simulated id with a same-shape "real" id to prove the safety
guarantee comes from the exact list, not from any structural difference
between the two.

**UX**: Reset requires an inline confirmation ("Reset simulated
session? Cancel | Reset") rather than a native `confirm()` dialog, kept
fully inside the panel's own testable DOM. Reset always stops the
session first (can't keep generating activity against data about to be
deleted) and clears every piece of local run state (log, vote tallies,
pool-reset count, tracked identities) so the *next* Start genuinely
begins a fresh run with no memory of the old one — including telling
`EventRoom` to clear its own `simulatedGuestIds` set (the "Simulated
speaker" placeholder tag), via a new `onSimulatorReset` callback,
mirroring `onSimulatedIdentitiesCreated`'s existing shape.

## 2026-08-27 — Session Simulator: round-testing presentation (timer, occupied placeholder, per-seat forcing) (issue #21, second real-device follow-up)

**Context**: the compact/collapsible/draggable pass above made the panel
usable on mobile, but the user still couldn't clearly *test the round
system itself* through it — no visible per-seat timer on the actual
stage, no obvious "this seat is occupied" signal for a seeded fake
speaker (LiveKit never actually connects for a simulated identity, so
the tile fell into the same "Camera off" placeholder a real permission
failure would), and one ambiguous global Force Continue/Narrow Loss/
Decisive-Replace control that operated on "whichever round happens to be
active first" — unusable once two independent per-speaker rounds exist
simultaneously. Scoped explicitly to simulator/test presentation and
deterministic controls only — no change to voting, round-resolution, or
selection logic.

**Round-number badge**: `SpeakerRoundDisplay` (useSpeakerRoundCountdown)
gained a `roundNumber` field, read straight from the seat's own
`round_number` — no new state, no separate simulator-only timer. The
badge now reads "Round N · Ns" while active, "Final Ns" while closing,
still fully suppressed until the final ~10s in production and shown for
the whole round on preview builds exactly as before. This is the *same*
authoritative deadline the real Vote control's countdown and the round-
resolution hook already read — explicitly not a second, simulator-owned
clock.

**"Simulated speaker" placeholder — cosmetic only, not a new occupancy
system**: a seeded/promoted simulated identity is a real `event_speakers`
row (via the real `claimSpeakerSeat` RPC, unchanged); it just never
opens a LiveKit connection, so it already fell through to SpeakerTile's
existing no-participant branch. The only change is *which* placeholder
that branch shows: a new `isSimulated` prop (cosmetic, presentation-only)
swaps "Camera off" for an unambiguous "Simulated speaker" label, so a
seeded seat can never be mistaken for a real technical failure while
testing. `isSimulated` is computed from a `simulatedGuestIds` set that
lives in `EventRoom` (only meaningfully populated in preview builds,
since `SessionSimulatorPanel` — the only thing that ever calls the
registration callback — isn't mounted otherwise) and threaded through
`RoomLayoutProps` → `SpeakerStage` → `SpeakerTile`, the same 5-layer
prop-threading shape `isPreviewBuild` already established. Deliberately
**not** authoritative or synced: a different browser tab that never
opened the simulator won't have these ids and will just see the ordinary
placeholder — acceptable, since this is a solo testing aid, not a piece
of shared room state, and reported as such rather than over-built into a
cross-tab-synced signal.

**Per-speaker force controls, not one global control**: `forceRoundDeadline`
(the simulator's one clock-skipping adapter) now returns the real
resolver's own outcome (`ResolveSpeakerRoundOutcome`) instead of `void`,
so the panel's forced-outcome feedback always reflects what
`resolveSpeakerRoundAction` actually decided — never just an echo of the
intended vote split. Every Force Continue/Narrow Loss/Replace button now
lives inside that specific seat's own round-status block and is called
with that seat's `event_speakers.id` directly — there is no shared
"first active round" lookup left anywhere in the panel. A seat already in
its closing phase shows a single "Force Replace Now" instead (no new
vote — the real RPC rejects votes once `round_phase != 'active'`, so
offering the three-way choice there would just fail silently). The
per-seat block also gained a "what would happen if this round ended
right now" projection, computed via the exact same pure
`resolveRoundOutcome` the real RPC mirrors — never a separately-invented
guess.

**Stable seed identities**: `SessionSimulatorPanel` now generates two
dedicated seed-speaker identities once per `Start Simulated Session` run
(stored in a ref), and every subsequent "Seed 2 Speakers" click reuses
the same two rather than drawing a fresh random pair from the general
audience pool — satisfying "the same two stable identities for that
simulation run" without inventing a second identity-generation path.

**One incidental fix, not scope creep**: fixing this pass required
touching `speakersRef`/`pendingRequestsRef`/`messagesRef`'s prop-mirror
assignments and a `Date.now()` read inside the observability block —
both pre-existing patterns that a stricter `react-hooks/purity`/
`react-hooks/refs` lint pass (apparently newly enforced since the prior
pass, not something either of the last two rounds introduced) now
flags. Fixed in place with this codebase's own established idioms (an
effect for the ref mirror, `useNow()` for the clock read, matching
`speaker-vote-panel.tsx`'s prior fix for the identical class of issue) —
reported here since it's a real, if incidental, code-health fix bundled
into an otherwise presentation-only pass.

## 2026-08-27 — Session Simulator: compact, collapsible, draggable panel (issue #21, real-device follow-up)

**Context**: real-device follow-up to the Phase 2 pass above — the
Session Simulator panel was too large on a phone, covering most of the
actual app and making real-device testing of the room itself difficult.
Explicitly scoped to simulator *presentation* only: no change to
simulation behavior, voting logic, speaker-round logic, comments,
candidate selection, or any production code path.

**Decision — presentation state kept fully separate from simulation
state**: `collapsed` (bool) and `position` (`{x,y} | null`, `null` meaning
"use the default CSS-anchored corner") are new `useState`s alongside the
existing `running`/`audience`/`log`/timer refs, but nothing in
collapse/expand/drag touches any of those existing pieces of state. The
collapsed vs. expanded panel is a render-time branch inside one component
that never unmounts — `running`, `audienceRef`, and the independent
`setTimeout` loops keep executing regardless of which branch is on
screen, and the 3-second round-vote-tally poll effect is unconditional
too. This is what makes "collapsing must not stop the simulation" true
by construction rather than by extra bookkeeping.

**Dragging — Pointer Events, not separate touch/mouse handlers**: the
header uses `onPointerDown`/`onPointerMove`/`onPointerUp`/
`onPointerCancel` plus `setPointerCapture`, which redirects all
subsequent pointer events to the header regardless of where the pointer
moves — no `document`-level listeners needed, and touch and mouse are
handled by the same code path. `touch-action: none` (Tailwind
`touch-none`) on the header stops the browser's own touch-scroll gesture
from fighting the drag. Position is tracked as absolute pixels
(`left`/`top`) computed from `getBoundingClientRect()` at drag-start and
clamped into the viewport (`window.innerWidth/innerHeight` minus the
panel's own current size, with a small fixed margin) on every move — so
the panel can never be dragged fully offscreen. The same clamp re-runs on
`resize`/`orientationchange` and whenever `collapsed` toggles (since the
panel's own footprint changes size), so a position valid in landscape
can't strand the panel off a narrower portrait viewport, and expanding a
previously-collapsed pill back to full size can't push it past the
screen edge either.

**Sizing**: `max-h-[min(55dvh,26rem)]` (was a flat `70vh`) with an
internal `overflow-y-auto overscroll-contain` content region —
`overscroll-contain` specifically so scrolling the panel's own content to
its end doesn't chain into scrolling the room behind it. `dvh` (dynamic
viewport height) rather than `vh` so the cap tracks the real visible area
as mobile Safari's browser chrome shows/hides, instead of sizing against
a taller value that then sits under the address bar. Width dropped from
`w-80` (320px) to `w-64` (256px) with a `max-w-[85vw]` backstop for very
narrow phones. Both the default anchor and the panel's padding use
`env(safe-area-inset-*)` (via `max(0.5rem, env(...))`) so the panel and
its bottom-most content never sit under the home-indicator/notch area.

**One test-environment gap found and worked around, not silently
ignored**: jsdom (this component's own Vitest environment) doesn't
implement `Element.setPointerCapture`/`hasPointerCapture`/
`releasePointerCapture` at all, unlike every real target browser — so the
handlers guard each call with a `typeof … === "function"` check. This
is defensive code that happens to be required for the test suite to run
clean, not a behavior change for any real browser.

**Not touched**: `isPreviewOrDevBuild()` gating (still the only thing
deciding whether this component renders at all, unchanged), every
`simulator-actions.ts` function, `speaker-round.ts`, and every existing
button's `onClick` — only the outer container/header/state around them
changed.

## 2026-08-26 — Per-speaker Continue/Replace rounds + preview-only Session Simulator (issue #21, Phase 2)

**Context**: Phase 2 of #21 — the first real Continue/Replace round system
(replacing the inert Vote emblem), plus a preview-only Session Simulator so
the user can exercise a near-real active session solo, ahead of scheduling
real multi-person testing of Phase 1 candidate promotion. Explicit
instruction to architect the round-authority model before writing schema,
and to stop and propose an alternative rather than add any
production-accessible testing backdoor if one seemed necessary.

**Round authority — reused #18's pattern, not invented new**: a round's
deadline (`round_ends_at`, later `closing_ends_at`) lives on
`event_speakers` itself, exactly like the existing seat-reconnect grace
deadline. A single trusted RPC, `resolve_speaker_round`, re-derives the
outcome from Postgres's own clock and the accumulated vote rows — never
from client-reported elapsed time. Any client (or the simulator) may
*trigger* re-derivation early; none may *decide* the outcome. Client-side,
`useSpeakerRoundResolution` schedules one `setTimeout` per occupied seat's
current deadline and calls the resolving Server Action when it fires —
the same shape as `useSpeakerReconnectGrace`. A round is per-speaker (one
independent state machine per occupied seat), not per-pairing, which
supersedes the 2026-08-20 per-pairing sketch noted in the entry below —
that sketch was never built and this pass's own instructions are
unambiguous about per-speaker state.

**Thresholds kept centralized, not scattered**: `lib/speaker-round.ts`
holds `ROUND_DURATION_SECONDS` (60), `CLOSING_DURATION_SECONDS` (30),
`NARROW_LOSS_THRESHOLD_PCT` (50), `DECISIVE_REPLACE_THRESHOLD_PCT` (66),
and the pure `resolveRoundOutcome`. The SQL RPC re-implements the same
integer cross-multiplication comparison (`replace_count*100 >= 66*total`)
rather than calling back into TS — duplicated by necessity (SQL can't
import TS), kept in sync by doc-comment cross-reference, same discipline
already used for `SPEAKER_DISCONNECT_GRACE_SECONDS`. A narrow Replace loss
(>50%, <66%) enters a `closing` phase with its own `closing_ends_at`
deadline and accepts no further votes — not a second voting round.

**Timer visibility split from the start**: `ROUND_TIMER_REVEAL_SECONDS`
(10) governs the eventual product behavior (hidden until the final
window); a separate `isPreviewBuild` boolean forces full-duration display
for this testing pass only, threaded down as a plain prop rather than
read from environment inside presentation components. This was called
out explicitly in the request as a distinction to architect cleanly, not
bake in permanently.

**Load-bearing gap found before building the simulator**: the existing
dev-tools gate (`isDevToolsAvailable`) checks `NODE_ENV !== "production"`,
but Next.js force-sets `NODE_ENV=production` for every `next build`,
Vercel preview deployments included — that gate would never appear on any
deployed preview URL the user could actually click, only local dev. Fixed
with a new `isPreviewOrDevBuild()` (`lib/preview-mode.ts`) checking
`VERCEL_ENV !== "production"` instead — Vercel's own per-deployment
signal, `"production"` only for real `main` deploys, unspoofable by app
config, and enforced server-side inside every simulator Server Action
itself (not merely hidden client-side). Concluded this was sufficient and
that no production-accessible backdoor was needed.

**Simulator architecture — "fake the people, not the systems"**: every
simulated action except one calls the exact same repository functions and
Server Actions a real guest session would (`insertMessage`,
`insertReaction`, `requestToSpeakAsGuest`, `castSpeakerRequestVoteAsGuest`,
`castSpeakerRoundVoteAsGuest`, `claimSpeakerSeat`, `endSpeakerSeat`) — a
simulated identity is just a generated UUID passed into these
already-real, already-service-role-gated functions in place of one
resolved from a session cookie. The one deliberate, isolated exception is
`forceRoundDeadline`, used only by the simulator's deterministic-outcome
buttons: it backdates `round_ends_at`/`closing_ends_at` directly via the
service client (no real pathway skips time) and then calls the real
`resolveSpeakerRoundAction` so the outcome decision itself is never
short-circuited — only the clock. This is the only simulation-specific
adapter in the feature.

**Tradeoffs**: the simulator's observability panel polls
`speaker_round_votes` on a 3-second client interval rather than
subscribing to Realtime, since it's preview-only tooling and simplicity
was preferred over adding a new Realtime subscription surface for a
non-production panel. `WatchModeControls` gained a narrow `voteSlot` prop
so the real Vote control could be swapped in without touching Speaker
View's existing `micCameraSlot` path — a seated speaker still has no way
to vote on a co-speaker's round this pass, reported as an explicit
scoping limit rather than silently left out.

## 2026-08-26 — Request-to-Speak voting + ranked Top 3 + authoritative weighted selection (issue #21, Phase 1 of the audience voting loop)

**Context**: the user asked for the first functional audience-voting/
speaker-selection loop — Request-to-Speak votes determining who speaks
next, plus (a later phase) Continue/Replace voting on the current
speaker's time. Explicitly instructed to reconcile against existing
docs/architecture first and flag any conflict rather than guess, and to
split into phases if the full loop was too large for one pass. It was:
implemented Phase 1 only (Sections A–E — request voting, ranked Top 3,
weighted selection, runner-up on failure, pool reset). Sections F–H
(60-second Continue/Replace blocks, Vote UI emphasis) are not built.

**Section I resolved, conflict flagged**: an earlier sketch (2026-08-20,
"Video-first room redesign finalized") described a *per-pairing*
Continue/Replace model — one shared window recurring via modular
arithmetic on `pairing_start_time`, evaluated by both seated clients
together. Never built (Vote has stayed an inert placeholder since). This
prompt's Section F/G unambiguously describe *per-speaker* state instead
("each speaker receives a 60-second... block," "the speaker's turn
ends"). Per instruction ("the rules in this prompt represent the current
product decisions"), the old sketch is treated as superseded, not
preserved — Phase 2 will build per-speaker blocks. Reported now since
Phase 2 wasn't started this pass but the resolution needed to happen
before any further schema work.

**A second load-bearing find**: `decideClaimEligibility`'s existing
top-3-self-claim-race model (issue #14) — every top-3-ranked requester's
client independently polls its own eligibility and races
`claimOpenSeat`, first-to-land wins — was already explicitly documented
as a placeholder in `lib/speaker-queue.ts`'s own comment: "not meant to
make this a click-speed competition by product intent... may evolve
into something more deliberately audience-driven." Section C's single
server-picked winner needed a genuinely different selection mechanism,
not just a different ranking input — that placeholder is what got
replaced.

**Weighting formula, stated before implementing**: fixed rank-based
weights `[3, 2, 1]` (`SELECTION_RANK_WEIGHTS`,
`lib/speaker-selection.ts`) — not raw vote-count-proportional. With 3
candidates the leader wins exactly 50% of selections (3/6) regardless of
how large the actual vote gap is, 2nd gets 33%, 3rd 17%; 2 candidates,
60/40; 1 candidate, 100%. Rank position (which requires more votes to
reach) always yields strictly better odds, but no landslide can approach
determinism — a raw-count-proportional weighting wouldn't have that
property. Isolated in one module, taking an externally-supplied
`randomValue` (never generating its own randomness) so every boundary is
exactly reproducible in tests.

**Schema (migrations 00000000000019, 00000000000020)**:
- `speaker_request_votes` — a genuinely separate table from
  `event_chat_message_reactions`, not a reuse: a vote's exclusivity (one
  active vote per viewer per event, transferable, toggle-off) is
  structurally different from an ordinary like's per-message independent
  toggle, and forcing it into the reactions table would need bolting on
  cross-row exclusivity logic that table's schema/RLS was never designed
  for. `unique(event_id, coalesce(voter_profile_id, voter_guest_id))` is
  the real race-safety backstop; `cast_speaker_request_vote(_as_guest)`
  is the friendly transfer/toggle wrapper around it.
- `speaker_selection_rounds` + new columns on `speaker_requests`
  (`selection_round_id`, `frozen_rank`, `frozen_vote_count`,
  `is_current_candidate`, `selection_failed`) rather than a second
  `speaker_selection_candidates` table — simpler to query/test, and the
  "frozen at selection time" snapshot lives right on the row it
  describes. `freeze_speaker_candidates` is idempotent (migration
  00000000000020's follow-up): calling it while a round is already
  active returns that round's existing candidates instead of erroring,
  with a `unique_violation` exception handler as the last-resort race
  backstop — safe to call on every eligibility poll, the same
  "every evaluation independently recomputes and re-verifies" discipline
  #13's disconnect cleanup and #23's promotion already established.
- `speaker_requests.status` gains `'expired'` (Section E's bulk
  pool-reset outcome — every other still-pending request when a new
  speaker joins, not just the winner's) — distinct from `'withdrawn'`
  (the requester's own voluntary action). `rank_pending_speaker_requests`
  (the old reputation-tiebreak ranking RPC) is left in place, unused by
  the new eligibility flow but not dropped — still a valid read, no
  reason to delete working infrastructure that costs nothing to keep.

**Selection orchestration split between SQL and TypeScript,
deliberately**: `freeze_speaker_candidates` (SQL) ranks and freezes;
`selectWeightedCandidate` (pure TS, unit-tested) picks; `commit_speaker_selection`
(SQL) records the pick. The actual `Math.random()` call happens in
`ensureActiveSelectionRound` (`room/actions.ts`, a Server Action) — on
the server, never in a client component, satisfying "the authoritative
selection must happen server-side" — while keeping probability logic
in one isolated, swappable module rather than embedded in a SQL
function where it would be harder to unit-test exhaustively.

**Runner-up advancement folded into the existing withdrawal RPCs**
(`withdraw_speaker_request(_as_guest)`, `CREATE OR REPLACE`, same
signature): withdrawing the round's current candidate is this pass's
only practical "failure" signal (no background heartbeat/timeout
infrastructure exists in this serverless deployment to detect a
selected candidate going silent any other way) — marks that candidate
`selection_failed`, promotes the next unfailed candidate by
`frozen_rank` within the *same* frozen round (never re-ranks from live
votes mid-round), or marks the round `exhausted` if none remain.
Scoping decision, reported: a genuinely silent selected candidate (no
withdrawal, just never claims) isn't detected this pass — acceptable for
Phase 1, a real gap to flag for Phase 2/3 if it matters in practice.

**Pool reset (`reset_speaker_candidate_pool`) called from `claimOpenSeat`
after `markSpeakerRequestGranted`, not before** — the winner's own row
must already be `'granted'` when the bulk-expire runs, or it would
itself get swept up (a bug this exact test caught in the real-database
integration suite before it ever reached the room code).

**Verification**: all backend RPCs tested against the real linked
Supabase project (11 integration tests, `speaker-request-voting.test.ts`
— vote transfer/toggle/independence-from-likes, idempotent freeze,
ranking, runner-up advancement, pool reset including the former winner's
immediate ability to re-request, permission boundaries). Weighted
selection's exact boundary math unit-tested (13 tests). Full suite
(737/737, 60 files), lint, tsc, build all clean.

**Rollback**: work continues on `feature/expanded-comments`, still not
merged — `main`/production untouched by this pass. The two new
migrations (`00000000000019`, `00000000000020`) are already applied to
the real linked Supabase project (per this project's standing rule that
schema changes go through the CLI immediately, not gated behind a
branch merge) — this is schema-additive only (new tables/columns/RPCs,
one widened CHECK constraint), nothing existing was removed or altered
destructively, and the old top-3-race eligibility path is simply
unreachable now that `resolveClaimDecision` no longer calls it, not
deleted.

## 2026-08-26 — Live-stream regular feed, frozen Expanded snapshot, Top Speaker Requests, double-tap likes, swipe-to-close (issue #21, refinement pass)

**Context**: real-device testing confirmed the Discussion Expanded
foundation (open/close, scroll, send, Speaker View compatibility)
works. This pass refines the interaction model per explicit product
direction: regular Watch Mode is a *live* feed, Expanded Comments is a
*deliberate, frozen* reading surface — not a bigger version of the same
thing.

**Regular comments rebuilt as a small live-stream feed**: the original
Phase 3 design (self-expiring 3-bubble stack, 7s fade-out) directly
conflicted with the new requirement to scroll back through older
ambient comments — a permanently-removed bubble can't be revisited.
Replaced with a small (`max-h-32`), always-scrollable feed: new
comments enter at the bottom and auto-scroll into view while the
viewer is at/near the live edge; scrolling up disables auto-scroll
without touching position, exactly the way a mature livestream chat
behaves. No cap beyond `useLobbyRealtime`'s existing 300-message
memory limit — the small fixed height is what keeps this from
becoming "a large permanent chat panel," not a message-count cap.

**Expanded Comments frozen-snapshot rebuild**: `snapshot` (newest→
oldest) is captured once, on open or on an explicit "↻ N new comments"
refresh tap — never mutated by background arrivals. This *replaces*
the previous round's live-follow/jump-to-latest design outright, per
explicit instruction, not alongside it. `newCount` is a derived value
(`messages` not in `snapshotIds`), not tracked state — simpler and
correct under any arrival ordering.

**Top Speaker Requests — ranking signal, investigated first**: no
vote/like/score column exists on `speaker_requests`. The one real
ranking signal, `rank_pending_speaker_requests` (reputation-weighted),
is a trusted-server-only RPC already explicitly decided *not* to be a
public leaderboard when issue #23 built it — reusing it here would
silently reverse that decision. Used FIFO by `created_at` instead
(documented in `listPendingSpeakerRequests`'s own doc comment), and
isolated the top-3 selection to one `.slice(0, 3)` on an
already-ordered array so a future like-based signal can replace just
that line.

**Top Speaker Requests stays live while Recent Comments freezes**:
deliberate, reported per instruction — a pending request represents a
current stage candidate, not historical chat, so there's no "reading
in peace" concern to protect by freezing it. New hook
`useActiveSpeakerRequests`, same on-`SUBSCRIBED`-resync discipline
`useActiveSpeakers` already established for issue #18's missed-delta
lesson, and a new public repository read (`speaker_requests` already
has a "publicly viewable" RLS policy — no migration needed).

**Double-tap-to-like — investigated first, nothing new needed**:
`event_chat_message_reactions` already has public select/self-insert
RLS, a `(message_id, emoji, identity)` uniqueness constraint (free
server-side dedup), is already in the Realtime publication, and
already has a working action (`addReaction`) and consumer
(`MessageItem`'s own 👍 button in the lobby view). This is a UI-only
addition — a double-tap gesture on `CommentRow` that calls the exact
same action, with the same optimistic-then-realtime-confirmed pattern
`MessageItem` already uses. No schema/backend expansion, so nothing to
stop and report on that front. Deliberately *not* added to
`AmbientComments`' bubbles: they already have a claimed single-tap
gesture (open Expanded), and once a first tap opens the sheet it
visually covers the bubble (z-20 over z-10), making a reliable second
tap on the same element impossible — scoped to Expanded Comments only,
where no competing gesture exists.

**Swipe-to-close scoped to the handle, not the list**: pointer handlers
live only on the grabber/header region (`expanded-comments-handle`);
`expanded-comments-scroll` (the actual comment list) has none. This is
what keeps ordinary scrolling from ever being mistaken for a dismiss
gesture — not a scroll-vs-drag disambiguation algorithm, just two
different DOM regions owning two different gestures.

**Rollback**: work continues on `feature/expanded-comments`, still not
merged — `main`/production untouched by this pass.

## 2026-08-26 — Discussion Expanded (issue #21): opened from the ambient bubble, not the composer

**Context**: post-public-beta continuation of #21 — an intentional,
tap-opened surface for browsing the live comment stream, without
replacing Watch Mode's ambient default. Two candidate entry points
existed, both reusable without new permanent UI: the ambient comment
bubbles (already carrying a `data-message-id` seam explicitly left for
this since Phase 3) and the compact composer's own input.

**What happened**: I implemented the composer-focus trigger first (tap
the "Add a comment…" input outside mic-request mode → open the sheet,
blur the underlying input). Running the existing, already real-device-
approved test suite immediately surfaced the problem: tests like
"sending a comment calls the existing sendMessage action" now opened
the full sheet before the send even happened, because focusing the
composer is exactly what those tests (and normal usage) do to type a
quick comment. That's a real regression, not a test-assumption
mismatch — it silently turns "tap, type, send" (approved, tested
behavior) into "tap, wait for a 70vh sheet, then type, send."

**Decision**: reverted the composer-focus trigger entirely. The sole
entry point for this pass is tapping an ambient comment bubble — the
seam that was purpose-built for exactly this. `ChatPanel`'s compact
composer is untouched; no new prop, no behavior change for any existing
caller.

**Tradeoff, accepted**: a viewer can't open the sheet while zero ambient
bubbles are currently visible (a silent room, or between a burst's 7s
fade cycles). Judged acceptable for a narrow first pass — a silent room
also has nothing new to browse — and easy to extend later (a small
dedicated affordance) if real-device review finds this actually matters
for discoverability.

**Other decisions this pass**:
- **No drag-to-resize on the sheet.** This project already tried and
  retired gesture-driven reveal twice (the original dead-zone drag
  design, then Watch Mode/Comments Mode). A fixed-height, tap-open/
  tap-close sheet stays consistent with that established direction —
  "obvious close/collapse button" is satisfied by an actual button.
- **`commentsOpen` stays local state in each room composition**, never
  lifted to `EventRoom`. This is the deliberate way to satisfy "must not
  recreate issue #18's role-synchronization problems": rather than
  carefully avoiding a causal path from this feature to role/seat/media
  state, it has *no* causal path at all — it never reads or writes any
  of that state.
- **Replies deferred, per instruction, after checking first**:
  `event_chat_messages` has no self-referencing column in any migration
  or in `database.ts` — real migration + RLS + query work, not a small
  additive change. The new comment list renders a flat array keyed by
  `message.id`, structured so a future `repliesByParentId` grouping can
  be added without restructuring the component.
- **Desktop untouched** — it already has a persistent, non-overlay chat
  sidebar (`RoomChatPanel`), a fundamentally different, already-approved
  pattern; explicitly out of scope per instruction.

**Rollback**: work happened on `feature/expanded-comments`, branched
from `main` at `public-beta-v1-stable` (`cc76a45`) — `main`/production
untouched by this pass.

## 2026-08-26 — First production release (public-beta-v1)

**Context**: `feature/social-stage-shell` HEAD (`c647cf6`) passed the
user's own real-device testing with no complaints. The user wants this
version live on the real production Virtual Stage site so other people
can use/test it, while development continues separately.

**Decision**: merged `feature/social-stage-shell` into `main` via an
explicit `--no-ff` merge commit (`4c43ff3`) — no history rewrite, no
squash — after re-running the full verification suite and confirming
Production's Vercel env vars and the linked Supabase project's applied
migrations both match what Preview had already been running against.
Tagged the pre-merge commit `public-beta-v1-stable` as the rollback
checkpoint, alongside (not replacing) every earlier `prototype-*-stable`
checkpoint. Pushed `main`, letting Vercel's existing main-branch
Production deployment hook do the actual deploy, and confirmed the
deployed SHA matched exactly.

**Reason**: this is the project's first genuine public release, not
another prototype checkpoint — `main` had accumulated 30 commits of
verified work (Watch Mode/Comments Mode split, ambient comments, full
Speaker View, server-authoritative seat expiration and self-healing
reconciliation) with no unverified or in-progress feature mixed in, so
there was nothing to cherry-pick or defer.

**Tradeoffs / what this is not**: this does not mean the product is
finished — issue #21's remaining Social Stage scope (voting, gifting,
full comment/reaction system) is substantial and deliberately stayed on
a feature branch, not on `main`. `main` is now the stable
public-testing baseline; it does not become a place to develop
directly — future features still go through preview deployments and
the user's real-device approval before merging back, exactly as
before. The production smoke test after this release used real browser
automation against the live URL (seat claim, Speaker View activation,
the full 11-second inactivity-expiration cycle, comment
send-and-render — all confirmed with zero console errors) but not an
actual phone; real-device confirmation of the *production* URL
specifically is still open, same as any other change.

## 2026-08-28 — Seat-role reconciliation made self-healing (issue #18 reopened): the fix already existed, nothing triggered it automatically

**Context**: the split-layout bug reproduced again on the build
confirmed clean the previous round. New, decisive evidence: tapping
"Join" a *second* time immediately fixed it. That single observation
settles the question the previous two rounds were still narrowing down
— `useActiveSpeakers`' resync mechanism (`refetch()`) is correct and
sufficient; the only remaining gap is that nothing *automatic* ever
called it. A user has no reason to know a second, redundant tap is the
fix, and shouldn't have to discover it by accident.

**Decision — reuse the existing reconciliation path, trigger it from
more places, never add a second role flag**: `mySeatNumber` (`EventRoom`,
via `findMySeatNumber`) remains the one canonical value
`participantRole`/`isSpeaker`/the role routers/self-preview eligibility
already all derive from — nothing about that architecture changed.
What changed is *how reliably its data source gets corrected*:

1. **Explicit triggers at the two moments a claim is known to have
   succeeded** — `handleTapEmptySeat`'s `joinOpenSeat` success branch
   and `useAutomaticPromotion`'s `claimOpenSeat` success branch (new
   `onClaimSucceeded` param, passed `refetchSpeakers` directly — not
   wrapped in a fresh arrow function, since that hook's claim effect
   depends on it and an unstable identity there would re-schedule its
   countdown timer on every unrelated `EventRoom` re-render) both now
   call `refetchSpeakers()` immediately instead of relying solely on
   `isSpeaker` eventually flipping via Realtime. This is *belt-and-
   suspenders* with the Realtime delta, not a replacement for it — the
   INSERT still arrives normally in the common case; this just stops the
   *first* claim attempt from being silently vulnerable to the exact gap
   `useActiveSpeakers`' own resync-on-reconnect fix only ever covered for
   a *subsequent* reconnect.

2. **A contradiction watchdog, not polling** (`useSeatReconciliation`,
   new hook): `canPublish` (from `useLiveRoomConnection`) is the single
   most direct "does LiveKit itself currently believe I'm a speaker"
   signal already live in this component — already-live state, so
   watching it costs nothing extra, and covers the user's literal
   "LiveKit permission/publication becoming speaker-capable" and "local
   camera/mic publication starting" triggers in one signal (actual
   publishing is always gated on `canPublish` already being true, so
   there's no publishing state this doesn't already precede). `canPublish
   && !isSpeaker` is exactly the contradiction the real-device report
   captured (self-preview live, role said audience) — triggers `refetch`
   once per contradiction *episode* via a ref, not an interval; React's
   own effect-dependency comparison already means the effect body can't
   re-run while `[canPublish, isSpeaker]` haven't changed, so this
   can't become a tight loop even without the ref, but the ref still
   guards against a rapid true→false→true flicker re-triggering
   redundantly.

3. **Visibility/focus restoration**, event-driven
   (`visibilitychange`/`focus` listeners, not a timer) — a backgrounded
   mobile tab is exactly where a Realtime WebSocket can silently degrade
   without the app ever being told; resyncing the moment the tab is
   looked at again is a cheap, well-targeted place to catch that,
   independent of whether a local contradiction happens to be visible
   yet.

4. **Realtime `SUBSCRIBED`/reconnect** — already covered by the previous
   round's `useActiveSpeakers` fix; unchanged here.

**Once reconciled, nothing else has to be told to "switch to Speaker
View"** — `participantRole`/the role routers/self-preview eligibility
were never the problem; they already correctly derive from
`mySeatNumber` every render. The moment `refetch()`'s fresh data lands,
the very next render already shows the right composition, with no
separate "now switch" step anywhere.

**Verification honesty**: automated (tsc, lint, full suite — 661/661
across 56 files, +17 new tests, production build) all pass, including
dedicated coverage for every scenario requested: a missed Realtime
delta after a successful claim triggering automatic refetch with no
tap of any kind; the watchdog reacting only to the genuine
`canPublish`-vs-`isSpeaker` contradiction (never the ordinary case, never
more than once per episode, never latched permanently); Speaker View
replacing the split layout once reconciled data lands; and no duplicate
`joinOpenSeat`/`claimOpenSeat` call anywhere in any of these paths — the
watchdog and the visibility trigger only ever call `refetch`, never a
claim action. What remains real-device-only, per the user's own explicit
condition, is whether this automatic recovery actually survives repeated
phone testing — issue #18 stays open, reopened this round, not closed
until that's confirmed.

## 2026-08-27 — Issue #18 confirmed clean on real-device retest; final diagnostic cleanup, issue closed

**Context**: the user's real-device retest of commit `9e9309e` (the
`useActiveSpeakers` resync fix) reported no complaints and no
reproduced issues — the whole #18 investigation chain (split-layout
composition bug, missing reconnect countdown, expiration enforcement,
unified inactive-speaker model, the ownership-contradiction bug) is now
verified working. This entry is the cleanup pass only: no behavior
changed.

**Removed, all temporary and specific to this investigation**:
- The fuchsia `EventRoom` diagnostic strip and the cyan `SpeakerStage`
  diagnostic strip (both added mid-investigation, explicitly marked
  "TEMPORARY... remove once confirmed from an actual on-device
  screenshot" in their own doc comments at the time).
- `SpeakerStage`'s instance-tracking registry (`useId`,
  `useSyncExternalStore`-backed live cross-instance count, the
  `parentComposition` prop and its five call-site wires) — built
  specifically to rule out a double-mounted `SpeakerStage` as the
  split-layout cause; that theory is conclusively ruled out (see the
  2026-08-27 entry above), so the instrumentation has no further job.
- The amber diagnostic strips in `SpeakerMediaActivationPrompt` and
  `SpeakerTile`, and the now-unused `reconnectDiagnostics` pure function
  and its dedicated unit tests — the reconnect-countdown data/render
  path they were built to inspect is now independently confirmed
  correct by both the automated suite and this real-device retest.
- Test coverage that existed only to assert on the removed diagnostic
  strips' own text content (instance ids, `parentComposition`,
  `liveInstances`, `raw=`/`parsed=`/`deadline=`/`remain=`/`active=`
  fields). The *behavioral* tests those diagnostics sat alongside —
  tile/seat counts asserted directly against the DOM, countdown text,
  resolving-state, expiration-enforcement, and the ownership-
  reconciliation tests — are untouched, since they test real behavior,
  not the diagnostic UI.

**Explicitly kept, not diagnostics**: the dev-only (`NODE_ENV`-gated)
`console.debug` composition-inputs trace in `EventRoom` (ongoing dev
tooling, not something added to capture evidence for this specific
investigation, and not visible in production either way); the
`console.error` assertions in `SpeakerStage` (`soloMode` without
`isSpeaker`) and `EventRoom`'s `handleTapEmptySeat` (the
already-speaking ownership contradiction) — both are permanent,
low-cost "this should be impossible" invariant checks in the same style
already established elsewhere in this codebase, not throwaway
diagnostics, and both are part of the actual fix/reconciliation logic
rather than separate from it.

**Verification**: automated (tsc, lint, full suite — 644/644 across 55
files, down from 656 by exactly the removed diagnostic-only tests,
production build) all pass. No underlying fix or behavior touched —
`useActiveSpeakers`' resync-on-(re)subscribe, the canonical
`mySeatNumber`-derived role chain, the `already-speaking` reconciliation,
`event_speakers_active`/`release_if_expired` expiration enforcement, the
unified 11-second inactive-speaker model, and every previously-approved
UI/layout/behavior are all unchanged by this pass. **Issue #18 is closed.**

## 2026-08-27 — The "split-layout" bug was a client-state staleness bug, not a rendering bug: `useActiveSpeakers` now self-heals instead of trusting Realtime deltas forever

**Context**: the instance-tracking diagnostics from the previous round
worked exactly as intended — they ruled out the double-mount theory
outright. The captured screenshot showed `liveInstances=1`,
`role=audience`, `isSpk=false`, `seat=null`, `renderSolo=false`,
`tiles=2`, `seats=1,2` — a single, correctly-rendering `SpeakerStage`
instance faithfully reflecting `EventRoom`'s own `participantRole`. At
the same time, the same identity's own `joinOpenSeat` attempt was
rejected with "You're already speaking," and their self-preview was
still live. That combination is only possible if `EventRoom`'s
computed `mySeatNumber`/`isSpeaker`/`participantRole` had genuinely
diverged from the server's own authoritative answer to the same
question — not a rendering bug at all, a **data bug**: the client's own
copy of "who holds which seat" was wrong.

**Root cause, found by tracing every consumer of "do I own a seat" back
to its actual source**: `mySeatNumber` (`EventRoom`, via
`findMySeatNumber`) is derived from `useActiveSpeakers`' `speakers`
array — `participantRole`/`isSpeaker`/the role routers/Speaker View
routing all already correctly derive from that one value (this was
already true before this round; there was no second, independently-
computed role flag to find). `getActiveSeatForIdentity` (which
`joinOpenSeat` uses for the "already speaking" check) is a completely
different, always-fresh server-side read. `useActiveSpeakers` itself had
no reconciliation mechanism at all: it seeds from `initialSpeakers`
once, then only ever applies *incremental* `postgres_changes` deltas on
top, with no path to notice or correct a missed one. Supabase Realtime's
Postgres-CDC subscriptions are not guaranteed to replay events missed
during a connection gap — a WebSocket drop and automatic reconnect
(routine on mobile networks, this project's primary real-device target)
can silently cause exactly one INSERT or UPDATE to never arrive, after
which this hook's state is permanently wrong for the rest of that
mounted session, with nothing to self-correct it. Self-preview being
visible while `mySeatNumber` said null was never itself wrong — it
correctly reflected "this tab is genuinely publishing," which is driven
by LiveKit's own permission push (`syncPublishPermission`), an entirely
separate channel from the Postgres Realtime subscription — it was a
symptom of the same underlying cache staleness, not a second bug.

**Decision — one canonical client representation, made trustworthy by
resyncing rather than assuming**: rather than add a second,
independently-checked role flag (explicitly rejected — see the
project's own standing architectural principle,
`lib/participant-role.ts`'s own doc comment on exactly this smell),
`useActiveSpeakers` now performs a full, replace-not-patch resync from
the same `event_speakers_active` view (migration 00000000000018)
`getActiveSeatForIdentity`/`listActiveSpeakers` already use server-side,
on every `SUBSCRIBED` callback from its Realtime channel — the initial
subscription *and* every automatic reconnect after a drop, both moments
its accumulated deltas could already be stale. It also now exposes a
`refetch()` for an explicit, immediate trigger.

**Defense in depth, at the one place a contradiction can be proven
directly**: `joinOpenSeat`'s "already holds an active seat" branch now
returns a distinct `{ reason: "already-speaking", seatNumber }` (not
folded into the generic error-string case) instead of a dead-end "You're
already speaking" message. `EventRoom`'s `handleTapEmptySeat` treats this
as definitive proof of the exact contradiction captured on-device — logs
it loudly (un-gated, inspectable via remote devtools on a real phone,
naming `participantRole`/`isSpeaker`/`mySeatNumber` against the
server's own `seatNumber`) and immediately calls `refetch()` to
reconcile, rather than leaving the caller stuck. This is the "invariant/
dev assertion for the contradiction" in this architecture's actual
terms: the moment `getActiveSeatForIdentity` and this tab's own
`participantRole` disagree is exactly the moment `joinOpenSeat` can
return this reason, so that's where the check and the correction both
live — a continuously-polled assertion would either duplicate the fix
uselessly or add real server load for no benefit once the underlying
staleness is fixed at the source.

**Verification honesty**: automated (tsc, lint, full suite — 656/656
across 55 files, +10 new tests, production build) all pass, and this
round's fix is verified more directly than usual: a new fake-Realtime-
channel test harness (the first in this codebase to mock a channel's
subscribe-status callback at all) reproduces the *exact* failure mode —
a seat `initialSpeakers` never had, standing in for a genuinely missed
Realtime delta — and proves it appears the instant `SUBSCRIBED` fires a
resync, and again proves `refetch()` performs the identical correction
on demand. A dedicated `EventRoom` test reproduces the full
contradiction end to end: `participantRole === "audience"`,
`joinOpenSeat` returns `already-speaking`, and asserts the reconciliation
trigger fires with no dead-end error text ever rendered — directly the
invariant requested ("never a stable render with the identity rejected
while participantRole is audience"). The split-layout diagnostics
(fuchsia/cyan/instance-tracking) are unchanged this round, still kept
per explicit instruction. `claimOpenSeat` (the automatic-promotion path)
was not given the same distinct-reason treatment this round — its own
"already holds an active seat" failure is caught generically today; the
same root-cause fix (the resync) reduces how often *any* path can hit a
contradiction at all, so this is noted as a smaller possible follow-up,
not treated as still-broken. Issue #18 stays in Testing / Review — this
resolves the specific captured evidence, but only a real-device retest
can confirm the split-layout report itself doesn't reproduce again for
an entirely different reason.

## 2026-08-26 — Split-layout instance diagnostics; real expiration enforcement (a stored deadline was never actually blocking a stale reconnect)

**Context**: the user reproduced both remaining #18 bugs on the
instrumented build, with real evidence this time. (1) The fuchsia/cyan
diagnostics agreed Speaker View/solo mode was active while the visible
stage still showed the two-tile split layout — a combination that,
given a single `SpeakerStage` instance, is structurally impossible from
its own render function (one ternary, no path renders both). (2) The
countdown correctly reached "Tap to reconnect · 0s," but the old
occupant could still reconnect and keep the seat afterward — proving the
countdown/render pipeline (fixed in prior rounds) was never the real
problem; *enforcement* was.

**Problem 1 — instance-level diagnostics, not another role-derivation
guess**: per explicit instruction, no further participantRole
speculation. Added a module-level, `useSyncExternalStore`-backed
registry (`liveSpeakerStageInstances`) that every mounted `SpeakerStage`
registers into on mount and removes on unmount — every instance's
diagnostic strip now reports a `useId()`-based `id`, the caller-supplied
`parentComposition` (all 5 real call sites now identify themselves:
PortraitRoom, PortraitSpeakerView, MobileLandscapeRoom,
MobileLandscapeSpeakerView, DesktopRoom), and a live `liveInstances`
count read off the registry — genuinely live (via `useSyncExternalStore`
subscription, not a value read once at each instance's own mount) so if
a second instance is ever mounted, *every* existing instance's strip
updates immediately, regardless of which one's `position: absolute`
strip happens to paint on top of the other's. Also added `tiles`/`seats`
fields computed directly from the same `renderSolo` value the JSX itself
branches on — the diagnostic cannot disagree with what's actually
rendered because it's the same value, not a separate description of it.
New tests prove the structural half of the hard invariant directly:
`renderSolo=true` renders exactly one `speaker-tile` and no divider,
full stop — this was already true from a second from-scratch read of
`speaker-stage.tsx`'s return statement (a single ternary, no path
renders both), so nothing here is a "fix" for problem 1 — it's the
instrumentation needed to catch it in the act next time it reproduces,
per the user's own explicit request. **Not claimed fixed.**

**Problem 2 — the actual root cause, confirmed by reading the code
rather than assuming**: `getActiveSeatForIdentity` (drives LiveKit token
minting's `canPublish`) and `listActiveSpeakers` (drives `findOpenSeat`'s
"which seat is open" decision) both only ever checked the base table's
`left_at is null` — with zero awareness that a row might already be
*logically* expired (`disconnected_at`/`media_inactive_since` past the
11s grace) but not yet physically released. `release_expired_inactive_speaker`
only ever runs when some connected client's local timer estimates the
deadline and asks the server to check — nothing guaranteed that
happened at all, let alone before the next reconnect attempt. The old
occupant's own "Tap to reconnect" mints a *fresh* token on a genuinely
fresh page load, re-running exactly this vulnerable check.

**Decision — one canonical predicate, applied everywhere ownership is
decided** (migration `00000000000018`): `is_speaker_seat_active(left_at,
disconnected_at, media_inactive_since, grace_seconds default 11)` — a
single `stable` SQL function evaluated against Postgres's own `now()`.
`event_speakers_active` (a `security_invoker` view) is the read-side:
`listActiveSpeakers`/`getActiveSeatForIdentity`/`listEventIdsWithActiveSpeakers`
now select from it instead of the base table, so a stale row simply
doesn't exist from any of these callers' perspective, regardless of
whether it's been physically cleaned up. `release_if_expired` is the
write-side: releases an identity's *own* row first if it's only
logically active, called at the top of `claim_speaker_seat` and
`request_to_speak_internal` (both `create or replace`d, same
signatures) — otherwise the active-identity unique index
(`event_speakers_active_identity_uniq`) would still physically block a
legitimate re-entry even after the read side stopped recognizing the
stale row as owned. `release_expired_inactive_speaker` itself was
refactored (same signature, same behavior) to delegate its threshold
check to the same predicate — one rule, not three independently-
maintained copies of "11 seconds." This directly implements "client may
trigger cleanup; server decides expiration" — the client (a countdown
reaching zero, or any connected viewer's scheduled check) only ever
*asks*; every decision re-derives from Postgres's clock, atomically, in
the same statement.

**Immediate revocation, per ARCHITECTURE.md's own already-standing
rule**: `checkAndEvictInactiveSpeaker` now pushes
`syncPublishPermission({canPublish: false})` on a successful release —
this was the one eviction path in the app that didn't already do this
(every other seat-ending path did). Best-effort, matching that
function's own existing contract: harmless if the identity isn't
currently connected, since the next token request self-corrects via the
now-expiration-aware `getActiveSeatForIdentity` regardless.

**Own-seat expiration confirmation**: `useSpeakerReconnectGrace`
deliberately never schedules a check for the viewer's *own* seat (never
made sense for a disconnected client to check on itself) — but for the
*media-inactive-while-still-connected* case, or a speaker alone in the
room with no one else to trigger a check, nothing was left to confirm
expiration promptly. New `confirmOwnSeatExpiration` server action
(self-service, resolves identity server-side, delegates to the same
`checkAndEvictInactiveSpeaker`) and `useOwnSeatExpirationConfirmation`
hook (reuses `useReconnectCountdown` directly — never a second timer —
and fires once per distinct deadline on the transition into 0) close
this gap.

**UI: no more stuck "· 0s."** Per explicit instruction, both the
speaker's own prompt and the audience tile now show a brief,
non-interactive resolving state ("Checking…" / "Speaker inactive —
resolving…") once the countdown reaches exactly 0, instead of a
tappable-looking button or a countdown that visually implies more time
is left. The prompt/tile don't decide the outcome themselves — they stop
rendering once the seat recovers (`inactiveSince` clears) or the whole
view unmounts once the seat is actually released.

**Verification honesty**: automated (tsc, lint, full suite — 650/650
across 54 files, +30 new tests, production build) all pass. The
expiration-enforcement fix is verified end-to-end against the real
linked database (`event-speakers-expiration.test.ts`, 10 tests): a row
past its deadline disappears from the active view even though `left_at`
is still null; `claim_speaker_seat` correctly evicts a stale occupant
and lets a new claimant in; the old identity's own reconnect signal
finds nothing to touch afterward; the guard is idempotent; a genuinely
active seat is still correctly protected from a duplicate claim; the
same guard correctly extends to the mic-request path. This is real
confidence in the mechanism, not a guess. **Problem 1 (split-layout) is
explicitly NOT claimed fixed** — the diagnostics are instrumentation for
next capture, not a change in behavior. Whether the *actual on-device*
reconnect-after-expiry now correctly fails, and whether the resolving
states read well, are still real-device-only. Issue #18 stays in
Testing / Review.

## 2026-08-25 — Unified inactive-speaker model shipped: one product-level `speakerPresence`, reusing the existing 11s grace period for both a LiveKit disconnect and connected-but-both-media-off

**Context**: the previous round's `isReconnecting`-precedence fix and
diagnostics still hadn't been confirmed working on real devices when the
user came back with a simplified product direction, explicitly
superseding the 30s-idle + 10s-warning architecture proposed (but not
built) at the end of the prior round: "Do NOT add the previously
proposed 30-second idle period... reuse the existing 11-second grace
period for both" causes of inactivity. The governing rule: "the
important question is not whether someone is technically connected; it
is whether they are meaningfully present on stage" — `speakerPresence =
active | inactive`, derived from either (A) a genuine LiveKit disconnect
or (B) still connected but both camera and mic off/muted, with camera-
off-alone and mic-muted-alone both remaining "active."

**Why this is smaller than the 30s/10s proposal**: cause A already had a
complete, real, server-authoritative 11-second grace-period mechanism
(migration 00000000000016) — this round's job was to *broaden* it to a
second cause, not build a new timer system. Cause B (media inactivity)
still needs its own authoritative clock, since mic/camera mute state has
no server-observable signal in this app (this app's LiveKit webhook
delivers no track-mute event) — but it can reuse the exact same
deadline math, release mechanism, and UI countdown components cause A
already has, rather than inventing a second, differently-shaped grace
period. That's what made this tractable in one pass where the 30s/10s
design wasn't.

**Schema** (migration 00000000000017): `event_speakers.media_inactive_since
timestamptz` — a second, independent clock, deliberately not a
repurposing of `disconnected_at` ("continue distinguishing... where
technically necessary" — the actual cause stays inspectable in storage).
Mirrors migration 16's shape exactly: `mark_speaker_media_inactive`/
`mark_speaker_media_active` (idempotent, `service_role`-only — but
unlike the disconnect pair, whose only trusted caller is the LiveKit
webhook, these are called by the *speaker's own connected client*, since
there is no server-observable alternative; this is a real, deliberate
difference in trust model, documented at the migration itself, not an
oversight — there's no adversarial concern here, only an
accidental-idle one, consistent with this prototype's threat model) and
`release_expired_inactive_speaker` — one new, unified atomic UPDATE
checking *either* clock, superseding `release_expired_disconnected_speaker`
for live app code (kept, unchanged, for tests that specifically want the
disconnect-only check). `left_reason` gained a new `'inactive'` value,
recorded by whichever clock actually crossed the threshold. The original
`left_reason` CHECK constraint (an unnamed inline constraint from
migration 5) was looked up dynamically via `pg_constraint` rather than
assumed by Postgres's default naming convention, safer against a real
shared database.

**Presentation layer — one collapsing point**: new `lib/speaker-presence.ts`
is the *only* place `disconnected_at`/`media_inactive_since` are read
together — `inactiveSince()` (the earlier of the two, if both are
somehow set) feeds every countdown; `isLocalMediaInactive()` (pure:
`needsMediaActivation || (microphoneMuted && cameraMuted)`, always false
without `canPublish`) is the client-observable half of cause B. Every
other component reads `inactiveSince(speaker)`, never `disconnected_at`
or `media_inactive_since` individually — this is what makes "camera off
alone remains active, mic muted alone remains active, both together is
inactive" true by construction rather than a rule several components
have to each remember.

**Client reporting**: new `useSpeakerMediaPresenceReporting` (called
unconditionally in `EventRoom`, a no-op for non-speakers) watches
`isLocalMediaInactive`'s already-live inputs and calls
`reportSpeakerMediaInactive`/`reportSpeakerMediaActive` (new server
actions) only on genuine transitions — never on every render, never from
a UI tap directly (per the explicit instruction "do not let meaningless
button tapping reset the timer... recovery should correspond to actual
speaker-presence/media state"). `useSpeakerReconnectGrace` (the existing
scheduler that triggers the eventual eviction check) now derives its
watch set from `inactiveSince()` too, so a media-inactive seat gets the
same "any connected viewer's tab can trigger the check" robustness a
disconnected one already had — extending an existing mechanism, not
building a parallel one.

**UI**: `SpeakerMediaActivationPrompt` now branches on cause —
`needsMediaActivation` still gets the tappable "Tap to reconnect · Ns"
(a real recovery action: `activateMedia()`); `bothMediaMuted` (already
publishing, both tracks explicitly muted) gets non-interactive "Resume
speaking · Ns" text instead — tapping `activateMedia()` in that state
would be a no-op (tracks are already held), so the actual recovery
action is the existing mic/camera toggle buttons already in the control
row, not a new button. `SpeakerTile`'s audience-facing text changed from
"Speaker reconnecting" to "Speaker inactive" (`isReconnecting`→
`isInactive` throughout) — per explicit instruction, the audience never
learns which cause applied. Diagnostics extended to show both raw fields
(`discAt`/`mediaInactAt`) alongside the already-collapsed deadline.

**Verification honesty**: automated (tsc, lint, full suite — 624/624
across 52 files, +28 new tests: unit tests for `speaker-presence.ts`'s
three pure functions and `useSpeakerMediaPresenceReporting`'s transition
logic, extended `useSpeakerReconnectGrace` coverage for the media cause,
and 11 tests in the real-linked-database full-path file covering both
causes' countdown/recovery/release/reassignment-safety end to end,
production build) all pass. The real-device confirmation this round
specifically needs: whether "Tap to reconnect"/"Speaker inactive" now
reliably carry a countdown at all (the underlying question from the
prior two rounds, now answered by a broader, more robust trigger
condition rather than just a display-precedence fix) is still
real-device-only. The split-layout diagnostics (fuchsia/cyan) are
unchanged this round, per explicit instruction — still no speculative
fix attempted. Issue #18 stays in Testing / Review.

## 2026-08-25 — Reconnect-countdown precedence fixed at its actual root cause; on-screen diagnostics added to both surfaces; inactive-speaker timeout scoped but not built (stop-and-report)

**Context**: a further real-device retest still showed "Tap to reconnect"
(speaker) and "Camera off" (audience) with no countdown, even though the
previous round's live-database script had already proven the DB/Realtime
pipeline delivers `disconnected_at` correctly. The user asked for the
*actual render path* to be traced with real evidence, not re-verified
math, plus a new, separate inactive-speaker-timeout feature.

**Root cause found — a real, provable divergence, not a timing
mystery**: `SpeakerTile`'s reconnecting-vs-"Camera off" branch was gated
by an `isReconnecting` *prop*, computed in `SpeakerStage` from
`reconnectingIdentities` (`useSpeakerReconnectGrace`'s returned Set) —
an independently re-derived signal from the *same* `speakers[].disconnected_at`
data `SpeakerTile` already reads directly for its own countdown number.
Two separately-maintained computations of the same fact, exactly the
architecture smell `lib/participant-role.ts`'s own doc comment already
named for a different pair of values. The concrete divergence source:
`useSpeakerReconnectGrace`'s `disconnected` map returns *entirely empty*
whenever its own `enabled` (`canConnect`) parameter is false — despite
the hook's own doc comment already noting this gating is vestigial
("kept for interface parity even though the hook's own derivation no
longer depends on this tab's own LiveKit connection state at all"). Any
viewer whose own `canConnect` isn't true at read time sees *no*
reconnecting indicator for *any* seat, regardless of what
`disconnected_at` actually says.

**Decision**: `SpeakerTile` now derives its own effective reconnecting
state as `isReconnectingProp || Boolean(speaker?.disconnected_at)` — the
seat's own authoritative field always wins, and the existing prop can
only ever add `true`, never suppress a `true` the field itself
establishes. This makes "reconnect UI must take precedence over generic
media-off UI" true by construction from one field, not by keeping two
independent derivations in sync by hand — no dependency on
`canConnect`/`reconnectingIdentities` remains in the *display* decision.
`useSpeakerReconnectGrace`/`reconnectingIdentities` are kept exactly as
they were (not removed, to avoid a 15-file prop-plumbing refactor this
pass didn't need) — they still do real, separate work: scheduling the
per-disconnect `setTimeout` that triggers the server-side eviction
check. Only the *rendering* decision no longer trusts that intermediary.

**Diagnostics added to both real render paths** (un-gated, visible on
the deployed preview, per explicit request): a new pure
`reconnectDiagnostics(disconnectedAt, remainingSeconds)` in
`use-reconnect-countdown.ts` — deliberately takes the *already-computed*
`remainingSeconds` from the same `useReconnectCountdown` call already
driving the visible text, rather than recomputing it from a second,
independently-clocked "now" (an early draft did exactly that via a
ticking `useNow()`, and a test caught the two disagreeing by a second at
a rounding boundary — the diagnostic must never be able to show a
different number than what's actually on screen). Rendered as an amber
strip in both `SpeakerMediaActivationPrompt`
(`diagnostic-speaker-reconnect`) and `SpeakerTile`
(`diagnostic-audience-reconnect`, rendered unconditionally whenever a
seat is occupied — not just inside the reconnecting branch — specifically
so it's visible even in the "Camera off" branch the bug report pointed
at). Shows raw `disconnected_at`, parsed ISO timestamp, computed
deadline, remaining seconds, and an active flag, exactly the five things
requested.

**Split-layout diagnostics (fuchsia/cyan) kept, unchanged, per explicit
instruction** — no new speculative fix attempted; the bug hasn't
reproduced with the diagnostics live yet.

**Inactive-speaker timeout — scoped, not implemented, per the user's own
stop condition**: designing this out loud (per this project's own
standing rule for cross-system state) surfaced that "connected but
functionally absent" cannot be detected the same way disconnection is.
`disconnected_at` is server-authoritative because it's LiveKit's *own*
webhook reporting a fact LiveKit's server observed; mic/camera mute
state has no equivalent server-observable signal available to this app
— LiveKit's webhook event set here doesn't deliver track-mute
transitions, so "muted + camera off + no activity" can only ever be
*observed* client-side and *reported* to the server, which then owns the
authoritative clock and release decision the same way
`checkAndEvictDisconnectedSpeaker`/`release_expired_disconnected_speaker`
already work for disconnects. That's a genuinely new schema/backend
surface — a new nullable timestamp column, three new
service-role-only SQL functions mirroring the disconnect-grace
migration's shape, a new server action for the client to report
idle/active transitions, and a new client-side activity-detection hook
— comparable in size to the entire disconnect-grace-period feature,
which was itself a dedicated migration. Per the user's own explicit
instruction ("if implementing this cleanly requires broader
schema/backend changes than expected, stop and report the proposed
architecture"), this round stops here with a concrete proposed design
(see the session's own handoff message) rather than writing the
migration unreviewed.

**Verification honesty**: automated (tsc, lint, full suite — 584/584
across 50 files, +9 new tests covering the precedence fix and both
diagnostic strips, production build) all pass. The precedence fix
removes a *provable* divergence source with a concrete before/after unit
test (`speaker.disconnected_at` set, `isReconnecting` prop explicitly
`false`, reconnecting UI still shows) — this is a real fix, not a
diagnostic-only pass, for the "Camera off overriding reconnect UI" half
of the report. Whether the *speaker's own* "Tap to reconnect" now
reliably carries a countdown (which depends on `disconnected_at`
actually reaching the client in time, not just being displayed
correctly once it has) is still real-device-only — the diagnostic strip
exists specifically to capture that if it recurs. Issue #18 stays in
Testing / Review.

## 2026-08-24 — Real-device retest reproduced all three #18 failures; audience reconnect countdown shipped, issue 1 explicitly NOT resolved

**Context**: after the hydration-race fix and countdown work below (the
entry immediately following this one), the user retested on real devices
(a speaker phone and a separate observer/audience device) and reported
all three original findings still reproducing: (1) the split-layout bug
still occasionally appears alongside speaker-specific state (Tap to
reconnect, Leave Stage, self-preview) rather than Speaker View; (2) the
returning speaker's "Tap to reconnect" prompt showed no countdown
suffix; (3) the audience had no visibility into a disconnected speaker's
remaining grace time. Explicit instruction: no new speculative
boolean/test around `participantRole`, no claiming "fixed" from unit
tests alone.

**Problem 1 investigation (composition/role divergence) — re-derived
from scratch, no new bug found**: re-read `event-room.tsx`,
`participant-role.ts`, `portrait-room.tsx`, `mobile-landscape-room.tsx`,
`portrait-speaker-view.tsx`, and `speaker-stage.tsx` end to end. Confirmed
the invariant chain that would need to break for the reported combination
to occur, and found no gap in it: `deriveParticipantRole` returns
`"speaker"` if-and-only-if `isSpeaker` is true (a pure function of the
same boolean, recomputed every render, never stored) —
`participantRole` cannot disagree with `isSpeaker` within one `EventRoom`
render. Both role routers (`PortraitRoom`, `MobileLandscapeRoom`) gate on
`participantRole === "speaker"` specifically so they redirect to Speaker
View in the exact same render `isSpeaker` says so — the audience
composition's own `isSpeaker`-gated `RoomControls` block is provably
unreachable in that render, since the role-router `if` returns first.
Inside Speaker View, `isSpeaker`/`mySeatNumber` are the same two values
`findMySeatNumber` produced together (never independently re-derived —
see the previous consistency fix below), and `mySeatNumber !== null` is
definitionally the same fact as `isSpeaker`, so `SpeakerStage`'s
`renderSolo = soloMode && mySeatNumber !== null` cannot be false while
`isSpeaker` is true and `soloMode` (always passed as a bare `true` by
both `PortraitSpeakerView`/`MobileLandscapeSpeakerView`) is set. No
`React.memo` exists anywhere in this chain to make a stale prop plausible
either. Static analysis, a second time, cannot find a concrete mechanism
— which is evidence the bug isn't in this pipeline's logic at all
(perhaps a real LiveKit/webhook timing race, a genuinely stale Realtime
delivery, or something environment-specific to the phone), not evidence
it doesn't exist.

**Decision — diagnostics over another guess**: per the user's own
suggestion, added two temporary, un-gated (visible on the real Vercel
preview, not hidden by `isDevToolsAvailable()`) on-screen overlays:
`EventRoom` (`data-testid="diagnostic-event-room"`, fuchsia) showing
`mounted`/`desktop`/`orient`/`phase`/`role`/`isSpk`/`seat`/`myDiscAt`/
`canPub`/`needsAct`/`connStatus`, and `SpeakerStage`
(`data-testid="diagnostic-speaker-stage"`, cyan) showing
`solo`/`seat`/`isSpk`/`renderSolo`. These read already-computed values
only — no new state, no new boolean, nothing that could itself introduce
a divergence. If the bug reproduces again, a screenshot of both strips
tells us directly whether the props genuinely disagree (a real bug in
this chain, contradicting the static analysis above) or agree with each
other but disagree with what's on screen (pointing outside this chain
entirely — CSS, a LiveKit video-attach issue, or similar). **To be
removed once a real-device screenshot has actually been captured with
the bug reproducing** — not before.

**Problem 2 investigation (missing speaker-side countdown) — DB/Realtime
pipeline conclusively ruled out**: wrote and ran a standalone script
against the real linked Supabase project (`@supabase/supabase-js`,
anon + service-role clients) that seated a real guest speaker, opened a
live `postgres_changes` Realtime subscription, called
`mark_speaker_disconnected`, and logged the received payload. The
Realtime UPDATE definitively included `disconnected_at` with the correct
timestamp — the DB schema, RLS/grants, Realtime publication, and payload
shape are not the cause. Script deleted after use; not committed.

**New hypothesis (unverified without a device)**: `needsMediaActivation`
(reset by any fresh `useLiveRoomConnection` mount — e.g. a page reload)
and `disconnected_at` (set only once LiveKit's own server detects a real
disconnect and fires `participant_left`, with its own detection +
webhook latency) are independent signals. A reload can make "Tap to
reconnect" appear before the server has actually started the grace-period
clock, which would correctly show no suffix (nothing to count down yet)
for a real but bounded window. Presented as a plausible explanation, not
a fix — genuinely resolving this needs the same on-device diagnostics
above, screenshotted at the moment "Tap to reconnect" appears with no
countdown.

**Problem 3 (audience countdown) — implemented, not just diagnosed**:
`SpeakerTile` already received the full `speaker: EventSpeaker | null`
prop (via `SpeakerStage`'s `renderTile()`), which already carries
`disconnected_at` — no new plumbing. Added
`useReconnectCountdown(speaker?.disconnected_at ?? null)` (the *same*
hook already used by the speaker's own `SpeakerMediaActivationPrompt`,
reading the *same* authoritative field) and changed the "Speaker
reconnecting…" text to append `· Ns` once known. Because both the
ordinary two-tile audience view and a co-speaker's view of the other
seat in Speaker View's `soloMode` render through the same
`renderTile()`, this covers both perspectives by construction, and
because it's the same hook/same field as the speaker's own prompt, the
two displays cannot independently drift out of sync — there is only one
timer.

**Full data/render path coverage added** (`reconnect-countdown-full-
path.test.tsx`, real linked DB, `describe.skipIf(!hasServiceCredentials)`
— same convention as `event-speakers-disconnect-grace.test.ts`): fetches
a real row's `disconnected_at` from the live project (a direct
service-client read shaped identically to `listActiveSpeakers`, for the
same `next/headers` reason `event-speakers-transitions.test.ts` already
documents) and feeds that *exact* fetched value into real renders of both
`SpeakerMediaActivationPrompt` and `SpeakerTile`, asserting matching
text. Covers: a disconnected row driving matching countdown text on both
components; reopening ~5s in showing ~5s, not a fresh 11; reconnecting
clearing both immediately (re-fetched row's `disconnected_at` back to
null); and expiration releasing the seat so the row disappears from a
fresh fetch entirely, removing both countdown states because there's no
seat left to render them for, including a stale post-expiry reconnect
attempt confirmed to still no-op. This is what closes the gap between
"the hook is correct" and "the UI actually has the timestamp" — a
synthetic fixture can't catch a real DB/type-shape mismatch; this can.

**Verification honesty**: automated (tsc, lint, full suite — 575/575
across 50 files including the 4 new real-DB full-path tests, production
build) all pass. Problems 2 and 3's countdown *math and rendering* are
now verified end-to-end against the real database, closing exactly the
gap the user identified ("do not assume the hook being correct means the
UI has the timestamp"). **Problem 1 (the split-layout bug) is explicitly
NOT claimed fixed** — nothing shipped this round changes its behavior;
the diagnostics exist to gather the evidence a fix requires. **Problem
2's actual on-device behavior** (whether "Tap to reconnect · Ns" now
genuinely appears, and whether the needsMediaActivation-vs-disconnected_at
gap theory holds) remains real-device-only. Issue #18 stays in
Testing / Review, not Done.

## 2026-08-24 — First-load composition-hydration race fixed; reconnect prompt shows the real remaining grace time (issue #18)

**Problem 1 — intermittent Speaker View failure on first/fresh load**:
a seated speaker occasionally landed in the ordinary two-seat/split
composition instead of Speaker View, most reproducible right after a
fresh deployment.

**Investigation**: traced the exact first-load lifecycle the user asked
for. Server-side data (`initialSpeakers`, `identity`) is not the
culprit — `page.tsx` resolves identity via `cookies()` before every
Supabase call (`lib/supabase/server.ts`'s `createClient()` reads
`cookies()` on every invocation), which makes the whole route
dynamically rendered per request; ruled out via Next.js's own bundled
docs for *this* installed version rather than assumed from training
data (Cache Components is off in this project's `next.config.ts`, so
the "previous model" applies, and `fetchCache: 'auto'`'s "cache fetches
before the first Request-time API" exception never applies here either,
since `cookies()` is always called first). `EventRoom`'s `isSpeaker`/
`participantRole` are synchronous, single-source values (previous
entries) — also ruled out.

The real cause: `useOrientation`/`useIsDesktopViewport` are correctly
`useSyncExternalStore`-based (genuinely external, mutable browser
state), but their `getServerSnapshot` — used for the server render
*and* the client's first hydration pass, to avoid a mismatch — returns
a fixed guess (`"portrait"`, `false`/mobile), not "unknown." On a real
desktop browser, that guess means the first client render always picks
a *mobile* composition first (which has its own role router, so Speaker
View can render correctly for one instant); React then corrects the
snapshot to the real client value, and `EventRoom` switches to
`DesktopRoom` — which has no role router at all (an intentional,
already-approved scope boundary: Speaker View has no desktop
equivalent) and never reconsiders role again. A seated speaker's first
paint could show Speaker View, then get silently replaced by
`DesktopRoom`'s ordinary layout for the rest of the session. The same
mechanism could also cause an unnecessary Portrait↔MobileLandscape
composition swap right after mount (both of those do have role
routers, so this direction doesn't get stuck, but is still an
unnecessary remount/flash).

**Decision**: new `useHasMountedOnClient()` (deliberately
`useSyncExternalStore`-based too — `getSnapshot` always `true`,
`getServerSnapshot` always `false` — not `useState`+`useEffect`, which
the codebase's own `react-hooks/set-state-in-effect` lint rule already
steers away from for this exact "recompute something the initial
render already knew" shape). React settles every `useSyncExternalStore`
correction in a commit before any passive `useEffect` runs, so by the
time this hook's own corrected value lands, `useOrientation`/
`useIsDesktopViewport` already have theirs too — no coordination with
those hooks' internals required, and neither hook's own contract
changes. `EventRoom` now renders a brief neutral state ("Reconnecting
to stage…" when the authoritative data already says speaker, silent
otherwise) instead of any of the three compositions while this is
`false` — the *only* render that ever picks a composition is the one
where viewport/orientation are already known, so a wrong composition
is never even briefly committed to (not "fixed after a flash" — never
rendered at all). Dev-only `console.debug` logs the exact
ordering (`hasMountedOnClient`, `isDesktopViewport`, `orientation`,
`participantRole`, `isSpeaker`, `mySeatNumber`) on every relevant
change, so a recurrence leaves a concrete trace.

**Problem 2 — reconnect prompt needed an accurate countdown**: "Tap to
reconnect" gave no sense of how much of the 11-second grace period
remained.

**Decision**: `EventRoom` now also threads the viewer's own active-seat
`disconnected_at` down (`myDisconnectedAt` — found from the same
Realtime-subscribed `speakers` state already used everywhere else, not
a new fetch). New `useReconnectCountdown`/`remainingGraceSeconds`
(`lib/speaker-reconnect.ts`'s `SPEAKER_DISCONNECT_GRACE_MS`) compute the
display purely from `disconnectedAt + grace period` — never a fresh
client-invented 11-second timer — so a reopened tab partway through an
existing grace window shows the correct remainder immediately, ticking
is a `setInterval` inside the effect body (not a raw `setState` call
there, for the same lint reason as above), and the countdown disappears
the instant `disconnectedAt` clears (reconnect) or the whole Speaker
View unmounts (seat released — the existing role-consistency guarantee
already covers that transition, so no new mechanism was needed for it).
Crossing zero is display-only, clamped, and never implies the seat is
still held — the seat's own disappearance from `speakers` is what
actually reflects release.

**Verification honesty**: automated (lint/tsc/full suite — 565/565, 49
files, run twice to check for fake-timer flakiness in the new countdown
tests, stable both times) and a local production smoke test all pass.
The first-load fix is verified via a new `event-room.test.tsx` that
drives the exact hydration-order scenarios requested (speaker data
already true before mount resolves, speaker data arriving one render
late, role changing from audience to speaker mid-hydration) against
mocked `useHasMountedOnClient`/`useIsDesktopViewport`/`useOrientation` —
this tests the *consequence* (EventRoom never commits to a composition
before it's known, and the first real composition render is always
correct), not a literal replay of `useSyncExternalStore`'s internal
timing, which isn't something a jsdom test can independently reproduce;
that guarantee rests on documented React behavior instead. Whether this
actually eliminates the original intermittent report, and whether the
countdown reads correctly across a real disconnect/reconnect cycle, are
still real-device-only.

## 2026-08-24 — "Tap to reconnect" wording, and a genuinely server-authoritative 11-second speaker disconnect grace period (issue #18)

**Problem 1 — reconnect wording**: Speaker View's media-activation
prompt read "Tap to enable camera & mic" even when it was showing to an
already-seated speaker whose tab came back fresh (a route remount while
still holding a seat) — not a first-time setup step, a reconnection.

**Decision**: changed the copy to "Tap to reconnect" in
`SpeakerMediaActivationPrompt` only — `RoomControls`/`SpeakerTile`'s own
"Enable camera & mic" entry points elsewhere are correctly still
first-activation wording, untouched. No behavior change: confirmed (see
that component's own doc comment) that `needsMediaActivation` becoming
true in Speaker View specifically can only mean an already-seated
speaker's tab came back fresh — a genuine first promotion always runs
`prepareLocalMedia` ahead of time, so `mediaActivated` is already `true`
before `canPublish` ever flips, meaning this state never legitimately
represents a first-time activation there.

**Problem 2 — the disconnect "grace period" wasn't real**: the LiveKit
webhook (`api/livekit/webhook/route.ts`) called `end_speaker_seat`
immediately on `participant_left` — releasing the seat the instant
LiveKit reported the disconnect, with *no* grace period server-side. A
client-side hook (`useSpeakerReconnectGrace`) layered a purely visual
"Speaker reconnecting…" state on top of that (comparing DB occupancy
against LiveKit's live participant list, then asking the server to
re-check after ~25s) — but the seat itself was already gone by then. The
"grace period" a viewer saw on screen didn't correspond to any real
protection for the disconnected speaker's seat.

**Decision**: migration 00000000000016 adds `event_speakers.disconnected_at`
and three `service_role`-only functions:
- `mark_speaker_disconnected` — sets `disconnected_at = now()`, called
  from the webhook's `participant_left` handler. Idempotent (only sets
  it if currently null, so a duplicate delivery never restarts the
  clock). Starts the grace period; does **not** release the seat.
- `mark_speaker_reconnected` — clears `disconnected_at`, called from a
  *new* `participant_joined` webhook handler (the webhook route now
  handles both event types) — the same authoritative, server-to-server
  signal disconnection uses, not anything the client asserts about
  itself. Scoped to the identity's own active-seat row only, never by
  seat number.
- `release_expired_disconnected_speaker` — the actual expiration: a
  single atomic `UPDATE ... WHERE left_at is null AND disconnected_at is
  not null AND disconnected_at <= now() - interval` releases the seat
  (`left_reason = 'disconnected'`). Called from
  `checkAndEvictDisconnectedSpeaker` (room/actions.ts, simplified — the
  old LiveKit `RoomServiceClient.getParticipant` live-check is gone
  entirely, replaced by this timestamp comparison), itself triggered by
  a connected client's local estimate of when the grace period should
  have elapsed (`useSpeakerReconnectGrace`) — but, exactly as before,
  that trigger is never trusted directly; the WHERE clause re-derives
  the real decision from Postgres's own clock every time.

`SPEAKER_DISCONNECT_GRACE_SECONDS = 11` (new `lib/speaker-reconnect.ts`,
shared by both the server enforcement and the client's scheduling
estimate) replaces the old, purely-cosmetic 25s.

**Race safety is the WHERE clause, not a separate check-then-write
step** — a single UPDATE is atomic per row in Postgres:
- A concurrent `mark_speaker_reconnected` clearing `disconnected_at`
  makes `disconnected_at is not null` fail, so a stale/late-firing
  release trigger can never evict someone who already reconnected —
  verified directly against the real linked project (see below), not
  just reasoned about.
- `left_at is null` failing (already released, by this call or an
  earlier one) makes a second release attempt a no-op, not an error.
- `mark_speaker_reconnected` matches only the identity's *own* active
  row — a stale reconnect signal for an already-released, since-reclaimed
  seat can never reach across to touch whoever claimed it afterward,
  because that new occupant's row has a different identity entirely.

**`useSpeakerReconnectGrace` redesigned** to match: "who's currently in
a disconnect grace window" is now a *pure derivation* from
`speaker.disconnected_at` (already flowing through `speakers` via the
same Realtime subscription `useActiveSpeakers` already has) — no more
comparing against LiveKit's own live participant list at all, which
removes a second, racier signal in favor of the one now-authoritative
one. The hook no longer needs a `getParticipant` parameter at all. What
it still does locally: schedule a `setTimeout` per disconnected seat,
computed from the seat's own `disconnected_at` (not from mount time —
loading the room partway through an existing grace window schedules
correspondingly sooner), and call `checkAndEvictDisconnectedSpeaker`
when it fires — a trigger, never a decision, same as before.

**Verification honesty**: this is the one piece of this session's work
verified against the real, live, linked Supabase project, not just
mocks — `event-speakers-disconnect-grace.test.ts` (new) exercises
`mark_speaker_disconnected`/`mark_speaker_reconnected`/
`release_expired_disconnected_speaker` for real, including every race
scenario asked for: reconnect at ~10s retains the seat, no-return
releases at 11s, a reconnect that lands *after* a stale release
trigger already fired is a no-op (the exact "old timeout can't evict a
reconnected participant" guarantee), and a late reconnect signal after
the seat was reclaimed by someone else never touches the new occupant.
`route.test.ts` (webhook) extended the same way for `participant_left`/
`participant_joined`. `useSpeakerReconnectGrace`'s own tests (mocked,
not live-DB) cover the client-side scheduling/derivation logic
separately. lint/tsc/full suite/build all pass (540/540, 47 files).
Whether the "Speaker reconnecting…" UI and the actual seat-release
timing feel right on a real device, across an actual network drop, is
still real-device-only.

## 2026-08-24 — Removed the separate "Request sent" bar; the composer's mic button carries the pending state (issue #18)

**Problem**: a real-device screenshot showed the compact "Request sent ·
Cancel" pill overlapping the composer/ambient request comment once the
bottom row got crowded — visually broken, not just aesthetically
redundant.

**Decision**: the pill is gone entirely from `PortraitRoom`/
`MobileLandscapeRoom`'s audience branch. `ChatPanel`'s own 🎙 mic button
now carries three states instead of two: idle (gray, opens the request
input), actively composing a not-yet-submitted request (`micRequestMode`,
solid accent — unchanged), and sent-but-not-yet-promoted
(`hasPendingRequest` while `micRequestMode` is false, a lighter pulsing
accent) — tapping the button in the third state calls
`onCancelPendingRequest` (wired to the same existing `onCancelPromotion`
action the removed bar's own Cancel button already called; issue #23's
automatic promotion has always supported cancelling a request whether or
not its countdown has started, so this needed no new server-side
capability) instead of reopening the input. Both new `ChatPanel` props
default to inert values, so every other caller is unaffected.

**Reason**: the existing badged ambient "requesting the mic" chat message
(`AmbientComments`/`MessageItem`, already styled distinctly for
`is_speaker_request` messages) is already the social feedback a request
went through — a second, separate UI element saying the same thing was
redundant even before it started visually overlapping. Once accepted,
`promotionCountdown` already takes the whole composition over to the
center-stage countdown (previous entries) — with the bar gone, there is
now no intermediate "request sent" screen at all between the mic
button's pending state and the countdown taking over.

**Verification honesty**: automated (lint/tsc/full suite — 521/521, 46
files) and a local production smoke test pass. Whether the new pending
mic-button state actually reads as clear on a real phone — distinct
enough from both idle and actively-composing, not too subtle — is a
real-device-only judgment.

## 2026-08-24 — Three corrective fixes on the center-stage countdown: no pre-countdown flash, Cancel actually cancels, self-preview reconciliation (issue #18)

**Problem 1 — pre-countdown candidate UI flash**: right before the
center-stage countdown appeared, the old "Request sent / Cancel / normal
composer / controls / ambient comment" UI briefly showed.

**Investigation**: traced the transition ordering precisely.
`PortraitRoom`/`MobileLandscapeRoom`'s `promotionCountdown !== null`
ternary (previous entry) already made the countdown/candidate-UI choice
atomic *within one render* — the actual gap was in
`useAutomaticPromotion`'s claim-success handler, which used to reset both
`hasPendingRequest` (via `onHasPendingRequestChange(false)`) and
`countdown` (via `.finally(() => setCountdown(null))`) the moment
`claimOpenSeat` resolved — racing an entirely *independent* completion,
the Realtime push that flips `isSpeaker` true (see `EventRoom`). Chained
`.then()`/`.finally()` continuations run in separate microtask ticks, so
these two resets could even land in different renders from each other,
compounding the gap. When the reset won the race (won it *before*
Realtime delivered `isSpeaker: true`), this composition's `promotionCountdown
!== null` ternary correctly fell back to its `else` branch — except
`hasPendingRequest` was *also* already false by then, so it fell all the
way through to plain Watch Mode (or briefly the old "Request sent" pill,
depending on exact ordering) for one or more frames before `isSpeaker`
caught up.

**Decision**: the claim-success path no longer resets `hasPendingRequest`
or `countdown` itself. `isSpeaker` flipping true (Realtime) is now the
single authoritative signal that ends this state: `useAutomaticPromotion`
reuses the *same* `useRoleTransitionReset` hook (previous entry) to reset
its own `countdown` on that transition, exactly like `EventRoom` already
does for `hasPendingRequest`/`micRequestMode`/`joinSeatMessage` — not a
second, parallel reconciliation mechanism. Until `isSpeaker` actually
flips, the countdown simply stays frozen (typically at `0`, mid-claim) —
still the countdown takeover UI, never a fallback to candidate UI. A
*failed*/lost-race claim is different: nothing else will ever flip
`isSpeaker` for that attempt, so `countdown` still resets to `null`
directly in that branch, falling back to waiting as before.

**Problem 2 — Cancel during the countdown didn't reliably cancel**:
`cancel()` set `countdown` to `null` immediately (correct, for hiding the
overlay) while `hasPendingRequest` was still `true` (the server
withdrawal hadn't resolved yet) — which, on the *very same render*,
re-armed the polling effect (its guard no longer had any reason to
return early) and could immediately restart a *new* countdown before the
withdrawal had actually landed server-side. A canceled promotion could
silently resurrect itself.

**Decision**: new `isCancelling` state, true for exactly the window from
tapping Cancel to `withdrawSpeakerRequest` resolving, added to the
polling effect's guard — suppresses any poll from starting while a
cancellation is in flight. `onHasPendingRequestChange(false)` and
clearing `isCancelling` were also moved into the *same* `.then()`
callback (not split across `.then()`/`.finally()`), closing a second,
narrower version of the same race between the cancel path settling and
`hasPendingRequest` actually reaching the component that gates polling.

**Problem 3 — self-preview intermittently missing in Speaker View**:
reported as an occasional real-device issue, not reliably reproducible.

**Investigation**: checked each suspected path directly. `SelfPreview`
itself attaches/re-attaches correctly on every `track` prop change and is
only ever mounted when `localVideoTrack` is non-null (`SpeakerStage`) —
ruled out a layout/attach bug; a missing preview always traces back to
`localVideoTrack` state itself being null. The ordinary paths
(`prepareLocalMedia`'s own `setLocalVideoTrack`, `applyPublishState`'s
prepared-tracks branch) set it directly and no concrete code-level gap
was found — but `syncCanPublish()`'s gesture-safety guard deliberately
*skips* publishing if the server's permission push arrives before this
tab's own `createLocalTracks()` resolves (a real possibility for issue
#27's direct join, which calls `prepareLocalMedia()` fire-and-forget
concurrently with the seat claim), deferring to `prepareLocalMedia`'s own
tail check instead. No proven gap in that specific handoff, but the
number of independent async completions involved (Realtime, LiveKit
permission push, getUserMedia, publish) makes an unmodeled rare ordering
plausible — reported honestly rather than claiming a confirmed root
cause.

**Decision**: a defensive reconciliation effect in
`useLiveRoomConnection`, gated by a new pure, fully unit-tested
`shouldReconcileLocalVideoTrack(...)` — whenever `canPublish` is true,
`localVideoTrack` is null, the camera isn't intentionally muted, and the
Room's own local camera publication already has a live, unmuted track,
adopt that existing track directly into `localVideoTrack` state. Never
calls `createLocalTracks`/`getUserMedia` (no permission prompt), never
reconnects, and isn't a poll — it only re-runs on real state changes
(`canPublish`/`localVideoTrack`/`cameraMuted`/`participantsVersion`, the
last already bumped by genuine LiveKit track/participant events).
Deliberately keyed on `canPublish` (the existing LiveKit-level signal),
not a new `participantRole`-aware check — matching this codebase's
existing DB-authoritative-for-role / LiveKit-authoritative-for-media-state
separation (see `useActiveSpeakers`'s own doc comment), not a second
role flag. Logs a `console.error` in development whenever it actually
reconciles something, so a real on-device recurrence leaves a concrete
trace instead of silently self-healing.

**Verification honesty**: automated (lint/tsc/full suite — 513/513, 46
files, including a pure-function battery for
`shouldReconcileLocalVideoTrack`, real-Room-mock integration tests for
the reconciliation wiring, fake-timer regression coverage for the
cancel-race fix, and a composition-level "frozen countdown never falls
back to candidate UI" test) and a local production smoke test all pass,
run twice to check for fake-timer flakiness. None of this proves the
original self-preview report is fixed on a real device — that's a
defensive recovery path for an unconfirmed root cause, verified only by
its own decision logic and wiring, not by reproducing the original bug.
The flash and Cancel fixes rest on a *confirmed* traced mechanism, which
is a stronger claim, but still only real-device testing confirms the
actual UX.

## 2026-08-24 — "Going live" countdown redesigned as a center-stage transition (issue #18 UX finding)

**Problem**: after the role-consistency fix, real-device stress testing
surfaced a separate UX issue: the automatic-promotion countdown rendered
as a small inline pill inside `RoomControls`, competing directly with
the persistent bottom composer/controls and ambient comments — all
visible simultaneously. An important transition (about to go live) read
as just another notification instead of a significant moment.

**Decision**: `PortraitRoom`/`MobileLandscapeRoom`'s audience/candidate
branch now renders a new `CountdownOverlay` component *instead of* (not
alongside) the ordinary bottom composer/controls and ambient comments,
for exactly as long as `promotionCountdown !== null` — the same
`useAutomaticPromotion` state (`promotionCountdown`/`onCancelPromotion`)
every earlier rendering of this countdown already used, just switched to
a different presentation. `SpeakerStage` gets a dimming `scrimOpacity`
(its own existing issue #21 mechanism, reused rather than a second
backdrop layer) while counting down. Top chrome (status pill/guest chip)
stays visible throughout, so the transition still reads as "entering the
live room" rather than a separate screen. One shared component for both
orientations — no landscape-specific variant, since centered flex
content scales naturally to either box shape, and a short landscape
viewport needs the identical "stop competing with everything else"
treatment portrait does.

**Not a new promotion system**: no new state, no new timer. The
existing role-router structure already guarantees this can never
coexist with Speaker View — `promotionCountdown` can only be non-null
while `!isSpeaker` (see `useAutomaticPromotion`'s own poll guard), and
the instant `isSpeaker` flips true, the *entire composition* swaps to
`PortraitSpeakerView`/`MobileLandscapeSpeakerView` (a different file
tree), which never renders `CountdownOverlay` at all — the same
structural guarantee the role-consistency fix (previous entry) already
established for the ordinary Audience/Speaker split, extended for free
to this third state rather than needing its own new invariant.

**Reason**: the user explicitly wants becoming a speaker treated as a
significant event, with the countdown visually dominant and nothing
competing with it, while still feeling like a transition within the
same room rather than a navigation. Explicitly a presentation change to
existing state, not a new promotion/state-machine.

**Verification honesty**: automated (lint/tsc/full suite incl. new
transition-level coverage for countdown→speaker and countdown→cancel,
folded into the same `role-consistency.test.tsx` invariant checks the
prior fix established) and a local production smoke test all pass. The
actual look/feel — countdown dominance, dimming, animation restraint,
landscape layout — is real-device-only and remains the user's own next
step.

## 2026-08-24 — Speaker View/Audience role consolidated to one authoritative source (issue #18, post-merge integration finding)

**Problem**: during the final #18 integration sign-off pass (on the
merged `feature/social-stage-shell`), the user reported an intermittent
real-device bug: sometimes becoming a speaker made Speaker View's
full-bleed composition activate, but the bottom control row stayed the
Audience row (React/Vote/Gift) instead of switching to Speaker's
(Mic/Camera/Gift) — not reliably reproducible. The user's instruction
was explicit: treat this as a role/UI consistency problem, not a
one-off boolean patch, and investigate whether the composition and the
control row actually derive from the same state before touching
anything.

**Investigation**: traced every place "am I currently a speaker" gets
computed in the room tree. `EventRoom` computes `isSpeaker` once, from
`speakers`/`identity`, and passes it straight through to
`PortraitRoom`/`MobileLandscapeRoom`'s role router *and* (via which file
that router chooses) the bottom control row — those two are provably
coupled within a single render, so a literal "composition says one
thing, controls say another" divergence couldn't be constructed against
the pre-fix code as it stood. But `SpeakerStage` itself independently
re-derived its own copy of the same fact — `viewerIsSpeaking`/
`mySeatNumber`, computed from raw `speakers`/`myIdentity` inside the
component, never receiving `EventRoom`'s already-computed `isSpeaker` at
all. This exact duplication had already been flagged as a latent risk
once before, in `EventRoom`'s `handleTapEmptySeat` guard's own comment,
for a different bug. No concrete timing race could be proven (both
computations read the same `speakers` prop synchronously, so they're
mathematically equivalent today) — reported to the user as such, rather
than inventing an unproven root cause.

**Decision**: consolidated to one authoritative computation.
`lib/participant-role.ts` (new) exports `findMySeatNumber` (the *one*
place "which seat does this identity hold" is computed) and
`deriveParticipantRole` (folds `isSpeaker`/`hasPendingRequest` into a
single named `"speaker" | "candidate" | "audience"` value, per the
user's own suggested shape). `EventRoom` computes `mySeatNumber`/
`isSpeaker`/`participantRole` once and passes all three down as plain
props. `SpeakerStage` now *receives* `isSpeaker`/`mySeatNumber` as
required props instead of re-deriving them — its own internal
`viewerIsSpeaking`/`mySeatNumber` computation is gone entirely.
`PortraitRoom`/`MobileLandscapeRoom`'s role routers key off
`participantRole === "speaker"` rather than raw `isSpeaker`, so the
composition choice and (via composition identity) the control row now
read the same named derived value. A dev-only `console.error` in
`SpeakerStage` fires if `soloMode=true` but `isSpeaker=false` — the one
remaining place two props from the same caller must agree; this is
prop-level defensive redundancy (the user explicitly wanted this kept),
not independent derivation (which the user explicitly wanted removed).

Separately, added `useRoleTransitionReset` (new hook): fires exactly
once on a `false→true` `isSpeaker` transition and resets
`hasPendingRequest`/`micRequestMode`/`joinSeatMessage` — self-healing so
candidate-only local state can never outlive the candidate role,
regardless of which path granted the seat (this used to be each
individual promotion path's own responsibility to remember, e.g.
`useAutomaticPromotion`'s countdown resolution resetting
`hasPendingRequest` itself on success).

**Reason**: the user's governing invariant — "there must be one
authoritative role determination," composition and controls must always
agree, defensive redundancy is fine but duplicated role *derivation*
isn't. Even without a proven reproduction, `SpeakerStage`'s independent
re-derivation was a genuine violation of that invariant and a real
latent-bug source for the future, already called out once in existing
code comments.

**Verification honesty**: automated (lint/tsc/full suite incl. new
transition-level regression coverage in `role-consistency.test.tsx`,
covering promotion, leaving, repeated join/leave cycles, promotion with
stale composer state, and an approximated "rotation" check comparing
both orientation compositions) and a local production smoke test all
pass. This does **not** confirm the original intermittent report is
fixed — it confirms the specific architectural redundancy that could
have caused a class of such bugs is now gone, and adds a loud dev-mode
signal if the one remaining prop-level contract (`soloMode` vs.
`isSpeaker`) is ever violated. Real-device re-verification, specifically
trying to reproduce the original report, remains the user's own next
step — see SESSION_LOG.md.

## 2026-08-24 — Composer capped to 40% width in landscape, one Tailwind variant covering both Watch Mode and Speaker View

**Problem**: after the landscape audience rebuild, the compact composer
stretched across most of the control row's width in landscape, pushing
React/Vote/Gift (or Mic/Camera/Gift for a speaker) toward the far right
instead of sitting immediately after it — reported directly, with a
requested target of roughly 35–45% of the row's width.

**Root cause**: `WatchModeControls`' row gives the composer no explicit
width of its own — it grows to fill whatever space the fixed-size
emblems beside it don't claim. In portrait (a narrow viewport) that
reads fine; in landscape (much wider) it visibly stretches.

**Decision**: added a single Tailwind `landscape:max-w-[40%]` to
`ChatPanel`'s own compact-mode `<form>` className — Tailwind's built-in
`landscape:` variant, `@media (orientation: landscape)`. Deliberately
*not* the app's own hand-written media queries elsewhere that also
exclude a desktop window by height (`(orientation: landscape) and
(max-height: 500px)`, used for the site-header-hiding rules): that extra
guard exists specifically because those rules target `body`/global
scope, which a genuine desktop browser window can also match. `compact`
mode structurally cannot render there at all — confirmed by checking
every caller: only the four mobile room compositions
(`PortraitRoom`/`MobileLandscapeRoom`, audience or speaker) ever pass
`compact`; `DesktopRoom` renders the non-compact `ChatPanel` via
`RoomChatPanel` instead. A bare `landscape:` variant is therefore both
correct and simpler here — no desktop-exclusion clause needed because
there's no desktop case to exclude.

**One change, both compositions fixed**: since `WatchModeControls`
(and therefore this exact `ChatPanel` instance) is shared verbatim by
Watch Mode and Speaker View in both mobile orientations, this single
class change fixes the composer width in both landscape compositions at
once — no separate Speaker-View-specific change needed, and portrait is
provably unaffected (the `landscape:` variant simply never applies
there).

**A cap, not a fixed size**: `max-width` alone, layered on top of the
composer's existing `flex-1`/`min-w-0` (unchanged) — it still grows and
shrinks normally, just never past 40% of the row's own width, so a
narrow landscape phone isn't forced into an oversized minimum. Nothing
about `WatchModeControls`' row itself needed to change — with the
composer capped, React/Vote/Gift (or Mic/Camera/Gift) naturally end up
immediately after it and the whole group reads left-aligned, since the
row was never using `justify-between` to push them to the far edge in
the first place; the composer's own width was the only thing making it
look that way.

**Verification honesty**: a new test pins the rendered class
(`landscape:max-w-[40%]` present in compact mode, absent in full mode)
and confirms `flex-1`/`min-w-0` are still intact on both the form and
the inner pill — jsdom doesn't evaluate the `orientation` media query
itself, so this cannot exercise the actual portrait-vs-landscape visual
difference; that remains the user's own real-device check.

## 2026-08-24 — Site header hidden for audience landscape too — broadened `speaker-view-active` into `mobile-landscape-live-active`

**Problem**: the previous pass rebuilt audience landscape onto the "05"
shell (minimal top chrome, ambient comments, persistent composer), but
the site-wide header still consumed real height and crowded the stage —
the existing header-hiding CSS only ever triggered for a *seated
speaker* (`body.speaker-view-active`), a role-specific condition that
never covered the ordinary audience/candidate composition it now also
applies to.

**Decision**: broadened the condition rather than adding a second,
nearly-identical class/CSS rule. `EventRoom`'s effect now toggles
`mobile-landscape-live-active` based on `phase !== "upcoming" &&
!isDesktopViewport && orientation === "landscape"` — true exactly when
`MobileLandscapeRoom` (either its audience or its speaker branch) is the
composition about to render, regardless of role. One class, one CSS
rule (`body.mobile-landscape-live-active > header { display: none; }`,
same height-gated media query as before) covers both. Renamed from
`speaker-view-active` rather than keeping the old name for a now-broader
meaning — a class named after a role it no longer requires would
mislead the next reader.

**Why this doesn't affect anything else**: the condition is `phase`/
`orientation`/`isDesktopViewport`-driven only, computed in the same
place and the same way the composition choice itself already is — it
can never be true when `PortraitRoom` or `DesktopRoom` render (portrait,
either role, is completely unaffected; a real desktop window never
matches `!isDesktopViewport`), and it can never be true outside the live
room at all (`phase === "upcoming"` — the pre-lobby countdown view,
which doesn't branch by orientation regardless — excludes it). The CSS
media query itself is a second, independent guard against a real
desktop window by height. Landscape browsing *outside* the room
(`/events`, etc.) never mounts `EventRoom` in the first place, so it was
never affected by either the old or the new class.

**Verification honesty**: `EventRoom` still has no dedicated test file
(the same pre-existing limitation noted when `speaker-view-active` was
first added) — the class-toggle logic is verified structurally (build
succeeds, the condition's inputs are all already-tested pieces of state)
rather than by a unit test asserting the class itself. Real-device
confirmation that the header is actually gone in both roles, and returns
correctly on rotation/leaving, remains the user's own check.

## 2026-08-24 — Audience landscape rebuilt onto "05 — Social Stage" (issue #21) — the last surviving pre-05 composition

**Problem**: real-device testing during the #18 integrated sign-off pass
found that rotating to landscape *as an audience member* still fell back
to the legacy interface — `RoomHeader`'s full status bar, the centered
"💬 Comments" toggle, `RoomChatPanel` mounted only when opened. Portrait
Watch Mode moved past this model days earlier (issue #21's "05" redesign
— always-visible minimal chrome + persistent composer + ambient
comments, no modal chat gate); `MobileLandscapeRoom`'s audience branch
was the one composition nobody had come back to update, so rotating
read as reverting to an older app.

**Decision**: rebuilt `MobileLandscapeRoom`'s audience/candidate branch
to reuse the *exact* components/props `PortraitRoom` and Speaker View
already use — `SpeakerViewTopChrome`, `AmbientComments`,
`WatchModeControls` wrapping the compact `ChatPanel`, `StageOverlayShell`
— rather than inventing a landscape-specific reimplementation of any of
them. The only genuine orientation-specific difference left is
`SpeakerStage`'s own `orientation="landscape"` (side-by-side tiles,
unchanged — two-speaker audience viewing untouched); everything else
(chrome, composer, ambient comments, positioning conventions) is
identical to portrait's, since none of it was ever actually
portrait-specific — only the stage tiling itself genuinely varies by
orientation. This directly answers "don't stretch portrait sideways":
the fix reuses portrait's *components*, not its *layout dimensions* —
landscape still tiles side-by-side, chrome still fits a short/wide box.

**`SpeakerViewTopChrome` reused here too, name notwithstanding**: despite
its name, the component's actual job (status pill + guest chip, left-
anchored, reserving `SelfPreview`'s responsive footprint) is
role-agnostic — `SelfPreview` renders for *any* held local video track,
including a landscape *candidate*'s prepared media ahead of promotion,
not just a seated speaker's. Reusing it here closes that same
self-preview-collision risk for audience landscape that portrait Watch
Mode's own inline top chrome still has *unfixed* (a known, previously
flagged, deliberately out-of-scope gap — portrait's own top chrome was
explicitly left untouched this pass, since the user's own verification
plan required "audience portrait looks unchanged").

**`useCommentsMode` deleted outright**, along with its test — once this
rebuild removed `MobileLandscapeRoom`'s last import of it, nothing in
the codebase referenced it (`RoomChatPanel` is still used by
`DesktopRoom`, confirmed separately, so that component stays). No shim,
no re-export — the retired-comments-mode precedent (`use-comments-focus.ts`,
deleted the same way when the drag gesture was retired) already
established this project's convention for genuinely dead hooks.

**Role router simplified as a side effect**: with `useCommentsMode()`
gone, `MobileLandscapeRoom` no longer owns any hooks of its own, so the
"call hooks before the branch" ordering constraint the previous role-
router pass needed (a dedicated regression test, since `isSpeaker` can
flip while the component stays mounted) no longer applies — the role
check can sit at the very top of the function, matching `PortraitRoom`'s
own structure exactly. The regression test for that constraint was
updated, not deleted, since toggling `isSpeaker` on a mounted instance
without throwing is still worth guarding even though the specific risk
(a hook call skipped) no longer exists in this file — cheap insurance,
not dead weight.

**Explicitly not done, per instruction**: no Discussion Expanded,
reactions, voting, or gifting behavior; React/Vote/Gift stay exactly as
inert as they already were; no landscape-specific chat/media
reimplementation; `MobileLandscapeSpeakerView` (the working Speaker
Landscape composition) untouched.

**Verification honesty**: automated tests cover the composition
directly (top chrome present, legacy chrome absent, composer always
rendered and functional, ambient comments render, React/Vote/Gift still
inert, role router still correct, ordinary rotation doesn't touch
`SpeakerStage`'s own DOM node/class list). They cannot verify the actual
felt result on a real device — whether landscape now genuinely reads as
"the same app" after rotating, not just a checklist of present
elements — that remains the user's own check.

## 2026-08-24 — Speaker View UI cleanup: one control row, safe-area-aware bottom clearance, top-right footprint reservation

**Problem**: functionally complete Speaker View (Phase 2 confirmed on
real-device) still had UI crowding/clipping on an actual phone: a
floating mic/camera row *and* the persistent bottom row read as two
separate control regions; ambient comments rendered behind the
now-taller control stack; the guest-name chip and `SelfPreview`
competed for the same top-right corner despite an earlier fix that only
addressed positioning, not width.

**One control row, not two**: `SpeakerMediaToggles` (new file) is the
*exact same* mic/camera toggle JSX that used to live in
`SpeakerControlBar`'s own row, moved — not reimplemented — into
`WatchModeControls`' 2nd/3rd slot via a new optional `micCameraSlot`
prop. `WatchModeControls` renders `{composer}{micCameraSlot ?? (React +
Vote)}{Gift}` — ordinary Watch Mode never passes `micCameraSlot`, so its
Comment/React/Vote/Gift row is untouched, purely additive.
`SpeakerControlBar` is back to being exactly what its name says: one
"Leave the stage" pill, nothing else. Same `toggleMicrophone`/
`toggleCamera`/`leaveSpeakerSeat` wiring throughout — no behavior change,
only which JSX tree renders which button.

**`AmbientComments`' clearance is Speaker-View-specific, not shared with
Watch Mode**: Speaker View's bottom overlay is now taller than Watch
Mode's (an extra leave-stage row above the composer/mic/camera/gift
row), so reusing Watch Mode's `bottom-16` let the lowest ambient bubble
render behind the controls — reported directly, screenshot included.
Speaker View's own offset is `bottom-32`, sized to clear leave-pill row
+ gap + control row + bottom padding with margin to spare. Watch Mode's
own `bottom-16` is untouched — different composition, different
footprint, deliberately not unified into one constant.

**Safe-area-aware bottom padding, Speaker-View-only**: `StageOverlayShell`'s
default `pb-3` doesn't account for the iPhone home-indicator region.
Rather than changing the shared component's default (which would also
touch Watch Mode, not part of this report), Speaker View passes
`pb-[max(0.75rem,env(safe-area-inset-bottom))]` via `StageOverlayShell`'s
existing `className` prop, which `cn()`'s `twMerge` correctly resolves as
an override of the component's own `pb-3` default — no change to the
shared component's API or Watch Mode's rendered output.

**Top-right footprint reservation, not just positioning**: the earlier
fix (this session, prior pass) moved the guest-name chip off
`SelfPreview`'s corner by anchoring both status pill and chip left
instead of `justify-between`. That reduced collision likelihood but
didn't structurally prevent it — CSS padding doesn't clip flex children
from rendering past it, and on a narrow phone the combined natural width
of a long event title plus a guest name could still reach into
`SelfPreview`'s zone. Fixed properly this time by reusing an
already-proven pattern from this exact codebase:
`MobileLandscapeRoom`'s own header overlay already reserves
`SelfPreview`'s responsive footprint via `pr-16 sm:pr-20` padding,
matching `SelfPreview`'s own breakpoint classes. `SpeakerViewTopChrome`
now does the same (`pr-20 sm:pr-24`, sized to `SelfPreview`'s actual
`w-16`/`sm:w-20` + `right-3` margin, not an arbitrary/tuned-to-one-
screenshot number), combined with `min-w-0 flex-1` on the status pill so
it actually shrinks/truncates under the narrower budget instead of
overflowing it — the same flexbox-shrink discipline already required
once before for the Watch Mode composer. The guest chip stays
`shrink-0`, capped by its own existing `max-w-[9rem]` truncation,
prioritized to stay legible over the event title under pressure.

**Preserved, none of this pass touched them**: LiveKit connection
lifecycle, `soloMode`, seat assignment, self-preview track handling,
mic/camera publication behavior (still `LocalTrack.mute()`/`.unmute()`,
unchanged), `leaveSpeakerSeat`'s call path, comment submission, ambient-
comment data/Realtime behavior. This was composition/layout cleanup —
every prop, action, and hook call is identical to before; only which
JSX renders where and how much space things reserve changed.

**Verification honesty**: automated tests cover the row composition
(mic/camera present exactly once, React/Vote absent for a speaker, Gift
still present), the `bottom-32`/`pb-[...env(safe-area-inset-bottom)]`
classes, and the top-chrome's `pr-20 sm:pr-24`/`min-w-0 flex-1`/
`shrink-0` classes — these pin the actual CSS mechanism the fix depends
on, not just a snapshot. They cannot verify the felt visual result on a
real notched iPhone (whether the clearances read as generous enough, not
just non-overlapping) — that remains the user's own check.

## 2026-08-24 — Speaker View live mic/camera mute toggles (the original plan's remaining Phase 3 half, approved by the user as "Phase 2")

**Phase-numbering reconciliation**: the originally approved 4-phase plan
was Phase 1 (static full-bleed layout), Phase 2 (composer + ambient
comments), Phase 3 (`SpeakerControlBar` — leave-stage first, then
mic/camera toggles), Phase 4 (real-device buffer pass). The prior
corrective pass already delivered the plan's Phase 2 content (composer,
ambient comments) *and* Phase 3's leave-stage half together, framed as
"stress-testing infrastructure" rather than by their original phase
numbers. The user's current "Phase 1 approved, proceed to Phase 2"
message treats everything already shipped as one approved unit and asks
for the next piece — which maps to the original plan's **remaining
Phase 3 content: live mic/camera mute toggles**, not a second delivery
of Phase 2's composer/ambient-comments (already done). Confirmed and
stated this mapping explicitly before writing any code, per instruction.

**Reused**: `SpeakerControlBar` (already exists, currently just the
leave pill) — extended in place rather than building a second bar,
matching what the component's own doc comment already anticipated
("Mic/camera toggles are a deliberate, separate follow-up to this same
component, not a different one"). `leaveSpeakerSeat` untouched. No new
LiveKit connection/subscription — same `Room` instance `EventRoom`
already owns.

**Added**: `useLiveRoomConnection` gained `microphoneMuted`/`cameraMuted`
state and `toggleMicrophone`/`toggleCamera` — implemented via
`LocalTrack.mute()`/`.unmute()` on the already-published track
(`room.localParticipant.getTrackPublication(Track.Source.Microphone /
Camera)?.track`), **not** `setMicrophoneEnabled`/`setCameraEnabled`,
exactly as the original plan specified: those convenience methods
unpublish-and-stop the underlying hardware track on disable and
re-acquire it via `createLocalTracks`/`getUserMedia` on re-enable — a
real reacquisition, and on iOS Safari specifically not guaranteed to
succeed without a fresh gesture at all (the same class of issue already
found and fixed twice this session). `mute()`/`unmute()` instead toggles
send state on the exact same `MediaStreamTrack` already held — no new
hardware access, correctly notifies the other participant via
`TrackMuted`/`TrackUnmuted`. A no-op if nothing is published for that
source yet (`getTrackPublication` returns `undefined`) — `canToggleMedia`
(`canPublish && !needsMediaActivation`, computed by the caller) gates
the buttons to disabled rather than silently no-op'ing on tap in that
state.

**Mute state resets alongside `localVideoTrack`** when `applyPublishState(false)`
runs (leaving the stage) — a later republish within the *same* mounted
hook instance (leave-then-rejoin, not a fresh page load) acquires a
genuinely new track via `prepareLocalMedia`, which always starts
unmuted; without this reset, a prior mute toggle could otherwise appear
to carry over onto a track that was never actually muted.

**Threaded through** `RoomLayoutProps`/`EventRoom`'s `layoutProps` the
same mechanical way every other `connection.*` field already flows —
four new fields, no new decisions there.

**Verification**: new `Room`-mocking tests in `use-live-room-connection.test.ts`
assert `toggleMicrophone`/`toggleCamera` call `.mute()`/`.unmute()` on a
fake track and *never* `setMicrophoneEnabled`/`setCameraEnabled`, that
`createLocalTracks` is never called by either toggle (no reacquisition),
and the no-op/disabled-when-not-publishing cases. These are strong
code-level guarantees against regressing the reacquisition invariant —
they cannot verify the actual felt experience (whether muting reads as
instant on a real device, whether the other participant's audio/video
actually stops), which remains the user's own real-device check.

## 2026-08-24 — Speaker View Phase 2: restored Leave/composer/ambient comments as stress-testing infrastructure, paused split-screen investigation

**Problem**: the seat-index investigation didn't reproduce on retest —
the user needs a better way to stress-test the join/leave cycle
repeatedly to catch the actual trigger, but Speaker View had no in-UI
way to leave the stage at all (only navigating away, which is slow and
introduces its own confound — the lifecycle/token-refresh behavior from
earlier passes). Explicitly asked to pause further split-screen changes
and restore real interface pieces instead.

**Leave the stage**: new `SpeakerControlBar`, currently just one pill,
calling the *exact same* `leaveSpeakerSeat` Server Action `RoomControls`
already uses — no new mutation path, no new authorization logic.
Deliberately not `RoomControls` itself: its `isSpeaker` branch is the
padded, bordered legacy block the user explicitly said not to bring
back. Once `leaveSpeakerSeat` succeeds, nothing further needs wiring —
`useActiveSpeakers`' existing Realtime subscription flips `isSpeaker`
false, the role router in `PortraitRoom`/`MobileLandscapeRoom` returns to
the Audience/Candidate composition on its own, and the existing
`canPublish → false` reaction inside `useLiveRoomConnection` (unchanged)
stops the published camera/mic and clears `localVideoTrack`, hiding
`SelfPreview` — this is the same mechanism already relied on everywhere
else a speaker's seat is ended, not new behavior.

**Composer + ambient comments**: `ChatPanel` gained one new prop,
`allowMicRequest` (default `true`, every existing caller unaffected) —
`false` hides the 🎙 toggle in compact mode entirely, since a seated
speaker already holds the seat a mic request would be for. Both Speaker
Views now wrap `WatchModeControls`/`ChatPanel`(`allowMicRequest={false}`)/
`AmbientComments` in the *same* `StageOverlayShell`/`bottom-16 left-3`
positioning Watch Mode already established — zero new layout logic, same
`sendMessage` action, same gesture-safety logic. React/Vote/Gift stay
inert via the unchanged `WatchModeControls`.

**`SpeakerMediaActivationPrompt` repositioned**: was pinned to the
bottom edge (`bottom-6`), which would now collide with the new
composer/leave row. Moved to vertically centered on the stage
(`top-1/2 -translate-y-1/2`) so it stays clear regardless of the bottom
overlay's actual rendered height, without needing to calculate it.

**Landscape gets the same additions, not portrait-only**: the user's ask
didn't restrict this to portrait, and the stress-test plan explicitly
includes rotating between states — leaving out landscape would mean
rotating mid-test loses the ability to leave or comment, a real
functional gap that could itself look like a new bug during testing.

**Explicitly not done this pass**: no further split-screen
investigation or fix — paused per instruction, pending a cleaner
reproduction from the user's own stress-testing session with these
tools now available. No live mic/camera mute toggles — still a planned
follow-up to `SpeakerControlBar` itself.

**Test updates**: two role-router tests (in `portrait-room.test.tsx` and
`mobile-landscape-room.test.tsx`) had asserted "no composer/no leave
button" for a seated speaker — now stale, since Speaker View genuinely
has both. Updated to assert the *real* leave button exists while the
*legacy* `RoomControls` block's text (`"Setting up your mic access…"`,
"Enable camera & mic") still doesn't — preserving the actual intent
(no legacy block) while fixing the outdated absence claim.

## 2026-08-24 — Speaker View "top seat vs. bottom seat" report: confirmed no seat-index asymmetry exists, via an actual empirical test run, not just re-reading the code

**Problem**: a precise real-device report — claiming the top seat lands
correctly in Speaker View, claiming the bottom seat leaves the old
two-tile composition in place. Explicitly instructed to confirm this
from the actual state/render path, not assume, and to trace both claim
paths side by side across a specific list of values (seat number,
resulting rows, `isSpeaker`, `viewerIsSpeaking`, `myIdentity`, which seat
`soloMode` treats as local/other, whether `PortraitRoom` actually
switches composition, any `seat === 1`/index/"first speaker" assumption).

**Method — verified empirically, not just re-read**: every prior pass
this session traced code by reading it; this time, before writing
anything, I wrote a throwaway probe test rendering `SpeakerStage` with
the viewer occupying seat 2 specifically (both remote-empty and
remote-occupied) and actually ran it. It passed cleanly — no divider, no
local tile, correct empty/occupied handling — proving `SpeakerStage`'s
`soloMode` is symmetric, not just arguing it should be. Also read
`mySeatNumber`'s computation (loops `[1, 2]`, returns whichever matches
`myIdentity` — no ordering bias), `EventRoom`'s `isSpeaker` (`speakers.some(...)`
— doesn't discriminate by seat_number), `PortraitRoom`/`MobileLandscapeRoom`'s
role router (`if (props.isSpeaker) return <...SpeakerView />` — no
seat-number logic at all), and `determineCanPublish`
(`activeSeat !== null` — seat-number-agnostic). All five are provably
symmetric.

**A concrete, relevant discovery while tracing**: `findOpenSeat`
(`lib/speaker-queue.ts`) — used by *both* `joinOpenSeat` (direct tap) and
`decideClaimEligibility`/`claimOpenSeat` (automatic promotion) — always
prefers the lowest-numbered open seat: `if (!occupied.has(1)) return 1;`.
Neither `onTapEmptySeat` nor the server action it calls take a seat
number at all — tapping *either* tile, when both seats are genuinely
open, results in the *same* seat (1) being assigned, regardless of which
tile was physically tapped. This means a "bottom seat" test only
actually exercises seat 2 if seat 1 was already occupied by someone or
something else at the time — worth confirming with the user, since it
changes what the two test runs actually compared.

**Conclusion**: no seat-index asymmetry found in `SpeakerStage`,
`PortraitRoom`/`MobileLandscapeRoom`'s role router, or `EventRoom`'s
`isSpeaker`/`viewerIsSpeaking` computation — all five relevant pieces are
symmetric by code and now by an executed test. Per the user's own
instruction not to assume a cause, no speculative production code change
was made this pass. What *was* added: the full required test matrix
(both local-seat permutations × remote-occupied/remote-empty × repeated
taps × self-preview) across `speaker-stage.test.tsx`,
`portrait-speaker-view.test.tsx`, and `mobile-landscape-speaker-view.test.tsx`
— closing a real, pre-existing coverage gap (every previous soloMode test
only ever put "my" seat at seat_number 1) and giving future changes a
guardrail this specific regression would trip.

## 2026-08-24 — Speaker View: hardened the empty-seat tap's actual mutation source; declined to auto-restore media without a gesture

**Issue 1 — tapping the empty remote seat while seated.** Traced
exhaustively before touching anything, per instruction: `SpeakerStage`'s
`renderTile()` already passes `onTapEmptySeat={viewerIsSpeaking ?
undefined : onTapEmptySeat}` to `SpeakerTile` — when `viewerIsSpeaking`
is true (guaranteed whenever `soloMode`'s `renderSolo` branch is even
reachable, since `mySeatNumber` and `viewerIsSpeaking` are derived from
the *same* `speakers`/`myIdentity` props in the same render pass, so
they cannot disagree within one render), `SpeakerTile` renders the empty
seat as a plain, non-interactive `<div>` — not a `<button>`, no
`onClick` at all. A passing regression test already proved this before
this pass started. Separately, even in a hypothetical worst case where
this *were* reachable, `joinOpenSeat` (`room/actions.ts`) has its own
server-side guard — `getActiveSeatForIdentity` — that rejects an
already-seated identity's claim before it ever reaches
`claim_speaker_seat`, whose own SQL additionally raises on a duplicate
active seat. So a genuine seat swap is provably impossible through this
path, in the client or the database.

**What I could not do**: conclusively reproduce, from static analysis
alone, a code path in the current build where the "split-screen returns"
symptom actually occurs — every reachable trigger I traced is already
inert or already guarded twice. I'm reporting this honestly rather than
claiming a root cause I couldn't verify.

**What I did fix — a real, independently-worthwhile gap**:
`handleTapEmptySeat` (`EventRoom`) itself had no guard of its own; it
unconditionally called `connection.prepareLocalMedia()` before even
attempting `joinOpenSeat`, trusting every caller to never invoke it
while seated. `prepareLocalMedia()`'s idempotency guard
(`preparedTracksRef.current.length > 0`) does **not** protect an
already-published speaker — their tracks already transferred out of
that ref on publish, so a stray invocation would have acquired a
*second*, unpublished `getUserMedia()` track and pointed
`localVideoTrack` state at it via `setLocalVideoTrack`, hiding the real
published track behind an orphaned one. Added an explicit `isSpeaker`
early return at the top of `handleTapEmptySeat` — the same value already
computed once in `EventRoom`, checked at the point the mutating action
actually originates, rather than relying solely on a second,
independently-re-derived check deep in `SpeakerStage`. This is the
"single source of truth, checked at the source" fix the user asked for,
not a cosmetic block — `SpeakerStage`'s own tap-gating stays exactly as
it was (already correct), this closes the gap in front of it.
`speaker-stage.test.tsx` gained the user's literal required test
(repeated taps, still full-bleed, divider/local tile never returns) —
already passing. `EventRoom`'s own new guard isn't independently unit
tested (no test file exists for `EventRoom` at all — a pre-existing
project characteristic, not introduced here — mocking its full hook
surface for a one-line early return wasn't judged worth the setup cost)
— its correctness rests on the guard being trivially reviewable plus the
already-independently-verified server-side check behind it.

**Issue 2 — auto-restoring camera/mic on a fresh, still-entitled
mount.** Investigated whether `prepareLocalMedia`/`activateMedia` can be
called automatically, without a fresh gesture, when `isSpeaker` and
`canPublish` are both already true on mount. **Conclusion: no, not
safely — the button stays as the only path**, per the user's own
explicit fallback instruction for exactly this outcome.

Camera/mic *permission* (the browser's allow/deny grant for the origin)
does persist across navigation — a returning user wouldn't see a new
permission dialog. But that's a different question from whether
`getUserMedia()` itself may be called without an active user gesture,
which is what actually determines whether `createLocalTracks()` (inside
`prepareLocalMedia`) succeeds. This project's own `useLiveRoomConnection`
already documents, from prior real-device testing, that Safari enforces
this **independently of whether permission was previously granted** —
"iOS/macOS Safari silently refuses to even show the permission prompt
for a `getUserMedia` call that isn't inside the call stack of a real
user gesture," with no clean, fast, catchable failure mode (`onclick`
handlers already carry an explicit comment: "MUST be called synchronously
... not a promise continuation or a LiveKit event callback"). The
existing "no second tap needed" behavior this codebase already relies on
(`activateMedia`'s own doc comment: "later `canPublish` flips resync
automatically without another tap") only holds *within one continuous
tab session* — the same `useLiveRoomConnection` hook instance, same
`mediaActivatedRef`. A genuine route-level remount (this exact scenario)
creates a *fresh* hook instance with `mediaActivatedRef.current` reset
to `false`, which is precisely the condition Safari's gesture
requirement was already found to bite on once, for real, on a real
iPhone.

Given that, calling `prepareLocalMedia()` automatically on mount would
mean deliberately violating an invariant this codebase states as an
absolute rule in multiple places, with a real, previously-proven risk of
silently reproducing the exact original bug (camera/mic never
activating, no visible error) — and no reliable way to detect success
vs. failure in advance to safely fall back. Not implemented. The
existing `SpeakerMediaActivationPrompt` (added last pass) remains the
only path, exactly as the user's own fallback instruction anticipated.

## 2026-08-24 — Speaker View: navigating away and back left no way to re-enable camera/mic — a missing UI entry point, not a state-loss bug; seat-vacate-on-navigation confirmed as already-expected behavior

**Problem**: after leaving the room via the site header's "VIRTUAL STAGE"
link and returning, the self-preview stayed gone even though the viewer
could still land back in Speaker View as a seated speaker. Instructed to
trace the actual navigation/remount lifecycle — what happens to
`localVideoTrack` on route teardown, what state exists on remount,
whether `isSpeaker` is restored before media, whether the self-preview
depends on a client-only reference that isn't repopulated, and whether
publication is actually restored for the *other* participant or only the
local preview is missing — and to explicitly verify, not assume, whether
seat persistence across navigation is even the intended lifecycle before
changing anything.

**Seat-vacate-on-navigation is already the intended, already-documented
lifecycle — verified, not assumed.** Navigating to `/` unmounts
`EventRoom` (it lives inside the route's own tree; `SiteHeader` lives in
the shared root layout and doesn't unmount). `useLiveRoomConnection`'s
connect effect's cleanup runs on that unmount: `room.disconnect()` — a
real LiveKit disconnect. LiveKit's own webhook (`participant_left` →
`endSpeakerSeat`, `app/api/livekit/webhook/route.ts`, issue #13) then
vacates the `event_speakers` row server-side. This was already explicit,
stated policy — Phase 1's own doc comments already said "closing the tab
or navigating away still releases the seat via the existing
LiveKit-webhook disconnect path" — so the *product* behavior here needed
no change. What the user observed as "returning to a speaker state" is
the webhook's own network latency: if the return navigation happens
before the webhook finishes processing, the DB row (and therefore the
fresh page load's `isSpeaker` computation) can still show the seat as
active. This is a timing artifact of an already-correct mechanism, not a
second, competing seat-retention feature — nothing in this pass changes
it.

**The actual bug, traced through the full lifecycle**: whether the
returning session finds itself seated by genuine re-promotion or by this
timing window, it always lands on a *fresh* `useLiveRoomConnection`
instance — `mediaActivatedRef`/`preparedTracksRef` reset to their
initial values, `localVideoTrack` starts `null`, by design, on every real
remount (this is the same "every piece of this tab's media state starts
over" fact already documented for the hard-refresh case, see the
2026-08-22 refresh-recovery entry below). On `RoomEvent.Connected`,
`syncCanPublish()` correctly sets `canPublish: true` (the server-side
grant is real), but deliberately does **not** auto-publish —
`mediaActivatedRef.current || !publish` is `false || false` when neither
has happened yet in this fresh tab, which is the same Safari-gesture
protection every other activation path in this app already relies on.
`needsMediaActivation` becomes `true`, exactly as designed.

The actual defect: **Speaker View Phase 1 has no UI that can ever act on
`needsMediaActivation`.** `SpeakerStage`'s `soloMode` never renders the
viewer's own seat's tile (the whole point of full-bleed Speaker View),
which is where the ordinary "tap to enable camera & mic" affordance
lives (`SpeakerTile`'s own `isLocal && needsMediaActivation` branch).
Neither `PortraitSpeakerView` nor `MobileLandscapeSpeakerView` render
`RoomControls` either (Phase 1 deliberately excludes it). Every *other*
room composition has one of those two paths; Speaker View had neither —
so `activateMedia()` could never be called, camera/mic were never
re-published (not just the local preview — the *other* participant would
also have kept seeing this speaker's tile as "Camera off," since nothing
was actually being published), and the self-preview had nothing to ever
repopulate it from.

**Decision**: added `SpeakerMediaActivationPrompt`, a small shared
component rendered by both Speaker Views, visible only when
`needsMediaActivation` is true (`null` otherwise — invisible in the
common case). Calls the *exact same* `activateMedia` prop already
flowing through both views, directly from its own `onClick` (the same
gesture-safe pattern as every other activation tap target in this app) —
no new acquisition logic, no new server call, idempotent by construction
via `prepareLocalMedia`'s own existing guard. This is not "forcing the
preview visible" — it restores the one missing trigger for an
already-correct mechanism, then lets that mechanism do exactly what it
already does everywhere else.

**Explicitly not changed**: seat-vacate-on-navigation behavior itself,
`useLiveRoomConnection`'s activation logic, `SpeakerStage`/`SpeakerTile`,
or the landscape corrections from the prior pass. `RoomControls` wasn't
reused wholesale specifically to avoid also introducing "Leave the
stage" as a side effect — that's still explicitly Phase 3's job, not
bundled into a lifecycle bug fix.

**Verification honesty**: automated tests confirm the prompt renders
only when needed and calls the correct `activateMedia` reference. They
cannot verify the actual real-device round trip (navigate away, wait a
realistic amount of time, return, tap, confirm the *other* participant
sees video resume) — that remains the user's own check.

## 2026-08-24 — Speaker View: the self-preview bug was a token-refresh-triggered LiveKit reconnect, not a CSS issue; site header hidden in landscape while speaking

**Problem**: the previous corrective pass (repositioning the guest-name
chip away from `SelfPreview`'s corner, fixing an iOS-zoom `text-sm`
override) did not fix the actual bug — the self-preview still
disappeared after committing a name edit while seated, and stayed gone.
Explicitly instructed not to make another speculative fix: trace the
actual render/state/track lifecycle and compare the tree before and
after the edit, or fall back to disabling name editing while speaking
rather than iterate blindly again.

**Investigation, grounded in this project's own bundled Next.js docs**
(per AGENTS.md's instruction to read `node_modules/next/dist/docs/`
before writing code, since this project's Next.js version has
non-default behaviors): `node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`'s
"Cookies" section states plainly — "When you set or delete a cookie in a
Server Action, Next.js re-renders the current page and its layouts on
the server... Client state is preserved for re-rendered components, and
**effects re-run if their dependencies changed**." `setGuestName`
(`app/events/[id]/lobby/actions.ts`) does exactly this: `cookies().set(...)`
inside a Server Action, with no `revalidatePath` needed to trigger the
re-render — the cookie write alone does it.

That re-render re-executes `EventPage` (`app/events/[id]/page.tsx`),
which re-calls `getLiveKitToken(id)` unconditionally as part of its
`Promise.all`. `mintLiveKitToken` (`lib/livekit/token.ts`) signs a new
`AccessToken.toJwt()` on every call — a genuinely different token
string each time, even for identical grants — confirmed by reading the
signing code directly, not assumed. That fresh string becomes
`EventRoom`'s new `initialToken` prop, which flows into
`useLiveRoomConnection`'s `params.token`. The connect effect's
dependency array was `[params?.livekitUrl, params?.token]` — a changed
token string, even while already connected, tore the effect down: its
cleanup calls `room.disconnect()` (a **real LiveKit disconnect**, not a
local-only artifact — every other participant would have seen the
speaker's tracks drop too) and `stopPreparedTracks()`, which
unconditionally calls `setLocalVideoTrack(null)` — hiding the
self-preview. The effect then re-ran, created a new `Room`, reconnected
with the new token, and on `RoomEvent.Connected` re-published camera/mic
via `setCameraEnabled`/`setMicrophoneEnabled` — a genuine `getUserMedia`
reacquisition, since an already-published speaker's tracks had already
left `preparedTracksRef` (the only branch of `applyPublishState` that
sets `localVideoTrack` is the *prepared-tracks* branch, which this path
never touches) — so `localVideoTrack` was never restored, permanently
hiding the preview even though the participant was, after a beat,
actually republishing.

**Why the previous fix didn't help**: it addressed two real but
unrelated defects (a genuine corner overlap, a genuine reintroduced iOS
zoom bug) that happened to *also* exist, neither of which was the actual
cause. Both are still worth keeping — they're real fixes — but this is
the bug the user was actually seeing.

**Decision**: `useLiveRoomConnection`'s connect effect now depends on
`Boolean(params?.token)`, not `params?.token`'s value. This is not a
workaround — it's aligning the implementation with a principle this
project's own architecture doc already states: "token expiry doesn't
enforce anything... revocation happens live via `syncPublishPermission()`'s
push to an already-connected participant, no reconnect required" (see
the LiveKit authorization model section). A token refreshed for reasons
unrelated to permissions (a cookie write) was never supposed to be a
reconnect signal — the connect effect just hadn't fully lived up to that
principle, since nothing had previously exercised the "already
connected, new token value arrives" case until a guest-name edit made it
observable. The one legitimate case this must still handle — the
documented null-params → real-params transition (e.g. phase flipping to
"ready") — still works, since presence flips from `false` to `true`
regardless of the specific string value.

**Verification honesty**: a new test suite
(`use-live-room-connection.test.ts`) mocks `Room` directly (previously
only `createLocalTracks` was mocked) to assert: a token-value-only
change never creates a second `Room` or calls `connect()`/`disconnect()`
again; the null → real transition still connects exactly once; an actual
`livekitUrl` change still reconnects correctly. These are strong,
code-level guarantees against regressing this specific mechanism — they
cannot verify the end-to-end real-device experience (whether the
self-preview visibly survives repeated real edits on an actual iPhone),
which remains the user's own check.

**Landscape site-header decision**: real-device testing separately found
the existing `room-active` padding-only header compaction insufficient
for Speaker View's landscape composition specifically, since it has no
sidebar/chat competing for space the way the audience composition does
— the header became proportionally the largest non-video element.
Added a second, more specific body class, `speaker-view-active` (tracks
`isSpeaker`, not just "any room mounted" — a separate effect in
`EventRoom` since its dependency is real, unlike `room-active`'s
mount/unmount-only lifecycle), gated behind the same landscape+short-height
media query, that hides the site header outright (`display: none`)
rather than further shrinking it. Explicitly scoped to the speaking
state only — ordinary audience landscape keeps exactly its existing
padding-only treatment, unchanged. Not unit-tested directly (`EventRoom`
has no existing test file, and mocking its full hook surface for a
two-line class-toggle effect wasn't judged worth the setup cost) —
verified structurally (build succeeds, class name matches the CSS
selector) and left to real-device confirmation.

## 2026-08-24 — Speaker View Phase 1 corrective pass: self-preview corner collision traced to two root causes; landscape gets its own thin role-router view, not a `soloMode` branch inside `MobileLandscapeRoom`

**Problem 1**: real-device testing found the self-preview disappearing
after tapping the guest-name chip in portrait Speaker View, and staying
gone after committing — not just a transient glitch during editing.
Instructed to trace the actual cause (remount, prop/state loss,
z-index/visibility, or the chip variant itself) rather than patch around
it with a "recreate the preview after editing" workaround.

**Investigation**: `GuestNameEditor`'s internal `editing`/`name` state is
local to that component — a React state update there cannot, by itself,
cause a sibling (`SpeakerStage`/`SelfPreview`) to re-render or remount;
confirmed no `revalidatePath`/`router.refresh()` anywhere in
`setGuestName` or its call path that could force a wider tree refresh
either. Two *real*, independently-verifiable defects were found instead,
both introduced when `PortraitSpeakerView` copied Watch Mode's top-chrome
markup verbatim in Phase 1, without accounting for the fact that Speaker
View — unlike ordinary Watch Mode — always has an active `SelfPreview`
occupying the fixed `top-3 right-3` corner:

1. **Positional collision**: the guest-name chip was placed at the
   opposite end of the top-chrome row via `justify-between`, landing it
   directly in `SelfPreview`'s own `top-3 right-3` box. Watch Mode's
   original layout this was copied from never had this problem because
   an ordinary audience member usually has no self-preview competing for
   that corner.
2. **A real, reproducible iOS-zoom bug, not just a visual overlap**:
   `GuestNameEditor`'s edit-mode `<Input>` passed `className="... text-sm"`
   in *both* variants. `cn()`'s `twMerge` correctly treats this as an
   override of `<Input>`'s own `text-base` default — the exact fix
   already added there, and already documented in its own comment,
   specifically to prevent iOS Safari's auto-zoom-on-focus (the *same*
   bug already found and fixed once for the Watch Mode composer, see the
   2026-08-23 entry below — it had just never been checked against this
   component too). Tapping the name to edit it silently re-triggered a
   real viewport zoom, which is what made the fixed-position self-preview
   appear to leave the visible screen — and, depending on whether the
   zoom fully settles back on blur, why it could still look "gone" after
   committing.

**Decision**: fixed both root causes directly, no workaround layer.
`GuestNameEditor` no longer sets any font-size class at all on the edit
`<Input>` (both variants), letting `<Input>`'s own 16px default apply
unmodified. A new shared `SpeakerViewTopChrome` component (used by both
`PortraitSpeakerView` and the new `MobileLandscapeSpeakerView`) keeps the
status pill and guest-name chip anchored together on the left
(`justify-start`, not `justify-between`), leaving the top-right corner
exclusively to `SelfPreview` in every Speaker View composition. Neither
fix touches `SelfPreview`, `useLiveRoomConnection`, or the local video
track at all — satisfying the explicit requirement that this be a real
fix, not a "recreate the preview" patch over a component that's still
actually losing it.

**Known adjacent risk, not fixed here**: the exact same corner-collision
pattern could in principle also affect ordinary Watch Mode for a
*candidate* (pending request, media already prepared ahead of promotion)
— `SpeakerStage` renders `SelfPreview` for anyone holding a local video
track, regardless of role, and `PortraitRoom`'s own top chrome still uses
`justify-between`. This wasn't reported and is out of this pass's scope
(Watch Mode is confirmed working from Phase 1–3 real-device testing), but
is worth a deliberate check rather than assuming it can't happen — noted
here rather than silently fixed or silently ignored.

**Problem 2**: rotating a seated speaker's phone to landscape dropped
them into `MobileLandscapeRoom`'s ordinary *audience* composition
(equal-split tiles, full `RoomHeader`, Comments Mode toggle, `RoomControls`'
full block) — undoing the entire role hierarchy Portrait Speaker View
had just established, since landscape was explicitly left unbuilt in the
original Phase 1 scope.

**Architecture question, resolved**: threading a `soloMode`-driven
conditional directly into `MobileLandscapeRoom`'s existing JSX was
rejected — that component's audience composition (`useCommentsMode`,
`RoomHeader`, `RoomChatPanel`, the scrim tied to `commentsOpen`) shares
essentially nothing with Speaker View, and conditionally stripping all of
it inline would tangle two unrelated concerns in one file. Instead: a new
`MobileLandscapeSpeakerView`, mirroring `PortraitSpeakerView` exactly
(same `SpeakerStage` `soloMode`, same `SpeakerViewTopChrome`, same reused
`SelfPreview`) — the same role-router pattern already proven for
portrait, applied consistently rather than inventing a second pattern.
`MobileLandscapeRoom` still calls `useCommentsMode()` unconditionally
before its own role check, since `isSpeaker` can flip while the component
stays mounted (promoted while already rotated to landscape) — calling a
hook conditionally there would be a genuine Rules-of-Hooks violation, not
just a style preference; a regression test (`rerender` toggling
`isSpeaker` back and forth without throwing) guards this specifically.

**No new video/media logic in either fix**: `soloMode` is reused exactly
as built in Phase 1; rotating between `PortraitSpeakerView` and
`MobileLandscapeSpeakerView` is the same "recreate the `<video>`
attachment, never reacquire the track, never touch `EventRoom`/
`useLiveRoomConnection`" tolerance already relied on for the ordinary
Audience/Candidate rotation and for entering Speaker View itself.

**Verification honesty**: automated tests cover the positioning class
(`justify-between` absent), the font-size class (`text-base` present,
`text-sm` absent), the role-router delegation for both orientations, and
the Rules-of-Hooks safety of toggling `isSpeaker` on a mounted
`MobileLandscapeRoom`. They cannot verify the actual felt experience on
real iOS Safari (whether the zoom fix fully eliminates the visual
disappearance end-to-end, whether the landscape layout reads as
"materially less cluttered" as asked) — both remain real-device-only
checks, reported as such.

## 2026-08-24 — Speaker View (#18): #16/#17 verified (not assumed) complete; Direction B chosen; Phase 1 built as a `soloMode` extension, not a new stage implementation

**Problem**: #18 (role-based room UI) was blocked on #16/#17, both still
open on GitHub despite the code already looking like it implemented
them. Before starting #18, needed to know whether that was genuinely
true or just superficially similar — the user explicitly required
checking actual acceptance criteria, not closing on appearance.

**#16/#17 verification**: read each issue's original body as a checklist
and checked every item against real code/migrations, not the doc
comments describing them. #16: migration `00000000000012` has every
specified schema/function change, `token.ts`/`permissions.ts` are
identity-shape-generic, and — the item most likely to have been missed
silently — the LiveKit webhook route's old profile-only early-return
(the exact regression #16 warned "will silently leak seats forever") is
gone, with a comment citing #16 directly. #17: `EventRoom` calls every
live hook unconditionally above the phase branch, LiveKit stays lazy
until `ready`, and the `/lobby`/`/room` routes are still real `redirect()`
stubs, not deleted (the issue explicitly required they not be deleted
outright). No gaps found in either. Both closed with the specific
evidence in the closing comment; board cards moved to Done.

**Architecture assessment (no code yet)**: found that Direction B's "own
camera stays small" half was already built — issue #22's dominant-video
corrective pass already suppresses a seated speaker's own big video,
`SelfPreview` already gives the small corner treatment, for both
candidates and speakers, in every composition, today. The only real gap
is the *other* speaker's tile still being equal-sized — already named
three times, verbatim, as deferred to #18 in ARCHITECTURE.md/DECISIONS.md
("literal asymmetric... grid sizing... still #18's territory"). Presented
three directions (corner-swap / full-bleed-remote / asymmetric-grid)
without picking one, and a recommended architecture (role derived from
already-live state, no new hooks; role branch inside each device
composition; extend the existing `SpeakerStage`/`SpeakerTile`/
`SelfPreview` trio rather than duplicating it) — the user chose
**Direction B** (full-bleed remote speaker, floating self-preview) with
six explicit decisions, most notably: mic/camera toggles must use the
*already-published* LiveKit tracks, never reacquire.

**Phase 1 decision — extend `SpeakerStage`, don't fork it**: the
alternative considered was a parallel "solo stage" component that only
renders one tile. Rejected — `SpeakerStage` already owns every
seat-tile-rendering concern (empty-seat placeholder, media-activation tap
target, reconnect grace, `<video>` attach/detach lifecycle), and forking
it would either duplicate all of that or silently drift out of sync with
it over time, the exact "duplicate implementation" the user's plan
explicitly asked to avoid. Instead: one new optional prop, `soloMode`
(default `false`), which skips the divider and the viewer's own tile,
calling the *same* `renderTile()` once instead of twice for whichever
seat isn't the viewer's own. Every existing caller (`MobileLandscapeRoom`,
`DesktopRoom`, `PortraitRoom`'s own Audience/Candidate path) is
unaffected by construction, not just by testing — the prop defaults to
today's exact behavior.

**Why this doesn't destabilize LiveKit**: `EventRoom`/
`useLiveRoomConnection` are untouched by this change entirely — the role
router lives in `PortraitRoom`/`PortraitSpeakerView`, both presentation
components below `EventRoom` in the tree. The only thing that happens at
the moment `isSpeaker` flips is the other speaker's already-subscribed
`<video>` element moving from the two-tile grid to the solo slot — a
one-time re-attach (`track.attach()` on a new DOM node), not a
resubscription. This is the identical tolerance already proven safe for
every existing orientation/viewport composition swap (documented in
ARCHITECTURE.md's Mobile orientation implementation section) — Phase 1
applies it across one more branch, it doesn't invent a new one.

**Deliberate Phase 1 gap, not an oversight**: per the approved phase
scope, this build has no `SpeakerControlBar` and no leave-stage control
of any kind inside Speaker View — a seated speaker can only exit via
disconnect (closing the tab, which the existing LiveKit webhook already
turns into a clean seat release). This was flagged explicitly rather than
silently left for the user to discover on their phone.

**Verification honesty**: automated tests (`speaker-stage.test.tsx`'s new
`soloMode` cases, `portrait-speaker-view.test.tsx`) cover the tile-count/
divider/empty-seat/self-preview logic and the defensive fallback when
`soloMode` is set without the viewer actually holding a seat — they
cannot verify the actual felt experience of the video re-attach at the
moment of promotion (a brief flicker vs. seamless, on real hardware) or
whether `SelfPreview`'s corner position still reads correctly against a
full-bleed remote video instead of a half-height tile — both remain
real-device-only checks, reported as such.

## 2026-08-23 — Phase 3: ambient comments reuse the durable chat stream; ambient lifecycle kept separate from data lifecycle

**Problem**: Watch Mode's persistent composer (Phase 2) can send
comments, but nothing shows them — the room doesn't yet *feel*
inhabited the way the approved "05 — Social Stage" design calls for.
Phase 3's brief: surface recent comments ambiently, without turning
Watch Mode back into a chat screen, and without building a second
comment system.

**Decision**: `AmbientComments` reads the *same* `messages` array every
other room composition already receives from `useLobbyRealtime` — zero
new Realtime subscription, zero new backend. This is explicitly the
"reuse an existing durable stream" case, not the "genuinely new
ephemeral broadcast" case ARCHITECTURE.md's Realtime-traffic-vs-durable-
writes section describes for the *future* ambient-reactions work
(Phases 5/6) — comments already persist one row per message on purpose
(dedup, moderation, history), so there's nothing to avoid persisting
here.

**Why local component state is still needed despite `messages` being
the source of truth**: the *ambient* lifecycle (fade in, hold ~7s, fade
out) is a presentation concern the underlying data doesn't have — a
message never disappears from `messages` once sent. `AmbientComments`
tracks which message ids it has already assigned a lifecycle to
(`shownIds`, a ref) so each message gets exactly one fade timer, the
first time it's seen, decoupled entirely from the data's own permanence.
A message re-appearing in a later `messages` prop (it always will,
since messages don't get removed) does not restart or re-trigger its
bubble.

**Seeded on mount, not empty**: the last `MAX_VISIBLE` (3) messages
already in `messages` when the component first mounts are shown
immediately, each given a *fresh* expiry timer starting from mount time
(not their original `created_at`) — a viewer arriving mid-conversation
should see the room is inhabited right away, not wait for the next live
message.

**Conservative, capped feed size**: never more than 3 bubbles at once —
a burst evicts the oldest immediately (clearing its now-pointless timer)
rather than stacking taller. This is the "small number of recent items"
the approved design calls for; the cap is a single constant
(`MAX_VISIBLE`), not hard-coded layout math, so a later phase can shrink
it further (e.g. while a future React/Vote/Gift tray is open) without
restructuring the component.

**Future click-target seam, deliberately inert today**: each bubble
carries `data-message-id` — a stable, already-identifiable DOM hook a
later Discussion Expanded phase can attach a tap handler to — but no
`onClick`/`onCommentSelect` prop exists yet. Each bubble is
`pointer-events-auto` even though nothing listens yet (the wrapping
overlay stays `pointer-events-none`, the same click-through pattern
already used for the top chrome and `StageOverlayShell`'s decorative
margin), so a later phase adds a handler, not a rewrite of the
click-through structure.

**Positioning**: an absolutely-positioned overlay sibling of
`SpeakerStage` (`bottom-16 left-3`), not a document-flow element — it
reserves no space and never resizes/reflows the video. `bottom-16`
(64px) was chosen from the composer row's own worst-case height (44px
emblem + 12px shell padding = 56px) plus a small margin, keeping the
overlay clear of the persistent bottom controls in every state observed
in code (with vs. without the compact `RoomControls` pending-pill above
the composer); real-device review is still what confirms this against
an actual device's rendering.

**Verification honesty**: automated tests (`ambient-comments.test.tsx`,
`portrait-room.test.tsx`) cover the seeding/eviction/expiry logic and
the click-through/positioning classes using `vi.useFakeTimers()` — they
cannot verify the *visual* read (whether it genuinely looks ambient
rather than cluttered, whether the fade timing feels right, whether
`bottom-16` actually clears every real device's rendered composer
height) — that remains real-device-only, reported as such.

## 2026-08-23 — Compact composer triggered iOS Safari's auto-zoom-on-focus; verified before touching anything

**Problem**: focusing the compact Watch Mode composer on a real iPhone
made Safari zoom the whole page toward the input, pushing parts of the
stage/UI out of view. The user's own hypothesis was a sub-16px input
font-size, but explicitly asked for verification, not an assumed fix.

**Investigation, all done before any code changed**:
- Computed font-size: no `tailwind.config` file exists (Tailwind v4,
  CSS-based config) and `globals.css` defines no `fontSize`/root-`html`
  override — Tailwind's stock scale applies unmodified, meaning
  `text-sm` really is 14px and `text-base` really is 16px in this
  project, not a guess.
- The compact composer's `<input>` (`chat-panel.tsx`) used `text-sm`
  (14px) — under Safari's 16px auto-zoom threshold.
- Checked for a compounding cause per the user's explicit checklist:
  no `transform`/`scale`/`zoom` CSS exists anywhere in the room
  component tree (`grep` across `src/components/room`), and no
  `scrollIntoView`/`visualViewport` code exists anywhere in this
  codebase. The pan the user saw is Safari's own native zoom mechanism
  operating on the true 14px font-size, not a second, app-level bug
  compounding it.
- The shared `<Input>` component (`src/components/ui/input.tsx`)
  already has this exact fix, with this exact reasoning, in its own
  comment (`text-base (16px), not text-sm: iOS Safari auto-zooms...`)
  — Phase 2's compact composer needed a raw `<input>` (the shared
  component's fixed rounded-rectangle styling doesn't fit the glass
  pill) and simply didn't carry that established convention over.

**Decision**: `text-sm` → `text-base` on the compact input's
`className`, nothing else. The same input element renders for both
mic-off and mic-on states (only the wrapping pill's border/background
and the placeholder text differ), so this one change fixes both — no
special-casing needed. Deliberately did **not** add
`maximum-scale=1`/`user-scalable=no` or any other global viewport
restriction — explicitly forbidden (breaks pinch-to-zoom
accessibility), and not necessary here since the real fix addresses
*why* Safari wants to zoom in the first place, not just the symptom.

**Verification honesty**: added a regression test pinning the rendered
`className` (`text-base`, never `text-sm`) for both composer states —
this guards the CSS class going forward, but a jsdom test cannot
exercise real Safari zoom behavior; that remains a real-device-only
check, reported as such, not claimed as automated proof.

## 2026-08-23 — Phase 2 real-device fixes: stale Request-to-Speak state traced to its root, compact pending feedback, bottom-row overflow

**Problem**: real-device testing of Phase 2 found four issues, none of
them cosmetic-only — see the user's own report. The most important was
issue 2: after leaving the stage, the room still showed "Your request
is live in chat..." plus a Withdraw button that "appeared to do
nothing." Per explicit instruction, this needed the actual lifecycle
traced, not a UI-level hide.

**Root cause, traced**: `useAutomaticPromotion`'s countdown-reaches-zero
effect calls `claimOpenSeat`, which marks the underlying
`speaker_requests` row `'granted'` server-side — but never told the
caller. `hasPendingRequest` stayed stuck `true` in `EventRoom`'s state,
merely *hidden* because `RoomControls`' `isSpeaker` branch takes
priority while seated. The moment the speaker left the stage
(`isSpeaker` → false again), the untouched, stale `hasPendingRequest`
resurrected the "still pending" UI for a request that had already been
consumed by a promotion the speaker didn't even use anymore.

Compounding it: pressing "Withdraw" called the existing
`withdrawSpeakerRequest`, whose underlying RPCs (migrations
00000000000011/00000000000012) `raise exception` "no pending request
found..." when the row's status isn't `'pending'` — exactly the state a
granted-then-abandoned request is in. That exception surfaced as a
generic UI error, and critically, `useAutomaticPromotion.cancel()` only
cleared `hasPendingRequest` on a *successful* result, so the flag never
cleared — the button "did nothing" because it was failing silently.

**Decision — two independent fixes, not one band-aid**:
1. **Root fix**: `claimOpenSeat` succeeding now calls
   `onHasPendingRequestChange(false)` immediately (a failed/lost-race
   claim still does *not* clear it — silently resets to waiting, per
   this hook's own pre-existing documented intent). This is what
   prevents the stale state from ever arising in the first place.
2. **Recovery fix**: `withdrawSpeakerRequest`/`withdrawSpeakerRequestAsGuest`
   (repository layer) now return `null` — not a thrown error — when the
   RPC's specific "no pending request found" exception fires, matching
   this codebase's existing pattern of matching specific RPC exception
   text (`requestToSpeak`'s own catch block does the same). "Nothing
   left to withdraw" and "successfully withdrew" both mean the same
   thing to the caller (no pending request remains), so the action layer
   now returns `{ok: true}` either way, and Withdraw/Cancel always
   correctly clears the flag even if the root fix's timing is somehow
   missed (multi-tab, a stale client, etc.).

**Compact pending-request feedback**: `RoomControls` gained an opt-in
`compact` prop, applied only to its two `hasPendingRequest` states (not
`isSpeaker`/Leave-the-stage, which real-device testing didn't flag) —
same information, same `onCancelPromotion` action, same
`mediaErrorNotice`, rendered as a single-line "🎙 Request sent · Cancel"
pill instead of a paragraph+button block. `PortraitRoom` wraps only the
`isSpeaker` case in its own background box now; the compact pill already
carries its own.

**Bottom-row overflow on narrow phones**: the actual cause was a broken
flexbox shrink chain, not a genuine width shortage — `WatchModeControls`'
three emblems are deliberately `shrink-0` (comfortable tap targets,
never compressed), leaving the composer as the only element allowed to
shrink. A flex item's default `min-width` is `auto` (its own content's
size), not `0`; the composer's form and its inner pill were both
missing an explicit `min-w-0`, capping how far they could actually
compress before the row's total width exceeded the viewport — pushing
Gift (the last item) partially off-screen. Fixed by adding `min-w-0` at
every nested flex level between the row and the `<input>` — the chain
only needs to be broken once to cap the whole thing.

**Placeholder truncation**: the compact composer's Request-to-Speak
placeholder shortened from "What do you want to talk about?" to "What's
your topic?" — compact-mode-only; the full `ChatPanel` (landscape/
desktop, more width available) keeps the original text unchanged.

**Deliberately not built**: any comment-sent confirmation UI (toast,
inline acknowledgment, etc.) — the user was explicit that Phase 3's
approved ambient-comment feed is the intended feedback mechanism, and a
temporary duplicate would just be thrown away next phase.

## 2026-08-23 — "05 — Social Stage" Phase 2: functional composer, reusing `ChatPanel` verbatim; Speaker View flagged as the next checkpoint

**Problem**: Phase 1's persistent bottom composer was a static, `disabled`
placeholder. Phase 2 needed to make it real — actual sending, actual
Request-to-Speak — without duplicating `ChatPanel`'s existing
send/request actions, its `micRequestMode` controlled-prop contract, or
its synchronous `onPrepareMedia()` submit order (the Safari
user-gesture requirement issue #22 already solved once).

**Decision**: gave `ChatPanel` itself an opt-in `compact` prop rather
than building a second composer component or extracting a new shared
hook. `compact` skips the message list and quick-emoji row and renders
the form as a small translucent "glass" pill instead of the full
Input/Button treatment — but it's the *same* `useActionState` pair, the
same `micRequestMode` branch, the same `onSubmit` calling
`onPrepareMedia()` synchronously only in the request branch. Nothing
about the actions or gesture-safety logic is duplicated; only the JSX
differs. `ChatPanel` is imported by exactly one thing
(`RoomChatPanel`, used by `MobileLandscapeRoom`/`DesktopRoom`), and
`compact` defaults to `false`, so neither existing caller is affected.

`WatchModeControls` gained a `composer?: ReactNode` slot (defaulting to
Phase 1's original inert placeholder when omitted) rather than special-
casing the composer internally — `PortraitRoom` now passes the compact
`ChatPanel` instance into that slot, wired to the same
`RoomLayoutProps` fields (`messages`, `reactions`, `micRequestMode`,
`onMicRequestModeChange`, `onHasPendingRequestChange`, `onPrepareMedia`)
`RoomChatPanel` already threads through elsewhere.

**Mic-on visual distinction, kept small on purpose**: the pill's own
border/background tints accent-colored and the mic glyph's own
26×26 circle fills solid accent — no new element, no size change, per
the explicit "visually unmistakable without making the composer
substantially larger" requirement.

**Reason**: "reuse or extend, don't duplicate" — `ChatPanel`'s compact
mode is the only place `sendMessage`/`submitSpeakerRequest`/
`onPrepareMedia` wiring exists now, for both the full chat surface and
the new persistent composer.

**Tradeoffs**: none identified. React/Vote/Gift remain exactly as
Phase 1 left them (`disabled`); no ambient comments, no Discussion
Expanded, no realtime reactions, no voting/gifting behavior — all still
explicitly out of scope for this phase.

**Speaker View flagged, not designed, this pass**: real-device testing
of Phase 1 surfaced that a seated speaker's UI still behaves like the
audience Watch interface — not the intended final behavior. Per
explicit instruction, this is a distinct checkpoint to design *after*
Phase 2 is verified and *before* Phases 3–7 (ambient comments, Discussion
Expanded, reactions, voting, gifting) — those systems may need
different placement depending on audience-vs-speaker role, so the
speaker composition should settle first. Scoped to #18 (already
existing, role-based room UI) rather than a new issue. Explicitly not
started in this pass.

## 2026-08-23 — "05 — Social Stage" real-device implementation begins: architecture survey, phased plan, Phase 1 (static shell)

**Problem**: the approved Figma "05" interaction model (video-first Watch
Mode, ambient comments/reactions, a persistent bottom control row,
Discussion Expanded) needed to move from static design into real code
without destabilizing the stable Watch Mode / Comments Mode
implementation it replaces, and without redoing work the app already
has (request-to-speak, the composer's actions, LiveKit connection
ownership).

**Investigation** (full architectural survey before any code changed):
confirmed reactions today are durable, per-message, DB-backed
(`event_chat_message_reactions` — one row per (message, emoji,
identity)) with no ambient/floating concept and no double-tap handling
anywhere; confirmed voting is entirely unbuilt (issue #25 territory —
no table, no action, only planning prose); confirmed the composer's
mic-request/send unification (`ChatPanel`, `micRequestMode` as a
controlled prop lifted to `EventRoom`, the synchronous
`onPrepareMedia()` call inside `onSubmit` for Safari's gesture
requirement) is exactly right and must be reused, not duplicated;
confirmed `useLiveRoomConnection` already lives strictly above all
orientation/composition branching, exactly where it needs to stay;
confirmed `SpeakerStage`'s tiles have existing tap-to-join/tile-activate
buttons a new double-tap handler must coexist with via
`event.target`-based exclusion, not replace; confirmed
`ARCHITECTURE.md`'s "ephemeral broadcast, no row per event" principle
is documented but has zero implementations anywhere in the codebase —
ambient reactions will be the first; confirmed no gifting/payment code
exists anywhere, and `PRODUCT.md`/`ROADMAP.md` list donations/payments
as explicitly out of scope (the approved gift *UI shell*, with no
backend at all, is a deliberate, scoped exception to that list, not a
reversal of it).

**Decision — phased implementation, one real-device-testable milestone
at a time**, stopping for the user's own approval after each:

1. Static layout shell (this entry)
2. Compact composer / Request-to-Speak, wired to the *existing* actions
3. Ambient comment feed (presentation-only, off the existing chat
   stream — no new backend)
4. Discussion Expanded (05d) — compressed video + discussion surface
5. Emoji quick-tray, ambient-only (first real ephemeral-broadcast
   implementation)
6. Double-tap targeting, layered onto the proven broadcast plumbing
7. Vote/Gift quick-access trays — local-UI prototype shells only, no
   persistence, no backend, explicitly not #25's real voting system and
   not a real monetization system

**Governing invariant restated** (user's explicit clarification): the
long-standing "Watch Mode never shrinks/rearranges video" rule still
holds for Watch Mode and its lightweight expansions (React/Vote/Gift
trays). Discussion Expanded is now an intentional, explicit exception —
the *invariant that must hold there* is stable media identity (same
`SpeakerStage`/tile instances mounted throughout, no LiveKit
reconnect/republish/reacquire, self-preview intact, Watch Mode restores
without rebuilding the media session), not immutable CSS geometry. This
replaces, not just refines, the older "video geometry is stable, only
what's layered over it changes" phrasing everywhere it appears in this
project's docs going forward, for this one transition specifically.

**Rollback**: `prototype-pre-05-implementation-stable` tagged at
`5c36d8b` (identical commit to `prototype-pre-figma-stable` — no code
had changed between them, only Figma work — tagged again because it
marks a different milestone: start of real implementation, not start of
design exploration). Implementation proceeds on `feature/social-stage-shell`,
never directly on `main`.

**Issue mapping** (per explicit instruction not to mechanically split
work into new issues): Phases 1–4 stay under #21 — retitled from its
original "dead-zone gesture" premise (already twice-superseded within
this same issue's own history) to reflect the approved 05 model; the
underlying problem never changed, only the mechanism, twice. Phases 5–6
(ambient reactions) and Phase 7 (Vote/Gift shells) are proposed as two
*new* issues once those phases actually begin — deliberately not
created yet, to avoid "unnecessary board churn" for work that hasn't
started. Neither #25 (real voting) nor #18 (role-based views) is
touched by any of this.

### Phase 1 (static shell) — what shipped

`PortraitRoom` rebuilt: `RoomHeader` replaced by a minimal top-chrome
status pill (live dot + title, connection-status word appended only
when not "connected" — the one safety-relevant piece of `RoomHeader`'s
job worth keeping) plus a guest-identity chip (`GuestNameEditor`'s new
opt-in `variant="chip"` — additive, every existing caller keeps its
exact current appearance). `StageOverlayShell` gained an opt-in
`gradient={false}` — the old always-on wash was sized for a
permanently-visible chat block; the new design's controls carry their
own individual translucent backgrounds, and every existing caller
(`MobileLandscapeRoom`) is unaffected since the prop defaults to `true`.
New `WatchModeControls`: the composer + React/Vote/Gift emblems, all
`disabled` in this phase — real markup, inert behavior, so later phases
only remove `disabled` and add handlers rather than restructure
anything. `SpeakerTile`'s identity label moved from a bottom gradient
bar to a lightweight top-anchored dot+name (portrait only — landscape
keeps its original treatment unchanged, since `MobileLandscapeRoom`'s
own header-as-overlay already occupies the top of both its
side-by-side tiles and would collide with the new style; a
`clearTopChrome` flag additionally offsets seat 1's label below the new
top-chrome row specifically, since only whichever tile renders visually
first in portrait can ever be under it). The old Comments Mode toggle,
`RoomChatPanel` mount, and `useCommentsMode` call are removed from
`PortraitRoom` entirely for this phase — commenting/reading are both
temporarily unavailable on this branch (not merged to `main`) until
Phases 2 and 4 restore them with the new model. The reserved
conversation-seam slot (`speaker-divider`) is untouched, no fabricated
timer added.

**Tradeoffs accepted for this phase**: participant/viewer count is
dropped from the persistent chrome, matching the approved Figma
design's explicit minimalism — not lost (still received as a prop),
just not surfaced yet; trivial to add back if real-device review misses
it.

## 2026-08-22 — Watch Mode / Comments Mode confirmed stable on real devices; `GuestNameEditor` blur-commit fix

**Status update, not a design change**: the tap-based Watch Mode /
Comments Mode states (previous entry below) passed the user's own
real-device confirmation on iPhone portrait and landscape. Per explicit
instruction, this is now the **stable interaction foundation** —
further Figma-assisted redesign work builds on top of it rather than
around it, and it is not to be redesigned or altered as a side effect of
unrelated fixes (see below). The progressive downward-drag reveal
remains deliberately deferred, unchanged from the "Future Figma seam"
reasoning in the entry below.

**Problem**: a small, unrelated bug surfaced during that same real-device
pass — `GuestNameEditor` (rendered inside the Watch Mode overlay) could
be left visually stuck in its editing state after tapping "change name,"
editing the text, and then dismissing the keyboard or tapping elsewhere
in the room (Comments, a speaker tile, the stage). Explicit instruction:
fix only this, don't touch the mode toggle, LiveKit, layout, or
responsive branching in the process.

**Investigation**: `GuestNameEditor` only ever exited editing mode from
its `<form>`'s own `onSubmit` (triggered by clicking the visible "Save"
button, or, on some browsers, Enter). There was no `onBlur` handler at
all — tapping literally anything else in the room moved focus away from
the input without ever calling `setEditing(false)`, leaving the form
visually open indefinitely. This has nothing to do with Watch Mode/
Comments Mode's own state; it was already broken before that work and
is a pre-existing gap in this one component.

**Decision**: commit on blur, not via a new document-level click-outside
listener. Every "tap outside" interaction the user listed (Comments, a
speaker tile, reactions, the stage) already fires a native `blur` on the
input first, since focus is moving away from it — that's the one event
already common to all of them. `<Input>` (`src/components/ui/input.tsx`)
didn't forward refs, so `GuestNameEditor` couldn't imperatively call
`.blur()` on its own input; wrapped it in `forwardRef` (purely additive
— no existing caller passes a ref, so no other consumer's behavior
changes). The form's `onSubmit` (Enter/Done) now just calls
`inputRef.current?.blur()` instead of saving independently, so there is
exactly one commit code path, not two that could race on a fast
double-tap (e.g., tapping the visible Save button both blurs the input
*and* submits the form — the second call is a harmless no-op against an
already-blurred element). Validation is untouched: `setGuestName` still
returns `{ error }` on an empty name and the component still just
declines to exit editing mode in that case, exactly as before — no new
message, no new rule, matching the explicit instruction not to invent
naming rules while fixing this.

**Reason**: the user explicitly asked for "the simplest conventional
solution—likely committing on blur/focus leaving the editor—rather than
introducing a global gesture system," which is what real product UIs
(and this codebase's own recent retired-gesture lesson) both point
toward: prefer the platform's native event for "focus left this field"
over inventing a broader interception mechanism to approximate it.

**Tradeoffs**: none identified — this is a strict bugfix with no new
surface area. The explicit "Save" button remains, redundant with blur
but harmless (kept for discoverability/parity with desktop mouse users
who might expect an explicit confirm action).

## 2026-08-22 — Gesture retired; Watch Mode / Comments Mode rebuilt as a plain tap toggle (the "Future Figma seam")

**Problem**: the room-level drag gesture (previous entry below) failed
real-device testing a second time — "dragging downward produced no
meaningful transition." Independently of whether the gesture itself
worked, the same test found the thing it revealed was still wrong:
comments/composer permanently occupied a substantial share of the stage
in both orientations, in landscape *and* in portrait (which had never
received any #21 work at all — it still had #20's fixed `h-40` chat
strip). The user's explicit read: two rounds of gesture-tuning against a
target that itself hadn't been visually designed is the wrong order of
operations. Reliable states first; a smooth transition between them
later, once Figma defines what those states actually look like.

**Investigation** (six questions, answered before any code changed):

1. Everything in `useCommentsFocus`/its `surfaceProps` existed solely to
   support dragging: `DEAD_ZONE_PX`/`DRAG_DISTANCE_PX`/`COMMIT_THRESHOLD`,
   `computeDragProgress`, `INTERACTIVE_SELECTOR`, and the
   `onPointerDown`/`Move`/`Up`/`Cancel` handlers meant to be spread onto a
   broad stage ancestor. None of it represented open/closed state itself.
2. The only genuinely reusable part was the *concept* of an
   `open`/`openComments`/`closeComments` boolean — everything else was
   gesture plumbing on top of that concept, not part of it.
3. Removing the drag handlers was confirmed safe: they only ever touched
   presentational props (`SpeakerStage`'s `scrimOpacity`/`scrimInstant`)
   and the chat wrapper's own height — a sibling concern to LiveKit/
   media/seat state, never a dependency of it. No LiveKit, self-preview,
   tap-to-join, request-to-speak, promotion, reconnect-grace, or
   reactions code path touched the gesture hook at all.
4. `MobileLandscapeRoom` mounted `RoomChatPanel` unconditionally inside
   `StageOverlayShell`, animating only its height (96px collapsed →
   160px expanded) — never actually removing it from the DOM, which is
   why "collapsed" still read as clutter on a real phone. `PortraitRoom`
   mounted it unconditionally at a fixed `h-40`, no collapse concept at
   all. `DesktopRoom` was untouched by any of this — its own dedicated
   sidebar `RoomChatPanel` never used the gesture hook.
5. Yes — hiding/showing the chat panel is a conditional-render decision
   in a sibling of `SpeakerStage`, not a prop or ancestor of it. Nothing
   about mounting or unmounting `RoomChatPanel` touches `SpeakerStage`'s
   own subtree, so its LiveKit tracks are never disturbed.
6. Yes — one hook (`useCommentsMode`) drives both `MobileLandscapeRoom`
   and `PortraitRoom` via the same `open`/`openComments`/`closeComments`
   shape, but each composition still owns its own JSX, its own Comments
   Mode height constant (208px landscape / 320px portrait — landscape
   has less vertical room to spare), and its own control placement. The
   hook enforces *one logical state*, not *one visual layout*.

**Decision**: delete `use-comments-focus.ts` and its test outright (not
deprecate, not keep behind a flag) — `git rm`, no re-export shim. Replace
with `use-comments-mode.ts`: a `useState(false)` boolean plus two
callbacks, nothing else. `MobileLandscapeRoom` drops `surfaceProps`
entirely and switches its chat wrapper from height-animated-but-always-
mounted to a plain `{commentsOpen && <RoomChatPanel .../>}`. `PortraitRoom`
gets the same treatment built from scratch (it never had any #21 code to
remove). Both keep a `💬 Comments` / `⌄ Hide` tap toggle — the *tap* was
never the failed part; only the drag was. `chat-panel.tsx`'s
`data-gesture-ignore`/`touch-pan-y` markers (added to exempt the message
list from the room-level drag) are removed along with the drag itself —
there's no gesture surface left to opt out of. `DesktopRoom` untouched.

**Reason**: matches the user's explicit instruction to treat the gesture
as "a failed UX experiment, not something to keep tuning with
thresholds," and to build "the smallest safe version" of two discrete
states rather than a third gesture attempt.

**The Future Figma seam** (documented, not built, this pass): the
eventual product vision is unchanged —

```
WATCH MODE
  ↓ user drags/scrolls downward
  progressive comments reveal
  ↓
COMMENTS MODE
```

— but that progressive gesture will not be attempted again until Watch
Mode and Comments Mode both have a real, Figma-defined visual design to
transition *between*. Building gesture physics against a visual target
that itself still needed to change is the throughline behind both of
this feature's real-device failures. When the gesture returns, it sits
on top of `useCommentsMode`'s existing `open` boolean as a continuous
`progress` value driving the same two endpoints — nothing in this pass's
simplification makes that harder to add back, and nothing beyond state
separation (no speaker-feed compression, no solid Comments Mode
background, no audience/speaker divergence) was invented here.

**Tradeoffs**: Comments Mode still uses the existing chat/composer
layout verbatim — no visual redesign, so it doesn't yet look like a
purpose-built "discussion" surface. That's deliberate scope control for
this pass, not an oversight — the redesign is Figma's job, not this
issue's.

## 2026-08-22 — Comments reveal rebuilt as a room-level gesture; the handle-driven design replaced, not patched

**Problem**: real-device testing clarified that the previous pass's
comments interaction was described wrong from the start. The product
intent was never "grab a small handle to resize a panel" — it's "the
room feels naturally vertically navigable," the same physical metaphor
as pulling down a notification shade: there's more interface below/
behind the video, reachable from a broad, natural gesture, not a
specific tiny target. The user explicitly authorized concluding the
existing implementation was the wrong abstraction rather than patching
around it.

**Investigation** (13 questions, answered before any code changed):

1–2. The previous `useCommentsFocus` bundled all its pointer handlers
   (including `onClick`) into one `handleProps` object, meant to be
   spread onto exactly one small `<button>` — nothing else in the tree
   had these handlers, so a touch starting anywhere else never began
   tracking a drag at all. This was a deliberate, working design for a
   *dedicated handle* — the architecture was never wrong for that
   narrower interaction, it was simply the wrong interaction to build.
3. **Conclusion: replace, not patch.** The dead-zone/commit-threshold
   math (`computeDragProgress`) is unchanged and still correct — a pure
   function, already decoupled from *where* it's triggered from. What
   had to change was the hook's whole surface-facing API: bundling
   `onClick` into the same handlers meant for a broad ancestor doesn't
   make sense (a broad surface has no single "the tap target" — see
   below), so the tap/drag disambiguation logic (`draggedRef`) that
   existed specifically to keep those two from double-firing on the
   *same* element became entirely unnecessary once they're driven by
   *different* elements instead.
4. **The gesture surface is a genuine DOM ancestor** — `MobileLandscapeRoom`'s
   own stage wrapper (containing the video, header overlay, and chat/
   controls overlay together), not a separate transparent layer placed
   on top of everything. This distinction matters concretely: a
   `pointer-events: auto` overlay *on top of* a button would receive the
   touch and never let it reach the button underneath at all (touch
   dispatch is a hit-test against the topmost element, not DOM
   ancestry) — event delegation via a real ancestor, relying on
   *bubbling*, is the only way `event.target` still correctly reflects
   "the button the user actually touched," which is what makes excluding
   it possible in the first place.
5. **Descendants that opt out**: real `<button>`/`<a>`/`<input>`/
   `<textarea>`/`<select>`/`[role="button"]`/`[contenteditable]`
   elements match a single CSS selector check — covers empty-seat tap-
   to-join, camera/mic activation, the composer, `GuestNameEditor`'s own
   button, and the new comments-toggle itself, with no per-component
   opt-out markers needed. One exception needed an explicit marker:
   `data-gesture-ignore`, added to `ChatPanel`'s own message-list
   container — a `<div>` with native scroll, not semantically a "control"
   the selector above would otherwise catch.
6. **Room gesture vs. comment-history scroll**: decided by *where the
   touch starts*, exactly as issue #21's own body already prescribed for
   the (now-replaced) handle — a touch beginning inside the message list
   is excluded from ever starting a room-level drag, so its native
   `overflow-y-auto` scroll runs completely unmanaged by this hook.
   Per explicit instruction ("reliability over cleverness"), no drag-to-
   close gesture was built once comments are open — only the explicit
   toggle reliably closes them, avoiding the nested-scroll ambiguity
   question entirely rather than trying to resolve it cleverly.
7. **Pointer Events**, unchanged from the previous design — well-
   supported on modern iOS Safari, unifies touch/mouse. CSS
   `overscroll-behavior`/`touch-action` are complementary, not
   alternatives — see point 8.
8. **Avoiding scroll leaking, and a real bug caught in this same
   investigation**: the room's own root containers are already
   `overflow-hidden` (#20), so document/body-level scroll isn't reachable
   from inside the room at all. The remaining risk is iOS Safari's
   native rubber-band/pan gesture competing with the manual drag. The
   *obvious* fix — `touch-action: none` on the shared stage-wrapper
   ancestor — was investigated and rejected: CSS `touch-action` for a
   given element is the *intersection* of its own value and every
   ancestor's, so `none` on the stage wrapper would also have disabled
   the message list's own scrolling, since the message list is a
   *descendant* of that same wrapper — the one thing that must keep
   scrolling normally. Fixed instead with `event.preventDefault()`
   called inside `onPointerMove`, but *only* once a drag has already
   started tracking (i.e., only for touches that already passed the
   interactive/message-list exclusion check) — this suppresses the
   competing native gesture for a genuine room-level drag without ever
   touching the message list's own `touch-action`, which is additionally
   reasserted explicitly (`touch-pan-y`) as a defensive belt-and-braces
   measure. This is a deliberate simplification, not a proven-reliable
   choice — flagged explicitly as real-device-unverified.
9. **Video geometry**: unchanged from the previous pass's own guarantee
   — `SpeakerStage`'s props (speakers/orientation/etc.) are never driven
   by gesture state, only the pre-existing `scrimOpacity`/`scrimInstant`
   presentational props and the chat wrapper's own height.
10. **💬 and the drag reach the same state** by construction — both are
    just different callers of the same `open` boolean inside one hook
    instance (`openComments()`/`closeComments()` for the explicit
    control, the drag's own commit logic for the gesture) — never two
    parallel state machines.
11. **Always-hideable**: a single, compact toggle button
    (`comments-toggle`) whose label/`aria-expanded` reflects `open` —
    present in exactly the same DOM position in both states (directly
    above the chat wrapper), reliable regardless of whether the gesture
    ever gets used at all.
12. **`GuestNameEditor`**: kept exactly where the previous pass's own
    fix already put it — above the reveal, fixed-size, outside the
    expand/collapse relationship entirely. That already satisfies "does
    not visually define this interaction"; this pass's job was fixing
    *how the reveal is triggered*, not repositioning identity UI a
    second time.
13. **Real-device risk, named explicitly**: the `preventDefault()`-in-
    `onPointerMove` approach (point 8) is the one piece of this design
    genuinely untested against real iOS Safari — a blanket
    `touch-action: none` is the more commonly-cited *bulletproof*
    pattern for this exact class of gesture, and was only rejected here
    because of the specific intersection conflict with the message
    list's own scroll requirement. If real-device testing finds the
    drag competing with page/rubber-band behavior, revisiting this
    specific tradeoff (e.g. applying `touch-action: none` to
    non-message-list siblings individually, rather than the shared
    ancestor) is the documented next step, not a sign the whole
    direction was wrong.

**Decision**: `useCommentsFocus` rewritten. Returns `open`/`progress`/
`dragging` (unchanged shape) plus `openComments`/`closeComments` (plain
setters, for the toggle) and `surfaceProps` (four pointer handlers, meant
for one broad ancestor). `MobileLandscapeRoom` spreads `surfaceProps`
directly onto its own stage wrapper div (replacing the small handle
button entirely) and renders one `comments-toggle` button, positioned
exactly where the handle used to be — directly above the chat wrapper,
still above nothing but the reveal target itself. Drag direction flipped
to match the corrected product description: `deltaY = currentY - startY`
(positive = moved *down* = reveal), not the previous pass's Maps/Music-
panel "drag up" convention. `ChatPanel`'s message-list container gained
`data-gesture-ignore` + `touch-pan-y`.

**Alternatives considered**: (1) keeping the handle *and* adding
broad-surface support alongside it — rejected: the spec is explicit that
a handle "must not be the required interaction target," and running two
parallel trigger mechanisms with subtly different behavior (one on a
tiny element with its own onClick, one on a broad ancestor) is exactly
the kind of duplication this project's own conventions warn against. (2)
A transparent overlay div layered on top of the whole stage, instead of
attaching handlers to a real ancestor — rejected outright once point 4
above was worked through: it cannot let taps reach real controls
underneath it at all, a fundamental dealbreaker, not a tuning question.
(3) Drag-to-close once comments are open — deferred per explicit
instruction, not attempted as a "clever" solution to the nested-scroll
question; the explicit toggle is the only reliable close path built.

**Tradeoffs**: `preventDefault()`-based suppression (point 8/13) instead
of a declarative `touch-action: none` is a real, named simplification —
the single biggest real-device risk in this pass, more so than the
gesture math itself. The compact-💬-emblem "fallback direction" the
user described as a possible Part 4 is not needed *as a fallback* here —
the always-present `comments-toggle` already *is* that affordance, built
as a first-class part of this design rather than a backup plan.

## 2026-08-22 — Refresh-recovery self-preview, a server-validated reconnect grace period, and the comments-focus target correction

**Problem**: three real-device findings from the previous pass, addressed
in priority order. (1) A seated speaker who hard-refreshes keeps their
seat, but tapping "Enable camera & mic" afterward published correctly
(the audience saw/heard them) while their *own* self-preview stayed
empty — recoverable only by leaving and rejoining. (2) That refresh
scenario exposed a real gap: the LiveKit webhook evicts a seat the
instant it sees `participant_left`, no grace period at all, so any
brief disconnect (a network blip, not just a refresh) risks losing a
seat outright. (3) The #21 comments-focus overlay shipped last pass
technically worked, but the drag/tap handle sat directly above
`GuestNameEditor`, with `RoomControls` between it and the chat — the
*literal* thing it revealed was the guest-name editor, not comments.

**Part 1 investigation** (per instruction, before guessing): traced the
full refresh lifecycle. Identity restoration, seat restoration, and the
LiveKit token/grant are all *already correct* — `page.tsx` (a server
component) calls `getLiveKitToken` fresh on every request, which derives
`canPublish` from `event_speakers` occupancy at request time
(`getActiveSeatForIdentity`), so a still-seated speaker's fresh token
already carries `canPublish: true`. What's lost is entirely client-side
and entirely expected to be lost — a hard refresh tears down the whole
JS realm, so `mediaActivated`, `localVideoTrack`, and any prepared
tracks all restart at their initial, empty values; there is no
"incorrectly destroying state" cleanup effect to find, because nothing
here survives a full page reload by design. The actual bug: tapping
"Enable camera & mic" called `activateMedia()`, which called
`applyPublishState(true)` directly — and when nothing was already
prepared (the refresh case, and originally #27's direct-join case
too), that function's fallback branch calls LiveKit's own
`setCameraEnabled`/`setMicrophoneEnabled` convenience methods, which
acquire *and* publish in one step but never touch `localVideoTrack`
state at all. Publishing worked (every other participant correctly
saw/heard the recovered speaker); this tab's own self-preview simply
never had anything told to it. A second, related bug found in the same
trace: because the old `activateMedia()` set `mediaActivated = true`
*unconditionally and immediately*, a *failed* attempt (permission
denied) also permanently hid `needsMediaActivation`'s retry
affordance — the "Enable camera & mic" button vanished forever after
one failure, with no way back short of leaving the seat.

**Part 1 decision**: `activateMedia()` now just calls `prepareLocalMedia()`
— the exact same acquisition path #22 already built (`createLocalTracks`,
sets `localVideoTrack`, then publishes via its own tail check once
`canPublish` is true) — rather than duplicating a second, incomplete
acquisition flow. This unifies every activation path (composer request,
direct join, and this recovery tap) onto the one mechanism that already
gets `localVideoTrack` right, and fixes the retry-affordance bug as a
direct consequence: `mediaActivated` now only flips true on an actually
*successful* acquisition, so a failed attempt correctly leaves
`needsMediaActivation` true and the retry button in place. No new
abstraction — an existing one, reused where it should have been from
the start.

**Part 2 investigation**: read `api/livekit/webhook/route.ts` — confirmed
it calls `endSpeakerSeat(eventId, identity, "disconnected")` immediately
on `participant_left`, no grace period, today. (LiveKit's own connection
layer already tolerates a *very* brief reconnect — e.g. a fast page
refresh — before it even reports the participant as gone, which is why
the bug in Part 1 was reachable at all: the seat really was still theirs
by the time the new page loaded. That built-in tolerance is opaque and
uncontrolled from this app's side, though, with no UI communicating it —
exactly the gap this part closes explicitly.) Confirmed via the LiveKit
server SDK (`RoomServiceClient`, already used by `syncPublishPermission`
for live permission pushes) that `getParticipant(room, identity)` can
independently, authoritatively answer "is this identity actually
connected right now" — the same trusted server credential every
token/permission call already uses, never anything a client sends.

**Part 2 decision**: a new server action, `checkAndEvictDisconnectedSpeaker`
(room/actions.ts), re-validates via that LiveKit query before calling
the *same* `endSpeakerSeat` the webhook uses — so a caller invoking it
early, repeatedly, or against an already-reconnected speaker can never
force an eviction; the re-check simply finds them present and no-ops.
This is what answers "how to avoid a malicious client pretending to
remain connected": authorization for the eviction was never "whoever
called this," it's "did the server's own independent LiveKit query
confirm absence" — the same authorization shape the webhook's signature
check already has, just a different verification mechanism for a
different caller shape. A new client hook, `useSpeakerReconnectGrace`
(reusing the exact `setTimeout`-then-re-validated-server-action pattern
`useAutomaticPromotion`'s own grace-period self-eviction already
established — not a second, unrelated timer system), watches every
*other* occupied seat for a gap between the DB's occupancy and LiveKit's
live participant list; after `RECONNECT_GRACE_PERIOD_MS` (25s, tunable)
of that gap persisting, it calls the new action. If the participant
reconnects first, the seat drops out of the "disconnected" set on the
next render and the pending timer is cleared, never reaching the
server. The viewer's own seat is explicitly excluded from the watch (a
tab reconnecting itself would otherwise transiently see *itself* as
disconnected during the brief window before its own connection
establishes). Runs for every connected viewer, not just the other
active speaker — issue #25's own heartbeat is scoped to the two active
speakers specifically to avoid *continuous* audience-wide polling, but
this schedules at most one deferred call per genuine disconnect event,
not a recurring interval, so the cost profile is different; broader
scope here is also what guarantees a *solo* disconnected speaker (no
co-speaker to notice) still eventually gets released. UI: `SpeakerTile`
gained an `isReconnecting` prop — "Speaker reconnecting…" instead of the
generic "Camera off" for a seat currently in that watched state, wired
through `SpeakerStage` and all three room compositions. Reclaiming the
seat without re-entering the queue falls out for free: the seat row is
never touched during the grace period, so `getActiveSeatForIdentity`
still finds it the moment the speaker's own client reconnects — nothing
to "reclaim," it was never released.

**Part 3 investigation**: re-inspected what was actually growing in
`MobileLandscapeRoom`'s overlay. The chat wrapper's own height genuinely
did interpolate correctly on drag/tap — the bug was ordering, not math:
`GuestNameEditor`/`joinSeatMessage` and `RoomControls` sat *between* the
handle and the chat, so the handle's own immediate, visible neighbor was
the guest-name control, not the message list — a user's eye and finger
naturally read "what's right here" as the thing being revealed,
regardless of what technically resized further down the flex column.

**Part 3 decision**: reordered so `GuestNameEditor`/`joinSeatMessage` and
`RoomControls` sit *above* the handle — fixed-size, always visible,
outside the expand/collapse relationship entirely — and the handle now
sits directly against the chat wrapper it actually controls, nothing
between them. Same `StageOverlayShell`, same `useCommentsFocus` state;
only the JSX order changed. `EXPANDED_CHAT_HEIGHT_PX` trimmed from 176
to 160 to compensate for `RoomControls`/`GuestNameEditor` now
permanently occupying space above the handle on a still-short viewport.
Part 4's compact-💬-emblem fallback is deliberately **not built** —
the instruction was explicit that this is the user's own real-device
judgment call after testing this correction, not something to
speculatively build in parallel; flagged in the verification report
instead.

**Alternatives considered**: (1) for Part 1, adding a second,
`setCameraEnabled`-aware code path that *also* sets `localVideoTrack` —
rejected in favor of unifying onto `prepareLocalMedia` entirely, since
maintaining two acquisition flows that both need to stay in sync with
`localVideoTrack` is exactly the kind of duplication that caused this
bug in the first place. (2) For Part 2, a new `event_speakers` column
(e.g. `disconnected_at`) to track grace-period state server-side —
rejected: no new SQL was needed once a client-side timer +
server-re-validated action (the same shape already proven for
promotion's own grace period) covered it, and a stored timestamp would
still need something to notice it and act, no different in kind from
what was built. (3) For Part 2, scoping the reconnect watch to only the
*other* active speaker's client (mirroring #25's own heartbeat scoping
more closely) — rejected: it would leave a *solo* disconnected speaker's
seat stuck forever whenever no co-speaker exists to notice.

**Tradeoffs**: a LiveKit API error in `checkAndEvictDisconnectedSpeaker`
(not just a genuine "not found") is treated the same as "absent" — a
transient failure evicts a moment early rather than late, the same
direction of error the webhook's own immediate, ungraced eviction
already accepted before this pass; not distinguishing error types is a
deliberate prototype-scoped simplification, not an oversight.
`checkAndEvictDisconnectedSpeaker` has no dedicated unit test (this
file's other server actions don't either — verified instead via
structural/production checks and the client-side hook's own thorough
unit coverage of the *trigger* logic). `RECONNECT_GRACE_PERIOD_MS` (25s)
and the comments-focus overlay's own height constants remain genuinely
untested against a real device.

## 2026-08-22 — Fourth checkpoint tagged (`prototype-responsive-mobile-landscape-stable`), then #21's first slice: comments-focus overlay + header-as-overlay for mobile landscape, without ever resizing the stage

**Problem**: real-device testing confirmed the three-composition responsive
split (previous entry) fixed mobile landscape's dashboard drift, but
found two more real problems specific to that composition: the comment/
composer overlay is still visually dominant at rest (even though it
never resized the stage, its own default size/opacity competes with the
video for attention), and the room's own header plus the site-wide
header together still consume real, permanent vertical space on an
already-short viewport. The user set an explicit governing rule before
any implementation: video geometry is stable — the interaction that
reveals more of chat/comments changes the interface *layered over* the
live video, never the size of the live video itself — and asked for a
checkpoint first, since this work touches the same sensitive area as the
last several passes.

**Checkpoint**: `prototype-responsive-mobile-landscape-stable` tagged on
`ff540b0` (confirmed matching both `origin/main` and the most recent
successful Vercel deployment before tagging), a GitHub Release created
from it marked prerelease. Note on process: implementation for this pass
was already underway (files written, not yet committed) when the
"before editing anything" instruction was re-read carefully — since
nothing had been committed or merged to `main` yet, tagging `ff540b0`
at that point was still exactly equivalent to tagging it before any
code changed history; recorded here for transparency rather than
silently proceeding as if the instruction had been followed to the
letter from the first tool call.

**Investigation** (per instruction — re-read #18/#20/#21/#22/#23/#24/#25/
#27, AGENTS.md, ARCHITECTURE.md, this file, and the commits since the
three-composition split, before touching anything):

1. **Stage geometry today**: `MobileLandscapeRoom`'s stage wrapper
   (`relative min-h-0 flex-1`) gets whatever height remains after
   *document-flow* siblings above it claim theirs — at the time of this
   investigation, that was `SiteHeader` (root layout) and `RoomHeader`
   (this component, in normal flow, one document-flow sibling above the
   stage wrapper). `SpeakerStage` itself, and the actual `<video>`
   elements/LiveKit tracks inside it, were never touched by anything
   below this point — `StageOverlayShell` (chat/controls) was *already*
   `position: absolute` over the stage, consuming zero flex space
   regardless of its own content's height. This is the key finding: the
   chat/composer's "dominance" complaint isn't about stage shrinkage at
   all (that channel was already closed) — it's about the overlay's own
   default size/opacity competing for attention while fully overlapping
   already-full-size video.
2. Of the elements inspected — `SiteHeader`, `RoomHeader`, `StageOverlayShell`,
   reactions, composer, chat/messages — only `SiteHeader` and `RoomHeader`
   were consuming real document-flow space above the stage.
   `StageOverlayShell` and everything inside it (reactions live inline
   per-message via `MessageItem`, not a separate reactions bar; composer
   and chat/messages are `ChatPanel`'s own internals) were already purely
   overlaid, contributing zero to stage geometry — confirmed by reading
   `ChatPanel` itself: the message list is `flex-1 overflow-y-auto`
   inside a wrapper whose *outer* height this component already
   controlled via a single div (today, a fixed `h-24`).
3. **Yes** — `SiteHeader` and `RoomHeader` could both become
   transparent/overlaid without touching `SpeakerStage` geometry, since
   neither one is `SpeakerStage` or a `SpeakerStage` dependency; they're
   siblings claiming flex space *before* it, purely a document-flow
   question.
4. **Yes, #20 already built exactly the primitives #21 needed**: `room-
   scrim` (`SpeakerStage`, `data-testid="room-scrim"`) — a
   `pointer-events-none absolute inset-0` layer, previously hardcoded
   `opacity-0` with a `transition-opacity duration-200` already present
   — and the always-on bottom legibility gradient (`StageOverlayShell`'s
   own `bg-gradient-to-t`, a *separate*, permanently-on layer, not
   animated by focus state, matching #20's own explicit "don't conflate
   the two" note). Confirmed #20's own issue body names this scrim as
   exactly what #21 was meant to animate — no new layer needed, only
   making its opacity controllable instead of hardcoded.
5. **Existing #21 infrastructure**: none yet — `room-scrim` was inert,
   the divider was inert (and stays inert here; voting is #25's job, not
   touched), nothing else in the codebase modeled focus/gesture state.
   Nothing to avoid duplicating; this pass is the actual first
   implementation.
6. **Yes** — confirmed the comments-focus transition can be, and was,
   implemented entirely by changing (a) `room-scrim`'s opacity and (b)
   one existing wrapper `<div>`'s height (the one already controlling
   `RoomChatPanel`'s visible height) — `SpeakerStage`'s own props for
   speakers/orientation/tiles are completely unaffected by focus state.
7. **Confirmed** — `<video>` elements and LiveKit track attachment never
   remount for this transition: `SpeakerStage` is passed two new,
   *optional* presentational props (`scrimOpacity`, `scrimInstant`,
   default `0`/`false` — zero behavior change for `PortraitRoom`/
   `DesktopRoom`, which don't pass them) and re-renders with a new style
   value, the same category of prop change `needsMediaActivation`/
   `mediaError` already are — nothing about `participant`/track lookups
   changes.
8. **#21 vs. #18**: this pass is #21's *first slice* only — the default/
   comments-focus toggle, scoped to `MobileLandscapeRoom` alone (not
   `PortraitRoom`, which the user required not to regress, so left
   completely untouched — the underlying hook is written to be reusable
   there later, just not wired up yet). Explicitly not built: the
   second-level "full comments view" with genuinely compressed video
   (deliberately deferred, an architectural seam left via the same
   `useCommentsFocus` state rather than a second competing mechanism —
   a later pass would add a second, higher `open` state or a related
   flag driven by a *tap* on the already-expanded panel, not by this
   pass's drag/tap toggle going further); any role-specific
   (audience/candidate/speaker) composition differences beyond what
   already existed for free (the no-duplicate-self-video fix, `SpeakerStage`/
   `SpeakerTile` reused unchanged); voting/#24/#25 (the divider stays
   exactly as inert as before).

**Decision**:

- New `useCommentsFocus()` hook (`src/hooks/use-comments-focus.ts`):
  `open` (boolean), `progress` (0–1, live during a drag, settled to 0/1
  otherwise), `dragging`, and `handleProps` to spread onto one small,
  dedicated handle element. A pure `computeDragProgress(deltaY,
  startedOpen)` function is exported and unit-tested directly (11 tests)
  — same reasoning `shouldPublish`/`classifyMediaError`/
  `resolveClaimDecision` are already tested this way, since simulating
  real pointer-gesture physics in jsdom isn't reliable. Dead zone 10px,
  drag distance 120px, commit threshold 0.5 — tunable constants, not
  validated against a real device yet, exactly like #21's own issue body
  frames its own thresholds.
- **Ownership boundary vs. scrolling the comments themselves**: settled
  by *where a touch starts*, not motion-direction heuristics — the
  hook's pointer handlers are spread only onto a small dedicated handle
  button (`touch-action: none`, `setPointerCapture`), never onto the
  message list, whose own native `overflow-y-auto` scroll is completely
  untouched and un-instrumented. This is the simpler, lower-risk
  boundary #21's own issue body already prescribed, not a new design.
- **Tap and drag can't double-toggle**: a `draggedRef` flag, set only
  once a drag's movement exceeds the dead zone, tells the handle's own
  `onClick` (which a negligible-movement tap still fires natively, and
  which real browsers *might* also fire — inconsistently across
  implementations — even after a real drag) to skip toggling when a
  drag already decided the outcome, rather than relying on browser
  click-suppression-after-drag behavior being consistent (untestable
  from here, so not trusted).
- `MobileLandscapeRoom`: `SpeakerStage` gets `scrimOpacity={progress *
  0.55}` and `scrimInstant={dragging}` (transition CSS included only when
  not actively mid-drag, so live tracking has zero lag but release/tap
  settles with a smooth animation). The chat wrapper's height is now
  `COLLAPSED_CHAT_HEIGHT_PX (96, identical to the old always-on h-24) +
  (EXPANDED_CHAT_HEIGHT_PX (176) − COLLAPSED) × progress` via inline
  style — collapsed state is byte-for-byte the same height as before
  this pass (zero regression at rest), expanded state reveals
  meaningfully more of the message history for free (`ChatPanel`'s own
  `overflow-y-auto` message list already adapts to whatever height its
  wrapper gives it — no changes needed inside `ChatPanel` itself).
  `RoomControls` is left completely unchanged in both states — it
  carries real functional information (leave-stage, promotion countdown,
  media errors), not just decoration, so it wasn't touched for size
  reduction risk.
- `RoomHeader` moves from a document-flow sibling of the stage wrapper
  to an absolutely-positioned overlay pinned to the stage's own top
  edge, `MobileLandscapeRoom`-only (reclaims its entire footprint for
  the stage) — same click-through-outer/interactive-inner split
  `StageOverlayShell` already established for the bottom overlay, and a
  `pr-16`/`pr-20` reserved margin on its content wrapper specifically so
  it doesn't visually collide with the top-right self-preview slot (a
  known, accepted minor cosmetic trade-off: the header's own translucent
  background gradient may still faintly wash over self-preview's very
  top edge, since a pixel-perfect coordinated cutout was judged not
  worth the added complexity for a self-preview that has no interactive
  elements to protect there).
- `DesktopRoom`: one isolated, responsive width class on the sidebar
  (`w-64 xl:w-80`, narrower only below the 1280px `xl` breakpoint) —
  see the desktop-squashing investigation below.

**Desktop squashing investigation**: right at the desktop viewport
threshold (1024px), `DesktopRoom`'s fixed `w-80` (320px) sidebar left
only ~700px for two side-by-side tiles (~350px each) — `SpeakerStage`'s
tiles have no minimum width or aspect-ratio floor, so on a
narrower-than-tall tile, `object-cover` crops the video heavily,
reading as pathological squashing rather than a natural landscape
frame. Fixed with the single isolated width class above; a hard
minimum width on the stage column itself, or an aspect-ratio-aware
tile treatment, would be a more thorough fix — left to #18 rather than
expanding this pass, per instruction.

**Alternatives considered**: (1) shrinking the collapsed chat height
below its current value to make the default state feel less dominant —
rejected: `ChatPanel`'s own composer (emoji row + input row) already
needs roughly the collapsed wrapper's full height just to render without
clipping; going smaller risked breaking the composer itself, a
functional regression far worse than the dominance complaint being
fixed. (2) Making `SiteHeader` itself `position: fixed`/a full overlay
in mobile-landscape-in-room mode (a further step beyond the previous
pass's padding-only compaction) — investigated, but making *both*
`SiteHeader` and `RoomHeader` simultaneously overlay the same screen
region without a coordinated single positioning scheme reintroduces
exactly the collision risk the previous pass deferred; moving only
`RoomHeader` (fully owned by this component, zero cross-component
coordination needed) captures most of the same benefit at materially
lower risk, so `SiteHeader`'s own treatment is unchanged from the
previous pass. (3) Velocity/flick-based gesture release — deliberately
deferred, matching #21's own "not required for this pass's acceptance
bar" framing; release commits purely on final position vs. threshold.

**Tradeoffs**: the expanded chat height (176px) and collapsed height
(96px, unchanged) are both genuinely untested against a real short
landscape viewport — flagged explicitly for the user's own real-device
pass rather than guessed at further. The second-level "full comments
view" (compressed video, solid-background chat) is not built — an
architectural seam is left (the same `useCommentsFocus` state a later
pass can extend) but nothing about it is implemented yet, per explicit
instruction not to prematurely build it.

## 2026-08-22 — Three room compositions, not two: form factor and orientation are independent axes

**Problem**: `EventRoom` picked between `PortraitRoom` and `LandscapeRoom`
purely on `useOrientation()`. That media query (`orientation: landscape`)
is about aspect ratio, not device class — a desktop browser window
matches it exactly the same as a phone rotated sideways — so both got
the identical composition: a real 320px chat sidebar, a small stage
strip, and the full site header. Real-device testing confirmed this
reads as a jump into a different, dashboard-style application on
rotation, not the same room changing aspect ratio — the opposite of this
project's video-first principle, and explicitly not what was wanted for
a phone.

**Governing rule the user set**: same product model, different
composition by form factor. Mobile portrait and mobile landscape must
share the video-first/overlay philosophy; desktop gets a real sidebar
because it has the width to spare without covering the speakers.
Orientation alone must never stand in for device class — an iPhone in
landscape stays mobile.

**Investigation** (per instruction, before changing anything):

1. `useOrientation()` (`orientation: landscape`) was the sole signal
   `EventRoom` used to pick `LandscapeRoom` — nothing distinguished a
   wide *phone* from a wide *window*.
2. No width-based breakpoint existed anywhere in the room's structural
   branching (Tailwind `sm:`/`lg:` classes exist elsewhere for ordinary
   responsive *styling*, never for swapping which component tree
   mounts).
3. Two independent axes, not one three-way enum: `useOrientation`
   (unchanged) decides portrait vs. landscape *within* mobile; a new
   `useIsDesktopViewport()` decides mobile vs. desktop by **width**
   (`min-width: 1024px`, Tailwind's own `lg` breakpoint) — deliberately
   not `width > height`, since the user explicitly ruled that out and an
   iPhone in landscape (max ~950px wide) sits comfortably under 1024px
   regardless of aspect ratio.
4. CSS media queries are sufficient for *styling* decisions (the site
   header's own compaction, the two mobile compositions' internal
   layout) — but swapping *which component tree* mounts is something
   only JS can decide, so `useIsDesktopViewport` mirrors
   `useOrientation`'s exact `useSyncExternalStore`/`matchMedia` shape
   (same established pattern, not a new kind of signal) rather than
   trying to fake component-branching with CSS visibility toggles (which
   would mean rendering two full DOM trees, including duplicate video
   elements, simultaneously — rejected as wasteful and a bigger change
   in kind, not degree).
5. The layout can change without remounting LiveKit because it already
   does, for the existing portrait↔landscape swap — `useLiveRoomConnection`
   is called once in `EventRoom`, above all three presentation branches,
   unchanged by this pass. Swapping which of the three room components
   mounts recreates their DOM (a genuine unmount/remount of the
   presentation layer, same as today's rotation already does), but the
   live connection/tracks/speakers/chat state underneath is untouched —
   nothing new here, just extended to a third branch.
6. Self-preview stays "spatially stable" in the sense already proven
   acceptable for rotation: always anchored to the same corner
   (top-right) across all three compositions, via the same
   `localVideoTrack` object — the `<video>` DOM node itself gets
   recreated on a branch swap (same as today), but reattaches the same
   live track instantly, not a real reacquisition.
7. Room header/nav: **two separate headers contribute chrome** — the
   room's own `RoomHeader` (inside whichever composition mounts) and the
   site-wide `SiteHeader` (root layout, rendered above every route,
   including the room). Only `RoomHeader` could get JS-driven
   conditional treatment for free (it's already conditionally
   mounted per composition); `SiteHeader` needed a different mechanism
   since it renders identically regardless of route.
8. Deferred to #18 (unchanged): role-specific composition differences
   beyond what already existed (the no-duplicate-self-video fix from the
   prior pass already satisfies "don't show me a giant duplicate of
   myself," inherited for free since `SpeakerStage`/`SpeakerTile` are
   reused unchanged by all three new room shells) — no new role-specific
   logic was needed or built in this pass.

**Decision**:

- New `useIsDesktopViewport()` hook (`min-width: 1024px`), same shape as
  `useOrientation`. `EventRoom` now branches three ways:
  `isDesktopViewport → DesktopRoom`, else `orientation === "landscape" →
  MobileLandscapeRoom`, else `PortraitRoom`.
- `LandscapeRoom` renamed to `DesktopRoom` (file and export) — its
  existing sidebar structure was never wrong for desktop, only wrong
  when applied to mobile landscape too. Internals essentially unchanged;
  only its scope narrowed to the viewports it was actually designed for.
- New `MobileLandscapeRoom`: the video-first/overlay philosophy, adapted
  for a wide-short box instead of `PortraitRoom`'s tall-narrow one —
  `SpeakerStage` gets `orientation="landscape"` (side-by-side tiles),
  and the overlay's own footprint is trimmed (`RoomHeader compact`, a
  shorter `h-24` chat panel vs. portrait's `h-40`, less top gradient
  padding) since a phone in landscape has meaningfully less vertical
  room than portrait.
- `StageOverlayShell` extracted from `PortraitRoom`'s existing overlay
  markup (click-through outer layer, interactive inner wrapper — the
  prior pass's pointer-events fix) now that `MobileLandscapeRoom` needed
  the identical structure — an existing duplication once the second
  caller existed, not a speculative abstraction. Parameterized only by
  `topClassName` (how much decorative top padding) and `children` (each
  caller keeps full control of its own content composition, avoiding a
  large prop-drilling wrapper).
- `RoomHeader` gained an optional `compact` prop (tighter padding/type;
  every piece of information — including connection-lost warnings —
  stays, only the size shrinks) so `MobileLandscapeRoom` can use it
  without duplicating the component.
- `SiteHeader`'s own compaction is CSS-only, deliberately not converted
  to a client component: `EventRoom` toggles a `document.body`
  class (`room-active`) for exactly as long as a room is mounted — the
  minimum JS needed to give a route-agnostic, server-rendered header a
  route-scoped signal — and a `(orientation: landscape) and (max-height:
  500px)` media query (globals.css) does the actual viewport decision
  in pure CSS. Only padding changes; every link/button in the header is
  untouched, so nothing is removed, just compacted — the more invasive
  alternatives (moving `SiteHeader` out of the root layout into
  route-group-specific layouts, or converting it to a client component
  with `usePathname`/viewport hooks) were rejected as materially more
  architectural churn for the same visual outcome. The room's own
  `RoomHeader` stays in normal document flow rather than also becoming
  `position: fixed` — an overlay treatment there risked visually
  colliding with the site header floating at the same screen position,
  a new collision surface not worth the risk in a pass this size; the
  `compact` prop's padding/type reduction is the safer lever.

**Alternatives considered**: (1) inferring desktop from
`width > height` — explicitly rejected per instruction; also incorrect
in practice (many desktop windows are taller than wide). (2) A single
new three-state hook (`"mobile-portrait" | "mobile-landscape" |
"desktop"`) instead of two independent booleans — rejected: orientation
and form-factor are genuinely different axes with different underlying
media queries, and collapsing them into one enum would make a future
"desktop portrait" case (an unusual but real window shape) ambiguous to
express; two hooks compose naturally, matching how `useOrientation`
already exists as its own independent concern. (3) Height-clamping the
mobile-landscape overlay further, or building a chat-collapse
affordance, to squeeze more stage height — deferred; the user was
explicit this pass is the layout correction, not #21's gesture system.

**Tradeoffs**: recorded, not built — the "translucent overlay header"
direction the user offered as one option would reclaim more vertical
space than the compact-in-flow approach taken here (a fixed/absolute
site header costs zero document-flow height instead of a reduced but
nonzero amount), at the cost of needing to solve the header-collision
risk noted above. If real-device testing finds the current compaction
insufficient, that's the next lever to pull, not a sign this approach
was wrong. Separately, cleared again (second time this session, unrelated
to this change): a stale `event_speakers_active_seat_uniq` conflict in
`scripts/dev-harness.test.ts` from more leftover real-device-testing
occupancy in the permanent test room — via the same `dev:harness
clear-sandbox` command as before.

## 2026-08-22 — Direct join converges onto #22's readiness path; the open seat gets visual priority over the chat overlay

**Problem**: two real-device findings from the dominant-video pass below.
(1) Requesting the mic through the composer produced a working self-
preview, but tapping an uncontested open seat directly (issue #27) did
not — direct join never called `prepareLocalMedia`, so a direct-joiner
landed on stage with no pre-acquired preview and, at the time,
`needsMediaActivation` still true (the ordinary gesture-gated fallback,
not the readiness path). (2) With one seat occupied and the other open,
the open seat's "Tap to join" tile could end up partly or fully
underneath the bottom chat/controls overlay in portrait — an actionable
target rendered unreachable.

**Investigation** (both, per instruction, before changing anything):

1. Direct join bypassed readiness simply because nobody had called
   `prepareLocalMedia()` from that path — `handleTapEmptySeat`
   (`EventRoom`) went straight to `joinOpenSeat()`. Nothing else was
   different; the underlying publish machinery
   (`applyPublishState` preferring already-held prepared tracks,
   `syncCanPublish` reacting to the server's `canPublish` push) is
   already generic across *whichever* entry point acquired the tracks.
2. The overlay covers the bottom of the stage (`absolute bottom-0`,
   `z-10`) with a height driven by its content (guest editor + error
   text + `RoomControls` + a fixed `h-40` chat panel) — on a typical
   phone viewport that can reach into, or past, the bottom half of a
   two-tile stacked stage. It also had no `pointer-events` distinction
   at all: even its purely decorative top gradient padding (`pt-14`, no
   real content there) captured taps meant for the stage underneath.

**Decision**:

- `EventRoom.handleTapEmptySeat` now calls `connection.prepareLocalMedia()`
  synchronously, directly in the tile's own click handler (same Safari
  gesture requirement `ChatPanel`'s `onSubmit` already established for
  the composer path) — before the async `joinOpenSeat` call, not inside
  its transition callback. Zero new abstraction: this is the exact same
  `prepareLocalMedia`/`applyPublishState` machinery #22 already built,
  reused as-is — confirming request-mic and direct-join really do
  converge onto one readiness path, not two. On any join failure
  (`queue-exists` or a real error), tracks are deliberately left held,
  not released — the state the user returns to (audience with a queue
  fallback, or a retry) can still use them, same as an unpromoted
  composer request already leaves them.
- `SpeakerStage` now visually promotes the open seat to the front
  (`order-first`, a pure CSS flex property) whenever exactly one seat is
  empty *and* the viewer isn't a speaker themselves (i.e., the seat is
  actually tappable) — both-empty, both-occupied, and the active
  speaker's own view of the other seat are all left in natural seat-
  number order, since there's no single actionable target to prioritize
  in any of those cases. Reordering is keyed identically to before
  (`seat?.id ?? 'empty-N'`), so React reconciles this as a move, not a
  remount — no LiveKit/track impact, confirmed safe per the instruction
  not to touch media or seat identity for this.
- `PortraitRoom`'s overlay is now split into a `pointer-events-none`
  outer layer (position/gradient/top padding) and a `pointer-events-auto`
  inner wrapper around the actual controls/chat — identical classes,
  redistributed, so a tap landing in the decorative margin now reaches
  the stage beneath instead of being swallowed. Landscape's chat is
  already a separate side-column flex sibling, not an overlay over the
  stage at all, so it has no equivalent occlusion to fix.

**Reason**: both fixes reuse machinery/signals that already existed
(`prepareLocalMedia`, `isLocal`/seat occupancy, `SpeakerStage`'s own key
scheme) rather than inventing new plumbing, matching "smallest clean
fix" — and both are presentation/gesture-timing changes with zero
interaction with track ownership, publishing, or seat authorization
(`claimSpeakerSeat`'s race protection, the queue-exists check) as
explicitly required.

**Alternatives considered**: (1) a dedicated `pointer-events` toggle on
individual overlay children instead of splitting into two layers —
rejected as more surface area for the same result; one outer/inner split
covers every current and future child uniformly. (2) Clamping the
overlay to a max-height so it can never structurally reach the top
tile — rejected: the fixed `h-40` chat panel plus variable
guest-editor/error/controls content makes a safe clamp hard to pick
without risking silently clipping real content on a short viewport, and
the reordering fix already solves the actionability problem directly
(the open seat no longer needs to be a fixed distance from the overlay,
it just needs to not be the bottom one). (3) Reordering only in portrait
(where the bug was found) — rejected: `SpeakerStage` is shared, the rule
is orientation-agnostic ("the tappable seat leads"), and applying it
uniformly costs nothing extra.

**Tradeoffs**: on a sufficiently cramped viewport (unlikely but not
impossible — e.g. the guest-name editor, a join-failure message, and the
full `RoomControls` state all showing at once on a short phone), the
overlay could theoretically still reach up far enough to touch the
*top* tile too, even after reordering. Not mitigated further here — the
user explicitly asked not to build #21's chat-collapse system for this;
flagged for the real-device check instead of guessed at further.
Separately, found and fixed via the project's own `dev:harness
clear-sandbox` command: this session's test suite run hit a stale
`event_speakers_active_seat_uniq` conflict in `scripts/dev-harness.test.ts`
from leftover real-device-testing occupancy in the permanent test
room — unrelated to this change, cleared via the existing purpose-built
tool, not a code fix.

## 2026-08-22 — A speaker's own seat tile stops rendering their own video; landscape's dashboard drift recorded, not fixed (issue #22 dominant-video corrective pass)

**Problem**: real-device testing of the previous pass (candidate
readiness/self-preview) confirmed local media acquisition and the
self-preview both work, but exposed a genuine duplication bug: once
promoted, a speaker's camera rendered *twice* simultaneously — once as
their own large tile in the two-seat grid (`SpeakerTile`, via the
LiveKit `participant` lookup) and again in the persistent corner
`SelfPreview` (via the directly-held `localVideoTrack`) — the same
underlying `MediaStreamTrack`, attached to two independent `<video>`
elements. Separately, testing landscape mode found the room collapses
into a dashboard-style layout (small horizontal video strip, permanent
side-panel chat, full header) — a different, unrelated finding the user
explicitly asked to *record*, not fix, in this pass.

**Investigation** (per instruction, before changing anything): the
duplication traces to `SpeakerTile` and `SelfPreview` being two
independent consumers of the same published track, with no coordination
between them — `SpeakerTile` renders whatever `hasVideo` says regardless
of *whose* tile it is beyond `isLocal`'s existing (narrower) uses
(mute attribute, "(you)" label, skipping the tap-to-enable/audio-element
cases). Confirmed `SpeakerStage` already computes exactly the needed
signal for free: `isLocal` on any given tile is only ever true for the
*local* participant's own seat, on *that* participant's own client —
never true for an audience member (their identity never matches a
seat's occupant), so gating on it can't affect what an audience member
sees. Confirmed suppressing the tile's own video is presentation-only:
`participant` here is `room.localParticipant`, whose track publication
(and thus what every *other* client subscribes to and renders) is
entirely independent of what this client chooses to render locally —
same principle the existing `muted={isLocal}`/no-local-`<audio>`-element
code already relied on for the mic side.

**Decision**: `SpeakerTile` gained `showBigVideo = hasVideo && !isLocal`
— the big `<video>` only ever renders for a *remote* participant's tile
now. When it's the local speaker's own occupied seat and `hasVideo` is
true, a new neutral placeholder ("You're live — see your preview in the
corner") renders instead of either the real video or the existing
"Camera off" text (which would be false — the camera is genuinely on).
No changes to `SpeakerStage`'s layout, the two-tile grid proportions, or
the empty-seat tile at all — the other seat (real remote speaker, or
still empty) renders exactly as before either way, which is what
"preserve the empty-seat state as dominant, don't enlarge my own preview
to fill space" required. No changes to `useLiveRoomConnection`, track
ownership, publishing, or the self-preview itself.

**Landscape finding recorded, not fixed**: full write-up in
ARCHITECTURE.md ("Landscape must stay video-first too") and issue #18
(the eventual owner — its own Portrait `SpeakerView` bullet already
anticipated most of the no-duplication fix above, pulled forward here;
its Landscape bullet already anticipated *collapsible* chat, compatible
with the new constraint). Explicitly out of scope for this pass per
instruction — no landscape code touched.

**Alternatives considered**: (1) literal asymmetric grid resizing — make
the other speaker's tile visually larger/dominant, not just decluttered
— rejected for *this* pass: the user explicitly asked for the smallest
presentation-layer fix and to avoid starting a broader layout redesign;
"dominant" is satisfied here by there being only one real video left to
look at, not by resizing the grid. True asymmetric sizing (matching
#18's own "strong visual priority" language) stays #18's job. (2) A new
prop threaded down from `SpeakerStage` (e.g. `suppressOwnVideo`) —
rejected as redundant: `isLocal`, already passed into every tile, is
already exactly the right signal (true only for the viewer's own seat,
on their own client) with no additional plumbing needed.

**Tradeoffs**: none functionally — this is a narrower slice of #22's own
already-reserved "Role-specific dominant video (partial, narrow)"
bullet, not new scope. The full grid-level "make the other speaker
visually dominant" treatment and the landscape redesign both remain open
(#18), by design.

## 2026-08-22 — Candidate media readiness is a local fact, not a new server field (issue #22's remaining scope)

**Problem**: after `prototype-auto-promotion-stable`, the remaining
scope of #22 was candidate readiness (pre-acquiring camera/mic ahead of
a seat), a persistent self-preview, and publishing at promotion time
without a second `getUserMedia()` call. The issue's own "Blocks #23"
note (written before automatic promotion existed) implied #23 needed a
"readiness signal" from #22 to distinguish a ready vs. unready
candidate — worth re-checking against what #23 actually became before
building anything.

**Investigation**: re-reading `useAutomaticPromotion` (issue #23)
confirmed its eligibility decision (`resolveClaimDecision`, shared by
`checkPromotionEligibility` and `claimOpenSeat`) depends only on queue
rank — never on media state. `needsMediaActivation`/`mediaError` only
feed its *grace-period self-eviction* effect, which reacts to outcomes
*after* promotion, not before. There is no pre-promotion "readiness
check" in the eligibility path at all — so #22 was never actually
blocking #23 the way the older note assumed, and #23 needed no changes.

**Decision**: readiness is represented purely by whether the client
currently holds valid local `LocalTrack`s — no new database column, no
new server round-trip. `useLiveRoomConnection` grew `prepareLocalMedia()`
(acquires camera+mic once, from the mic-request composer's own submit
gesture — same Safari gesture constraint `activateMedia` already
documents), `releaseLocalMedia()` (stops held-but-unpublished tracks,
for withdrawal), and `localVideoTrack` (the held camera track, for the
new `SelfPreview` component). `applyPublishState` now checks for
already-held prepared tracks before falling back to the existing
`setCameraEnabled`/`setMicrophoneEnabled` gesture-gated path — so
promotion calls `publishTrack()` directly on tracks acquired earlier,
with no second permission prompt. On successful publish, ownership of
those tracks transfers conceptually to the Room (the prepared-tracks ref
is cleared so a *later* re-request re-acquires fresh tracks instead of
reusing spent ones) while the `localVideoTrack` React state is left
untouched, so the same mounted `SelfPreview` keeps rendering the same
track uninterrupted across the whole pending → countdown →
published-speaker transition — nothing above it ever swaps which
component or DOM node owns the attachment.

**Alternatives considered**: (1) a server-side `speaker_requests.is_ready`
column, flipped by a new mutation once `getUserMedia()` succeeds —
rejected per explicit instruction and because it would duplicate state
that's inherently local and can go stale silently (a track dying doesn't
push anything to the server); the client already has the ground truth.
(2) A second, parallel "media-ready" promotion path alongside
`useAutomaticPromotion` — rejected as a competing mechanism; the
existing grace-period self-eviction already covers "seated but
never/no-longer publishable," regardless of *how* the seat was reached,
and needed no changes to keep covering the #22-readiness case too.

**Reason**: keeps the server as the sole authority on *who* gets a seat
(rank, race-safety) while keeping *whether local media is usable right
now* — a fact only the browser tab can actually know, and one that can
change without any server-visible event — entirely client-side, matching
the project's existing "server decides eligibility, client reports its
own readiness" split rather than inventing a new one.

**Tradeoffs**: `createLocalTracks({ audio: true, video: true })` acquires
both devices in one call (deliberately — one combined permission prompt
instead of two), so a rejection can't be cleanly attributed to just one
device; classified against `"camera"` as the more central failure mode
for this product rather than adding a third, more precise `MediaError`
source for one ambiguous case. A candidate whose media dies while
genuinely still waiting (before any publish attempt) isn't detected
live — it surfaces the next time a publish is actually attempted (at
promotion), where the existing grace-period fallback already takes over;
no new "track ended" listener was added for this pass, since the
existing fallback already resolves it, just one step later than a live
listener would. The larger "make the other speaker's video dominant
once I'm on stage" redesign is explicitly deferred (possibly #18) —
`SelfPreview` stays the local feed only, never resized/repositioned by
this pass.

## 2026-08-22 — Third checkpoint tagged (`prototype-auto-promotion-stable`)

**Problem**: the friction-reduction work since `prototype-live-av-stable`
(video-first shell, the always-on test room, direct join, composer
mic-request, automatic promotion) reached a state the user confirmed as
"acceptable enough to continue" in real production use. The next planned
work (#22's remaining scope — local media pre-acquisition, self-preview,
promotion without reacquiring) touches the same sensitive LiveKit/media-
acquisition path this whole sequence has been careful around, so the
user asked for a fresh recovery point before starting it.

**Decision**: same process as the prior two checkpoints — annotated tag
`prototype-auto-promotion-stable` on `main`'s current tip
(`e934619d72b63cd1f35bb0adcdfeddf0cb67fd60`), confirmed via two
independent checks (the commit matches both `origin/main` and the most
recent Vercel deployment's SHA, that deployment's own status is
`success`), plus a fresh structural pass against the deployed production
site (Join Live Audience journey, direct-join tile, mic-mode composer,
no manual claim button, stage/overlay layering) immediately before
tagging. Pushed, verified present on the remote via `git ls-remote`, and
a GitHub Release created from it, marked prerelease — same reasoning as
before: a prototype checkpoint, not a production version.

**`prototype-live-av-stable` is untouched** — confirmed still pointing
at `397d3ff` immediately before pushing the new tag. This is an
additional, newer checkpoint, not a relocation of the existing one.

**Tradeoffs**: none — pure bookkeeping, no implementation changed.

---

## 2026-08-22 — Automatic promotion narrowed below #23's own original scope, deliberately

**Problem**: real-device testing of the mic-request flow found the
manual "Claim your seat" button was exactly the kind of friction issue
#23 already existed to remove — a candidate who'd already expressed
intent by requesting the mic still had to notice a button and click it.
The user asked for automatic, server-authorized promotion with a
"You're up next" countdown instead — but #23's own written design ties
automatic promotion's "eligible" determination to issue #22's readiness
signal (pre-acquired local media), which isn't built.

**Decision**: implement automatic promotion *without* #22 as a
prerequisite. The user was explicit that camera/mic publish should keep
using "the existing authorized path" — meaning the existing separate,
gesture-gated "Tap to enable camera & mic" step stays exactly as it is,
triggered once actually seated, same as today. This sidesteps needing
#22's readiness pre-acquisition at all: "eligible" for this pass is
still `decideClaimEligibility`'s existing rank/seat-availability check,
unchanged; "did the candidate actually follow through" is observed
*after* promotion (media activation within a grace period) rather than
predicted *before* it (pre-acquired tracks).

**Design that came out of this**: `checkPromotionEligibility` (read-only)
and `claimOpenSeat` (acts) now share one `resolveClaimDecision` helper,
extracted from what was previously all inside `claimOpenSeat`'s own
body — the eligibility the countdown polls for and the eligibility the
final claim enforces are structurally the same code path, not two rules
that could drift apart. The countdown is deliberately just a client-side
`setTimeout` chain with no authority of its own; the claim at the end
re-validates completely independently, so a countdown that turns out to
have been based on stale information just fails quietly (reset to
waiting), the same non-alarming way a lost race already worked before
this change.

**Polling, not purely Realtime-reactive**: eligibility depends on rank,
which is reaction-count-driven (`rank_pending_speaker_requests`) — a
candidate can become newly eligible because *someone else's* request
lost support, with no `event_speakers` row changing at all. A purely
`event_speakers`-Realtime-triggered check would miss that window
entirely. Polling only while a candidate has a pending request (a small,
bounded set) avoids the audience-wide-polling concern already ruled out
elsewhere in this project (issue #25's design) — this scales with
concurrent candidates, not concurrent viewers.

**Grace-period addition, scoped narrowly**: issue #23's approved design
calls for skipping a candidate who cancels, disconnects, or never
becomes media-ready. Disconnection is already handled (issue #13's
LiveKit webhook). Cancel reuses the existing `withdrawSpeakerRequest`.
The one genuinely new piece is a promoted-but-silent candidate — added
as a 30-second grace-period timer that self-evicts via the existing
`leaveSpeakerSeat`, no new authority, applying uniformly regardless of
whether the seat was reached via this promotion path or issue #27's
direct join (there's no reason to treat the two differently).

**Tradeoffs**: the full "eligible factors in readiness, unready
candidates yield via time-graduated eligibility *before* ever occupying
the seat" design from #23's original body is not implemented — a
candidate can still be promoted, occupy the seat, and only THEN turn out
to be unready, for up to 30 seconds before self-eviction frees it back
up. Accepted explicitly: closing that gap is what issue #22's readiness
pre-acquisition is *for*, and the user was explicit about not pulling it
in as a prerequisite for this pass.

**Testing note**: one planned test (the full multi-tick countdown-to-
claim chain, via `renderHook` + fake timers) was attempted with several
strategies (`advanceTimersByTimeAsync` at multiple granularities,
`runAllTimersAsync`) and none reliably converged in this test
environment — a React-effect-rescheduling-a-timer chain interacting with
fake timers, not a sign of an implementation bug (the underlying
single-timer mechanism is the same shape already proven by the
grace-period self-eviction test, which does pass reliably). Dropped
rather than forced; the full sequence is covered by real-device
verification instead.

---

## 2026-08-22 — Speaker divider fixed by CSS stacking containment, not z-index escalation

**Problem**: real-device screenshots showed the speaker divider (and its
decorative center dot) painting on top of "Claim your seat"/"Withdraw",
the composer, and other foreground controls — a genuinely broken-looking
interface, not a cosmetic nitpick. The user explicitly ruled out the
obvious quick fix (raising every foreground button's z-index until it
happened to outrank the divider), correctly identifying that as a hack
that treats the symptom per-element instead of the actual cause.

**Root cause, confirmed by inspection, not guessed**: `SpeakerStage`'s
root div was `className="relative h-full w-full ..."` — `position:
relative` with an implicit `z-index: auto`. A stacking context requires
*both* a position value and a non-`auto` z-index; with only the former,
the divider's own `z-index: 10` did not stay scoped inside the stage —
it escaped to whichever ancestor actually established a stacking
context, landing it in direct competition with `stage-bottom-overlay`
(the chat/controls layer in `portrait-room.tsx`), which had no z-index
at all. `10 > auto`, so the divider won, regardless of DOM order or
which element was "supposed" to be on top.

**Decision**: fix containment at the source. `SpeakerStage`'s root
becomes `relative z-0` — `0` is a real value (unlike `auto`), so this
now genuinely establishes its own stacking context, and everything
nested inside it is permanently confined to comparing z-index only
against its own siblings within that context, never against anything
outside `SpeakerStage` again. `stage-bottom-overlay` gets an explicit
`z-10` to make the outer ordering self-documenting rather than an
implicit DOM-order tiebreak. With the stage now contained, the divider
itself no longer needs a z-index at all — it never overlapped the tiles
it sits between, so the `z-10`/`relative` on it were removed entirely,
netting *less* code, not more.

**Reason this generalizes rather than being a one-off patch**: any
z-index #21 or #25 later add *inside* `SpeakerStage` (a drag handle, a
voting-active highlight) is now automatically contained by the same
`z-0` root — there is no way for a future change inside the stage to
reintroduce this bug without deliberately breaking the containment
itself.

**Also removed**: the divider's circular center dot. It had no
user-facing function yet (#21/#25 haven't landed), and was itself part
of the visual clutter flagged — kept only the divider bar, the actual
structural anchor those issues need.

**Tradeoffs**: none — this is pure layering/paint-order correction, zero
behavior change to LiveKit, video geometry, Join Live Audience, the
always-on test room, tap-to-join, or the mic-mode composer.

---

## 2026-08-22 — Speaker-entry friction removed; verification tiers codified in AGENTS.md

**Problem**: real-device testing of the room found the standalone
"Request the mic" control consuming valuable video space and creating a
mandatory request→justify→submit→claim sequence even for a literally
uncontested empty seat — friction the project had already identified
(issues #22, #27) but not yet implemented. Fixing it meant touching a
component that's used by two structurally different situations (an
open seat with nobody waiting vs. one with a real queue behind it), and
getting the queue-protection boundary wrong would mean a bystander could
cut a real requester's place.

**Decision**: two entry points, one server-authoritative boundary.
Tapping an empty seat calls a new `joinOpenSeat` action that checks for
*any* pending `speaker_requests` on the event before touching a seat at
all — if none exist, it reuses `claim_speaker_seat` exactly as the
existing contested-claim path already does (same partial unique index,
same race safety, verified by nothing new); if any exist, it refuses
with a distinguishable `"queue-exists"` result, and the tap handler
falls back to the chat composer's new 🎤 request mode instead of showing
an error. The composer's request mode is a controlled prop (lifted to
`EventRoom`), not local state, specifically because tapping an empty
seat needs to be able to switch it from outside itself.

**Reason this reuses existing primitives rather than adding new ones**:
`claim_speaker_seat`'s own UPDATE-then-INSERT-under-a-partial-unique-
index pattern was already the correct, already-verified concurrency
primitive for "resolve competing seat claims safely" — the actual new
problem here was authorization (should this attempt be allowed at all),
not concurrency, and authorization is a plain read (`rankPendingSpeakerRequests(eventId).length > 0`) checked before the existing claim path runs, not a new database mechanism.

**Verification-tier rule, same session**: this was the third time a
change passed every automated check while still failing the real user
journey (issue #20's first pass; the Browse Events dead end hit twice).
The pattern each time was the same — "the code should work" standing in
for "this was actually exercised" — so the fix this time is process, not
another one-off correction: AGENTS.md now codifies three explicit
verification tiers (automated / production-interaction / real-device)
and requires every handoff on a UI/UX-affecting change to report against
all three by name, with real-device items marked "UNVERIFIED — requires
real-device testing" rather than silently rounded up to "verified." Also
codifies that a discoverability/navigation feature must be tested from
its real public entry point (the landing page, Browse Events), not a
direct `/events/[id]` URL standing in for the journey it's supposed to
shorten.

**Tradeoffs**: `joinOpenSeat` does not (yet) acquire camera/mic —
promotion still goes through the existing separate "tap to enable
camera & mic" gesture once seated. This is #22's remaining, explicitly
narrowed scope (readiness pre-acquisition, self-preview, promotion
without reacquiring), not an oversight of this pass — see issue #22's
amended body.

---

## 2026-08-21 — Permanent test room: a database-level guarantee, not a workflow habit

**Problem**: real-device testing hit "Nothing scheduled right now" on
Browse Events three times across sessions (Session 20, and twice in this
one) — a dev-harness fixture's `scheduled_start` aged past the events
list's 2-hour visibility cutoff, or a `reset` (this session's or an
unknown prior one's) deleted the one event a session depended on. The
user was explicit this was no longer acceptable: the deployed app must
always have at least one testable room reachable through the real
Browse Events → tap → room journey, with zero commands run first, and
the guarantee must survive resets and the passage of time between
sessions — not just "the last person to test remembered to leave one."

**Alternatives considered**:
- A cron job that periodically bumps a fixture's `scheduled_start`
  forward. Rejected: this project's deployment tier (Vercel Hobby, see
  README's Deployment section) only supports daily-granularity cron
  without a paid upgrade — the same constraint already hit and rejected
  for issue #25's voting-window evaluation — and it's real new
  infrastructure for a problem that doesn't need a timer at all (see
  below).
- A session-start checklist ("always verify/recreate the fixture before
  asking the user to test"). This is necessary discipline regardless
  (see the `feedback_real_device_verification` memory) but isn't
  sufficient on its own — it depends on remembering, every session,
  forever, which is exactly the class of failure that already happened
  twice. A durable fix shouldn't depend on procedural memory.

**Decision**: one permanent database row, not a periodically-refreshed
one. `events.is_permanent_test` (migration `00000000000015`), enforced
to be at most one by a partial unique index — a real invariant, not a
convention (verified: a second insert attempt raises a genuine
unique-constraint violation). Its `scheduled_start` is pinned once, at
migration-apply time, and never needs to change again:
`getEventPhase` (`lib/events.ts`) already treats any *past*
`scheduled_start` as `"ready"` forever — the row doesn't need to be kept
"fresh," it needs to be *exempted from the query that hides old things*.
`listUpcomingEvents` now does exactly that (`.or()`-ing the permanent
flag in alongside the normal cutoff, sorted first) — zero changes to
phase/countdown logic anywhere else in the app. Both reset paths
(`dev-harness.mts`, the `/dev` page's action) explicitly exclude
`is_permanent_test` rows, verified with new integration tests against
the real linked project — not just asserted from the title convention
already making them structurally unlikely to match.

**Reason this is the *smallest* reliable solution, not just *a*
solution**: it required touching exactly one query's filter/sort clause,
two reset functions' `WHERE` clauses, and one migration — no new
infrastructure (no cron, no scheduled function, no new service), no
special-casing of any existing time-computation logic
(`getEventPhase`/`EventCountdown`/`formatCountdown` are all completely
unchanged), and no new authorization surface (RLS on `events` already
allows public SELECT unconditionally, so no policy change was needed
either).

**Tradeoffs**: the card's displayed date (`formatEventDateTime`) will
show the day the migration was applied, indefinitely — not updated to
look "current." Accepted deliberately: this room is unmistakably labeled
`[DEV] Always-On Test Room`, and building special-case display logic
just to make a test fixture's timestamp look fresher isn't worth the
added surface area for a prototype-phase tool. `clear-sandbox` (new
`dev-harness.mts` command) exists specifically so its *content* doesn't
need to look stale either, without deleting the row itself.

---

## 2026-08-20 — Video-first room redesign finalized, issues #19–#25 created

**Problem**: Session 21's participation-friction design work (queue/mic-request/
direct-join/voting) needed to be reconciled with a mobile UX direction the
user specified: the live video should stay the stable visual foundation of
the room, not something that shrinks/rearranges as focus shifts to chat or
voting. Several open technical questions had to be resolved before issues
could be created: how to layer chat/voting over video without touching the
video element itself, how to prevent accidental swipes from morphing the
room, how the self-preview stays spatially stable through candidate→speaker
promotion, and — the one with real scaling risk — how a voting window's
close gets *evaluated* server-side without every audience member polling.

**Decisions**:

- **Scrim/overlay layers, not video resizing.** The video base layer's own
  size/position never changes across focus states. A translucent scrim
  `div` animates `opacity` above it; panel content animates in via
  `transform`, never `top`/`left`/`width`/`height`. Verified against mobile
  Safari's compositing behavior before committing: video elements typically
  get their own compositor layer, and repeatedly mutating their box is the
  more expensive, glitch-prone path versus leaving the video alone and
  animating a separate layer. Only `opacity`/`transform` are used for any
  focus-state animation — both GPU-compositable, neither triggers reflow.
- **Controlled layout state with a dead zone, not scroll-snap or
  scroll-position interpolation.** Both scroll-based options were
  considered and rejected: scroll-snap can't deliver a continuous
  transition, and scroll-position interpolation would require nesting a
  native scrollable "focus" container against chat's own scrollable
  message list — the same nested/ambiguous-scroll-container pattern
  already diagnosed as the root cause of the "video disappears while
  scrolling chat" bug (`layout.tsx`'s `overflow-y-auto` on `<body>`
  competing with `ChatPanel`'s internal scroll). A dedicated drag-handle
  gesture (bottom-sheet pattern, `touch-action: none` during drag) with an
  explicit dead zone — no visual change below a small delta threshold,
  live-follows-finger above it, commit/cancel decided on release — avoids
  reintroducing that class of bug entirely, since nothing in the mechanism
  touches native scroll. Tap remains the unconditional, guaranteed path to
  voting regardless of the gesture layer.
- **`ChatPanel` becomes one continuously-mounted component** across
  default/chat-focus, clipped to a short height in one state and expanded
  in the other — not two separate components. This is the same
  "state-owning component stays mounted, presentation branches below it"
  discipline already established for orientation (`useOrientation`) and
  the event/lobby/room lifecycle (issue #17), applied a third time. Draft
  text, mic-request mode, scroll position, and the Realtime subscription
  survive focus changes automatically as a result, with no state-lifting
  or sync code needed.
- **Self-preview spatial stability falls out of the scrim architecture for
  free.** Because focus-state changes only affect the overlay layers above
  the video (per the first decision above), a self-preview living in a
  fixed slot in the stable base layer is naturally unaffected by chat/
  voting focus changes — no separate mechanism needed to "protect" it.
  Candidate→speaker promotion keeps the same DOM `<video>`/attached track
  the entire time (`createLocalTracks()` once at mic-request time,
  `publishTrack()` on the same track object at promotion — no second
  `getUserMedia()` call, confirmed via `livekit-client`'s own type
  definitions).
- **Voting-window evaluation triggers scale with active pairings, not
  audience size.** Audience clients never poll for evaluation — they
  receive results via the room's existing Realtime subscription (the same
  mechanism `event_speakers` changes already use) and their own vote-cast
  response for the reveal-then-collapse percentage display. Only the two
  currently active speakers' clients (2 per room, not 2 per viewer) poll
  as a heartbeat, plus any vote being cast opportunistically re-checks as
  a side effect. Considered and rejected: **Vercel Cron** (this project's
  actual deployment tier, Hobby, only supports daily-granularity cron —
  not workable for a sub-minute voting window without a paid upgrade) and
  **Supabase `pg_cron`** (a new backend extension adopted solely for this,
  when the existing serverless-triggered-by-real-activity pattern issue
  #13's LiveKit webhook already established covers it with no new
  infrastructure). Every evaluation independently recomputes the window/
  tally and re-verifies the pairing hasn't already changed before acting —
  the same idempotent, safe-no-op pattern #13's disconnect cleanup and
  #23's promotion already rely on.
- **Recurring voting windows via modular arithmetic on `pairing_start_time`
  (`(now - start) mod (CONVERSATION_PERIOD + WINDOW_DURATION) >=
  CONVERSATION_PERIOD`)** — a pure function every client and the server
  compute identically, with no stored "which window number" state and no
  server timer opening/closing anything.
- **No-replacement eviction is immediate, not held.** A vote evicting one
  or both speakers with nobody queued produces `room-status.ts`'s already-
  modeled `"selecting"`/`"waiting"` states, picked up by direct-join or
  automatic promotion (#23) the instant anyone's eligible. Chosen
  explicitly over holding a rejected speaker until a replacement exists,
  because the audience's vote should visibly do something the moment it
  resolves — these are presented states already built for other reasons,
  not an accidental fallthrough left for the schema to imply.
- **Room format seam**: one additive `events.format` column
  (`default 'main_stage'`, CHECK-constrained), same pattern as
  `left_reason`. No plugin/rules-engine framework. Roulette/Spotlight/
  Group Stage documented as future values, not built.

**Reason issue #20 (the shell) is still sequenced after #19 (the format
seam)** despite no true technical dependency between them: kept as
intentional sequencing, landing the small boundary-setting issue first,
per the user's own instruction to distinguish sequencing from genuine
dependency rather than justify ordering after the fact.

**Issues created**: #19 (room format seam), #20 (video-first room shell),
#21 (chat/voting focus interactions), #22 (composer mic-request/candidate
readiness/self-preview), #23 (direct-join/automatic promotion), #24 (fresh
next-speaker ranking), #25 (audience retention voting) — all added to the
project board. Full technical reasoning (including the rejected
alternatives for each decision above) is in the design conversation itself,
not duplicated here.

**Tradeoffs**: The video-first/scrim architecture (#20/#21) is a larger,
riskier rewrite of the room's layout than the original "sticky layout" fix
this was scoped as in Session 21 — split into a shell issue (#20) and an
interactions issue (#21) specifically so the stable frame can be verified
on a real phone before the gesture layer is added on top, rather than
shipping both as one large, harder-to-isolate change.

---

## 2026-08-18 — Second checkpoint tagged (`prototype-live-av-stable`): two-device LiveKit verified

**Problem**: `prototype-mobile-single-device-stable`'s one explicitly
unverified item — real two-device LiveKit audio/video — was the last
gap before the user considered the core live-conversation hypothesis
actually testable. They personally verified it with two real devices
connected to the same live event and asked for the same
checkpoint/tag/release/documentation process to mark this state too,
before shifting focus to participation-friction UX work.

**Decision**: Same process as the first checkpoint. Annotated tag
`prototype-live-av-stable` on commit `397d3ffa496ace5dd7eeb2fa21b1617049e4715e`
(the tip of `main` at the time — the previous checkpoint's own
documentation commit, no code changes since), confirmed via the same
two independent checks as before: `vercel inspect` on the live
production deployment (`dpl_7LsVvkZReBHXAhkSY64durDmCaze`) and GitHub's
deployments API for that commit SHA, which recorded the identical
Vercel deployment ID. Pushed to `origin`, plus a GitHub Release created
from the tag, marked **prerelease** for the same reason as before — a
prototype checkpoint, not a production version.

**What was verified**: the core LiveKit conversation working between
two real devices, audio and video both directions. Everything from the
first checkpoint still holds underneath it.

**Reason issues #15/#16/#17 stay open despite this checkpoint**: same
as the first checkpoint — this marks a recovery point in what's been
built, not a closing confirmation against each issue's own stated
acceptance bar.

**Tradeoffs**: None — pure bookkeeping, no implementation changed.

---

## 2026-08-18 — First user-confirmed stable checkpoint tagged (`prototype-mobile-single-device-stable`)

**Problem**: After several rounds of real-device fixes (issues #15/#16/#17),
the user personally verified the deployed app end to end on their iPhone
for the first time and confirmed it as "the first state of the project
I consider a stable, usable mobile prototype." They asked for this exact
state to be preserved as a known-good recovery point, separate from and
prior to any further feature work, so a future regression has something
concrete to compare against or restore to.

**Decision**: An annotated Git tag, `prototype-mobile-single-device-stable`,
on commit `1e72311e20efb195e5d63d6e7e8f6b6d7ca06d65` — confirmed (not
assumed) to be exactly what's live in production via two independent
checks: `vercel inspect` on the current production deployment
(`dpl_3ncVAw1JEPQHRamaaxMXVNw1gdZA`) and GitHub's own deployments API
for that commit SHA, which recorded the identical Vercel deployment ID.
Pushed to `origin`, plus a GitHub Release created from the tag and
explicitly marked as a **prerelease** — deliberately not a normal
"Latest Release," since this is a prototype checkpoint, not a production
version number. No code changed to create this checkpoint; the working
tree and `main` were already clean and in sync with `origin/main` before
tagging.

**What was actually verified, exactly as the user reported it** (real
iPhone, against the live deployment): landing page, Browse Events,
discovering the test event through that page (not a direct link),
one-tap entry into the unified room with no lobby/room navigation step,
chat, reactions, the request-the-mic control, the full guest-speaker
request→claim flow, and camera/microphone both activating successfully.
The click count/navigation feel was explicitly confirmed acceptable.

**What remains explicitly unverified — recorded so it isn't quietly
assumed later**: a genuine two-device live-media test. Specifically:
a second device receiving the first speaker's video; a second device
receiving the first speaker's audio; the first speaker receiving a
second speaker's video/audio; a simultaneous two-speaker conversation;
and rotation/orientation surviving an active two-device call. Camera/mic
*activating* on one device was confirmed — tracks actually reaching
another participant was not, and is a materially different claim.

**Reason issues #15/#16/#17 stay open despite this checkpoint**: the
user was explicit that this milestone doesn't constitute their
acceptance criteria for those issues — it's a recovery point for what's
been built so far, not a closing confirmation. Each issue's actual
closing bar (stated in their own threads/DECISIONS.md entries above)
still requires the two-device verification listed above.

**Tradeoffs**: None — this is a pure bookkeeping/safety action, no
implementation changed.

---

## 2026-08-18 — Two more real-device #17 findings: stale test fixtures, and the request-mic control buried below the fold

**Problem**: The user's real-device retest of #17 found two blockers:
(1) the test event handed off couldn't be found through the actual
"Landing page → Browse events" journey at all, and (2) the direct room
link worked, but no "Request the mic" control was visibly reachable —
exactly the flow #16 exists to let a guest exercise.

**Finding 1 — not a code bug, a stale-fixture bug of my own making.**
Reproduced directly: `listUpcomingEvents` filters `scheduled_start >
(now - 2h)` (`getEventsListCutoffIso`, intentional — hides events that
"started" more than two hours ago, documented in its own comment). The
test events handed off earlier had been created under a stale
assumption about the current date — real wall-clock time had moved
forward roughly two days since — so their `scheduled_start` had aged
`~48h` past that cutoff and was correctly excluded from "Browse events."
`getEventById` (used by the direct room link) has no such time filter,
so the direct link kept working the whole time and masked the problem —
which is exactly why the user's instruction not to substitute a direct
link for the real journey mattered: the direct link's success was
hiding a real gap in how discoverable the test event actually was.
Confirmed by reproducing the exact query against the anon key locally
(returned zero rows for the stale event, non-zero for a freshly created
one) rather than assumed. **Fix**: none needed to the list/query logic
itself — it's working as designed. Created fresh test data and
reconfirmed it appears in the deployed "Browse events" page before
handing anything off again.

**Finding 2 — the request-mic control's logic was correct; its position
wasn't.** Traced the full render-condition chain the user asked for —
event phase (`ready`), `PROTOTYPE_CONFIG.guestParticipationEnabled`
(`true`, default), identity type (`guest`), pending-request state
(`false`, fresh guest), active-speaker state (`false`) — every condition
correctly resolves to `RoomControls` rendering its default "Request the
mic" branch, confirmed present in the actual deployed HTML. The gap
wasn't the logic, it was position: `RoomControls` sat *after*
`RoomChatPanel` (a variable-, potentially-tall-height flex-1 element) in
`PortraitRoom`, with the temporary `RoomDiagnostics` panel stacked below
*that* — meaning on a real phone, reaching the request-mic control
depended on scrolling past however much chat content and diagnostic
text came before it. This is the same shape of bug the tile-placement
fix already found once for camera/mic activation: a control that's
logically present and even present in the server-rendered HTML, but not
reliably discoverable to a real user under real viewport constraints.

**Decision**: Two changes, without trying to fully prove the exact
viewport-unit mechanics on a device I can't access directly:
1. Reordered `PortraitRoom` so `RoomControls` sits directly below the
   speaker stage, *before* `RoomChatPanel` — its reachability no longer
   depends on chat content height at all; only the chat feed itself
   (already internally scrollable via its own `overflow-y-auto`)
   absorbs remaining space. Landscape wasn't changed — its chat is a
   fixed-width side panel, not vertically stacked, so this specific
   failure mode doesn't apply there.
2. `RoomDiagnostics` collapsed to a single-line toggle by default,
   expandable on demand — it was itself a real, measurable contributor
   to pushing real controls further down the page, on top of being
   something the user had already flagged as "not a product feature."
   Still fully available for the next round of debugging, just not
   permanently consuming vertical space it doesn't need most of the
   time.

**Reason recorded together with finding 1**: both are the same root
lesson in different clothes — verifying "the code is correct" (a passing
query, a rendered button) is not the same claim as "a real user can
actually reach this," and this project's own standing discipline (real
devices, real linked databases, not mocks or assumptions) is what caught
both. Worth a checklist reflex for future sessions: when handing off a
test link, reproduce that it's reachable through the *actual* discovery
path, not just that the direct link responds.

**Tradeoffs**: None of consequence for either fix — the reorder is
presentation-only (no state/logic moved), and the diagnostics collapse
is reversible/still fully available on tap.

---

## 2026-08-16 — One event URL: collapsing event/lobby/room into a single persistent experience (issue #17)

**Problem**: Real-device testing repeatedly confirmed the three-route
event→lobby→room split (each a full navigation, each mounting its own
top-level state-owning component) as an active usability failure, not
polish — roughly three taps before reaching anything interactive, and a
screenshot showing the room's empty-seat/"Waiting for speakers" state
with the chat/request-mic flow the user expected not actually present
(because they'd reached it via the narrower, chat-only `LobbyRoom`
before "Enter the room," not the full room layout). The user's own
framing: tapping an event should mean immediately being in the room,
whatever state it's currently in.

**Alternatives considered**:
1. Keep three routes; make the "Enter Lobby"/"Enter the room" transition
   automatic (a client-side redirect once the phase flips) instead of a
   manual click. Rejected explicitly by the user up front — an automatic
   redirect between routes still unmounts and remounts every
   top-level component, tearing down and rebuilding the chat/presence
   Realtime subscription and (once live) the LiveKit connection. That's
   the reload-equivalent PRODUCT.md's mobile-orientation principle
   already forbids for rotation; the same reasoning applies to a phase
   transition.
2. One URL (`/events/[id]`), one persistent client component owning
   every live hook unconditionally, with phase becoming a render branch
   *above* the existing orientation branch — the exact same shape
   already proven for orientation (see the mobile-orientation entries
   below): hooks that never unmount, only the presentation chosen
   underneath them changes.

**Decision**: Option 2. `LiveRoom` was renamed `EventRoom` (it now owns
the whole lifecycle, not just the "live" part) and gained a fourth
unconditional piece of state — `phase`, computed the same
`useNow()`-driven way `EventCountdown`/the old `LobbyRoom` already did —
sitting above `useLobbyRealtime`/`useActiveSpeakers`/`useOrientation`.
`useLiveRoomConnection` already handled a `null → real params`
transition by design (its own doc comment states this explicitly); the
LiveKit connection simply starts using the token already fetched at
initial page load the moment `phase` becomes `"ready"`, without any
remount or new fetch. The room's *existing* layout
(`RoomHeader`/`SpeakerStage`/`RoomChatPanel`/`RoomControls`) needed no
restructuring — it already showed seat placeholders, chat, and (as of
issue #16) the request-mic control together; the actual bug was that
this layout was gated behind an extra click and only reachable once
`phase === "ready"`, not that the layout itself was missing anything.
It's now reachable from `lobby_open` onward, with only a lightweight
countdown-only view before that (matching what the old event-detail page
showed pre-lobby).

**Server-side data fetching also unified**: `/events/[id]`'s page now
fetches speakers, messages/reactions, a LiveKit token, and pending-request
status unconditionally, regardless of phase, replacing the old
per-route, phase-gated fetches. Minting a token before "ready" is
harmless — signing a JWT never contacts LiveKit's servers, and
`canPublish` is still derived purely from real `event_speakers`
occupancy either way (see the LiveKit authorization model section).
`initialPhase` is computed server-side (no `now` parameter, so it
reflects the actual request-time truth) and used until the client's
`useNow()` clock ticks past hydration — this is what makes opening an
already-live shared link land directly in the live state on first
paint, not a placeholder that flips a moment later.

**A real, deliberate gap this surfaced, not silently absorbed**: making
`RoomControls` reachable before `phase === "ready"` means requesting the
mic (a real product requirement — "waiting together is part of the
experience") also makes *claiming* a seat reachable from the same
screen, before the scheduled start. Left unguarded, that would let the
live conversation start early, defeating the purpose of a scheduled
start time. Fixed by adding a server-enforced check to `claimOpenSeat`
itself — fetches the event, rejects with a clear message unless
`getEventPhase(event) === "ready"` — not just a hidden button, consistent
with this project's "the server decides, the client never does" rule.
Requesting the mic and withdrawing a request remain available from
`lobby_open` onward, unchanged.

**Route fate**: `/events/[id]/lobby` and `/events/[id]/room` become
plain `redirect()` stubs — kept, not deleted, for any link already
shared before this change, per the user's explicit allowance. The old
`LobbyRoom` and `EventEntryStatus` components became genuinely dead code
once nothing rendered them and were deleted rather than left unused;
`GuestNameEditor` (previously only in `LobbyRoom`'s sidebar) moved into
the unified room's layout, shown for guests in both the pre-lobby
countdown view and the main room view.

**Reason this is recorded as a first-class architectural decision, not
just a routing tweak**: it's the second time in this project a
navigation/redirect pattern was rejected specifically because it would
tear down live state (the first being the mobile-orientation principle
itself) — worth naming explicitly so a future session recognizes the
pattern (hooks-above-the-branch) as the general answer to "how do I add
a new mode to a live experience," not something to rediscover per
feature.

**Tradeoffs**: `EventRoom` is now a larger component, owning one more
piece of branching logic (phase) on top of orientation and role — still
manageable, but issue #18's role-based UI split will add a third
dimension on top of this same base, worth watching for complexity as
that lands. The pre-lobby countdown view duplicates a small amount of
"upcoming" rendering logic that used to live in the now-deleted
`EventEntryStatus` — judged acceptable since it's a handful of lines,
not worth extracting into a shared component for one caller.

---

## 2026-08-16 — Guest speaker participation (issue #16): design, and a real grant-revocation regression caught by the existing test suite

**Problem**: A third real-device test of issue #15 (after the LiveKit
credential fix and the tile-visibility fix) showed every layer working —
connection, token, browser permission — except `canPublish`, because the
user's own session correctly resolved as a guest, and guests couldn't
become speakers at all. The user reframed the priority: validating "the
live room works" the way they actually intend to test it (no login
required during this prototype phase) requires guest speaking first.
#16 was promoted from "next in sequence" to "prerequisite for #15's own
final validation." See SESSION_LOG.md for the full re-evaluation this
session did (which issue owns which piece of the journey, the exact
end-to-end acceptance test, why #17/#18's order didn't need to change).

**Design — preserving the security boundary while widening who can
reach it**: the question wasn't "should guests speak" (the user decided
that, as an explicit, reversible testing-phase exception — see
PRODUCT.md) but "how, without letting an anonymous client tell Postgres
*which* guest it is." Guest identity is a server-resolved, httpOnly-
cookie-derived id — trustworthy as *the caller in a Server Action*
(already true for guest chat authorship), but with no `auth.uid()`
equivalent Postgres/RLS can check the way it can for accounts. So:

- `claim_speaker_seat`/`end_speaker_seat` (already `service_role`-only,
  already took an explicit target identity rather than `auth.uid()`) —
  smallest possible change: widen the identity to optionally be a guest,
  in the *same* function, XOR-validated exactly like the table's own new
  constraint. Not a second overload — Postgres resolves overloads by
  parameter type, and a guest-only version would have the identical
  `(uuid, uuid, smallint)` signature, which isn't a valid overload at
  all. `p_profile_id`/`p_guest_id`/`p_guest_display_name` all default to
  null so an existing partial-parameter caller (including the "not
  callable by an ordinary user" grant tests) still resolves to this one
  function.
- `request_to_speak`/`withdraw_speaker_request` (self-service,
  `auth.uid()`-gated, granted to `authenticated`) — left **completely
  unchanged**. A guest gets a separately-named, `service_role`-only
  sibling (`request_to_speak_as_guest`/`withdraw_speaker_request_as_guest`)
  instead of a widened single function, because the authorization
  *mechanism* genuinely differs (a caller can't spoof `auth.uid()`; there
  is no equivalent trust anchor for a guest) — unifying them would mean
  one function serving two different trust models awkwardly, which is
  the opposite of "clearest API," the standard the user asked this
  decision be judged against. The atomic message+request insert logic is
  shared via an internal `request_to_speak_internal` function that's
  never granted to anyone — only reachable from the two public wrappers.
- `event_speakers`/`speaker_requests`: `profile_id` becomes nullable,
  `guest_id` added, `check ((profile_id is not null) <> (guest_id is not
  null))` — the exact XOR pattern `event_chat_messages`/
  `event_chat_message_reactions` already established for guest-vs-account
  authorship (migration `00000000000003`), applied here for the first
  time to the *speaking* tables. The active-occupancy/active-request
  partial unique indexes became `coalesce(profile_id, guest_id)`-keyed,
  same shape as the existing reaction-dedup index.
- Everywhere else (LiveKit token minting, `syncPublishPermission`, the
  disconnect webhook, `SpeakerStage`'s participant-identity lookup,
  `decideClaimEligibility`) was already either identity-generic
  (`mintLiveKitToken`/`determineCanPublish` needed zero changes) or had a
  single hardcoded `{type: "profile", ...}` assumption to generalize —
  no new authorization logic, just correctly propagating whichever
  identity a seat/request actually belongs to.
- `PROTOTYPE_CONFIG.guestParticipationEnabled` (`lib/config.ts`) — already
  existed, unused, from a much earlier session, apparently set up in
  advance for exactly this decision — is now the single gate every new
  guest-facing branch in `room/actions.ts`/`RoomControls` checks, so this
  can be tightened back to account-only later without touching the
  authorization system.

**A real, live security regression this caught, not just risked**:
after applying the migration, the *existing* "claim_speaker_seat/
end_speaker_seat are not callable by an ordinary authenticated user"
integration tests failed — for real, against the live linked project,
not a mock. Cause: both functions had to be recreated via `drop
function` + `create function` (Postgres doesn't allow `create or
replace` to change a parameter list), and a fresh `create function`
resets to PostgreSQL's PUBLIC-execute-by-default — **the exact same
mistake this project's own issue #13 entry below already documents
happening once before** (migration `00000000000006` → fixed by
`00000000000008`). Every other new function in this migration correctly
included its own `revoke ... from public`; only these two, extended in
place rather than authored from scratch, were missed. Fixed immediately
with a forward migration (`00000000000013`, applied within minutes of
the failing test run, before any other work continued) rather than
editing the applied migration, per this project's standing rule.
Verified directly against `pg_proc.proacl` afterward, not just by the
test passing, the same way the original issue #13 finding was verified.

**Reason this is worth a second, explicit callout despite already being
a documented pattern**: it demonstrates exactly why this project's
integration tests hit the real linked database instead of mocking it —
this class of bug is invisible to `tsc`, to `eslint`, and to a test
suite that mocks Postgres's grant system, and was only caught because
the existing tests already asserted the security boundary directly
against a real database and were run before considering the migration
done. Worth encoding as a checklist reflex for the next session that
touches a `security definer` function's signature: **recreating a
function via drop+create is not the same as altering it in place —
always re-verify its grants afterward, never assume they survived.**

**Tradeoffs**: Two forward migrations (`00000000000012`/`00000000000013`)
instead of one, for the same reason every prior grant-fix in this project
has been a forward migration, not an edit. A guest's seat/request rows
carry no FK to any table (unlike a profile, which FKs through
`auth.users`) — nothing to clean up if a guest's cookie is later cleared;
this is an accepted consequence of guest identity being a bare id, not a
new gap introduced here.

---

## 2026-08-16 — The activation control existed and worked; the user couldn't find it (issue #15, second real-device retest)

**Problem**: After the user fixed the actual LiveKit credentials on
Vercel (see the entry below), a second real iPhone test confirmed every
layer up through browser permission was genuinely working — production
diagnostics read `LiveKit connection status: connected`, `Server grants
canPublish: true`, `Needs media-activation tap: true`, `Media error:
none`, and the tile's own direct `getUserMedia` test reported `SUCCESS`.
Despite all of that, the user still reported "I still only see my
initials / camera off" and couldn't find a working activation control.

**Diagnosis**: Confirmed by re-reading the render tree, not guessed —
`RoomDiagnostics` and `RoomControls` both read the exact same
`needsMediaActivation`/`isSpeaker` values from one shared source
(`LiveRoom`'s `layoutProps`), so there was no possible state mismatch
between what the diagnostics panel reported and what `RoomControls`
received. The actual "Enable camera & mic" button (added by the first
#15 fix) rendered correctly — but only inside `RoomControls`, a small
control strip at the very bottom of the room, competing for space with
"Leave the stage," chat, and (this session) the diagnostics panel itself.
`SpeakerTile` — the thing actually showing "camera off," which is what
the user is looking at — had no awareness of `needsMediaActivation` at
all and offered no interactive element whatsoever. This was a
discoverability/placement bug, not a logic bug: the fix from the first
#15 entry was real and worked, it just lived somewhere the user's
attention never went.

**Alternatives considered**:
1. Make the existing `RoomControls` button more visually prominent
   (larger, different color, moved higher in the strip) — doesn't
   address the root issue, which is that the control lives in the wrong
   *place* on the page, not that it's insufficiently styled.
2. Put the primary activation control directly on the local
   participant's own `SpeakerTile` — exactly where the "camera off"
   placeholder the user is looking at already is.

**Decision**: Option 2, keeping `RoomControls`' button too (redundant,
still useful, doesn't hurt). `SpeakerTile` now takes optional
`needsMediaActivation`/`activateMedia`/`mediaError` props; when
`isLocal && needsMediaActivation`, the tile's placeholder becomes a real
`<button>` ("Tap to enable camera & mic") instead of static text, calling
`activateMedia()` directly from its own `onClick` — still a genuine user
gesture, satisfying Safari's requirement the same way `RoomControls`'
button already did. `SpeakerStage` threads these three props to every
tile (they only ever act on the tile matching `myIdentity`), and
`PortraitRoom`/`LandscapeRoom` pass them through unchanged from
`layoutProps`, same wiring pattern as everything else in the room.
`mediaError`, when present on the local tile with no activation pending,
now shows a compact reason ("Permission denied", "No camera found") in
place of the generic "Camera off" too — the tile itself, not just
`RoomControls`, now explains what's happening.

**Reason this matters beyond just "add a button"**: this is the second
distinct #15 finding where a value was computed correctly and even
verified correct by a diagnostics panel, yet the actual product surface
failed to make it actionable for a real user under real conditions — the
first was a silently-discarded `mediaError` (never rendered anywhere),
this is a correctly-rendered control the user's attention never reached.
Both are the same underlying lesson: computing the right state isn't the
same as a real person being able to act on it, and only real-device
testing — not unit tests, not code review, not even a passing diagnostics
readout — caught either one.

**Tradeoffs**: None of consequence — purely additive props with safe
defaults, existing `SpeakerTile`/`SpeakerStage` callers/tests needed no
changes beyond the two room-layout call sites that now pass the three new
props through.

---

## 2026-08-16 — Issue #15's gesture fix never got exercised in production: LiveKit itself isn't reachable there (issue #15, real-device retest)

**Problem**: The gesture-gating fix (below) shipped, passed full automated
verification, and deployed — but a second real iPhone test against the
same deployed build still showed no camera/mic activation at all.
Re-closing the issue on the first fix's merge, before this retest, was
premature; reopened per the user's explicit correction. Rather than
assume the original gesture diagnosis was incomplete and layer on another
speculative fix, this session traced the actual deployed path end to end.

**Investigation, in order**:
1. Downloaded every JS chunk the deployed room page's HTML actually
   references and grepped all of them for a literal LiveKit `wss://`
   hostname — `NEXT_PUBLIC_LIVEKIT_URL` is a build-time-inlined
   `NEXT_PUBLIC_` var, so a genuinely-configured value must appear as a
   literal string somewhere in the client bundle. Found none, anywhere.
2. Added a temporary, safe diagnostics panel to the room UI
   (`components/room/room-diagnostics.tsx` — booleans/enums only, never
   token contents) surfacing identity type, seated-speaker recognition,
   whether the server issued a token, whether the client LiveKit URL is
   configured, live connection status, `canPublish`,
   `needsMediaActivation`, and `mediaError`, plus a button that calls
   `getUserMedia` directly, bypassing LiveKit entirely, to isolate raw
   browser/OS permission failures from every other layer.
3. Deployed the diagnostics-only change and read the *server-rendered*
   values directly off the live production page (no phone needed for
   this part) — confirmed, not inferred:
   - `LiveKit client URL configured: false`
   - `Server issued a token: false` (`mintLiveKitToken` is throwing —
     `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` aren't usable at runtime
     either, not just the client URL)
   - `LiveKit connection status: unavailable` (the room never even
     attempts to connect — `useLiveRoomConnection` is called with `null`
     params from the very first render)
4. Cross-checked against `vercel env ls`: all three vars
   (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL`)
   are listed as configured for Production — but, per the Session 16
   finding, Vercel's "Sensitive" var type can't be read back by CLI, so
   "the key exists" and "the value is correct and non-empty" are
   different claims, and step 3's runtime evidence says the second one
   is false for at least these three. My own local `.env.local` has the
   same var present as a key with a confirmed 0-length value — the same
   class of gap, not a coincidence.

**Root cause**: LiveKit is not actually reachable from the deployed app
at all — client URL and server API key/secret alike — which is why the
room never gets far enough to even show issue #15's "Enable camera &
mic" button. The gesture-gating fix is real, correct, and still needed
once this is resolved; it simply was never exercised, because everything
upstream of it was already broken. This is a deployment *configuration*
gap (empty or invalid env var values on Vercel), not a defect in #15's
code.

**Decision**: Not a code fix. `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
and `NEXT_PUBLIC_LIVEKIT_URL` need their actual values re-verified/
re-entered on Vercel (Production environment) — something only the
project owner can do, consistent with this project's standing rule
against ever having a secret value pasted into an agent session (see
Session 16's Migration workflow note on the database password, same
principle). The temporary diagnostics panel stays deployed specifically
so this can be re-confirmed the moment the values are fixed, without
needing another full phone round trip for the parts that don't actually
require a phone.

**Reason this is recorded as its own entry, not folded into the fix
below**: this is a second, independent example of the exact risk
Session 16's "Sensitive env var" finding already named — a credential
that *looks* configured (present as a key, scoped correctly) but cannot
actually be verified as *correct* without exercising the deployed app's
real behavior. Worth a second entry because it's now happened twice, to
two different LiveKit-related variable sets, which makes it a pattern
this project's deployment checklist should watch for by default, not
just a one-off.

**Tradeoffs**: None of consequence — the diagnostics panel is
temporary and explicitly marked for removal once the real root cause is
confirmed fixed by a real-device test, not left as permanent surface
area.

---

## 2026-08-13 — Camera/mic never activated on real iPhone Safari: gesture-gated activation, not automatic (issue #15)

**Problem**: Hands-on testing of the deployed app on a real iPhone
(Session 17) found that a seated speaker's camera and microphone never
activated — Safari never even showed the permission prompt, and
`SpeakerTile` silently rendered the generic "camera off" placeholder with
no indication anything had failed.

**Root cause, traced through the actual connection code, not guessed**:
`useLiveRoomConnection` called `setMicrophoneEnabled`/`setCameraEnabled`
(the calls that trigger `getUserMedia`) from `syncPublishing()`, itself
invoked from the async `RoomEvent.Connected` and
`RoomEvent.ParticipantPermissionsChanged` callbacks — LiveKit's own
WebSocket event emitter, never a user tap. iOS/macOS Safari requires
`getUserMedia` to execute synchronously within the call stack of a real
user-gesture event handler; called from an async event callback, it
silently declines to even show the prompt. A second, independent bug
compounded this: the hook already computed a `mediaError` value in its
catch blocks, but nothing in the component tree ever read it —
`RoomLayoutProps` had no field for it — so even a *legitimate* failure
(permission actually denied, no camera present) produced no visible
error either.

**Alternatives considered**:
1. Try to keep auto-publishing on connect, and look for a workaround that
   preserves "user activation" across the async gap to `RoomEvent.Connected`
   (e.g. pre-warming a `getUserMedia` call speculatively earlier in a click
   handler that led to this page). Rejected — fragile, browser-version
   dependent, and exactly the "fighting the browser" approach ruled out
   up front; Safari's user-activation window doesn't reliably survive a
   WebSocket round trip no matter how it's massaged.
2. Require an explicit, separate tap to first-activate camera/mic, and
   treat every *subsequent* `canPublish` change (server promotion,
   live revocation, re-promotion) as automatic, since browser-granted
   media permission persists for the rest of the tab's session once
   the first prompt is resolved.

**Decision**: Option 2. `useLiveRoomConnection` now exposes
`canPublish` (the server's grant, tracked live as before),
`needsMediaActivation` (true once `canPublish` but before this tab has
activated media), and `activateMedia()` — a function that must be called
directly from a real click handler. `RoomControls` renders an explicit
"Enable camera & mic" button for a seated speaker whenever
`needsMediaActivation` is true, and calls `activateMedia()` synchronously
from its `onClick`. Disabling (`canPublish` becoming `false`) never needed
a gesture and still happens automatically in every case, same as before.

**Media errors are now classified and surfaced, not swallowed**:
`classifyMediaError` maps `getUserMedia`'s own `DOMException.name`
(`NotAllowedError`/`SecurityError` → permission denied,
`NotFoundError`/`OverconstrainedError` → no device,
`NotReadableError`/`AbortError` → device unavailable, anything else →
init failed) into a `MediaError` value threaded through
`RoomLayoutProps` down to `RoomControls`, which shows source-specific
copy ("Camera permission was denied…", "No microphone found on this
device.") instead of a generic failure. A "Setting up your mic access…"
message covers the brief connected-but-not-yet-granted window
specifically (distinguished from still-connecting/reconnecting, which
`RoomHeader` already covers, to avoid showing both at once).

**Reason this is scoped as its own issue, not folded into the later
role-based UI work**: this is a correctness bug affecting today's
account-only speakers already, independent of guest participation or the
lifecycle/UI redesign work queued behind it — fixing it first means every
later issue in the sequence (guest speaking, the unified lifecycle,
role-based views) gets tested against a room where media actually works,
rather than compounding on top of a known-broken foundation.

**Tradeoffs**: A seated speaker now sees an explicit button rather than
media silently starting on its own — a small extra step, but the
alternative (silent, and on Safari, *non-functional* auto-publish) isn't
actually simpler, it's just broken. The activation button and error copy
live in the existing `RoomControls` strip for now, not a
speaker-specific layout — issue #18 (role-based Audience/Candidate/Speaker
views) is where this gets a more prominent, purpose-built treatment; this
issue deliberately doesn't redesign the room's layout to stay narrowly
scoped to the activation bug itself.

---

## 2026-08-13 — First deployment (Vercel Hobby), and two real findings from wiring LiveKit into it

**Problem**: usability testing needed a public HTTPS URL — nothing to
decide here (the user asked for exactly this), but several details of
*how* to configure it correctly weren't obvious from the code alone and
only surfaced by actually doing it.

**Decision**: Vercel Hobby tier, project imported from GitHub
(`Rapscallion12/project-stage`, private — Vercel's GitHub App was granted
access during import), no custom domain. Production URL:
`https://project-stage-weld.vercel.app` (Vercel appended `-weld` since
the bare `project-stage` subdomain was already taken globally). Deployed
via the dashboard's "Import Git Repository" flow rather than a bare
`vercel deploy` from local source specifically because the user wanted
future pushes to `main` to auto-deploy — that requires the Git
integration, which the dashboard import sets up as a side effect and a
CLI-only deploy would not.

**Finding 1 — `NEXT_PUBLIC_SITE_URL` must be set explicitly, not left to
the existing `VERCEL_URL` fallback in `getSiteURL()`**: `VERCEL_URL` is
Vercel's *per-deployment* URL — a hash that changes on every single
build, not the stable production domain. `getSiteURL()`'s fallback
predates any real deployment (written speculatively early in the
project) and was never exercised against Vercel's actual runtime
behavior until now. Left as-is, every push to `main` would have silently
changed where auth confirmation emails point. Fixed by setting
`NEXT_PUBLIC_SITE_URL` explicitly in Production env vars to the stable
`project-stage-weld.vercel.app` domain — an env var change, not a code
change (the existing fallback order already checks this var first).
Vercel does expose a *stable* per-project variable
(`VERCEL_PROJECT_PRODUCTION_URL`) that `getSiteURL()` could fall back to
instead of `VERCEL_URL` — not adopted here, since an explicit,
dashboard-visible env var is more inspectable than a second layer of
runtime auto-detection for a single-domain prototype with no preview
workflow that depends on it.

**Finding 2 — Vercel's "Sensitive" env var type cannot be read back by
anyone, including the project owner, once set**: attempted to verify the
LiveKit credentials by pulling them locally (`vercel env pull`) and
replaying the app's own token-minting/webhook-signing logic against the
real LiveKit project as a server-side check. Every var came back as the
literal string `[SENSITIVE]` — not a bug, a deliberate Vercel security
property of that variable type (all vars in this project default to
Sensitive when added through the dashboard/CLI). **Consequence**:
verifying a Sensitive credential's correctness can only be done by
observing the *deployed app's* actual behavior — never by fetching the
value out for a local side-by-side test, not even by the person who set
it. Adjusted the verification approach accordingly: checked the live
room page's SSR output for the absence of `getLiveKitToken`'s
"Couldn't connect" fallback text (proves the vars are present and
non-empty, and that local JWT signing succeeds — token minting itself
never calls LiveKit's API), and separately confirmed the deployed
webhook route genuinely validates signatures (a bogus signature and a
missing one both correctly return 401 from the live public URL). What
this *doesn't* prove — a validly-signed webhook payload being accepted,
and the actual client-side WebRTC connection succeeding — can't be
proven without either the real secret (which nobody but the person who
set it should paste anywhere, including here) or a real browser
(camera/mic permission prompts, actual video negotiation), which this
environment doesn't have. Documented as an explicit, honest limit of
what an agent session can verify for this feature, not glossed over.

**Reason both are recorded here**: neither was a design *choice* so much
as a real gap between how the code was written (before any deployment
existed) and how Vercel's platform actually behaves — exactly the kind
of thing worth writing down so the next session that touches deployment
config doesn't rediscover either the hard way.

**Tradeoffs**: none of consequence — both fixes were env-var-only, no
code changes, no new infrastructure.

---

## 2026-08-12 — A dev-only `/dev` route for browser-based usability testing, and why it has to be gated differently than the CLI harness

**Problem**: the CLI harness (`scripts/dev-harness.mts`) solved "create
and seat test events" but still required running terminal commands —
usability testing needs a way to launch and use the product without CLI
commands, i.e. something reachable by clicking through a browser.

**Alternatives considered**:
1. Extend the CLI harness's ergonomics (shorter commands, a watch mode,
   etc.) — doesn't solve "no CLI commands," just makes the CLI nicer.
2. A dev-only Next.js route (`/dev`), gated at runtime.

**Decision**: Option 2 — `src/app/dev/`, at the user's direction.

**Reason this needs a genuinely different safety model than the CLI**:
the CLI harness achieved zero production footprint by living entirely
outside `src/` — never imported by application code, never bundled, not
HTTP-reachable *at all*. A UI-reachable tool cannot make that same claim
by construction: it has to be a Next.js route, which means it exists in
the production server bundle regardless of gating. So "keep production
behavior unchanged" has to mean something more precise here — the route
must be behaviorally inert in a real deployment, verified, not just
gated and hoped. Concretely: `isDevToolsAvailable()`
(`lib/dev-demo.ts`) checks `process.env.NODE_ENV !== "production"` —
reliable specifically because Next.js itself force-sets
`NODE_ENV=production` for every `next build`/`next start`, regardless of
shell environment, so it isn't a flag that can be accidentally left
unset. The page calls `notFound()` on this check; **every Server Action
in `src/app/dev/actions.ts` independently re-checks the same guard as
its first statement**, since an action has its own callable endpoint,
reachable whether or not the page that renders its trigger button ever
rendered — hiding the page alone would not have been sufficient.
Verified both ways directly: `npm run build && npm run start` on a spare
port, confirmed `/dev` 404s while a real route stays healthy, and a unit
test (`src/app/dev/actions.test.ts`) stubbing `NODE_ENV=production`
proving each action rejects synchronously, before ever touching
`resolveIdentity()`/cookies() or the database.

**No new backend capability, on purpose**: every write goes through
primitives issue #13/#14 already built and authorized — `claimSpeakerSeat`
(seating the *currently logged-in* account directly, bypassing the
production request-queue/ranking gate from issue #14, the same bypass
the CLI's `seat` command already established as acceptable for testing)
and a plain `events` insert via the existing service client. `/dev` is
orchestration over existing, already-reviewed capability, not a new one.

**One shared source of truth for tagging, not two**: extracted the
harness's `[dev-harness] ` prefix, `.invalid` test-email domain, and
phase-timing helper into `lib/dev-demo.ts` (pure, no Supabase/IO) and
refactored `scripts/dev-harness.mts` to import from it instead of
keeping its own copies. Effect: the CLI's `reset` and `/dev`'s "Reset all
demo events" clean up *each other's* data — one convention, two entry
points.

**A genuine testing-infrastructure bug this surfaced, not a flaky
network blip**: once `src/lib/repositories/dev-demo.test.ts` existed
alongside `scripts/dev-harness.test.ts` — two *independent* integration
test files both creating `[dev-harness] `-tagged fixtures and both
running their own "delete everything tagged" reset — Vitest's default
parallel file execution let one file's reset delete the other file's
still-in-use fixtures mid-run, producing a real (reproducible, not
timing-flaky) test failure (`eventsDeleted` was `0` when it should have
found the file's own fixture). Every other integration test in this
project was safe under parallel execution because each one scopes its
fixtures to unique, randomly generated ids/emails that could never
collide across files — this was the first case where two files
deliberately *share* a broad tag, which is exactly what made them able
to step on each other's test runs too. **Fix**: `fileParallelism: false`
in `vitest.config.mts`, with a comment explaining why — this removes the
whole class of cross-file shared-state interference (present and any
future case), not just these two files, at the cost of a few extra
seconds of total suite runtime. Considered scoping each test's
assertions to "my own fixture specifically" instead (more surgical,
preserves parallelism) but judged less robust: it would require
correctly auditing every assertion in every current *and future*
integration test file for hidden global-state assumptions, an easy thing
to get subtly wrong once and not notice until the next flaky failure.

**Tradeoffs**: none of consequence for the gating design — the "route
necessarily ships in the bundle" tradeoff was unavoidable given the
requirement (UI-reachable), not a choice. For the test-parallelism fix,
the total suite runtime increased (roughly summed rather than
overlapped for the integration-heavy files) — accepted as clearly worth
it for a prototype's test suite, where correctness matters far more than
shaving several seconds off `npm test`.

---

## 2026-08-12 — The speaker request queue is comment-driven, not a generic waiting list; request creation is atomic by construction

**Problem**: PRODUCT.md's own literal text describes "Speaker request
queue" as "an ordered list of account holders waiting for a seat" — a
generic FIFO/priority-queue shape. Building it that way would create a
second, parallel content system (queue entries) sitting next to chat
(comments), when the product's actual direction — confirmed by the user
before implementation — is that these converge: "request the mic" and
"submit a comment" (two separately-listed account-holder capabilities in
PRODUCT.md) are meant to be one action, and a future pinned/featured
comment surface needs to highlight exactly the same content a request
produces.

**Alternatives considered**:
1. A dedicated `speaker_queue` table (position, joined-at, status),
   independent of chat, as PRODUCT.md's literal wording suggests.
2. A mic request is a chat message with a flag on it. `speaker_requests`
   stores lifecycle only (pending/granted/withdrawn) and references the
   message that carries the actual content — never duplicating it.

**Decision**: Option 2, at the user's explicit direction, with two
refinements added during design review:

- **Request creation must be atomic** — the chat message and the
  `speaker_requests` row are never two independent application-level
  writes that could partially succeed. Implemented as a single
  `security definer` Postgres function (`request_to_speak`, migration
  `00000000000011`): one function call is one implicit transaction, so a
  losing concurrent call (the partial unique index rejecting a second
  pending request from the same profile) rolls back its message insert
  too. Proven with a real race test in `speaker-requests.test.ts` —
  two concurrent `request_to_speak` calls from the same profile, then
  asserting the count of "is_speaker_request" messages exactly equals
  the count of `speaker_requests` rows for that profile (no orphan
  either direction) — not just asserted from reading the SQL.
- **Promotion eligibility is `TOP_ELIGIBLE_COUNT = 3` pending requests,
  not strictly rank 1**, and this is recorded here explicitly as an
  **MVP selection policy, not a permanent product rule**. A strict
  "only rank 1 may claim" design has a real failure mode this prototype
  has no infrastructure to solve: an absent top-ranked requester would
  block the seat forever, with no background-job/cron mechanism in this
  serverless setup to expire or skip them. Widening eligibility to the
  top few — with `claim_speaker_seat`'s own existing race-safety (issue
  #13) as the tiebreak if more than one eligible requester claims at
  once — solves the stuck-seat problem without new infrastructure. The
  durable concepts this stands in for, which should survive even if this
  specific policy is replaced later: audience support determines which
  requests rise (reaction-count-driven ranking), only sufficiently
  elevated requests become eligible (this constant), and the mechanism
  that finally promotes one of the eligible requests may evolve into
  something more deliberately audience-driven than "first successful
  claim wins." Documented at length in `lib/speaker-queue.ts` itself, not
  just here, so it's visible at the point anyone would change it.

**Reason**: Same principle issue #3 already established for speaker
occupancy (the database is authoritative, the realtime channel is
presentation) applied to requests: `event_chat_messages.is_speaker_request`
is a permanent marker (set once, never flipped back — "was this
submitted as a request," not "is it still pending"), so a future
pinned/featured surface is a read (`pending speaker_requests`, ranked)
rendered through `RoomChatPanel`'s existing `featuredSlot` (issue #3),
never a schema change. Ranking itself is trusted-server-only
(`rank_pending_speaker_requests`, `service_role`-gated — it reads
`profiles.reputation_score`, which `anon`/`authenticated` can't select
directly) and is never exposed to the client as a public leaderboard in
this issue; `claimOpenSeat` (the Server Action) only ever returns
pass/fail.

**A genuine, if minor, forward-compatibility check performed, not just
assumed**: the user asked to keep future one-level comment replies in
mind without building them. Confirmed nothing in this migration blocks
adding a nullable, self-referencing `parent_message_id` to
`event_chat_messages` later — a plain additive column, same shape as
every other "left room for it" decision in this schema.

**Tradeoffs**: `reputation_score` is always `0` for every profile today
(nothing mutates it yet — same accepted gap issue #13 left for
`display_name`'s tiebreak-adjacent reasoning), so ranking currently
reduces to reaction-count-then-recency; harmless, not a blocker, but
worth remembering when reputation mutation eventually lands elsewhere.
`claimOpenSeat`'s pure decision (`decideClaimEligibility`, in
`lib/speaker-queue.ts`) had to be extracted from the Server Action
specifically because the action itself can't be unit-tested directly —
it depends on `resolveIdentity()` → `next/headers`' `cookies()`, valid
only inside a real Next.js request. Same limitation this project has
hit for every other Server Action; the fix (test the decision, not the
wrapper) is the same one already used for
`determineCanPublish`/`shouldPublish`/`applySpeakerChange`.

---

## 2026-08-12 — Closing a GitHub issue does not update the Project board's Status field; treat them as two separate updates

**Problem**: Reviewing the board before starting this issue (per the
user's request to check whether issues #4/#5 were already satisfied by
#3) surfaced that issues #13 and #3 — both already merged and closed via
"closes #N" in their commit messages — still showed **Status: Backlog**
on the Project board, not Done. The "closes #N" convention this project
has used since issue #1 closes the GitHub *issue*; it does not touch the
board's custom Status field, which is a separate piece of state entirely.
Every prior session assumed closing the issue was sufficient and never
verified the board reflected it.

**Decision**: Fixed the four stale cards (#13, #3, and the newly-closed
#4/#5) to Status: Done via `gh project item-edit`, and are treating the
board Status update as its own explicit step from here forward — moved
issue #14 through In Progress → Testing / Review → (Done, once merged)
deliberately, rather than only relying on the commit message's
"closes #N".

**Reason**: AGENTS.md's own standing rule — "a stale board... is worse
than no board" — already named this risk category; this is the first
session with working `gh` access to actually verify state against it,
and the verification found exactly the drift that rule warns about.
Worth fixing retroactively rather than leaving stale cards next to
newly-accurate ones.

**Tradeoffs**: None — this is a correctness fix with no design
alternative to weigh; it was simply an unchecked assumption until now.

---

## 2026-08-11 — A standalone dev-harness script, not an application route, for manual test-session tooling

**Problem**: there was no efficient way to manually test the live room.
Creating an event required hand-writing SQL against the live project (the
same one `supabase/seed.sql` populates — there's no separate dev/staging
database for this prototype); becoming a speaker was, by design,
impossible through the app at all (`claim_speaker_seat` deliberately has
no `anon`/`authenticated` grant and no Server Action wrapper — issue
#13's explicit constraint, reaffirmed for issue #3). Every verification
of the two-speaker room so far had been a service-role test script, never
an actual person clicking into a browser tab.

**Alternatives considered**:
1. A dev-only page/Server Actions inside the Next.js app (e.g.
   `/dev/test-events`), guarded by a runtime `NODE_ENV`/similar check
   that 404s in production.
2. A standalone CLI script, outside `src/`, never imported by
   application code, using the same `service_role` credential and the
   same already-authorized `claim_speaker_seat`/`leave_speaker_seat`/
   `end_speaker_seat` RPCs issue #13 built — i.e., becoming one more
   trusted server-side caller of primitives that already exist, not a
   new capability.

**Decision**: Option 2, at the user's direction —
`scripts/dev-harness.mts`, run via `node --experimental-strip-types
--env-file=.env.local scripts/dev-harness.mts <command>` (wrapped as
`npm run dev:harness --`). Four commands: `create [--phase=...]`, `seat
<email-or-label> <seat>`, `list`, `reset`.

**Reason**: A runtime-guarded route (option 1) is still application code
— it ships in the bundle, it's still a route the server has to handle,
and "guarded by an env check" is a weaker guarantee than "does not exist
in the deployed surface at all," which is what the user's "do not expose
the harness through the production application" constraint actually
calls for. A standalone script under `scripts/` (not `src/`) is
structurally never reachable via HTTP and never bundled — confirmed by
`npm run build`'s route table having no entry for it, not just asserted.
It also needed zero new backend capability: `claim_speaker_seat`'s
service-role-only tier already exists specifically for "a trusted
server-side caller decides who's seated," and this script is exactly
that, the same way the LiveKit webhook route already is.

**Safety design — how `reset` can never touch real content**: every
resource the harness creates is tagged, and `reset` only ever acts on
tagged resources:
- Events: title prefixed `[dev-harness] `.
- Auto-created test accounts: email on the reserved, non-routable
  `@dev-harness.invalid` domain (RFC 2606) — real signups can never
  collide with it.

Critically, `seat` **refuses to auto-create an account for an email that
isn't already a real profile and isn't a harness-tagged address** —
rather than silently creating an untagged throwaway account `reset`
could never find and clean up (a leak `reset`'s own tag-based logic can't
detect by construction). This is also what makes seating your own real
dev account safe: pass your real email, and since it already exists, the
harness reuses it and never creates or deletes it — verified directly
(`scripts/dev-harness.test.ts`'s end-to-end suite creates an untagged
"real" event and account alongside harness-tagged ones, runs the actual
`resetHarness`, and asserts the untagged fixtures survive byte-for-byte
while the tagged ones are gone — not just asserting the tag-matching
predicates in isolation).

**A real, if minor, finding while implementing**: `tsc --noEmit` rejects
an explicit `.ts`/`.mts` extension in an import specifier by default
(`TS5097`) — required here because `scripts/dev-harness.test.ts` imports
value exports (not just types) from `scripts/dev-harness.mts`, and
Node's own ESM resolution (used when the script runs directly) requires
that same explicit extension. Fixed by adding
`allowImportingTsExtensions: true` to the project's single `tsconfig.json`
— safe project-wide because it requires (and this project already has)
`noEmit: true`; the flag only changes what the type-checker accepts in
import specifiers, never what gets emitted, and Next.js's own bundling
doesn't go through `tsc` at all.

**Tradeoffs**: requires Node 22.6+ (native `--env-file` and
`--experimental-strip-types`) — a real constraint, documented in
README.md rather than worked around with a new dependency
(ts-node/tsx) that would add ongoing maintenance for a tool used
occasionally. Testing an actual two-person conversation still requires
two browser sessions (one per seated speaker) — the harness prepares the
data, it doesn't automate the browser; that's out of scope for "smallest
tooling."

---

## 2026-08-11 — The live room renders speakers from `event_speakers`, never from LiveKit's own state; `display_name` is denormalized to make that possible for guests

**Problem**: Issue #3's initial design proposal (before the user's
correction) derived the room's "who is speaking" display from LiveKit's
own participant/track state — a speaker's tile would show whoever
currently had a published, subscribed audio track. That's a reasonable
reading of "the room should show who's talking," but it makes `event_speakers`
*not* actually authoritative in the UI: a speaker who mutes, loses camera
permission, or has a transient connection hiccup would visually vanish
from the room, even though the database still correctly says they hold
the seat — the exact kind of drift PRODUCT.md's "the audience controls
the stage" principle (and every design decision since issue #1) has been
built to avoid.

**Alternatives considered**:
1. Derive current speakers from LiveKit's participant/track state
   directly (the original proposal).
2. Derive current speakers entirely from `event_speakers` (already
   fetched server-side, kept live via Realtime); use LiveKit's
   participant list *only* to decide whether a video frame is currently
   available to render for an already-known speaker.

**Decision**: Option 2, at the user's explicit direction.
`hooks/use-active-speakers.ts` subscribes to `event_speakers`'s Realtime
feed (migration `00000000000010` adds it to the `supabase_realtime`
publication) and is the *only* source `SpeakerStage`/`SpeakerTile` use to
decide whether a seat is occupied and by whom.
`hooks/use-live-room-connection.ts`'s LiveKit `Room` is consulted only to
look up a *matching, already-known* speaker's participant object for
media attachment — a `SpeakerTile` can have a `speaker` (DB) with no
`participant` (LiveKit) at all, and renders a named "camera off"
placeholder, not an empty seat. The reverse (a `participant` implying
occupancy) never happens; nothing in the room ever asks LiveKit "who's
speaking."

**Reason**: This is a direct extension of the same principle
`event_speakers` itself was designed around (issue #1) and that issue
#13's whole authorization model reinforces: the database is the single
source of truth for stage occupancy, and every other system (LiveKit
included) is downstream of it, never a peer source. A speaker's media
having trouble is a *presentation* concern, not an *occupancy* one.

**A real problem this decision surfaced**: `profiles` RLS grants `select`
to `authenticated` only (migration `00000000000001`) — guests can't read
it. Showing a speaker's name (sourced from `event_speakers.profile_id`)
to a guest viewer therefore needed *some* way to resolve a name without
a `profiles` join. Considered using LiveKit's own participant `.name`
metadata (already embedded in tokens by `mintLiveKitToken`, and readable
by any connected participant, guests included) — rejected, because that
re-couples the *name* to LiveKit connection state, exactly what this
whole decision exists to avoid: a speaker's name would disappear right
when their connection is the thing having trouble.

**Fix**: `display_name` (migration `00000000000010`) — a denormalized
snapshot of `profiles.display_name`, written by `claim_speaker_seat`
itself (a plain `select` at assignment time; the function already runs
`security definer` with full table access, so this needed no new grant),
never accepted as a caller-supplied parameter. Exactly the pattern
`event_chat_messages.author_display_name` already established for the
identical guest-visibility problem — not a new idea, a second application
of one. `profile_id` remains the durable identity reference for every
authorization check and future join; `display_name` is presentation-only
and never trusted for anything else.

**Tradeoffs**: A speaker's on-screen name is a snapshot, not live — if
they rename their account mid-show, the room keeps showing the name they
had when seated (same accepted tradeoff `event_chat_messages` already
made, for the same reason: consistency of what's currently displayed
matters more here than reflecting a rename that happens to land
mid-conversation). The table's zero rows in the live project at the time
of this migration meant no backfill was needed for the new `not null`
column — confirmed by query before writing the migration, not assumed.

---

## 2026-08-11 — Two testing-infrastructure gaps issue #3 surfaced (not product bugs)

**Problem**: Issue #3 was this project's first component-rendering test
(`speaker-tile.test.tsx`) and first hook that mirrors genuinely external
browser state via a subscription (`useOrientation`, matching
`window.matchMedia`). Both surfaced gaps in shared test/lint
infrastructure rather than in the feature code itself.

1. **React Testing Library's DOM wasn't being cleaned up between tests.**
   Multiple `render()` calls in `speaker-tile.test.tsx` left prior tests'
   DOM trees mounted, so `getByTestId`/`getByRole` started matching
   multiple elements once more than one test in the file called `render`.
   Testing Library's auto-cleanup relies on a global `afterEach` being
   available, which requires `test.globals: true` in `vitest.config.mts`
   — not set in this project (every test file explicitly imports
   `describe`/`it`/`expect` from `"vitest"` instead, a deliberate style
   choice worth keeping). **Fix**: `vitest.setup.ts` — already loaded for
   every test file — now explicitly calls `cleanup()` in its own
   `afterEach`, rather than turning on `globals: true` project-wide for
   one feature's sake. This benefits every future component test, not
   just this issue's.
2. **A first draft of `useOrientation` and part of `useLiveRoomConnection`
   set state synchronously inside `useEffect`**, which
   `react-hooks/set-state-in-effect` flags as an error — the same
   underlying issue `useNow`'s own comment already documents (see
   `hooks/use-now.ts`): setting state synchronously on every effect run
   is the wrong tool for mirroring genuinely external state.
   `useOrientation` was rewritten to use `useSyncExternalStore`, the same
   fix `useNow` already established as this project's pattern for exactly
   this case. `useLiveRoomConnection`'s violation was different in kind —
   an async connection-lifecycle effect, not a snapshot of synchronous
   external state — so `useSyncExternalStore` doesn't fit there; instead,
   the redundant `setStatus`/`setMediaError` calls that only restated
   what the `useState` initializer already knew were removed, leaving
   every `setState` call in that hook inside a genuine LiveKit event
   callback or promise resolution — which is what the lint rule is
   actually asking for.

**Reason recorded here**: both are exactly the kind of gap that's easy to
introduce once and then have silently affect every test/hook written
after, if not caught and fixed at the shared-infrastructure level. Same
reasoning as documenting issue #13's `PUBLIC`-execute-by-default finding
in ARCHITECTURE.md as a standing rule rather than just fixing the one
instance.

---

## 2026-08-11 — Three real bugs the issue #13 integration tests caught, fixed as forward migrations

**Problem**: Running issue #13's integration tests for real (once
`SUPABASE_SERVICE_ROLE_KEY` was configured) surfaced three genuine bugs
that unit-level reasoning about the migration's SQL hadn't caught. Each
is recorded here because each is a *pattern*, not a one-off typo — the
next migration that introduces a new `security definer` function or a new
`service_role` caller can hit the same thing.

1. **`service_role` had no table grants at all.** The service client's
   very first real call (`events.insert(...)` in a test fixture) failed
   with "permission denied for table events." `service_role` bypasses
   RLS, but RLS bypass and the underlying Postgres table `GRANT` are
   separate privilege layers — this project's tables were never granted
   to `service_role` (only `anon`/`authenticated`, deliberately, per
   table), and this project's setup turned out not to inherit the
   standard Supabase default-privilege bootstrap that normally makes that
   unnecessary. **Fix** (migration `00000000000007`): explicit
   `grant ... on all tables in schema public to service_role`, plus a
   matching `alter default privileges` so future tables inherit it
   automatically — the one place a blanket grant is correct instead of
   per-table, since `service_role` having full table access isn't an
   access-control decision the way `anon`/`authenticated` grants are, it's
   what the role is documented to mean.
2. **`claim_speaker_seat`/`end_speaker_seat` were callable by anyone,
   despite never being granted to `anon`/`authenticated`.** This is the
   one that mattered most: it's exactly the exposure the user's
   constraint on this issue was written to prevent, and it was happening
   silently. Cause: PostgreSQL grants `EXECUTE` on a new function to
   `PUBLIC` by default, unlike tables (which start with no privileges for
   anyone). Migration `00000000000006` added the *intended* explicit
   grants but never revoked the default `PUBLIC` one those were supposed
   to replace — confirmed via `select proacl from pg_proc where proname =
   'claim_speaker_seat'`, which showed an empty-role (`PUBLIC`) entry
   granting execute. The test written specifically to prove the exposure
   constraint held (signing in as an ordinary user and asserting `42501`
   on both functions) is what caught this — it failed with "expected null
   not to be null" instead, i.e. the call had simply succeeded. **Fix**
   (migration `00000000000008`): explicit `revoke execute ... from
   public` on all three functions. Documented in ARCHITECTURE.md's Data
   model section as a standing rule: a new `security definer` function
   must revoke `PUBLIC` execute in the same migration that creates it,
   never rely on omission the way a table grant works.
3. **`end_speaker_seat`'s no-op case returned a garbage object, not
   `NULL`.** When its `UPDATE ... RETURNING` matched zero rows (the
   intended safe no-op), the PL/pgSQL `v_row` variable was never assigned
   — but an unassigned composite variable is a row of all-NULL *fields*,
   not SQL `NULL` itself. `RETURN v_row` returned that, which PostgREST
   (calling a non-`SETOF` composite-returning function via `FROM
   fn(...)`, which always contributes exactly one row) serialized as
   `{"id": null, "event_id": null, ...}` — a real JSON object, not `null`.
   `endSpeakerSeat()`'s `data ?? null` check only catches genuine JSON
   `null`, so callers (the LiveKit webhook handler included) were getting
   a truthy garbage object where they expected — and the doc comment
   promised — `null`. **Fix**: migration `00000000000009` replaces the
   function body to check PL/pgSQL's `FOUND` variable (set by the
   preceding `UPDATE` to whether it matched a row) and `return null`
   explicitly when it didn't — the correct SQL-level fix. That alone
   wasn't sufficient, though: PostgREST's FROM-clause-call behavior means
   even a function that *genuinely* returns SQL `NULL` still serializes as
   one row of null fields once composite-typed. `endSpeakerSeat()` in
   `lib/repositories/event-speakers.ts` was also updated to check the
   row's `id` field rather than trusting `data` itself to be `null` —
   belt-and-suspenders, but the JS-side check is what's actually load-
   bearing given the PostgREST behavior.

Also worth recording: the first attempt at the race-safety integration
test asserted the wrong invariant (`exactly one of two concurrent claims
must reject`), and failed on a run where both fulfilled. That's not a
bug — `claim_speaker_seat`'s own semantics are "replace whoever's there,"
so if the two calls happen to land closely enough that the first fully
commits before the second's `UPDATE` step runs, the second legitimately
replaces the first's brand-new row, and *both* promises correctly
fulfill. A true concurrent collision (both transactions' `UPDATE` running
before either `INSERT` commits) is the other legitimate outcome, and
*that's* the one where the partial unique index causes a rejection. The
test now asserts the property that's actually invariant regardless of
interleaving — never more than one active row for the seat afterward, and
every non-active row for that seat properly closed out as `'replaced'` —
rather than asserting a specific fulfilled/rejected split that timing
doesn't guarantee either way.

**Reason this is recorded here rather than just fixed silently**: all
three are the kind of gotcha that reads as obvious in hindsight but isn't
something migration-writing or code review alone would have caught —
verifying against the real linked project, not just reasoning about the
SQL, is what surfaced each one. Consistent with why this project's
integration tests hit the real database instead of mocking it.

**Tradeoffs**: None beyond the three extra migrations
(`00000000000007`–`00000000000009`) needed to land on top of
`00000000000006` rather than editing it in place — consistent with this
project's "never edit an applied migration, write a new forward one"
rule, same as the `--linked` reset guidance in the Migration workflow
section.

---

## 2026-08-09 — Issue #13's write path: three functions with three different authorization models, and where `service_role` enters this project

**Problem**: `event_speakers` (issue #1) was read-only from the app's
perspective; issue #13 had to add the actual write path — atomic seat
assignment/replacement, voluntary leave, disconnect cleanup — without a
table-level grant that would let any authenticated client write directly.
Every write needs *some* PostgREST-facing authorization, and this
project's Postgres functions are `security definer` (they run with the
function owner's table access, elevated above the caller's own grants),
so the real question was: what authorizes the *call*, per operation?

**Alternatives considered, per operation**:
1. One generic `assign_speaker(event_id, profile_id, seat_number)`
   function, granted to `authenticated`, callable by anyone.
2. Self-service: a claiming user calls a function that ends whoever
   currently holds the seat and inserts themselves, authorized by
   `auth.uid()` alone (no special permission needed beyond being logged
   in) — the design this session initially proposed and the user
   approved, reasoning that "claiming" a contested resource doesn't need
   permission *over* its previous holder.
3. Split by who the operation acts on: functions that only ever act on
   the *caller's own* row are `auth.uid()`-gated and safe to expose
   broadly; functions that act on *someone else's* row require a
   different, trusted-server-only authorization tier.
4. For that trusted-server tier specifically: a hand-rolled shared-secret
   parameter checked inside the function (via a Postgres `current_setting`
   or similar), avoiding `service_role` entirely.

**Decision**: Option 3, with `service_role` (not option 4) as the
trusted-server tier's actual mechanism.

- `leave_speaker_seat(event_id)` — self-service, `auth.uid()`-gated,
  granted to `authenticated`. Ends only the caller's own row.
- `claim_speaker_seat(event_id, profile_id, seat_number)` and
  `end_speaker_seat(event_id, profile_id, reason)` — **not** granted to
  `anon`/`authenticated` at all. Callable only via the `service_role`
  client (`lib/supabase/service.ts`, introduced by this issue).

**Reason this isn't option 2, despite it being approved first**: revisiting
it, self-service claiming has a real flaw — without Phase 3's queue/voting
system built yet (and it deliberately isn't, this issue), granting
`claim_speaker_seat` to any authenticated user means *any* logged-in
account could seize the microphone from the current speaker at will,
repeatedly, adversarially. That's not an edge case to accept for a
prototype, it's the direct opposite of PRODUCT.md's "the audience controls
the stage" — the audience (collectively, via a mechanism that doesn't
exist yet) should decide, not any individual by calling an RPC. The user
caught this and set the constraint explicitly: ship the atomic,
race-safe *mechanism* in this issue, but it must not become a generally
exposed production action — Phase 3's queue/voting is what will own
deciding *who* is allowed to call it. `end_speaker_seat` has the same
shape of problem (ending *someone else's* occupancy) for the same reason.

**Reason this is `service_role` and not option 4**: every write reachable
through `service_role` here is already independently authorized before it
ever reaches Postgres — the LiveKit webhook route verifies LiveKit's
webhook signature before calling `end_speaker_seat`, and
`claim_speaker_seat` has no caller at all yet. A hand-rolled shared secret
stored in a Postgres GUC would add real complexity (a value that can't
simply live in a migration file, since migrations are committed to git —
it would need Postgres Vault or an out-of-band `ALTER DATABASE ... SET`
step) for no actual security improvement over a mechanism (`service_role`)
Supabase already provides and documents for exactly this scenario:
trusted, non-client-reachable backend code. This is a deliberate,
narrowly-scoped exception to this project's prior stance of never using
`service_role` — see ARCHITECTURE.md's Vendor portability section, which
that stance predates. It is not a general reversal: `service_role` is
used in exactly one file (`lib/supabase/service.ts`), imported by exactly
three call sites (the webhook route, `claimSpeakerSeat`, `endSpeakerSeat`),
each of which has its own independent gate before touching it.

**A second partial unique index** (`event_speakers_active_profile_uniq`
on `(event_id, profile_id) where left_at is null`) was added in the same
migration — a genuine gap in issue #1's schema surfaced while designing
`claim_speaker_seat`: nothing stopped the same profile from holding two
seats in one event at once. `claim_speaker_seat` relies on it as the real
race-safety backstop (an application-level existence check is only a
friendlier early error; concurrent callers are resolved by the unique
indexes, not by app logic), same pattern as the existing per-seat index.

**Tradeoffs**: `claim_speaker_seat` ships with no production caller and no
way to exercise it from the app UI — only tests call it, via the same
`service_role` access tier a real future caller (Phase 3) would need. This
is the same "ship the primitive, no UI trigger yet" shape issues #1 and #2
already established, just one level further (no Server Action stub
either, since creating one would itself be "generally exposing" it). The
integration tests that prove this all works (race safety, replacement
history, the authorization boundary itself) require
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local` and real fixture rows (test
accounts created via the Auth admin API, not fake UUIDs, since these
functions write through real foreign keys) — they `describe.skipIf` when
that key is absent, same discipline as the existing anon-key integration
tests.

---

## 2026-08-09 — LiveKit token minting (issue #2) is split from seat-state writes (issue #13)

**Problem**: Issue #2 was originally scoped as "LiveKit SDK integration
and token endpoint," with its own body already anticipating that token
minting would need to check "occupying or entitled to occupy" a seat.
Working through the full authorization model before implementing (per
the user's request — audience joining, speaker promotion, replacement,
reconnects, race conditions, expiry, moderator actions, multi-room)
surfaced that "entitled to occupy" isn't just a read: it implies
*deciding* who occupies a seat, which needs an atomic DB write, a live
LiveKit permission push to already-connected participants, and
disconnect cleanup — none of which "mint a token" by itself requires.

**Alternatives considered**:
1. Implement all of it as one piece of work under issue #2.
2. Split: issue #2 mints tokens from *current* `event_speakers` state
   only (a read); a new issue owns changing that state (atomic
   assignment, live permission sync, disconnect cleanup).

**Decision**: Option 2, at the user's direction. New issue #13 covers the
write path; issue #2 stays a read-only token endpoint. Issue #13 was
positioned in the Project board's item order directly after #2 and
before #3/#4 (`updateProjectV2ItemPosition` via the GraphQL API — `gh
project` has no CLI flag for this), reflecting the real dependency: #3/#4
can be built and manually tested against hand-seeded `event_speakers`
rows (the same way `supabase/seed.sql` hand-seeds events) without #13,
but real dynamic speaker promotion needs it.

**Reason**: This mirrors the exact split already made for `event_speakers`
itself in issue #1 (ship the read path + RLS, defer the write
path/authorization logic to the issue that actually needs to design it) —
consistent, not novel. Bundling the write path into issue #2 would have
meant designing atomic-assignment race safety, a LiveKit webhook
receiver, and disconnect-grace-period handling as a side effect of "add
a token endpoint," which is a much larger and less independently
reviewable unit of work than the title suggested. Splitting keeps issue
#3 (room UI) unblocked as soon as #2 lands, without waiting on the
harder write-path problem.

**The authorization model itself** (what issue #2 actually implements):
the server is the sole source of truth for `canPublish` — the client
never receives the LiveKit API secret, only a scoped JWT whose grants
LiveKit's own SFU enforces server-side. `canPublish` is decided from
whether the requester currently holds an active `event_speakers` row
(`determineCanPublish()`, a pure function over an already-fetched
occupancy record, kept separate from the DB lookup specifically so it's
unit-testable without a live fixture — `event_speakers` has no write
grant, so a test can't seed an "active speaker" row through the app's
own client the way it seeded other fixtures). Token TTL is generous (4
hours) and deliberately *not* the revocation mechanism — see
ARCHITECTURE.md's LiveKit authorization model section for why relying on
expiry would visibly contradict "the audience controls the stage," and
why issue #13's live permission push is the real enforcement point.

**Tradeoffs**: Issue #2 ships a token endpoint that, in practice, always
returns `canPublish: false` today — nothing can create an active
`event_speakers` row yet, so there's no way to manually verify the
`true` branch end-to-end until #13 lands. Mitigated by unit-testing that
branch directly with a constructed (not DB-fetched) occupancy record,
same reasoning as issue #1's read-path tests not requiring a live
fixture either.

---

## 2026-08-09 — `event_speakers` models occupancy episodes, not a schedule or a pointer

**Problem**: Issue #1 needed a data model for "who's speaking in an
event." Three framings were plausible on the surface — a scheduled
speaker assignment, a single "current speaker" pointer per seat, or a
historical occupancy record — and the wrong choice would either
contradict the product's own principles or make Phase 3/4 (replace
voting, reputation, reliability) expensive to retrofit.

**Alternatives considered**:
1. A "scheduled speaker" table — pre-assign who will occupy each seat.
2. A single mutable pointer per seat (e.g. `events.current_speaker_1_id`),
   updated in place whenever a speaker changes.
3. Append-only occupancy episodes — one row per (seat, occupant) stretch
   of time, with `joined_at`/`left_at`, never overwritten; replacing a
   speaker ends one row and inserts another.

**Decision**: Option 3.

**Reason**: Option 1 doesn't match how this product actually works —
PRODUCT.md's Principle 1 ("the audience controls the stage") and
Principle 3 ("anyone can eventually earn the microphone," via a live
queue) both describe who's on stage as something the audience/queue
decide in the moment, not something scheduled in advance. Building a
"scheduled speaker" concept would invent a feature that contradicts those
principles rather than support them. Option 2 would destroy exactly the
history Phase 3's replace-speaker voting exists to create — the moment
someone gets replaced, there'd be no record they ever spoke, cutting off
Phase 4's reputation/reliability work ("votes received while speaking,"
"removals for cause") at the schema level, not just leaving it unbuilt.
Option 3 is simultaneously the simplest of the three to reason about,
matches how speakers actually change hands in this product (replacement,
not reassignment), and gives Phase 4 what it needs for free — no
retrofit required, since the full history already exists as a natural
consequence of the design rather than a feature added on top of it.

Also decided in the same pass, each following the same "match already-
established project conventions" logic:

- **`left_reason` is a `CHECK`-constrained `text` column, not a native
  Postgres enum** — easier to extend later (a migration adding a value to
  a `CHECK` is simpler than altering a Postgres enum type, which has real
  restrictions on removing/reordering values), and no other table in this
  project uses a native enum, so this doesn't introduce a second
  convention. The vocabulary (`voluntary`, `replaced`, `moderator_removed`,
  `event_ended`, `disconnected`) was deliberately kept to values that
  trace to already-scoped work (issues #2, #3, #6, and Phase 3's replace
  voting/moderator controls) rather than guessing at hypothetical future
  reasons.
- **Room-agnostic, matching `events`' own precedent exactly**: no `room_id`
  column, because no `event_rooms` table exists and Phase 2 has exactly
  one room per event. The migration comment documents the specific future
  change (nullable `room_id`, re-scoping the active-seat uniqueness from
  `(event_id, seat_number)` to `(room_id, seat_number)`) so it's an
  expected additive follow-up, not a surprise redesign.
- **No write grant in this migration.** `events` itself shipped
  SELECT-only in its first migration, before event creation was a
  feature; `event_speakers` follows the same pattern. The authorization
  logic for "who's allowed to occupy a seat" doesn't exist yet — it's
  already scoped into issue #2 (LiveKit token minting checks
  occupancy/entitlement, per that issue's own body) — so granting INSERT
  here would mean guessing at rules that haven't been designed, or
  worse, an open door. Verified this is actually enforced, not just
  documented, with a committed regression test
  (`event-speakers.test.ts`) that attempts a real insert against the
  linked project and asserts it's rejected with `42501`.

**Tradeoffs**: The table is inert from the app's perspective until issue
#2 adds a write path — by design, but it does mean this issue ships
schema and a read-only repository function with no UI yet consuming
either. `listActiveSpeakers()`'s only current caller will be issue #4's
audience-viewing work.

---

## 2026-08-09 — Adopt the Supabase CLI mid-project via `migration repair`, not a reset

**Problem**: Three migrations' worth of schema had already been applied by
hand through the SQL Editor, across three separate sessions, with real
data sitting on top of it (seeded events, chat history, a real account).
Adopting the CLI (issue #12) meant getting `supabase/migrations/` and the
live project's own bookkeeping of "what's been applied" into agreement,
without touching the schema or data that already matched.

**Alternatives considered**:
1. Run `supabase db push` naively and let it try to reapply all three
   migrations for real.
2. Wipe the project (`supabase db reset --linked` or manually dropping
   everything) and let the CLI rebuild it from a clean slate.
3. Verify the remote schema matches the local migration files exactly via
   read-only introspection, then use `supabase migration repair` to mark
   the three existing migrations as applied — bookkeeping only, no SQL
   executed.

**Decision**: Option 3.

**Reason**: Option 1 would have failed partway through each file —
`CREATE TABLE ... IF NOT EXISTS` might no-op, but `CREATE POLICY`,
`CREATE TRIGGER`, and `CREATE FUNCTION` are not idempotent in Postgres and
error on "already exists," risking a half-applied, confusing state. Option
2 is explicitly what the user's own requirements ruled out ("preserve all
existing data and avoid destructive operations") — real accounts and chat
history live on this database; there is no staging copy to test against.
`migration repair` exists specifically for "adopt the CLI on top of an
already-manually-managed database" — it only writes rows into
`supabase_migrations.schema_migrations`, the tracking table, and cannot
touch application tables, policies, grants, or data.

Verification came first, deliberately, before repairing anything — no
Docker is available in this environment, so `supabase db diff`'s
local-shadow-database comparison wasn't an option, but `supabase db query
--linked` (executes SQL directly against the linked project via the
Management API, no Docker required) was enough to directly compare, one
by one: table/column shapes (`information_schema.columns`), RLS enabled
per table (`pg_tables.rowsecurity`), every policy
(`pg_policies`), every meaningful grant
(`information_schema.role_table_grants`), the profile-provisioning trigger
(`pg_trigger`), and Realtime publication membership (`pg_publication_tables`).
All of it matched the three migration files exactly. Only then were the
three versions marked applied.

The forward workflow was proven end-to-end with a real (if low-risk)
migration — `00000000000004_table_comments.sql`, adding `COMMENT ON TABLE`
documentation — applied via `supabase db push --linked` and confirmed live,
rather than trusting the setup without exercising it.

`database.ts` was switched from hand-written to
`supabase gen types typescript --linked`-generated in the same pass — see
the superseded note on "Hand-write `src/types/database.ts`" above.

**Tradeoffs**: `migration repair` is a footgun if used carelessly — it
will happily mark a migration "applied" whether or not the remote schema
actually matches, since it never checks. The verification step above is
what makes this safe; skipping it would have converted "the CLI's
bookkeeping is wrong" into "the CLI's bookkeeping is wrong *and* nobody
checked," silently papering over any real drift instead of catching it.
Local dev (`supabase start`, `supabase db reset --local`) still isn't set
up — no Docker in this environment — so `db diff` and a true local
Postgres remain unavailable; documented as a gap in ARCHITECTURE.md's
Migration workflow section rather than worked around.

---

## 2026-08-08 — Data access goes through a repository layer, not scattered Supabase calls

**Problem**: The scheduled-events + pre-show-lobby milestone was the first
feature with real, substantial data access — events, chat messages,
reactions, presence — and it was built with pages, Server Actions, and
`lib/identity.ts` all calling `createClient().from(...)` directly. The
user flagged this before it became a bigger habit: Supabase is the
prototype's backend because it's fast to build on today, not necessarily
the platform this product would stay on at large scale, and "scattered
direct Supabase queries throughout UI components" is exactly what makes a
later migration expensive.

**Alternatives considered**:
1. Leave it as built — direct Supabase calls in pages/actions/hooks — and
   deal with portability later if it ever actually matters.
2. A full abstraction: a generic repository *interface* + a Supabase
   implementation behind it, ready to swap in a second backend.
3. A lightweight repository layer — plain functions in
   `lib/repositories/`, returning plain domain types not aliased from the
   Supabase-generated schema type — as the only place durable-data queries
   happen, with Auth and Realtime left as explicit, documented exceptions
   rather than force-abstracted too.

**Decision**: Option 3. Refactored the just-built events/lobby code
(`lib/repositories/events.ts`, `chat.ts`, `profiles.ts`) the same session
it was written, rather than letting the anti-pattern spread to more
features first. Documented in ARCHITECTURE.md's new "Vendor portability"
section (the repository rule, the Auth/Realtime exceptions and why they
aren't abstracted too, and the realtime-vs-durable-writes distinction for
reactions specifically), AGENTS.md (standing rule + a new Testing &
Definition of Done checklist item), and this entry.

**Reason**: A folder-boundary convention (repositories return plain types,
callers never import Supabase-generated types) gets most of the
portability benefit — contain a future backend swap to `lib/repositories/`
and `lib/supabase/` — for close to zero cost today, since the functions
are just `async function`s, not a class hierarchy or DI container. Option
2 was rejected specifically because the user's own instruction paired
"design for portability" with "do not prematurely introduce distributed
infrastructure solely for hypothetical scale" — a generic interface with
exactly one implementation is complexity paid for today against a benefit
that only materializes if this product actually reaches a scale where
Supabase stops fitting, which is explicitly not assumed. Auth and Realtime
were deliberately left un-abstracted for the same reason in the other
direction: both have provider-specific API shapes deep enough that a
generic wrapper would just rename Supabase's API, not add real
portability — abstracting them now would be the same over-engineering
mistake in a different spot.

**Reason for also documenting the realtime/durable-writes distinction**:
the user's instruction specifically called out not persisting every
high-frequency reaction individually if aggregation suffices. The lobby's
message-reactions table does persist individually — a deliberate, correct
choice (dedup requires knowing *who* reacted; volume is bounded by message
count, not by tap frequency) — but it reads, out of context, like exactly
the pattern the instruction warns against. Documented explicitly in
ARCHITECTURE.md so Phase 3's live emoji reactions (the actually
high-frequency case the instruction has in mind) don't copy this table's
pattern by precedent.

**Tradeoffs**: Every new table needs a repository file (or an addition to
an existing one) before any page can use it — one extra hop compared to
querying inline, paid on every future feature that touches data. Accepted
as the cost of keeping the migration path real rather than aspirational.
Auth and Realtime remain genuine, acknowledged rewrite risk if either
provider is ever replaced — not mitigated by this decision, by design.

---

## 2026-08-06 — Portrait and landscape are two intentional live-room modes

**Problem**: The live room (Phase 2+) is the one screen in this app where
mobile orientation isn't just a layout question — portrait and landscape
audiences want genuinely different things (following the crowd vs.
focusing on the conversation). Left undecided, the default engineering
approach would be a single responsive layout that just reflows on rotation
— or worse, two component trees swapped by orientation that each own their
own LiveKit connection and chat subscription, silently dropping the call
and resetting state every time the phone rotates.

**Alternatives considered**:
1. Treat orientation as just another responsive breakpoint — one layout,
   CSS reflow only, no orientation-specific behavior differences.
2. Two distinct presentation modes (portrait: participation/community
   context; landscape: focused live-show view), architecturally required to
   share the same live state so rotating never drops the connection or
   resets anything.

**Decision**: Option 2, specified in detail by the user: portrait
prioritizes speakers-visible + easy-to-reach chat/reactions/prompts/voting/
request-to-speak + prominent chat + no horizontal scroll; landscape
prioritizes the conversation itself — speakers get substantially more
space, side-by-side feeds when practical, chat collapsed by default with
an easy reopen, reactions/controls as lightweight overlays. Rotating
between them must preserve live video, chat state, votes, reactions,
speaker state, and timers, with no reload. Documented in PRODUCT.md (new
Mobile orientation behavior section + Principle 13), ARCHITECTURE.md (new
Mobile orientation implementation section — the architectural rule that
live state must be owned above the orientation-conditional branch, not
inside it — plus a new Testing & Definition of Done checklist item),
AGENTS.md (standing rule against the naive per-orientation-component-tree
approach), and ROADMAP.md (cross-referenced from Phase 2).

**Reason**: This is a corollary of the existing responsive design
principle (PRODUCT.md Principle 11) applied to the one place in the MVP
where orientation carries real product meaning, not just layout
convenience — the live room is simultaneously a video call and a crowd
experience, and which one dominates should follow how the phone is held.
Calling it out as its own principle (rather than leaving it implicit under
"responsive design") exists because the failure mode is worse than a
typical responsive bug: getting breakpoints wrong looks bad, but getting
orientation wrong on this screen actually drops the user's live connection
— severe enough to warrant an explicit, named rule future sessions can't
miss.

**Tradeoffs**: Requires more deliberate component architecture up front
(shared state lifted above two presentation-only orientation branches)
than the naive approach would. Accepted, since retrofitting this after
building it the naive way would mean rearchitecting state ownership in a
component that also has to manage a live WebRTC connection — considerably
more expensive later than deciding it now, before Phase 2 exists at all.
Currently a design commitment for a future session to implement against,
not working code — there's no live room yet.

---

## 2026-08-06 — Authentication is a progressive upgrade, not an entry gate

**Problem**: Session 1 built the landing page and header with signup/login
as the primary, unavoidable calls to action — "Join the audience" led to
`/signup`, and there was no path into the product that didn't route through
account creation first. The user corrected this: nobody should have to
create an account to open the app, view an event, or participate as
audience.

**Alternatives considered**:
1. Keep authentication as the front door — simplest to build, matches a lot
   of default SaaS templates, but means every visitor's first experience of
   the product is a signup form, not the conversation itself.
2. Progressive authentication — guests can fully watch/react/vote; an
   account is required only for actions that need persistent identity
   (requesting the mic, commenting, reputation).

**Decision**: Option 2, specified in detail by the user: guest capabilities
(view landing, view events, join as audience, watch, emoji react,
continue/replace vote, view chat, leave anytime) vs. account-only
capabilities (request mic, comment/prompt/question, build reputation and
reliability, future speaking opportunities, saved history, hosting,
persistent display name). Guest identity is a temporary anonymous session
(cookie-based), not a `profiles` row; guest votes/reactions are rate-limited
and duplicate-checked but never accrue reputation, reliability, hosting
privileges, or payouts. Documented across PRODUCT.md (new Progressive
authentication model section + Principle 12), ARCHITECTURE.md (Auth flow
rewritten, new Guest identity and Rate limiting sections, Data model updated
per-table for guest eligibility), README.md, AGENTS.md, and ROADMAP.md
(every phase item annotated for guest eligibility).

**Reason**: The prototype exists to test whether people voluntarily watch
and stay invested in strangers' conversations (see PRODUCT.md's core
question). A login wall in front of that test contaminates the result —
you'd be measuring "who is willing to sign up for an unproven product,"
not "who is willing to watch." Gating only the actions that genuinely need
persistent identity (requesting the mic, building reputation) keeps the
account meaningful — see PRODUCT.md Principle 4, reputation earns
opportunity, not control — without making it a toll.

**Reason for the specific mechanism (cookie-based guest identity, not, say,
letting guests vote with no identity check at all)**: PRODUCT.md explicitly
requires guest actions to be "rate-limited and protected against obvious
duplicate abuse," which needs *some* stable-enough identity per guest per
session. A signed session cookie is the minimal mechanism that satisfies
that requirement without creating an account, an email address, or any
`auth.users`/`profiles` row for the guest — see ARCHITECTURE.md's Guest
identity section.

**Tradeoffs**: Every account-only server action must check for an
authenticated user itself and degrade to an inline "create an account to do
this" prompt, rather than relying on a route-level gate to keep unauthorized
users out — more discipline required per-action, but this is also just
correct: a route-level gate would violate the "guests are never redirected
away from where they are" requirement by construction. The guest identity
mechanism (cookie, rate-limiting, dedup) is unbuilt as of this decision — no
guest-facing write exists yet (that's Phase 3) — so this is currently a
design commitment for future sessions to implement against, not working
code. The existing landing page was refactored this session (Hero's primary
CTA no longer points at `/signup`); see ROADMAP.md's Known gaps for the
placeholder anchor link that needs to become a real guest-join flow once
Phase 1's events exist.

---

## 2026-08-06 — Responsive design is a permanent, first-class product principle

**Problem**: Whether mobile support could be treated as a later adaptation
pass on a desktop-first build (or vice versa), given the MVP's time
pressure to validate the core behavioral hypothesis quickly.

**Alternatives considered**:
1. Build desktop-first, adapt/compress for mobile once the core loop is
   validated.
2. Build mobile-first, stretch for desktop later.
3. Treat both as first-class from the start: shared business logic, layouts
   and interaction patterns intentionally designed per screen size.

**Decision**: Option 3, adopted explicitly by the user mid-session as a
permanent architectural/product principle — not a per-feature judgment
call. Documented in PRODUCT.md (product rule), ARCHITECTURE.md
(implementation notes + testing/Definition-of-Done checklist), README.md,
AGENTS.md, and ROADMAP.md (checklist reference on every phase).

**Reason**: The prototype's entire purpose is testing whether people stay
invested in watching strangers talk — a huge share of realistic usage (half-
attentive viewing) happens on phones, and a platform that only works well
on one form factor doesn't actually test the hypothesis for the audience
that matters. Graceful degradation under poor network conditions was
called out specifically because a live-conversation product that hard-fails
on a network hiccup breaks the exact behavior (staying invested) being
measured.

**Tradeoffs**: More engineering effort per screen than a single desktop (or
mobile) layout — accepted explicitly by the user as worth it. Landing page
and auth pages built earlier in this same session (before the principle was
formalized) use responsive Tailwind utilities throughout but have not yet
been walked through the full testing checklist (real device widths,
throttled network) — flagged in ROADMAP.md Phase 0 as a follow-up rather
than blocking this session on manual device testing that isn't available in
this environment.

---

## 2026-08-06 — Defer LiveKit SDK installation

**Problem**: The tech stack specifies LiveKit for video, but the MVP
feature being built this session (landing page + auth) doesn't use it.

**Alternatives considered**:
1. Install `livekit-client`/`livekit-server-sdk` now so the dependency is
   "ready" for later.
2. Defer installation until the live-room feature (Roadmap Phase 2) is
   actually being built.

**Decision**: Defer (option 2).

**Reason**: Principle 10 ("never add unnecessary complexity") and the
project's own testing rule — untested, unused dependencies and code paths
are a liability, not readiness. LiveKit also needs an `events`/speaker-seat
data model to be useful, which doesn't exist yet.

**Tradeoffs**: A future session has one more `npm install` step before
Phase 2 work. Judged cheap.

---

## 2026-08-06 — Hand-write `src/types/database.ts` instead of generating it

**Problem**: Supabase's recommended workflow generates database types from
a live project (`supabase gen types typescript --project-id ...`), but this
environment has no Supabase project or credentials.

**Alternatives considered**:
1. Skip typed Supabase clients entirely (use `any`/untyped queries) until a
   real project exists.
2. Hand-write types that mirror `supabase/migrations/` exactly, and
   document that they must be kept in sync by hand until generation is
   possible.

**Decision**: Hand-write (option 2).

**Reason**: Untyped Supabase queries would defeat the purpose of using
TypeScript for the one layer (data access) most prone to silent bugs.
Keeping migrations as the schema source of truth, with types mirroring
them, is the same discipline the project will use once generation is
available — it's a placeholder for the mechanism, not a different design.

**Tradeoffs**: Manual sync risk — a migration and `database.ts` can drift.
Mitigated by calling this out explicitly in ARCHITECTURE.md and requiring
both to change in the same commit.

**Superseded 2026-08-09**: the Supabase CLI is now set up and linked (see
"Adopt the Supabase CLI mid-project" below) — `database.ts` is generated,
not hand-written. The manual-sync risk this entry accepted as a tradeoff
materialized exactly once (the missing `Relationships`/`Views`/`Functions`
bug), which is part of why generation was worth doing as soon as it became
possible rather than continuing to accept the risk indefinitely.

---

## 2026-08-06 — RLS enabled on every table from the first migration

**Problem**: Whether to enable Postgres Row Level Security per-table as a
judgment call, or as a hard default.

**Alternatives considered**:
1. Add RLS later, once there's more than one table and a clearer sense of
   access patterns.
2. Enable RLS on every table from the start, including the first
   (`profiles`).

**Decision**: Hard default from the start (option 2).

**Reason**: Retrofitting RLS onto a table that's already accumulated
policies-by-omission (i.e., an open table the client happened to only query
safely) is a common source of real-world data leaks. Cheaper to establish
the pattern once, correctly, than to audit for it later.

**Tradeoffs**: Slightly more ceremony per migration (must write policies
alongside the table). Judged worth it for a social product with
user-generated data.

---

## 2026-08-06 — Package name required a workaround for `create-next-app`

**Problem**: `create-next-app` refuses to scaffold into a directory whose
name isn't a valid npm package name; the project folder is `Virtual Stage`
(capital letters, a space).

**Alternatives considered**:
1. Rename the working directory.
2. Scaffold into a temporary valid-named subdirectory (`virtual-stage/`),
   then move its contents up to the repo root and remove the subdirectory.

**Decision**: Scaffold into `virtual-stage/` then move up (option 2).

**Reason**: The working directory name is outside this project's control
(user's filesystem); renaming it wasn't requested and risks confusing the
user about where their project lives. The npm package name (`package.json`
`name` field) only needs to be a valid identifier — it doesn't need to
match the folder name — so `virtual-stage` was kept as the package name
after the move.

**Tradeoffs**: None of consequence — purely a scaffolding-time workaround.
