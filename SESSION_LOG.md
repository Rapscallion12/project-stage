# Session Log

Newest entry first.

---

## 2026-09-06 — Session 72: Comprehensive sandbox cleanup — root-caused stale test-room state, fixed `clear-sandbox`, added an internal "Clear Test Room" control (real-device report), on `fix/sandbox-cleanup-comprehensive`

**Goal**: a real user testing the mobile UX correction found stale
comments/an active seat in `[DEV] Always-On Test Room` (migration
00000000000015's shared permanent fixture) that the Session Simulator's
own "Reset" never removed. Branched from `main` (not either open feature
branch — this is a test-infrastructure fix, independent of both).

**Root cause, traced end to end, not assumed**: two independently-scoped
cleanup paths exist, and neither is a comprehensive room-wide clear —
this was by design for one of them, and an incomplete implementation for
the other.
1. **Simulator "Reset Session"** (`resetSimulatorSession`) is
   *deliberately* scoped to the exact `guestIds` the current browser
   tab's own simulator run generated in memory this session — correct
   and necessary, since a room-wide wipe there would be unsafe against a
   room with real participants mixed in. A fresh page load (a new
   preview deployment, e.g.) starts that in-memory set empty, so it has
   no memory of a *previous* session's own simulated rows, let alone
   real interactive activity or CLI-seeded fixtures.
2. **`scripts/dev-harness.mts`'s `clearSandbox`** (CLI-only, never
   wired into the app) *is* room-wide, but only ever cleared two of the
   eight tables a room's transient state actually spans —
   `event_chat_messages`/`event_speakers` — never `stage_rounds` or
   `stage_reaction_heat`, neither reachable via any cascade from what it
   did clear (confirmed by reading every relevant migration's own FKs).
3. **The visible symptom traced to a self-inflicted feedback loop**: this
   project's own `scripts/dev-harness.test.ts` inserts a real chat
   message into this exact shared room as part of proving `clearSandbox`
   works — but its *own* precondition (a fresh insert into seat 2)
   collided with real leftover state from interactive simulator use
   against the same room, throwing *before* the test ever reached its
   own cleanup call. Every full-suite run across recent sessions left
   one more "clear-sandbox test guest" comment behind, compounding.

**Fixes**:
- `clearSandbox` (CLI) rewritten to explicitly, independently clear all
  eight tables (chat messages → reactions/requests/request votes;
  speakers → round votes; `stage_rounds` and `stage_reaction_heat`
  independently), each counted precisely rather than trusting cascades
  for the reported numbers.
- `scripts/dev-harness.test.ts`'s own clear-sandbox test rewritten to be
  self-healing and deterministic: clears first (a precondition, not an
  assumption of a clean starting state), inserts one deliberate fixture
  per table, clears again, and authoritatively re-queries every table —
  rather than depending on whatever state happened to already exist.
- New `clearTestRoomSandbox` server action (app-side, independently
  implemented rather than importing the CLI script — that script
  documents itself as intentionally outside the app boundary) mirrors
  the same fixed table list, but adds a hard server-side safety check:
  refuses unless the target event's own `is_permanent_test` column is
  true, verified fresh from the database, never trusted from the
  caller. Gated by the same `assertSimulatorAvailable()` every other
  simulator action already requires.
- New, clearly-separate **"Clear Test Room"** button in the Session
  Simulator panel (distinct color/label from "Reset Session," reuses
  the same `onSimulatorReset` local-state reconciliation callback and
  the same in-flight/Start-barrier guards) — deliberately *not* a
  widening of Reset Session's own correctly-scoped behavior.
- Manually ran the fixed cleanup against the real linked project:
  authoritatively confirmed genuinely blank (0 across every table),
  then seeded 2 speakers and re-verified the expected populated state
  (including a real `stage_rounds` row the seat-claim RPC itself
  creates), then cleared again and re-confirmed blank.

**Testing**: `dev-harness.test.ts` gained a deterministic, self-healing
`clear-sandbox` describe block (starts blank, seeds one fixture per
table, clears, authoritative re-query, plus an idempotent-no-op-on-
already-blank test). `simulator-actions.test.ts` gained
`clearTestRoomSandbox` tests (production-gate refusal, refuses an
ordinary/nonexistent event, and a real-DB test against the actual
shared sandbox proving the comprehensive clear). `session-simulator-
panel.test.tsx` gained a "Clear Test Room" describe block (distinct
from Reset Session, logs comprehensive counts, surfaces a server
refusal as a log line not a crash, in-flight guard, Start-button
barrier).

**Verification**: `npm run lint` clean, `npx tsc --noEmit` clean, `npm
run build` clean, room/room-actions/scripts suites clean (828 tests,
including the real-DB sandbox tests against the live project). Full
project suite run separately — see this session's own handoff.

Not merged to `main`. Not deployed to production.

---

## 2026-09-05 — Session 70: Reaction cooldown + sender-dedup correction (real-device report, issue #21)

**Goal**: second narrow reaction correction on the same branch — cooldown
tuning and a real, confirmed duplicate-echo bug the previous pass's own
id dedup design didn't actually survive in practice.

**Cooldown now exits only at genuinely zero, not 55%** — explicit
product decision, not a bug fix: `REACTION_HEAT_COOLDOWN_EXIT` changed
from 55 to 0 on both sides. Server: migration 00000000000046
`CREATE OR REPLACE FUNCTION record_stage_reaction_attempt` with the
identical body as migration 00000000000045, only `p_cooldown_exit_heat`'s
default changed — the decay/hysteresis *mechanism* itself untouched, so
this was a pure tuning change, not a redesign. Client:
`src/lib/reactions/constants.ts`'s copy changed to match; the comparison
logic in `useReactionHeat` (`decayed <= REACTION_HEAT_COOLDOWN_EXIT`) and
in the SQL function (`v_decayed_heat > p_cooldown_exit_heat`) both
already generalized correctly to the zero case with no further code
changes needed — confirmed with a real-DB test forcing heat to 99/75/55/
1 during cooldown (all still rejected — 55 explicitly proven to no
longer unlock) and to exactly 0 (accepted).

**Root cause of the still-duplicating sender echo, traced through the
actual runtime path, not assumed**: the *first* id-dedup design (this
file's own previous session) compared an incoming broadcast's id against
whatever was still in the `incoming` array — but `incoming` entries are
pruned after `REACTION_BURST_LIFETIME_MS` (2200ms, tied to the on-screen
animation), while the round trip being deduped against (resolve identity
→ DB row lock/update → REST broadcast → Realtime propagation back to the
sender) has no such guarantee of finishing that fast. A round trip
slower than 2.2s — entirely plausible on a real phone — meant the
optimistic entry was already gone by the time its own confirmation
arrived, so the id match silently found nothing and the broadcast got
added as a "new" reaction: a second, genuinely duplicate on-screen burst.
Confirmed by writing a regression test that drives exactly this timing
(advance a fake clock 5s past the burst's own prune before resolving the
round trip) — it reproduced the bug against the old code and passes
against the fix.

**Fix**: a second, separate, much longer-lived ref
(`sentReactionIdsRef`, `REACTION_SENT_ID_MEMORY_MS` = 30s — no relation
to the visual burst's 2.2s) tracks ids this exact tab has sent,
independent of the pruned `incoming` array. The broadcast handler checks
this set *before* ever calling `addReaction`, so a slow round trip can
no longer defeat the dedup. Deliberately still id-based, not
`senderIdentity`-based, per explicit instruction: a reaction genuinely
sent from a *different* tab/device under the same account (e.g. a guest
cookie open in two tabs) was never added to *this* tab's own sent-id
set, so its first sighting via broadcast still renders normally — an
identity-based filter would have wrongly suppressed that legitimate
activity. Heat was confirmed never touched by the broadcast-receive path
at all (only `send()` calls `recordOptimisticSend`/`reconcileWithServer`,
and `addReaction` has no access to `heat`) — the reported "heat also
fills again" was the duplicate *reaction* being mistaken for a duplicate
*heat increment*; a dedicated test now proves receiving any reaction,
including the sender's own echo or another viewer's, never moves the
receiving client's own outgoing heat.

**Testing**: `use-stage-reactions.test.ts` gained the regression test
above plus explicit heat-isolation tests (echo doesn't double-increment,
others' incoming reactions never move my heat, a same-identity-
different-origin id still renders on first sighting). `use-reaction-
heat.test.ts` gained a "cooldown-exit rule" describe block (99/75/55/1
still blocked, only exactly 0 exits) plus a "heat at 99, not yet in
cooldown, still allows sending" test. `stage-reactions.test.ts` (real-DB)
gained a direct multi-checkpoint test against the live migrated
`record_stage_reaction_attempt`.

**Verification**: `npm run lint` clean, `npx tsc --noEmit` clean, `npm
run build` clean, room/hooks/lobby/room-actions suites clean (1132
tests, including the real-DB reaction tests against the newly applied
migration). Full project suite run separately — see this session's own
handoff for the final count.

Not merged to `main`.

---

## 2026-09-05 — Session 69: Reaction UX correction — instant sender feedback, Side mode target-awareness (real-device report, issue #21)

**Goal**: narrow correction to Session 68's reactions, based on real-
device testing against the internal simulator-enabled deployment. No
redesign of the reaction gesture model, timer swap semantics,
authoritative targeting, voting, RTS, media, or simulator internals.

**Root cause of the sender's own reaction delay, confirmed by reading
`useStageReactions.send`, not assumed**: the ONLY path that ever added
anything to the client's own `incoming` array was the Realtime broadcast
subscription handler — including for the sender's *own* reaction. So the
sender genuinely waited out the full round trip (resolve identity →
`record_stage_reaction_attempt` → `httpSend` REST broadcast → that
broadcast traveling back down the sender's own subscribed WebSocket
channel) before ever seeing their own animation. There was no local/
optimistic rendering path at all.

**Fix — instant local feedback, id-based dedup, never a "which are
mine" flag**: `send()` now constructs a client-generated `id`
(`crypto.randomUUID()`) up front and, only when the client's own already-
synchronized heat state (`canSend`) doesn't already know sending is
blocked, adds a local optimistic entry to `incoming` immediately,
synchronously — before `sendStageReaction` is even called. That same id
is threaded through `sendStageReaction`'s new optional `reactionId`
parameter and echoed back verbatim in the broadcast payload, so when
that broadcast eventually returns to the sender's own subscribed channel
(Realtime delivers to every subscriber, sender included), `addReaction`'s
own id-based dedup recognizes it as the confirmation of what's already
showing and silently drops it — no separate "is this reaction mine"
bookkeeping needed anywhere. The authoritative call still always
happens regardless of the local heat guess, still the only thing that
can move heat or trigger a real broadcast; an unexpected server
rejection after an optimistic render is not "undone" — the animation
just finishes on its own (already time-bounded) while heat/cooldown
reconcile normally.

**Fix — Side mode now preserves which speaker was targeted, and
distinguishes the sender from everyone else**: previously Side mode
dumped every reaction (everyone's) into one shared bottom-corner lane,
regardless of target — losing the whole point of a *directed* reaction,
and hiding the sender's own precise feedback behind everyone else's
traffic. Now: **the viewer's own reactions** render on-speaker, at their
exact tap location, exactly like On Speaker mode — Side mode only ever
changes where *other viewers'* reactions go. **Other viewers'
reactions**, in the two-tile portrait case, split into two lanes
(`ReactionSideLane`'s new `region="top"`/`"bottom"` prop) — one for
whichever seat currently occupies the top visual slot, one for the
bottom — derived from `firstSeat`/`secondSeat` (already flips with the
Section 7 timer swap), never from seat 1/2 directly, so region placement
correctly follows a locally-swapped speaker to their *new* visual slot
while authoritative `targetIdentity` never changes. Landscape/desktop
deliberately keep the original single, unsplit lane unchanged (still
excluding the sender's own reactions) — an explicit, reported scope
decision, not an oversight; a real landscape/desktop spatial treatment
is deferred to the upcoming desktop UX audit. Hidden mode suppresses
everything uniformly, sender included, with zero extra logic (both
paths already gate on the same `showReactions` flag) — and sending
itself remains completely unaffected regardless of display mode, since
`onDoubleTapReact` was never gated on it.

**Also this pass**: idle UI transparency (Section 8, Session 68) was
found too subtle on a real phone — the compact comment composer, the
widest surface in the row, had been scoped out of the original fade
entirely. Extended the identical idle-fade treatment to `ChatPanel`'s
own compact composer pill and replaced the prior 6% idle fill with
fully transparent (0%) everywhere idle fading applies — a decisive
difference, not another small increment. And: simulator UI needed to
stay hidden on the ordinary launch-facing preview while still being
testable, so a second deployment now uses a one-off `vercel deploy -e
ENABLE_SESSION_SIMULATOR=1` (a runtime override scoped to that single
deployment) rather than any change to shared Vercel project environment
variables or the simulator's own gating code.

**Testing**: `use-stage-reactions.test.ts` gained an "instant local
sender feedback" describe block (immediate local render, concurrent
authoritative send using the same id, no optimistic render when already
known-blocked, dedup on the broadcast echo, no awkward undo on
rejection). `send-stage-reaction.test.ts` gained a `reactionId` describe
block (verbatim passthrough, server-generated fallback when absent/
empty, rejection still never broadcasts). `speaker-stage.test.tsx`
gained a "Side mode: sender/others split + region follows local visual
swap" describe block (On Speaker unchanged, top/bottom region
targeting, timer-swap-follows-target, sender-never-duplicated, Hidden
suppresses both while still allowing send, landscape's unsplit-lane
scope decision). `stage-reactions-overlay.test.tsx` gained direct
`region` prop coverage. `chat-panel.test.tsx`/`watch-mode-controls.
test.tsx`/`reaction-control.test.tsx` updated for the new idle-
transparency value.

**Verification**: `npm run lint` clean, `npx tsc --noEmit` clean, `npm
run build` clean, room/hooks/lobby/room-actions suites clean (1116
tests, including the real-DB `stage-reactions.test.ts`/
`simulator-actions.test.ts`). Full project suite run separately — see
this session's own handoff for the final count.

Not merged to `main`.

---

## 2026-09-05 — Session 68 follow-up: idle transparency too subtle, internal simulator-testing deployment path (real-device report, issue #21)

**Goal**: narrow real-device follow-up on Session 68's preview, on the
same branch — no redesign of reactions/timer-swap/voting/RTS/media/
simulator internals.

**Issue 1 — couldn't practically test the new interaction features
without simulator access, but simulator must stay hidden from the
ordinary launch-facing preview.** Root cause: `ENABLE_SESSION_SIMULATOR`
is a single Vercel project-level env var — setting it would have turned
the simulator on for *every* Preview deployment, including the one
meant to represent the real launch-facing experience. **Fix, no gating
code touched**: a second deployment via `vercel deploy -e
ENABLE_SESSION_SIMULATOR=1`, which sets that variable as a *runtime
override scoped to that one deployment only* — the shared Vercel project
Preview environment variables (and therefore the ordinary git-triggered
preview for this branch) are completely unaffected. Confirmed via
`vercel inspect` that the resulting deployment's `target` is `preview`,
not `production`.

**Issue 2 — idle UI transparency was real but too subtle to matter on a
phone.** Root-caused: Session 68's fade only touched the small React/
Vote emblems (14% → 6% white fill); the compact comment composer — the
*widest* surface in Watch Mode's bottom row — was explicitly scoped out
of that pass (shared with the lobby, flagged as higher blast radius in
DECISIONS.md) and never faded at all, so the net visual change across
the row was minor. **Fix**: extended the identical idle-fade treatment
to `ChatPanel`'s own compact composer pill (new optional `idle` prop,
default `false`, scoped to the `compact` branch only — the lobby's own
non-compact rendering is untouched), and replaced the prior 6% idle fill
with fully transparent (0%) everywhere this pattern applies — a
decisive difference instead of another small increment. Border, mic
icon, placeholder/input text, emoji, and the mic-request-mode accent
background (an active state) are all unchanged, matching the original
Section 8 constraints; active (non-idle) opacity is unchanged.

**Testing**: `chat-panel.test.tsx` gained an idle-adaptive-transparency
describe block (default full opacity, fades to transparent when idle,
mic-request-mode's accent background is exempt). `watch-mode-controls.
test.tsx` and `reaction-control.test.tsx` updated for the new fully-
transparent idle value.

**Verification**: `npm run lint` clean, `npx tsc --noEmit` clean, `npm
run build` clean, room/lobby/hooks suites clean (1052 tests). Real-
device: UNVERIFIED — requires the user's own iPhone pass, this time
against the internal simulator-enabled link so two-speaker interaction
state can actually be created.

Not merged to `main`.

---

## 2026-09-04 — Session 68: Pre-launch interaction pass — directed emoji reactions, tap-timer speaker swap, adaptive idle UI, Gift-icon removal, Session Simulator launch-visibility gate (issue #21)

**Goal**: a focused pre-launch UX pass on top of the `pre-reactions-stable`
rollback checkpoint (Session 67's `4608926`, real-device tested and
tagged). No vote-UI rework, no monetization, no regression to the
media-readiness/camera-preview/audio-visualizer work Sessions 66-67
established. See DECISIONS.md's own entry immediately above for the four
consequential design decisions this pass had to make before implementing
anything.

**Directed emoji reactions**: double-tapping a speaker tile (manual
pointer-based double-tap detection — mobile browsers don't reliably fire
native `dblclick` for touch) sends the viewer's own selected emoji
(curated 8-emoji set, ❤️ default, tapping the emoji button only opens a
selection/settings panel — there is no general "send" action) at that
specific speaker, rendered at the normalized tap position. Delivery is
Supabase Realtime `broadcast` via `RealtimeChannel.httpSend()` from a
Server Action (confirmed by reading `@supabase/realtime-js` directly —
the broadcast endpoint is available immediately, no persistent socket
needed), never persisted as comments/history. Rate limiting is a real
server-side decaying heat/hysteresis budget — see DECISIONS.md; the
visible button-fill meter is UX only. Three local, localStorage-persisted
display preferences (On speaker / Side lane / Hidden) — presentation-only,
never change what others see, and sending stays possible even when
hidden. Reaction targeting is derived from authoritative seat identity at
render time, so it survives camera on/off, video/audio-visualizer state,
and the new visual speaker swap below, by construction — verified with a
dedicated test that swaps first, then double-taps, and asserts the
correct original identity was targeted.

**Tap-center-timer speaker swap** (portrait/mobile only — audited
landscape and desktop separately; landscape has no genuine stacked
top/bottom relationship to apply this to, desktop is left untouched):
tapping the shared round timer visually swaps the top/bottom tiles,
purely local presentation state — no seat/vote/RTS/round/LiveKit state
touched, no message to other viewers. A FLIP-style transition (manual
`useLayoutEffect` + `getBoundingClientRect` before/after) animates the
exchange, skipped under `prefers-reduced-motion`. Implemented by
reordering *which* `renderTile(seatNumber)` call renders first, never by
swapping which seat's *data* renders in a fixed slot — see DECISIONS.md
for why the other way would have silently remounted media.

**Adaptive idle transparency**: `useIdleActivity` (registerActivity /
holdActive+releaseActive, counter-based so concurrent holds don't
prematurely resume the idle countdown) drives a ~2.5s idle fade on the
*actual* visible glass surfaces (`WatchModeControls`' own backgrounds,
the new reaction button's background) — never a blanket opacity drop,
never while a composer is focused or a panel is open, always instantly
restored on any interaction. Ambient comments' own independent hide/show
toggle is unaffected.

**Gift icon**: audited — genuinely dead, no implemented function. Removed
from `WatchModeControls`' render output only; no gifting/tipping/payment
code exists to delete, so there was nothing else to touch.

**Session Simulator launch-visibility gate**: new `isSimulatorUiEnabled()`
(`ENABLE_SESSION_SIMULATOR=1`, defaults off), AND'd with the existing
`isPreviewOrDevBuild()` check as a second, narrower, independent
condition — see DECISIONS.md for why an ordinary Vercel preview alone can
no longer imply "show simulator UI." Nothing about the simulator's own
implementation was touched or deleted; this is a visibility change to one
render condition in `EventRoom`. Also added a small, genuinely optional
preview-only convenience (gated the same way, additive): two "Simulate
Reaction → Seat N" buttons in the panel that call the same production
`send()` path a real double-tap uses, so testing incoming-reaction
rendering doesn't require a second browser tab; Reset Session now also
clears any `stage_reaction_heat` rows the simulator's own guest ids
accumulated.

**Testing**: new dedicated unit/component test files —
`use-reaction-preferences`, `use-double-tap`, `use-reaction-heat` (incl. a
proactively-found-and-fixed stale-closure bug in its own "skip redundant
re-render" optimization), `use-idle-activity`, `use-stage-reactions`,
`reaction-panel`, `reaction-control`, `stage-reactions-overlay` — plus a
real-DB test (`stage-reactions.test.ts`, against the live linked Supabase
project, same discipline as `event-speakers-expiration.test.ts`) proving
`record_stage_reaction_attempt`'s actual decay/hysteresis/cross-identity/
cross-event isolation and its identity-XOR guard, not just a mocked RPC.
`speaker-stage.test.tsx` gained an 8-test timer-swap describe block
(including the no-remount and reduced-motion tests). `event-room.test.tsx`
gained a 4-test Session Simulator launch-visibility describe block
(OFF/preview-alone/flag-alone/both-ON). `session-simulator-panel.test.tsx`
gained tests for the new reaction-testing buttons and the Reset cleanup
count. Two pre-existing tests asserting "React stays disabled" were
rewritten (now genuinely false — React is a real control).

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean, full suite clean: **107 files / 1424 tests**
   (including the two new real-DB test files), zero failures.
2. **Production interaction**: not yet performed this session — see the
   handoff for what's outstanding before this is reported as tested.
3. **Real-device: UNVERIFIED — requires real-device testing.** See the
   handoff's own checklist.

Not merged to `main`.

---

## 2026-09-04 — Session 67: Media rendering bugfix pass — stale local self-preview after joining, missing audio-only visualizer (real-device report, issue #21)

**Goal**: narrow bugfix on top of Session 66's Media Readiness + Audio
Visualizer pass — real-device testing of that preview found two real
bugs before it ever shipped: (1) the local speaker's own camera preview
showed camera-off/no-video immediately after joining, only fixed by
manually toggling the camera; (2) camera-off+mic-on never showed the
audio-reactive visualizer at all. No redesign, no readiness/product
semantics changed, RTS/voting/round/reservation architecture untouched.

**Bug #1 root-caused by reading `livekit-client`'s own source**, not
assumed: this pass's own new pre-claim media acquisition means
`SelfPreview` can now mount *before* a claim (inside the candidate
composition's `SpeakerStage`) and then *again*, fresh, the moment the
role router swaps to Speaker View on claim — a second `attach()` call
for the same already-flowing `LocalVideoTrack` on a brand-new `<video>`
element. Confirmed *why* toggling the camera "fixed" it isn't a
coincidence: `LocalVideoTrack.mute()` for a camera source genuinely stops
the hardware track, and `unmute()` reacquires it and re-runs
`attachToElement()` on every attached element — mechanically the same
repaint, just via an unwanted real hardware reacquisition.
`livekit-client`'s own `attachToElement()` already carries an equivalent
"reset `srcObject` to force a repaint" workaround for a documented,
similarly-shaped Safari/Firefox bug (cites Safari 15 in its own source) —
independent confirmation this class of bug is real in this exact
dependency, just not covered for this specific (non-browser-specific)
trigger. **Fix**: `SelfPreview` now applies that same nudge itself,
universally — one `requestAnimationFrame` after `attach()`, reset
`srcObject` and replay. One file, no new dependency, no camera toggling.

**Bug #2 root-caused as two separate, confirmed problems**: (1)
structural — the local self-view visualizer was wired only into
`SpeakerTile`, but Portrait/MobileLandscape Speaker View's `soloMode`
never renders the local speaker's own tile at all (confirmed by reading
`SpeakerStage`'s own `soloMode` logic) — the local visualizer was simply
unreachable code on mobile. (2) `createAudioAnalyser` (confirmed by
reading its actual implementation) constructs a brand-new `AudioContext`
every call, which browsers commonly start suspended outside a user
gesture — its own only recovery is a one-time `click` listener on
`document.body`, so a viewer who never happens to click anywhere would
see permanently-silent bars with real audio genuinely flowing.

**Fix**: extracted `deriveParticipantMediaState` (new
`lib/participant-media-state.ts`) — the one shared place `hasVideo`/
`hasAudio` get derived from live LiveKit publications, now used by both
`SpeakerTile` (remote/co-speaker tiles, unchanged behavior) and
`SpeakerStage`'s own self-view corner slot, which now chooses between
video (`SelfPreview`), a new compact variant of `AudioOnlyVisualizer`
(same real bars, no avatar/name), or nothing — converging local and
remote onto one canonical participant/publication-derived state, per
explicit instruction. The corner slot still falls back to the raw
`localVideoTrack` reference only for the pre-claim candidate self-preview
(no publication exists yet to read). `AudioOnlyVisualizer` now explicitly
calls `.resume()` on its own analyser's `AudioContext` immediately after
creating it — a head start ahead of the click-fallback, not a
replacement for it. Also widened `SpeakerTile`'s own "You're live" branch
from `hasVideo`-only to `hasVideo || hasAudio` (issue #22's own rule that
the tile never shows local media, video or otherwise, now applied
consistently to audio-only too — it was briefly violated by Session 66's
own visualizer branch, which this closes).

**Diagnostics** (temporary, dev/preview-only, per explicit instruction):
extended the existing `RoomDiagnostics` panel (already gated by
`isDevToolsAvailable()`, already collapsed by default) with a "MEDIA
RENDER DEBUG" section — per-seat publication existence/subscribed/muted/
track-sid, `hasVideo`/`hasAudio`, inactive, and the actual render branch
chosen. `AudioOnlyVisualizer` writes debug-only `data-*` attributes
(track sid, rAF-active, context state, latest amplitude) to its own root
element in the same rAF tick already mutating the bars — never a React
re-render, never production UI. Both meant to be removed once the two
bugs are confirmed fixed on a real device.

**Testing**: new `audio-only-visualizer.test.tsx` (7 tests — AudioContext
resume on suspended/running, cleanup on unmount, re-creation on track
swap, full vs. compact identity treatment, dev-only debug attributes).
`speaker-stage.test.tsx` gained a 5-test describe block for the corner
slot's video/visualizer/nothing decision, including the specific
regression this pass fixes (a stale `localVideoTrack` must not win once
the publication itself reports the camera authoritatively muted).
`self-preview.test.tsx` gained 3 tests for the repaint nudge itself
(resets srcObject without a second attach/detach cycle, safe with no
srcObject to reset, cancels its pending rAF on unmount).
`speaker-tile.test.tsx`'s existing local-visualizer test was corrected
to assert the new, actually-correct behavior (no visualizer in the big
tile for local — the neutral "You're live" text, matching camera-on).

**What this environment could and couldn't verify**: no camera/mic
hardware, and no LiveKit URL configured in local dev — confirmed via a
real (non-mocked) browser session that tapping an empty seat correctly
dispatches a genuine `getUserMedia` call and blocks the claim while
unresolved (the readiness gate itself, from Session 66, still holds) and
that the new diagnostics panel renders without error against real
(non-connected) participant data — but the actual attach/publish/
analyser behavior these two fixes target needs real-device confirmation.

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean, full suite clean: **97 files / 1318 tests,
   zero failures** (up from 96/1303).
2. **Production interaction** — local dev server, real Supabase-backed
   throwaway test account: confirmed the room (audience and seated-
   speaker views) renders without error after these changes, and the
   extended diagnostics panel renders its new "MEDIA RENDER DEBUG"
   section correctly. The actual camera-preview/visualizer bugs
   themselves require a real camera/mic and a real LiveKit connection —
   neither is available in this environment (no hardware; no LiveKit URL
   configured for local dev) — so the *fixes* could not be reproduced
   live here, only reasoned from `livekit-client`'s own source and
   applied narrowly.
3. **Real-device: UNVERIFIED — requires real-device testing.** Checklist:
   (1) join → confirm your own camera preview shows live video
   *immediately*, no toggle needed; (2) toggle camera off → confirm the
   voice-reactive visualizer appears in your own corner preview *and* on
   remote viewers'/your co-speaker's tile, and audibly reacts while you
   speak; (3) toggle camera back on → confirm video returns immediately,
   repeated a few times with no stale state.

Not merged to `main`.

---

## 2026-09-04 — Session 66: Media Readiness + Audio Visualizer pass — gate real seat claims on verified camera+microphone, replace the dead camera-off tile with a real audio visualizer (issue #21)

**Goal**: close the "unprepared candidate becomes seated, kicked later"
gap — neither `useAutomaticPromotion`'s auto-promotion claim nor
`handleTapEmptySeat`'s direct join had any media-readiness precondition;
the only existing safety net (`MEDIA_ACTIVATION_GRACE_MS`, 30s) only
fires *after* seating. Also: replace the dead "Camera off" tile for a
seat with camera off but mic actually publishing (a fully valid,
intentional post-join state) with a real, audio-reactive visualizer.

**Current media flow audited first**, per explicit instruction, not
assumed: traced RTS submit → candidate selection/reservation
(`ensureActiveSelectionRound`) → `useAutomaticPromotion`'s countdown →
unconditional `claimOpenSeat` → `event_speakers` row → LiveKit token
mint (`shouldPublish`) → `SpeakerTile`/`SpeakerStage` rendering →
`MEDIA_ACTIVATION_GRACE_MS` post-seating eviction. Confirmed directly
(not assumed) that both `claimOpenSeat` call sites fire with zero media
precondition, and that `simulator-actions.ts` calls `claimSpeakerSeat`
(the repository function) directly — never through the client-facing
actions this pass gates — so the simulator is structurally unaffected by
construction, no new bypass code needed.

**Three concepts kept distinct**, per instruction: (A) requesting to
speak (RTS submit, untouched), (B) becoming a speaker (the seat claim —
now gated), (C) media state after already being a speaker (existing
mute/inactivity system, untouched). Gate placed at (B), immediately
before both `claimOpenSeat` call sites, not at RTS-submit time — see
DECISIONS.md for the reasoning.

**`prepareLocalMedia` rewritten**: camera and microphone are now acquired
via two independent calls (`createLocalAudioTrack`/`createLocalVideoTrack`,
dispatched synchronously via `Promise.allSettled` — still gesture-safe)
instead of one combined `createLocalTracks({audio, video})`. This is what
makes a camera-only or mic-only failure distinguishable, and what makes a
retry only re-acquire the device that actually failed rather than
re-prompting for one that already succeeded. New exported
`MediaReadinessState` (`{camera: {ready, error}, microphone: {ready,
error}}`), kept alongside the existing aggregate `mediaError` (issue #22),
not replacing it. New `describeMediaReadinessFailure` helper for the
direct-join path's single-line failure text.

**Seat-claim gate, both paths**: `handleTapEmptySeat` now awaits
`prepareLocalMedia()`'s result *inside* the existing `startJoiningSeat`
transition (captured synchronously, for the Safari gesture requirement)
before calling `joinOpenSeat` — a failed readiness never calls it at all,
surfacing the specific device(s) that failed via the existing
`joinSeatMessage` convention. `useAutomaticPromotion` gained
`cameraReady`/`microphoneReady` params; its claim effect now no-ops at
`countdown === 0` until both are true (countdown stays frozen at 0 — an
already-established display state, not a new one) instead of firing
unconditionally. A new bounded 45s effect calls the *existing* `cancel()`
(the same "Cancel"/"Withdraw" → `withdrawSpeakerRequest` path) if
readiness never succeeds — no new replacement-queue mechanism.

**New `StageReadinessPrompt`** ("Ready to speak?" / "Camera & microphone
required", per-device Camera/Microphone status rows, Enable/Try Again
button, a settings hint specifically for permission-denied): one
component, a `compact` flag for two render contexts — `RoomControls`'
existing pending-candidate block (desktop, replacing "Going live in 0…"
for exactly that instant) and `PortraitRoom`/`MobileLandscapeRoom`'s
center-stage overlay slot (replacing `CountdownOverlay` at countdown 0
while unready). Once both devices report ready, this stops rendering and
the already-gated claim fires on its own — no extra confirmation modal.

**New `AudioOnlyVisualizer`**: audited the installed LiveKit surface
first — `@livekit/components-react` (which ships `BarVisualizer`) isn't
installed; `createAudioAnalyser` (confirmed exported from the installed
`livekit-client@^2.21.0`) is the lower-level primitive it's presumably
built on, used directly instead of adding a new dependency. Bar heights
are written straight to DOM refs inside a `requestAnimationFrame` loop,
never via `setState`. Driven by `microphonePublication.track` — the same
prop for local self-view, audience-of-remote, and speaker-viewing-partner,
no separate local/remote implementation. Wired into `SpeakerTile` as a
new branch (camera off, mic live+unmuted), after the inactivity check
(inactivity still wins if both are somehow true) and before the
simulated-speaker placeholder.

**Explicitly untouched, confirmed by reading the actual code, not
assumed**: RTS ranking/tie-break, replacement reservation, shared
rounds/Final 30, seat lifecycle semantics, guest participation, comments,
voting, desktop header, Room Info, Supabase/LiveKit architecture, the
post-seating both-off inactivity grace period (`MEDIA_ACTIVATION_GRACE_MS`
itself is a completely separate timer from this pass's new 45s
readiness timeout), simulator behavior (unaffected by construction, not
by a new gate).

**Testing** (Section 24's explicit list): new coverage in
`use-live-room-connection.test.ts` (camera-only failure, mic-only
failure, retry re-acquires only the failed device, idempotency) —
also fixed a real pre-existing staleness bug found while doing this: the
whole file's media-acquisition mocks still referenced the old, no-longer-
called `createLocalTracks`, silently passing only because nothing
asserted on the resulting `localVideoTrack`/`mediaError` state in most
cases; one test (`does not reconcile — and does not overwrite —...`)
was a real, currently-failing regression once the rewrite from the
previous session's own carryover work was accounted for, now fixed.
`use-automatic-promotion.test.ts` gained a dedicated readiness-gate
describe block (never claims before both ready; camera-only/mic-only/
both-false readiness; retry success fires the withheld claim without a
new tap; retry failure releases via the existing cancel() path once the
45s timeout elapses; a successful retry inside the window never
triggers the timeout). `event-room.test.tsx` gained a direct-join
readiness-gate describe block (camera-only/mic-only/both-failure never
call `joinOpenSeat`, each with its specific failure text; success calls
it normally). `speaker-tile.test.tsx` gained an audio-only-visualizer
describe block (renders for camera-off+mic-on; ordinary placeholder for
both-off; real video takes over once camera returns; identical for the
local speaker's own seat; inactivity still wins if both are somehow
true at once).

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean, full suite clean: **96 files / 1303 tests,
   zero failures** (up from 96/1286).
2. **Production interaction** — local dev server, real Supabase-backed
   throwaway test account (`npm run dev:harness -- seat`, deleted
   afterward), real browser (not a unit-test mock): logged in as the
   seated test account, clicked "Leave the stage" to vacate the seat,
   then tapped the now-empty seat as that same signed-in account —
   confirmed the tile immediately switched to disabled "Joining…" (not
   an instant claim) and a real `navigator.mediaDevices.getUserMedia`
   call was dispatched (confirmed directly via `page.evaluate` in the
   same origin) — and, critically, confirmed the seat was **never**
   claimed while that call stayed unresolved: no `event_speakers` row
   appeared, both tiles stayed on "Joining…" indefinitely rather than
   either tile becoming occupied. This is the actual invariant this pass
   exists to prove (no claim before verified readiness) exercised against
   a real browser API call, not a mocked one. This environment's browser
   automation has no fake-camera/mic device flag and no way to answer the
   native OS/browser permission dialog (invisible to the accessibility
   tree), so the actual grant path, the deny→recovery path, and the
   visualizer's real audio reactivity could not be observed this way —
   see the Real-device item below for what that leaves outstanding. Once
   pushed, also confirmed the preview deployment itself is live and
   responding (see the link above).
3. **Real-device: UNVERIFIED — requires real-device/real-browser testing**
   with an actual camera and microphone. Checklist: (1) tap an empty seat
   or let an RTS win reach the "Ready to speak?" prompt, grant camera+mic
   when the browser asks, confirm you actually go live with no extra
   confirmation step; (2) deny/block camera or mic, confirm you stay off
   stage with the specific "Camera & microphone required" message (not a
   raw browser error) and a working Try Again; (3) once live, turn your
   camera off — confirm the audio-only visualizer appears and visibly
   reacts while you speak, settles while silent, and disappears the
   instant the camera comes back on; (4) on a second device/browser as
   audience, confirm you see that same visualizer reacting to the
   speaker's real transmitted audio, not just on the speaker's own
   screen; (5) mobile Safari specifically at ~390×844/844×390 — the
   permission flow, denial state, and visualizer must not clip, cause
   accidental navigation, or ignore safe areas.

Not merged to `main`.

---

## 2026-09-04 — Session 65: Desktop room navigation pass — a persistent desktop-only header restoring one-click Home/Events/account access (real-desktop regression report)

**Goal**: a narrow desktop-only layout fix. Real-desktop feedback: hiding
the site-wide header for the whole time a room is mounted (seventh
corrective pass, issue #21) was correct for mobile's scarce vertical
space, but the same blanket rule also hid ordinary Home/Events/account
navigation on desktop, where there's no comparable pressure — the room
read as an isolated tool rather than part of the product. No redesign,
no live-stage logic touched.

**Root cause confirmed, not assumed**: read `RoomHeader`/`DesktopRoom`/
`globals.css`'s `body.room-active > header` rule directly — the site
header truly is hidden unconditionally for the whole time any room
composition is mounted, with no viewport carve-out; `RoomInfoOverlay`
was the only path back to Home/Events/account on every composition,
including desktop.

**No new breakpoint** — audited `useIsDesktopViewport()` first (`min-
width: 1024px`, Tailwind's `lg`) and confirmed it's already the exact
gate that decides whether `DesktopRoom` (the sidebar+stage composition)
mounts at all. The new header is built as part of `DesktopRoom` itself,
so there's no scenario it could render at a width that gate wasn't
already built for — introducing a second, independent threshold would
only risk future drift between the two. Verified directly in the
browser: 1024px (still desktop, comfortable), 1000px (correctly falls
back to the compact `MobileLandscapeRoom` composition, header absent
entirely).

**New `DesktopRoomHeader`**: one full-width row, rendered as a sibling
*above* `DesktopRoom`'s existing stage+sidebar `flex-row` (not nested
inside either column) — the structural choice that guarantees alignment
with both without coordinating two separately-sized header halves by
hand. Left: Virtual Stage/Home + Events, both real navigable links.
Center/flexible: the room's own identity — reuses `RoomHeader` itself
(unmodified rendering, just embedded with its own border/padding
stripped via two small new optional props — `className` and
`roomInfoAriaLabel`, both defaulted so every existing caller is
unaffected) rather than a second copy of that logic. Right: viewer
count, then the account control — `HomeAccountMenu`, the exact same
component the home page header already uses, not a new implementation;
guests get the identical Log in/Sign up pair `SiteHeader`'s own guest
branch renders. One new prop, `identityAvatarUrl` on `RoomLayoutProps`,
mirrors the identical plumbing `RoomInfoOverlay` already had via
`EventRoom`.

**`RoomInfoOverlay`'s own content is completely untouched**, per the
pass's own explicit instruction — it still shows its full description/
navigation/account section on desktop, now redundant with the persistent
header but harmlessly so. Its trigger's accessible name changed from
"Room info and navigation for X" to "Room details for X" (via the new
`roomInfoAriaLabel` override) — accurate now that navigation no longer
routes through it on desktop, without touching what it actually renders.

**Testing**: new `desktop-room-header.test.tsx` (10 tests — Home/Events
links, room identity, viewer count, guest vs. authenticated account
state, the shared My Profile/Edit Profile/Log out/Complete Profile
behavior, Room Info's recontextualized accessible name, keyboard
reachability). `desktop-room.test.tsx` gained 6 integration tests
(Home/Events/avatar render as part of the real composition, guest state,
header spans full width as a sibling of the stage+sidebar row not nested
inside either, sidebar width classes unaffected) — all 12 pre-existing
tests in that file pass completely unmodified, confirming the
restructuring preserved every existing contract (heading name,
`room-info-trigger` testid, sidebar responsive width). Added an explicit
mobile-regression test to both `portrait-room.test.tsx` and
`mobile-landscape-room.test.tsx` — confirms `desktop-room-header`
never renders and the compact trigger stays the only entry point.

**Real browser walkthrough** (local dev server, real Supabase-backed
test account, deleted afterward, dark mode emulated): confirmed the
header at 1440×900, 1920×1080, 1366×768, exactly at the 1024px
breakpoint edge, and 1000px (correctly falls back to compact mobile-
landscape chrome, no header at all). Clicked "Virtual Stage" from inside
a room — landed on Home directly, no hamburger involved; re-entered,
clicked "Events" — landed on Browse Events directly. Opened the account
avatar menu — same My Profile/Edit Profile/Log out behavior confirmed
live, logged out successfully from inside the room. Re-entered as a
guest — confirmed Virtual Stage/Events/viewer count still shown, Log
in/Sign up in place of the avatar, no forced account UI, guest-name
editor in the sidebar unaffected. Opened Room Info from the new
header's own trigger — confirmed unchanged content, correctly
positioned beneath the new persistent header with no overlap. Confirmed
the Session Simulator panel (position, buttons, expanded/minimized
state) and the Discussion sidebar's own alignment were unaffected at
every size tested. Confirmed mobile portrait (390×844) shows the
compact status-pill trigger only, no persistent nav — the existing
unrelated guest-identity pill visible there is pre-existing chrome this
pass never touched. All test data cleaned up afterward.

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean, full suite clean: **96 files / 1286 tests,
   zero failures** (up from 95/1268).
2. **Production interaction** — not applicable this pass; the real-
   browser walkthrough above (local dev server against the real
   Supabase project) is the stronger verification actually performed.
3. **Real-device**: not flagged as requiring iPhone testing this pass —
   this is a desktop-only change; mobile is provably unaffected (the
   new header is structurally absent below the existing 1024px gate,
   confirmed by both the regression tests and a real-browser check), so
   there is nothing here a phone could exercise differently from the
   desktop-browser confirmation already performed.

Not merged to `main`. Fresh preview to be deployed and linked in the
handoff.

---

## 2026-09-04 — Session 64: Responsive/accessibility polish pass — Room Info's unreachable landscape close button, a real accent-filled contrast fix, guest-header wrapping (issue #29-adjacent, real-device bug report)

**Goal**: a narrow fix pass on top of Session 63's Room Info redesign
and visual identity work, driven by a real iPhone landscape bug report
(the close button was completely unreachable) plus two already-known
small items from the previous handoff's own honest self-report (a
contrast near-miss, a header-wrapping observation). No redesign, no
core live-stage changes.

**Root-caused the landscape bug before touching anything**, per the
pass's own explicit instruction: the previous `RoomInfoOverlay` put its
header (title + ✕) inside the *same* single `overflow-y-auto` flex
column as every other section — nothing pinned it. Landscape exposed
this for two compounding reasons: a ~390px-tall viewport hits the
sheet's `max-h` cap far more often than portrait's ~844px does, *and*
mobile Safari's dynamic address bar — present far more of the time in
landscape, consuming a much larger fraction of an already-short
viewport — means plain `vh` units (computed against the largest-
possible, chrome-hidden viewport) can size a sheet taller than what's
actually visible before any scrolling even happens.

**Fix, two independent layers**: switched `max-h-[85vh]`/`max-h-[75vh]`
to `dvh` (tracks Safari's real visible viewport) — narrows the problem
but doesn't structurally eliminate it — and restructured the sheet into
a `shrink-0` sticky header above a `min-h-0 flex-1 overflow-y-auto`
content region, which is the fix that actually *guarantees* the close
button can't scroll out of view regardless of content height,
orientation, or any future viewport quirk. Added `overscroll-behavior:
contain` on the content region so a fully-scrolled sheet can't chain
its scroll into the stage underneath. Bumped the close button from 36px
to this project's own established 44px minimum while already touching
the markup. `Home` and `✕` stayed deliberately distinct actions
throughout (confirmed via a new test: tapping Home never calls
`onClose`).

**Contrast fix**: the previous pass's own honest report — dark-mode
white-on-`--accent` for a filled button measured 4.37:1, just under AA's
4.5:1 — got a real fix, not a rounding-up. Since no single color can hit
4.5:1 against both a near-black background (for text/links) and white
overlaid text (for a filled button) at once, a genuinely distinct token
pair was needed: new `--accent-filled` (`#4f63f0`, white-on-it =
**4.80:1**) and `--accent-filled-hover` (`#3f50d9`, white-on-it =
**6.25:1** — hover *darkens* here, deliberately the opposite direction
from `--accent-hover`'s brightening, since brightening would have made
an already-marginal contrast worse). Light mode needed no change (its
existing `--accent` already passes both directions comfortably, so
`--accent-filled` is just aliased to it there). Scope: only `Button`/
`ButtonLink`'s `primary` variant changed — `--accent` itself and every
text/icon/focus-ring/soft-background usage elsewhere is untouched, so
this is a filled-button-specific fix, not a second brand-color change.

**Guest header wrapping fix**: root cause was simply too little space at
~375-390px for four items (wordmark, Events, two full-padding buttons)
at the original spacing, with no `whitespace-nowrap` anywhere to prevent
the browser's default flex-shrink-then-wrap behavior. Tightened spacing
below the `sm` breakpoint only (restored above it), added explicit
`whitespace-nowrap` to the wordmark and both guest buttons. Scoped
entirely to the guest branch of `SiteHeader` — the authenticated
branch (a single avatar) was untouched and confirmed unaffected.

**Testing**: `room-info-overlay.test.tsx` gained a dedicated "close
control always reachable" describe block (structural sibling check
confirming the header isn't nested inside the scrollable region, close
button survives a long expanded description and a full signed-in
account section, 44px touch target, `dvh` present in the class list) —
5 new tests — plus a Home-vs-✕ distinctness test. New `button.test.tsx`
(4 tests) guards the `accent-filled` token usage on the primary variant
specifically. New `site-header.test.tsx` (4 tests, the first ever for
this component — calling the async Server Component directly and
rendering its resolved JSX, mocking `@/lib/supabase/server` and
`getOwnProfile`) covers the `whitespace-nowrap` contract on the guest
branch and confirms the authenticated branch is unaffected.

**Real browser walkthrough** (local dev server, real Supabase-backed
test account, deleted afterward): reproduced the exact reported
scenario — a demo room with a deliberately long description, opened
Room Info at 844×390 (the classic iPhone landscape size) — confirmed ✕
visible immediately, confirmed it stays visible after scrolling the
sheet's content all the way to the bottom (Log out and all), closed
successfully with room/stage state intact. Repeated at 932×430. Tested
orientation change *with the sheet open*: portrait (390×844) → rotate
to landscape (844×390) — ✕ stayed visible and reachable, no
remount, no lost state; and the reverse, landscape (932×430) → rotate
to portrait (430×932) — same result. Confirmed Escape and backdrop-click
dismissal both still work (existing mechanisms preserved, not just the
new close button). Confirmed the desktop popover (1440×900) is
unaffected — full content fits, Log out visible and red at the bottom.
Confirmed the guest header at 375px and 390px: "VIRTUAL STAGE" and
"Log in"/"Sign up" all stay on one line, no horizontal overflow;
confirmed the authenticated header (single avatar) unaffected at the
same widths. All test data cleaned up afterward.

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean, full suite run clean this time: **95 files /
   1268 tests, zero failures** (up from 90-93/93 files with a handful of
   pre-existing environmental flakes the last two sessions — this run
   had none, consistent with those being transient rather than
   structural).
2. **Production interaction** — not applicable this pass; the real-
   browser walkthrough above (local dev server against the real
   Supabase project, reproducing the exact reported bug scenario) is the
   stronger verification actually performed.
3. **Real-device**: **UNVERIFIED — requires an actual iPhone**, per this
   project's own three-tier discipline — automated and local-browser
   confirmation are not a substitute for the real Safari/hardware
   confirmation this bug was originally reported from. See the
   handoff's three-item checklist.

Not merged to `main`. Fresh preview to be deployed and linked in the
handoff.

---

## 2026-09-03 — Session 63: Visual identity + Room Info UX pass — a new blue-violet brand palette and a redesigned Room Info sheet (issue #29-adjacent, real-user feedback)

**Goal**: two closely related real-feedback-driven changes: (1) redesign
the Room Info overlay's information hierarchy (it read as a developer/
settings drawer on a real iPhone) and (2) replace the near-black +
saturated-orange visual identity (real user feedback: an unwanted,
specific resemblance to an adult-content site) with a distinctive
palette — explicitly not a single hex swap, a real semantic token system.
No core live-stage behavior touched.

**Color system**: audited `globals.css` first — found only 5 loose
tokens (`background`/`foreground`/`accent`/`muted`/`border`), no
elevation tiers, no functional-state tokens. Added `surface`/
`surface-elevated`/`surface-hover`, `secondary` (a real second text
tier alongside `foreground`/`muted`), `border-strong`, `accent-hover`/
`accent-soft`, `success`/`warning`/`danger`, and `vote-continue`/
`vote-replace`. New accent: blue-violet ("electric indigo"), light mode
`#3b4cd1` / dark mode `#5468ff` — computed actual WCAG contrast for every
candidate rather than eyeballing hex values (see DECISIONS.md for the
full math, including the proof that dark mode's near-black background
and white button text can't both hit 4.5:1 against the same accent
value simultaneously — an honest, reported near-miss on the primary
button's white-text contrast, not silently rounded up).

**Orange audit**: classified every real usage — BRAND (the `--accent`
token itself, `.stage-overlay`'s own accent override, and one hardcoded
`rgb(251 146 60...)`/`orange-400` bubble in `ambient-comments.tsx`'s
"requesting to speak" badge, migrated to `color-mix(in srgb, var(--accent)
…, transparent)` so it now moves with the token) vs. STATE/DECORATIVE
(the diagnostics banner's amber warning, the Session Simulator's own
orange/amber preview-only tool colors — both left unchanged, neither is
user-facing brand identity). `speaker-vote-panel.tsx`'s hardcoded
`emerald-500`/`red-500` became named `vote-continue`/`vote-replace`
tokens at the identical values — a pure refactor, zero visual change,
satisfying "preserve state semantics, don't re-theme everything blue."
Because nearly everything else in the app already referenced `text-
accent`/`bg-accent`/`Button`'s own variants rather than hardcoding
color, most of the app (home page CTA, links, focus rings, profile
pages, Follow button, live-room mic/comment controls) picked up the new
palette automatically from the `globals.css` change alone — confirmed
directly in the browser, not assumed.

**Room Info redesign**: reorganized into three visually distinct
groups — room identity (status dot + name, clamped description with a
length-heuristic "Show more"), navigation (`Home`/`Browse Events` as
real icon+label+description rows, not plain breadcrumb text), and
account (the holder's own avatar+name+@username leading, `My Profile`/
`Edit Profile` grouped tightly beneath, `Log out` demoted to small
secondary/destructive text so it stops competing with the account
holder's own name). The account avatar is a new, independently optional
`identityAvatarUrl` prop threaded from `events/[id]/page.tsx`'s own
`getOwnProfile` read down through `EventRoom` — deliberately not a
widening of the shared `Identity` type (which already required a
mechanical touch of ~11 test files once, for `username`, in an earlier
pass) for a field only this one component needs. Both the mobile bottom
sheet and the desktop popover share the exact same section markup, so
"same information architecture on both" holds by construction.

**A real lint fix, matching this codebase's own established pattern**:
resetting the description's expanded state on re-open needed a `useState`
+ `useEffect`, and `RoomInfoOverlay` doesn't actually unmount on close
(its own JSX conditionally returns `null`, the component instance
persists) — a synchronous `setState` in that effect triggered the
project's `react-hooks/set-state-in-effect` rule. Fixed with the same
`async function` + `await Promise.resolve()` continuation pattern
`useAutomaticPromotion`/`use-profile-directory.ts` already established
for this exact rule.

**Testing**: `room-info-overlay.test.tsx` extended with 12 new/rewritten
tests — status-dot color per room status, description clamp/toggle
(including reset-on-reopen, correctly awaited past the async effect),
avatar rendering (photo and fallback), `@username`/"Complete your
profile" secondary line. All pre-existing tests in that file pass with
only the expected `Home`/`Browse Events` label updates (already covered
by loose regex matches, so no changes needed there). Full room component
suite (93 files spanning speaker/RTS/round/comment behavior) re-run in
full — all passing.

**A note on this session's real-database test flakiness**: hit several
transient failures during full-suite runs (`event-speakers-expiration.
test.ts`, `stage-rounds.test.ts`, and others — "seat already occupied,"
a 116ms round-deadline timing overshoot). Investigated properly rather
than assumed: `git stash`-ed this pass's own changes and re-ran the
identical failing files against the untouched base commit — they failed
there too, and on a second stashed run additionally hit genuine Supabase
auth rate-limiting ("Request rate limit reached") from this whole
session's cumulative real sign-in load. Conclusive proof this is
environmental (test-isolation/timing/rate-limit pressure under a long
session's real-database load), not a regression introduced by this
pass — documented rather than silently retried into a clean number.

**Real browser walkthrough** (local dev server, real Supabase-backed
test account, deleted afterward, dark mode emulated via `page.
emulateMedia` — the variant that actually shows the near-black
background the user's own feedback was about): Home mobile (390×844)
confirmed the header, CTA, and links all render in the new blue-violet,
zero orange remaining; opened Room Info against a demo room with a
deliberately long test description, confirmed the clamp/"Show more"/
"Show less" toggle, the icon-and-label Home/Browse Events rows, and the
account identity block with a real avatar; followed My Profile and Edit
Profile to confirm both inherit the palette automatically; returned to
the live room and confirmed the composer/mic/reaction chrome and the
"Tap to join" placeholder text render in the new accent, with the
preview-only Session Simulator panel correctly untouched. Repeated Room
Info in mobile landscape (844×390, no clipping, scrollable) and desktop
(1440×900 popover — Home/Browse Events/account block/My Profile/Edit
Profile/Log out all visible, Log out visually small and red at the
bottom). Confirmed the pre-existing guest-header text-wrapping at 390px
(both "VIRTUAL STAGE" and "Log in" wrap to two lines) is unrelated to
this pass — reproduced identically in both light and dark mode, and
this pass touched no header layout/spacing, only color and the Room
Info sheet's own markup. Flagged as an observation, not fixed (out of
this pass's scope).

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean, full suite run twice; the handful of failures
   both times were the same pre-existing, environmentally-confirmed
   flakiness documented above, not this pass's own changes.
2. **Production interaction** — not applicable this pass; the real-
   browser walkthrough above (local dev server against the real Supabase
   project) is the stronger verification actually performed.
3. **Real-device**: **UNVERIFIED — requires an actual iPhone.** See the
   handoff's short checklist.

Not merged to `main`. Fresh preview to be deployed and linked in the
handoff.

---

## 2026-09-02 — Session 62: Profile UX polish pass — home page avatar/account menu, shared account-menu links, clickable Edit Profile avatar (issue #29)

**Goal**: a narrow polish pass on top of Session 61's profile work, driven
by two pieces of real-iPhone feedback: (1) the home page had no visible
way to reach a profile at all, and (2) Edit Profile's avatar + separate
"Add photo" button wasn't an obvious relationship. Explicit constraints:
no profile architecture/schema changes, no core live-room changes, reuse
the existing upload pipeline verbatim, and — unlike the previous pass —
actually perform the requested real-browser walkthrough this time.

**Home page avatar**: `SiteHeader` now fetches the signed-in visitor's
own `getOwnProfile` row (same repository function Edit Profile/the public
profile page already read — no separate cached identity state) and
renders a new `HomeAccountMenu` in place of the old bare email + full-
width "Log out" button. Tapping the avatar opens a small, right-anchored
dropdown — My Profile / Edit Profile / Log out, or a single "Complete
Profile" for an account without a username yet (never a link to a public
profile page that doesn't exist). Closes on Escape, an outside click, or
tapping any of its own links. A `-m-1 p-1` trigger brings the actual tap
target to 44px (this project's own established minimum) without visually
enlarging the 36px avatar. Guest header is completely untouched.

**Shared `AccountMenuLinks`**: the actual "where do these links point"
logic was extracted into one small component, used by both
`HomeAccountMenu` and the room's own `RoomInfoOverlay` — which previously
had a single hardcoded "My Profile" link that hadn't been updated for
this pass's "Complete Profile" wording. Audited and swapped in, rather
than left to drift into inconsistency with the new home menu. See
DECISIONS.md for why this is a small shared component and not a reuse of
`RoomInfoOverlay` wholesale (it's a full room-info sheet, not a small
account menu, and forcing the home header into that shape would be the
"broad rewrite to deduplicate a few lines" the pass's own instructions
warned against).

**Edit Profile avatar**: the avatar circle in `AvatarEditor` is now a real
`<button>` wrapping `ParticipantAvatar`, calling the exact same
`inputRef.current?.click()` the old "Add photo" button called — same
`uploadAvatar`/`saveAvatarUrl`/`deleteAvatarFile`/`removeAvatar` pipeline,
completely unchanged. A small `aria-hidden` camera-emoji badge (📷,
matching this app's existing emoji-icon language) is purely decorative;
the real accessible name lives on the button (`aria-label`, "Add profile
photo" / "Change profile photo" depending on whether one exists already).
The large standalone "Add photo"/"Change photo" button is gone; "Remove
photo" survives as small secondary text, shown only once a photo exists.
A real `<button>` gets keyboard activation (Enter/Space) for free — no
extra key-handling code needed.

**Testing**: new component suites for `HomeAccountMenu` (10 tests —
photo/fallback avatar, opens on tap, correct links per profile-
completeness state, closes on second tap/Escape/outside-click/link-tap,
Log out reachable), `AccountMenuLinks` (4 tests — the two link-set states,
never linking to a broken profile route, `onNavigate` firing), and
`AvatarEditor` (11 tests, rewritten for the new interaction — correct
accessible label in both states, fallback avatar renders inside the
trigger, clicking/keyboard-focus-then-Enter both open the file picker
whether or not a photo already exists, real `<button>` tag, the existing
upload/error/remove pipeline is exercised unchanged, the old large
button no longer exists). `room-info-overlay.test.tsx` updated for the
new Complete Profile / My Profile+Edit Profile split.

**Real browser walkthrough — actually performed this time** (the previous
pass's stated gap): local dev server, two real Supabase-backed test
accounts (one with a username, one without — both service-role-created
and deleted afterward). Mobile viewport (390×844): logged in as the
username'd account, confirmed the header avatar (fallback initials,
correct color/label), opened the menu, followed Edit Profile, tapped the
avatar itself (confirmed it opens the native file chooser), uploaded a
real JPEG through it, watched the button label flip to "Change profile
photo" and a "Remove photo" control appear, watched the *home header's
own avatar* update live on the same page load (a Server Action's
automatic route-tree refresh re-rendering the root layout, not anything
built for this pass — confirms Section 9/10's identity-consistency and
back-navigation requirements were already satisfied by the existing
architecture), saved, landed on the public profile page, navigated Home,
confirmed the new avatar persisted there, reopened the menu, and
confirmed Log out actually works (back to the guest header). Logged in
separately as the no-username account and confirmed the menu shows only
"Complete Profile," routing to `/profile/edit` with a "Complete your
profile" heading and a Cancel link correctly pointing at `/` (no username
to fall back to) rather than a broken profile route. Desktop (1440×900)
and mobile-landscape (844×390) both re-confirmed the same header/menu
render with no clipping or overflow. Confirmed keyboard activation
specifically (Shift+Tab to focus the avatar trigger, Enter to activate)
opens the same file chooser. Also opened a real room (via `/dev`'s demo-
event tooling) and confirmed `RoomInfoOverlay`'s account section now
correctly shows "Complete Profile" through the shared component. All test
accounts, uploaded files, and the demo event were deleted afterward; the
shared sandbox test room was cleared.

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean, full suite **93 files / 1246 tests, all
   passing** (up from 90/1221 before this pass).
2. **Production interaction** — not applicable this pass; the real-
   browser walkthrough above (tier 3, against a local dev server backed
   by the real Supabase project) is the stronger verification actually
   performed, superseding a plain fetch-based production-interaction
   check for this UI-behavior-focused pass.
3. **Real-device**: **UNVERIFIED — requires an actual iPhone.** See the
   handoff's short checklist.

Not merged to `main`. Fresh preview to be deployed and linked in the
handoff.

---

## 2026-09-02 — Session 61: First profile/social-identity pass — username, avatar, bio, social links, follow system, live-room identity linking (issue #29)

**Goal**: an entirely new, large scope shift off issue #21's corrective-
pass track — build a real but lightweight social profile system per a
27-section specification. Explicit standing constraints: never gate the
core guest experience (only Follow may prompt signup), audit existing
identity architecture before building anything, stay inside the existing
repository/RLS/migration conventions, and stop after a fresh preview —
no merge to `main`.

**Section 0 audit first**: read `lib/identity.ts`, the `profiles` table
and its signup trigger, guest-session cookie handling, and every place
comment/speaker/RTS identity is rendered, before writing anything new.
Confirmed: `profiles` already existed (display name only, no username/
avatar/bio), guests are structurally profile-less by design (unchanged),
and the room already threads identity through several distinct render
sites (`SpeakerTile`, `ExpandedComments`, ambient comments) that needed
to be extended consistently rather than duplicated.

**Data model** (migration `00000000000044`): extended `profiles` with
`username` (unique, case-insensitive via a lowercase-only format check,
reserved-name list, 3–20 chars), `avatar_url`, `bio` (≤160 chars, plain
text), `social_links` (jsonb). New `public_profiles` view exposes an
explicit, minimal column list to `anon`+`authenticated` — deliberately
*not* `security_invoker`, since the base `profiles` RLS stays
authenticated-only on purpose; new `follows` table (composite PK,
`no_self_follow` check, RLS scoped to `auth.uid()`); new `avatars`
Storage bucket (public read, owner-folder-scoped write). Full reasoning
for each in DECISIONS.md.

**Routing**: `/profile/[username]`, not `/@[username]` — confirmed
directly against Next.js's own bundled docs that `@folder` is
exclusively a parallel-route-slot convention before choosing the
fallback the pass's own instructions anticipated. See DECISIONS.md.

**Live-room integration**: new `ProfileLink` wraps whatever avatar
markup a speaker tile/comment row already renders — a real `<a>` (via
`next/link`) with `stopPropagation` on click, so tapping an identity
never also fires the surrounding vote/like/comment/speaker control.
Renders as a plain `<span>` (non-navigable, no visual "Guest" badge) for
a guest or an account without a username yet — same treatment for both,
deliberately. New `useProfileDirectory` hook resolves the set of
currently-visible `profile_id`s (speakers + comment authors + pending
requests) to `{username, avatarUrl}` once per room mount. Wired into
`SpeakerTile` (3 of 4 avatar branches — the "tap to activate media"
button and the simulated-speaker placeholder were deliberately left
alone) and `ExpandedComments` (both the Recent Comments and Top Speaker
Requests rows). **Ambient comments' tiny avatars were deliberately left
non-navigable** — they render as `<button onClick>` rows, and nesting a
real `<a>` inside a `<button>` is invalid HTML; the same message is one
tap away from being profile-linkable in Expanded Comments, so this was
judged the correct scope boundary rather than restructuring ambient
comments' click semantics for this pass.

**Identity semantics, made explicit**: `event_speakers.display_name` /
`event_chat_messages.author_display_name` stay frozen historical
snapshots, exactly as before this pass — a later display-name edit does
not retroactively change already-sent messages or past speaker episodes.
Only the avatar image and the tap-to-profile link are live (queried
fresh via `useProfileDirectory` every render) — reasoned as safe since
neither existed before this pass, so there was no existing snapshot
invariant to break.

**Follow system**: follow/unfollow with a DB-enforced no-self-follow
check and idempotent duplicate handling (composite primary key ⇒ a
duplicate insert is a caught `23505`, not an application-level check).
Follower/following *counts* are correct, live, and guest-visible; actual
follower/following *lists* are explicitly deferred to a future pass per
the spec's own "implement if reasonably small scope, otherwise flag as
deferred" instruction — counts alone were judged the right cut for this
pass's size.

**"My Profile" entry point**: one new link inside `RoomInfoOverlay`'s
existing account-holder branch — routes to the public profile if a
username is set, `/profile/edit` (a "complete your profile" prompt) if
not. No revived site-wide header inside the room.

**Testing**: new real-linked-database suite
(`profiles-and-follows.test.ts`, 16 tests) covering username uniqueness/
case-insensitivity/format/reserved-name rejection at the DB layer, bio
length, cross-account RLS ownership rejection, the `public_profiles`
view's own column boundary (confirms `reliability_score`/
`reputation_score` never leak through it, confirms a username-less
profile is excluded, confirms anon readability), follow/unfollow/
duplicate-follow/self-follow/cross-account-follow-forgery rejection, and
avatar Storage RLS ownership. New pure-function unit tests for
`lib/username.ts` (12 tests) and `lib/social-links.ts` (16 tests,
including explicit `javascript:`/`data:`/`file:`/`vbscript:`/`ftp:`
rejection for the website field). New component tests: `ProfileLink`'s
own stopPropagation contract (4 tests), profile-navigation coverage
added to `speaker-tile.test.tsx` and `expanded-comments.test.tsx`
(including an explicit "tapping the avatar link does not also trigger
the row's own double-tap-to-like" case), and a "My Profile" entry-point
describe block added to `room-info-overlay.test.tsx` (including "never
shown for a guest"). All pre-existing tests for comment/speaker/RTS/
mobile-layout/room-menu behavior pass completely unmodified except
mechanical prop-threading additions (`profileDirectory: {}`) — no
existing assertion was weakened to make this pass's changes fit.

**A real issue-numbering correction mid-pass**: initially labeled every
new doc comment/test description "issue #26," carried over from an
earlier, since-summarized point in this same session. Discovered while
writing this entry that GitHub issue #26 is a *different*, already-
existing feature ("Join Live Audience fast path," unrelated, already
merged into this branch from an earlier session) — confirmed via `gh
issue view 26`. Created the correct issue, **#29**, added it to the
project board, and corrected every reference across this pass's own
changed files (mislabeled files not touched by this pass — `join/
route.ts`, `hero.tsx`, `event-speakers.ts`, `events.ts` — were left
alone, since their `#26` references are legitimately about the real
issue #26). Re-ran lint/tsc after the correction to confirm nothing
besides comment text changed.

**Verification**:

1. **Automated** — `npm run lint` clean, `npx tsc --noEmit` clean,
   `npm run build` clean (both new routes registered:
   `/profile/[username]`, `/profile/edit`), full suite **90 files /
   1221 tests, all passing** (up from 86/1162 before this pass — +4
   files, +59 tests net of this pass's own new/removed tests). Sandbox
   test room cleared before the final run.
2. **Production interaction** — not yet performed this pass (see below;
   the fresh preview deploy and its own smoke check happen after this
   entry).
3. **Real-device** — **UNVERIFIED — requires real-device testing.** See
   the handoff for the full checklist (signup → complete profile →
   avatar → save → reopen → edit → remove a social link → verify
   persistence; a second account's follow/unfollow with count updates;
   a live-room comment → tap avatar → profile opens → return without
   corrupting room state; the guest flow proving zero forced signup —
   iPhone-sized viewport and desktop, both).

Not merged to `main`. Fresh preview to be deployed and linked in the
handoff.

---

## 2026-09-01 — Session 60: Nineteenth corrective pass — a winning RTS candidate's own reservation never cleared, silently blocking a later reopening of the same seat; proven production-reachable, fixed at the source (issue #21)

**Goal**: the eighteenth pass's own flagged finding — a stale RTS
reservation blocking a real vacancy. Explicit mandate: determine whether
this is reachable through normal production flows or only via unusually
rapid simulator force actions, before touching anything. Do not assume
production selection is broken.

**Mapped the reservation lifecycle first**: `is_current_candidate`/
`reserved_seat_number` on `speaker_requests` is cleared by exactly three
paths (withdrawal, a failed claim, a new candidate taking the same
seat) — grepped every migration to confirm these are exhaustive. A
*successful* claim was never among them — `markSpeakerRequestGranted`
only ever updated `status`/`resolved_at`.

**Why this stayed hidden in the ordinary case**: `resetSpeakerCandidatePool`
excludes the winner's own row from its bulk wipe (harmless normally,
since the round it's in gets marked resolved right after). The gap only
surfaces in **dual replacement**: when the *other* seat's own
reservation is still pending, the pool reset **defers entirely** — the
round stays fully active, and the first winner's stale flag survives
inside it indefinitely.

**Reproduced directly against the real linked database — zero simulator
code anywhere in the chain**: both seats open, three candidates frozen
(X→seat 1, Y→seat 2, Z third and unreserved); X claims first (an
ordinary timing difference, not a forced race); the pool reset correctly
defers since Y is still pending; confirmed via a temporary `git stash`
of only the fix that X's own row incorrectly still shows
`is_current_candidate = true` on the pre-fix code (direct before/after
proof); seat 1 reopens again before Y ever claims; a fresh
reconciliation call finds X's stale reservation and refuses to reserve
Z — the exact reported symptom. **Classification: production-reachable**
— confirmed with real evidence, not simulator-only.

**Fix, at the source**: `markSpeakerRequestGranted` now clears
`is_current_candidate`/`reserved_seat_number` in the same UPDATE that
sets `status: 'granted'` — safe by construction, since this runs
strictly after the claim itself already succeeded and independently
re-validated eligibility (the exact "successful claim losing
authorization before completion" race the pass's own instructions
warned against is structurally impossible here). Paired defense-in-
depth: migration 43 adds a `status = 'pending'` guard to
`reserve_speaker_candidates_for_seats`'s own "already reserved" check.
Dual-replacement isolation re-verified explicitly — the fix only ever
touches the winning row's own fields; the other seat's reservation is
proven byte-for-byte unchanged throughout.

**Observability**: `useSpeakerSelectionReconciliation` gained a
`SpeakerSyncDiagnostics`-shaped accessor (before/after reservation
snapshots, last reconcile time), surfaced in the debug snapshot as two
new sections — RESERVATION LIFECYCLE (per-reservation target seat,
round, created time, eligibility, occupancy match, validity) and
SELECTION RECONCILIATION. Preview/dev only.

**Verification**: full suite (1162 tests, 86 files — up from 1153/84),
lint, tsc, build all clean. New real-database tests cover the
reproduction, withdrawal/Cancel advancement, failed-claim release,
third-party-claim rejection preserved, one-seat-per-reservation,
duplicate-reconciliation idempotency, and concurrent reconcile-vs-claim
safety, plus new hook-level diagnostics tests. Live-browser verification
(fresh dev server, real demo event, unscripted simulator run): a natural
decisive replacement, a natural Final-30 expiration, then a deliberate
rapid-fire stress test (several Force Replace/Resolve Round Now clicks
in quick succession, producing a genuine simultaneous both-seats-closing
state and seven round-boundary renewals back to back) — RESERVATION
LIFECYCLE stayed clean throughout, and the resulting dual replacement
correctly reserved two distinct candidates with no stale state
surfacing anywhere. Not merged to `main`; fresh preview deployed.

---

## 2026-09-01 — Session 59: Eighteenth corrective pass — `event_speakers_active`'s frozen columns were silently dropping five round-lifecycle fields from every client, breaking Final-30's automatic replacement (issue #21)

**Goal**: the narrow, dedicated follow-up the seventeenth pass's own
finding flagged — a narrow-loss seat correctly entered `closing`, but
its 30s grace window never automatically finished for a real
participant. Fix the data plumbing only, not a Final 30 redesign.

**Proved the view problem first**: local migrations show
`event_speakers_active` (migration 18) as `select * from event_speakers
where ...`, created before migration 21 added five columns
(`round_number`, `round_started_at`, `round_ends_at`, `round_phase`,
`closing_ends_at`). Confirmed directly against the *live* database's own
generated types, not just the migration files: the view's `Row` type had
exactly 11 columns before this fix — all five migration-21 columns
absent, not just the two (`round_phase`/`closing_ends_at`) the previous
pass's own finding named. `speaker-vote-panel.tsx`'s own `roundKey`/
`nearestDeadlineMs` had the identical, previously-unnoticed gap.

**Precisely characterized the failure, not just described it**:
`useActiveSpeakers`'s Realtime subscription reads off the *base table*
directly (Postgres CDC bypasses views entirely) — so every live
INSERT/UPDATE delta already carried all 16 columns correctly, the whole
time. It was specifically every *reconcile* (on-SUBSCRIBED,
visibility/focus, the 20s backstop) — reading the stale view — that
clobbered a just-delivered-correct `round_phase: "closing"` back to
`undefined` moments later. This is why the seventeenth pass's own
reproduction looked the way it did: the client learned correctly, then
had it taken away again, canceling `useStageRoundResolution`'s
already-scheduled replacement timer. Confirmed `speakerRoundDisplay`
already derives its countdown purely from the authoritative arguments
passed in, no local timer state — a pure data-plumbing bug, zero
display-logic changes needed.

**Fix**: `create or replace view` with an explicit column list (not
another `select *`, to prevent this exact drift recurring silently) —
reproduces the original 11 columns in their original order, appends the
five migration-21 columns at the end. No SQL-level dependents existed to
break (confirmed by grep); this is the only view in the entire schema.
Every newly-exposed column is the same public visibility tier as the
rest of the row — nothing sensitive newly surfaced. Simplified the
Session Simulator's debug snapshot (removed a now-redundant base-table
workaround query from the seventeenth pass), added a FINAL 30 / CLOSING
STATE section (authoritative vs. client side by side).

**Verified with a real, unscripted, natural expiration — no Force
Replace Now.** Narrow-loss resolved via real vote-casting; the seat
entered `closing` with authoritative/client state matching exactly
(25s remaining both); ~30s later the seat vacated automatically (the
client's own scheduled timer firing on its own); a replacement was
deterministically reserved and seated; the shared round resumed active
— the whole vacancy-to-resumed-pairing cycle took about 3 seconds,
entirely without intervention. Migration 41's shared-round invariant
reconfirmed throughout: active while merely closing, legitimately
demoted only once the seat genuinely vacated. A real browser reload
mid-countdown showed the remaining time derived from the authoritative
deadline, not reset to 30 — also pinned deterministically at the hook
level (same `closing_ends_at`, called 12s apart: 30s then 18s).

**Found, deliberately not fixed**: an unusually rapid sequence of manual
test actions left one Request-to-Speak reservation stuck pointing at an
already-refilled seat, blocking that vacancy's own selection
reconciliation. Confirmed unrelated to `event_speakers_active` (RTS
reservation logic never reads that view) — a separate, pre-existing
selection-reconciliation edge case, flagged for whoever picks up RTS
selection edge cases next, not folded into this pass.

**Verification**: full suite (1153 tests, 84 files — up from 1149/84),
lint, tsc, build all clean. New tests: three real-database tests reading
through `event_speakers_active` directly (narrow-loss fields visible
through the view; both seats independently closing each get correct
fields; voluntary leave before deadline doesn't produce a duplicate
resolution), plus the countdown remount/refresh test. Not merged to
`main`; fresh preview deployed.

---

## 2026-09-01 — Session 58: Seventeenth corrective pass — a closing seat was demoting the *shared* round for both speakers even though the pairing stayed fully intact (issue #21)

**Goal**: new real-device snapshot — both seats authoritatively
occupied by the same two speakers, canonical client state matching
perfectly, yet the shared round stuck in `awaiting_pairing` with the
60s timer gone. Explicit ask: trace the actual writer (don't assume),
define the legal round state machine first, distinguish legitimate vs.
broken `active→awaiting_pairing` transitions, and don't just force the
timer visible.

**Trace**: `stage_rounds.phase` has exactly one writer in the whole
codebase, `ensure_stage_round` — confirmed by exhaustive grep, not
assumption. It required both seats occupied *and* nobody in their own
Final-30 "closing" window before treating the round as active. A
narrow-loss vote outcome puts the losing seat's `round_phase` to
`'closing'` *without vacating it* — still occupied, still part of the
pairing — then `resolve_stage_round` calls `ensure_stage_round` in the
same breath. Both seats were still occupied, but `closing_count` was
now 1, so the function's `else` branch fired and demoted the whole
shared round, hiding the timer for the *continuing* speaker too.

**Design-intent conflict, resolved explicitly.** Migration 24's own doc
comment had documented this exact behavior as deliberate. This pass's
own instructions directly say otherwise ("the two seats still share ONE
authoritative round... must reliably become/stay active"). Treated the
current instruction as authoritative and recorded the reversal as
deliberate in the new migration's doc comment, not silently.

**Proved not a race** (explicitly requested): `ensure_stage_round`
always re-derives occupancy fresh, under a row lock, at the top of its
own execution — no caller can pass in a stale count. Pure SQL logic
bug.

**Fix**: the active-round gate now depends only on both seats occupied
— closing no longer excludes it. The existing renewal condition then
correctly gives the continuing seat a fresh round at the normal
boundary, unaffected by the other seat's own independent 30s countdown.
Added `stage_rounds.last_transition_reason` (written only on an actual
transition, source-tagged by all six callers of `ensure_stage_round`) —
preview/dev diagnostics only, surfaced in the existing debug snapshot.

**Independent confirmation**: a pre-existing real-database test had
been asserting the *old, buggy* behavior as correct — its own failure
after the fix, requiring correction to the new intended behavior, is
evidence the diagnosis was right, not just internally consistent.

**Audited `useStageRound`** for the same stale-observation class fixed
in the sixteenth pass's `useActiveSpeakers` — found on-SUBSCRIBED and
visibility/focus resync already present, added the missing bounded 20s
backstop for consistency (defense-in-depth, not the actual fix, which
is server-side).

**A second, separate, pre-existing bug found live while verifying this
fix — not fixed this pass.** `event_speakers_active` (the view every
live client read of seat state goes through) was defined *before*
`round_phase`/`closing_ends_at` existed as columns; Postgres freezes a
view's `select *` at creation time, so those two columns never actually
reach any client. Concretely: a real speaker's Final-30 grace window
never automatically resolves (`useStageRoundResolution`'s client-side
timer depends on a field that's always `undefined`), and the vote
panel's own closing countdown UI is equally blind to it. Reproduced
live: a simulated seat sat in `closing` across three consecutive round
boundaries with no automatic eviction until manually forced. Flagged
clearly for its own corrective pass — different root cause and fix
shape than this pass's bug, per this project's "name the gap, don't
unilaterally expand scope" discipline.

**Verification**: full suite (1149 tests, 84 files — up from 1145/84),
lint, tsc, build all clean. New tests: `last_transition_reason`
recording, concurrent duplicate `ensure_stage_round` calls not
demoting an active pairing, a redundant reconcile after a narrow-loss
not undoing the round, `useStageRound`'s new backstop. Live-browser
verification (fresh dev server, real demo event, unscripted simulator
run): 7 consecutive rounds — two decisive replacements, one narrow-
loss/closing (the exact bug scenario, confirmed fixed — timer visibly
ticking across three round boundaries while one seat stayed closing),
one full replacement cycle to completion. Not merged to `main`; fresh
preview deployed.

---

## 2026-09-01 — Session 57: Sixteenth corrective pass — canonical stage speaker state now reconciles event-driven off bootstrap's own authoritative confirmation, closing a real 13+ second client/database divergence (issue #21)

**Goal**: with bootstrap now authoritatively succeeding, a new snapshot
showed a different gap — bootstrap's own confirmation coexisting with
the stage-facing client still reporting both seats vacant, 13+ seconds
later. Explicit ask: trace the actual state paths, not a generic
"Realtime timing" explanation; fix event-driven, never a poll or
arbitrary delay.

**Trace**: two separate sources of truth — bootstrap's own direct
`event_speakers_active` read (local to `SessionSimulatorPanel`), and
the *canonical* stage speaker state, `useActiveSpeakers`, which only
updated via incremental Realtime deltas plus a full resync on-SUBSCRIBED
— no bounded backstop, no visibility/focus resync (unlike its sibling
hooks, already fixed for this exact class of bug in earlier passes).
Nothing connected the two; a successful bootstrap claim never told the
canonical hook to look again, leaving it entirely dependent on Realtime
redelivering the same INSERT its own mutation caused.

**Fix**: `useActiveSpeakers` gained one canonical `reconcile(reason)`
(exposed as `refetch(reason?)`), reused by every trigger (SUBSCRIBED,
visibility, focus, a new 20s backstop, and any external caller) —
`SessionSimulatorPanel`'s `establishSeat` now calls it directly, tagged
"bootstrap," immediately after its own authoritative confirmation. No
simulator-specific duplicate speaker store — `EventRoom` passes its own
hook instance's `refetch` straight through as a prop. Found and closed
a second race while building this: overlapping reconciles could let an
older, slower read clobber a newer one — fixed with a monotonic
sequence number, only the most recently *started* reconcile ever wins.

**READY semantics changed**: bootstrap now does one final, bounded,
awaited verification (refetch + check both seats match) before
declaring READY — converges on the first attempt in the ordinary case
since it's a direct authoritative read, not Realtime-dependent. A
genuine non-convergence is reported as a distinct "CLIENT SYNC" failure,
never conflated with a bootstrap failure.

**Safety net, not the fix**: a new `useSpeakerInvariantRecovery` hook
(the inverse of the existing `useStageRoundReconciliation`) fires one
bounded reconcile per round transition when an active round coexists
with fewer than two known local speakers — never a loop, never a poll.

**Why the user's own session self-healed after 13+ seconds**: not
provably certain from the evidence, stated honestly. The pre-fix hook
had exactly one mechanism able to replace its entire stale state at
once (both seats simultaneously, matching what was observed) — a fresh
on-SUBSCRIBED resync, which only fires on initial connect or a real
reconnect. Most likely explanation: a genuine WebSocket reconnect
(network blip, or the tab backgrounding/foregrounding) — the only
trigger the hook actually had.

**Debug snapshot**: new `AUTHORITATIVE SPEAKER STATE` /
`CANONICAL CLIENT SPEAKER STATE` side-by-side blocks, plus `SPEAKER
SYNC` (channel status, SUBSCRIBED/event/reconcile timestamps, reason,
result, mutation source).

**Verification**: full suite (1145 tests, 84 files — up from 1122/82),
lint, tsc, build all clean. New test files:
`use-active-speakers-sync.test.ts` (bootstrap-before-SUBSCRIBED, missed
INSERTs, the stale-fetch race, partial delivery, normal fast path,
removal/replacement without resurrection, sync diagnostics, backstop)
and `use-speaker-invariant-recovery.test.ts`, plus new
`session-simulator-panel.test.tsx` coverage for the bootstrap→reconcile
wiring, CLIENT SYNC reporting, and the new debug-snapshot sections.
Live-browser measurement (fresh dev server, real demo event): Start tap
→ both seats confirmed → stage tiles showing both real names at ~1.9s →
round active ~1.93s → Startup READY ~2.0s — canonical state converged
*before* READY, not 13+ seconds after. A real Open Seat → vacate →
reserve → promote → occupy cycle afterward kept canonical state
correctly synchronized throughout, confirming the real replacement
pipeline is untouched. Not merged to `main`; fresh preview deployed.

---

## 2026-08-31 — Session 56: Fifteenth corrective pass — retired the real-RTS-wait bootstrap path for an already-established stage; unified authoritative bypass bootstrap with stale-generation cleanup (issue #21)

**Goal**: the simulator still needed repeated Reset→Start attempts on an
already-established room, even after the fourteenth pass's fixes. A new
snapshot showed startup submitting real Request-to-Speak requests for
its two bootstrap candidates, then timing out waiting for the real
deterministic RTS system to select them — it never did, because a
*stale* request from an earlier, superseded generation ("Calm Wolf")
won the tie-break instead. Explicit ask: prove/disprove that bootstrap
and testing the real replacement system are two conflated jobs, and if
so, separate them with a preview-only bootstrap bypass that never
evicts a real participant and never weakens `claim_speaker_seat`.

**Diagnosis confirmed**: the fourth pass's own "Case B" (established
stage seeds via real Request-to-Speak + bounded-retried
`simulateAdvanceSelection`, deliberately never bypassing production's
authorization model) asks the real, competitive system to eventually
choose two specific identities it has no obligation to pick — a vacancy
may not exist, the round may still be active, and other eligible
candidates (including uncleaned stale ones) can correctly outrank the
fresh attempt. Case B was exercising the real system correctly; it was
never suited to be a bootstrap mechanism.

**Fix — one unified, authoritative bootstrap path.** Every seat now
uses the same bypass-claim-and-self-heal mechanism the fourteenth pass
already proved for a fresh stage, regardless of established mode. Not a
new capability: `claim_speaker_seat`'s own bypass flag was always
documented for exactly this ("the Session Simulator's own
`simulateSeedSpeaker` bootstrapping adapter," no established-mode
qualifier) — only this component's client-side branching declined to
use it once `round_number >= 1`. Migration 24's "never steal an
occupied seat" guard is unconditional and untouched. Added an
authoritative pre-check before any mutation, so a redundant re-seed
recognizes an already-correct seat immediately.

**Fix — stale-generation cleanup runs before every bootstrap.**
`cleanupStaleSimulatorRequests` withdraws every pending Request-to-
Speak whose guest id belongs to this tab's own historical simulator set
(same ownership boundary Reset already uses) via the real "Cancel
Request" pathway, before seeding — a no-op when there's nothing stale.
This is what makes repeated Start presses stop accumulating candidates
that can silently win a future tie-break.

**Recovery, not rollback**: a partial bootstrap failure (one seat
succeeds, the other blocked by a real participant) leaves the
successful seat as-is rather than rolling it back (which could disrupt
a real pairing `ensure_stage_round` may have already formed) — the next
bootstrap attempt's own self-heal recovers it cleanly, no Reset needed.
Proven end-to-end, real database, in `simulator-startup.test.ts`.

**Debug snapshot**: the fourteenth pass's own "Seat N authoritative"
fields were re-fetched live, so a real later replacement looked like
startup drift. Fixed by freezing bootstrap-time facts once
(`Initial bootstrap Seat N`), leaving the pre-existing live section
untouched. Added bootstrap mode/generation, stale-generation/request
counts, and a non-simulator-occupant blocker line.

**Security**: no server-side change at all this pass. The bypass's only
callers remain gated by `assertSimulatorAvailable()`'s server-side
`isPreviewOrDevBuild()` re-check on every call — proven by this
codebase's existing, unmodified "refuse to run on production" tests.
Real production claim paths still always pass `bypassSelectionAuthorization:
false`, unchanged.

**Verification**: full suite (1122 tests, 82 files — up from 1118/82),
lint, tsc, build all clean. New real-database tests prove: bypass claim
succeeds on an established stage; a real participant blocks bootstrap
for exactly one seat, the other bootstraps normally; the full partial-
failure → participant-leaves → clean-recovery sequence with no Reset;
and a real post-bootstrap vacancy flows through the unmodified real RTS
pipeline, never the bootstrap bypass. Live browser: started once
(fresh, succeeded), stopped, started again *without Reset* on the now-
established stage — the exact previously-broken sequence — watched it
self-heal both seats' leftover occupants automatically within one Start
press, reaching Running, with the new bootstrap diagnostics confirmed
live in a real Copy Debug Snapshot capture. Replacement/vacancy
(ninth-twelfth), RTS/weighted-selection (thirteenth), and Reset/
re-entrancy/React-#441 (fourteenth) work confirmed untouched by diff
scope. Not merged to `main`; fresh preview deployed.

---

## 2026-08-31 — Session 55: Fourteenth corrective pass — simulator startup made idempotent and self-healing; React #441 grounded to a real, redacted Server Action error; a genuine Reset-follow-up race closed (issue #21)

**Goal**: a third, separate real-device pattern, isolated from the now-
healthy replacement/RTS work: the Session Simulator sometimes needed two
or three Reset→Start attempts before becoming useful, instead of "Reset
once → Start once → simulator becomes useful." A real-device snapshot
showed startup logging "Seat 1 seed failed: Minified React error #441"
and a half-established failure, yet the same log later showed that same
seat's occupancy transition — meaning a mutation startup believed had
failed had actually succeeded. Explicit instruction: don't assume the
cause, prove it; don't touch the working replacement/RTS architecture.

**React #441, grounded**: fetched React's real error-codes table for
this project's installed version (19.2.8) — #441 is React's own generic
"an error occurred in the Server Components render... the message is
omitted in production builds," i.e. exactly what any thrown `Error`
inside a Next.js Server Action looks like once a production build
redacts it client-side. Read `claimSpeakerSeat` and `claim_speaker_seat`
(migration 35) directly: a bypass claim throws a real, specific,
authoritative error ('seat already occupied' / 'identity already holds
a seat') — #441 was never a client bug, just production redaction
hiding a real message. Proven directly against the real database.

**The actual gap**: `establishSeat`'s Case A branch decided success
solely from whether the mutation promise threw or resolved, never from
authoritative state. A leftover occupant from an earlier incomplete
Start (one seat succeeded, the other failed, so `running` never
flipped true and nothing cleaned up the successful seat) collided with
every retry on the same seat number, deterministically, since the stage
genuinely never finishes pairing without a Reset. Fixed: every seed
attempt is now followed by a fresh authoritative
`event_speakers_active` read — an intended-identity match is treated as
a real success (never retried); a leftover simulator-owned occupant
(tracked via `allSimulatedGuestIdsRef`) is cleared via the existing
`simulateOpenSeat` adapter and retried (bounded, `MAX_SEED_ATTEMPTS =
2`); anyone else is never evicted (could be a real participant) —
startup reports a precise `FAILED PHASE/ATTEMPTS/EXPECTED/
AUTHORITATIVE/LAST ERROR/RECOVERY` detail instead of a generic message.

**Two structural races closed alongside it**: a synchronous
`startupInFlightRef` re-entrancy guard (checked before any `await`,
since `SimButton`'s own executing-disables-itself state depends on a
React re-render that's never synchronous with the triggering click —
proven with a same-`act()`-batch double-dispatch test, which two
sequential `fireEvent.click` calls would have hidden); and a
`resetInFlightRef` Reset-Start barrier closing the window where Reset's
own synchronous `running=false` would otherwise re-enable Start before
its database deletes actually land.

**A third, real, narrow Reset race found while investigating**: the
guest-scoped deletes in `resetSimulatorSession` were always exact (fresh
UUIDs can't collide with an old run's list), but its `stage_rounds`
reconciliation (delete if occupancy is 0, else resync) was never
guest-scoped at all — decided purely from current global occupancy. The
panel's own ~2s delayed follow-up sweep calls this same function again
for the *old* run's ids — if a *new* run's occupancy is transiently zero
at that exact moment, the follow-up would delete the *new* run's own
round row, unrelated to the old ids entirely. Proven deterministically
against the real database (a directly-inserted round row genuinely gets
deleted at zero occupancy, regardless of whose ids were passed). Fixed:
`resetSimulatorSession` gained `reconcileStageRound` (default `true`,
unchanged for the primary pass); the delayed follow-up sweep now passes
`false`.

**Debug snapshot**: kept the T0/T1 architecture exactly as established.
Added a `SIMULATOR STARTUP` block — state/phase/run-generation-id/
reset-in-progress/reset-generation/startup-attempt/per-seat intended vs.
authoritative occupant/last error/pending-cleanup — so the next
real-device report is immediately diagnosable.

**Verification**: full suite (1116 tests, 82 files — up from 1103/81),
lint, tsc, build all clean. New real-database coverage
(`simulator-startup.test.ts` + additions to `simulator-actions.test.ts`):
the real "already occupied" error message, the leftover-seat
clear-and-reclaim flow, a genuine concurrent-claim race (exactly one
winner), the `reconcileStageRound` fix proven both ways, and a 20-cycle
Reset→Start stress test at 20/20 first-attempt successes. Live browser:
two consecutive first-try Reset→Start cycles against a real dev server,
new log lines and the new `SIMULATOR STARTUP` snapshot block confirmed
rendering correctly. Replacement/vacancy (ninth-twelfth passes) and
RTS/weighted-selection (thirteenth pass) work confirmed untouched by
diff scope. Not merged to `main`; fresh preview deployed.

---

## 2026-08-31 — Session 54: Thirteenth corrective pass — RTS vote-count drift traced to a real Realtime delivery gap and closed with a bounded backstop; "weighted selection" confirmed stale wording only (issue #21)

**Goal**: a narrow, diagnostic pass on two smaller issues with the now-
healthy replacement architecture: recurring client/database RTS vote-
count drift, and whether "weighted selection" in the activity log was
stale text or stale logic. Explicit instruction: do not touch the
replacement/vacancy architecture unless directly implicated.

**Vote-count drift**: traced the full lifecycle before writing anything.
`cast_speaker_request_vote(_as_guest)` is a real DELETE then a real
INSERT for a transfer, never an UPDATE — `useActiveSpeakerRequests`'
own handlers already handle both correctly; no logic bug found. The
real gap: neither of its two existing resync triggers (on-SUBSCRIBED,
visibility/focus) can ever catch a single WAL message silently dropped
in transit without the connection itself closing or the tab
backgrounding — a known failure mode on cellular networks, and exactly
how both real-device captures were taken (long, continuously-visible,
continuously-connected sessions). Fixed with a bounded 20s backstop
resync, explicitly secondary to the instant Realtime path — the same
precedent `useAutomaticPromotion`'s own backstop poll already
established. Proven with fake-timer tests: a drifted count converges
via the interval with no other trigger firing, and the interval
doesn't fire early.

**"Weighted selection" audit**: searched the whole codebase for every
variant of the term. Confirmed directly (not assumed) that
`lib/speaker-selection.ts` no longer exists and `freeze_speaker_candidates`'
own SQL ranking has no randomness anywhere. Every remaining "weighted"
mention was either two live, user-visible activity-log strings (the
actual source of the confusion) or comments/test names correctly
contrasting current deterministic behavior against the retired system
by name. Renamed the two live strings and the handful of genuinely
stale mentions; left the correctly-contrasting ones alone. Proved
determinism directly against the real database: same vote arrangement
selects the same winner across 5 independent rounds; a genuine 5-5 tie
selects the earlier request across 5 independent rounds; the client's
live ranking matches the authoritative ranking both before and after a
real vote transfer.

**Debug snapshot**: the twelfth pass's single-line RTS vote-count
mismatch check became a dedicated `RTS COUNT MISMATCH` block per
candidate (name, both counts, signed delta, both ranks), with an
explicit `PROSPECTIVE RANKING MISMATCH` call-out when the rank itself
differs.

**A real bug found in the test harness, not the product**: an early
version of the repeated-selection test left both seats vacant between
attempts, correctly triggering the atomic dual-seat reservation (top
two candidates, two distinct seats) — the test only checked seat 1 and
misreported a "wrong winner." Fixed by keeping a stable filler on seat
1; this incidentally re-confirmed dual-seat reservation is still
working exactly as designed.

**Verification**: full suite (1103 tests, 81 files — up from 1093/81),
lint, tsc, build all clean. Live browser: confirmed the new log wording
("...promoted (deterministic RTS ranking — #1 by votes)") and the new
`RTS COUNT MISMATCH: none detected` diagnostics live, in a real forced-
vacancy cycle. Not merged to `main`; fresh preview deployed.

---

## 2026-08-31 — Session 53: Twelfth corrective pass — a genuinely stale `speaker_selection_rounds` row could block selection forever, found via the eleventh pass's own two-phase debug snapshot and root-caused against the real database (issue #21)

**Goal**: the eleventh pass's own two-phase debug snapshot did its job —
the user captured a clean, trustworthy real-device failure (591ms T0→T1
latency, no state change during capture, client and authoritative state
in full agreement): established room, one seat freshly vacant, two
eligible RTS candidates, no reservation. Explicit instruction: do not
dismiss this as timing, trace the exact failing transition, do not add
another speculative workaround.

**Root cause, found by querying the real linked database directly**:
the permanent test room had a `speaker_selection_rounds` row frozen two
days earlier, still `status = 'active'`, with zero `speaker_requests`
rows still referencing it. `freeze_speaker_candidates`'s own
idempotency check ("reuse an existing active round, never create a
second one") has no liveness check — it kept reusing this dead round on
every call, silently blocking this event from ever freezing a fresh
round from its own current live pool, regardless of how many new
requests or vacancies happened. Every vacancy path funnels through this
one function, so the bug could defeat reconciliation regardless of
which specific action created the vacancy. Traced why nothing had ever
resolved it: both mechanisms that ever transition a round out of
'active' depend on a *specific* later event happening to that exact
round, and the simulator's own bypass-authorization seed path (used for
initial pairing/re-seeding) never triggers either one. Reproduced the
identical condition directly against the real database before writing
any fix.

**Fix (migration 00000000000040)**: `freeze_speaker_candidates` now
verifies an existing "active" round actually has a live reservation or
a remaining viable candidate before reusing it; if not, marks it
`exhausted` and falls through to create a genuinely fresh round from
the current live pool. Race-safe. Verified directly against the real
database (manufactured reproduction self-heals correctly) and via a
new real-database test file. The actual two-day-old stale round in the
permanent test room was cleared as a one-time courtesy.

**Architecture consistency**: fixed the one remaining vacancy path with
no direct reconciliation trigger (`simulateOpenSeat`, deliberately left
alone in the ninth/tenth passes) the same way as every production path.
Also found and fixed the same gap in `simulateRequestToSpeak` and
`simulateWithdrawRequest` — their production counterparts got this fix
in the tenth pass, but the simulator's own equivalents hadn't. None of
these were provably *the* cause of this specific capture (the exact
triggering transition's own row-level evidence had already been
cleared by later ordinary use of the shared room by the time this
investigation began — reported honestly as unrecoverable, not guessed),
but the root-cause fix closes the underlying bug regardless of which
path a future session uses.

**New diagnostics**: Session Simulator's activity log now records
"OBSERVED" transitions (seat occupancy, reservation, round-phase
changes) purely from prop diffs, regardless of cause — closing the
exact gap that left the original capture's own log ending at startup
info with no clue why a seat had gone vacant. Copy Debug Snapshot
gained "VACANCY DIAGNOSTICS" with explicit `INVARIANT STATUS: OK`/
`VIOLATION` per vacant seat, and RTS vote-count comparison was added to
`STATE MISMATCHES` (the same capture showed a real client/authoritative
vote-count disagreement — 4 vs 3 — that the old mismatch detection
never checked for; now it does, though the root cause of that specific
drift is not investigated this pass, per explicit instruction not to
let it distract from the primary bug).

**Verification**: full suite (1093 tests, 81 files — up from 1082/80),
lint, tsc, build all clean. Real-database: a targeted reproduction test
manufacturing the exact stale-round condition, plus a 20-cycle stress
test in one continuously-running event — real measured vacancy→
reservation latency avg 463ms, max 532ms, well under 3s, every cycle
correct. Live browser: manufactured the identical bug condition against
a fresh demo event, confirmed the Session Simulator's own "Open Seat"
button — the exact real-device mechanism — now self-heals and reserves
correctly (23ms observed), with the new OBSERVED transition log making
the full cause-and-effect chain visible end-to-end. Not merged to
`main`; fresh preview deployed.

---

## 2026-08-31 — Session 52: Eleventh corrective pass — "Next Speaker" redefined as the prospective #1 live candidate, a two-phase T0/T1 debug-snapshot capture, and a live-reproduction audit of a delayed-snapshot vacancy report (issue #21)

**Goal**: the user clarified "Next Speaker" had been answering the wrong
question — they want the prospective #1 live RTS candidate visible
during an active round, with no vacancy or reservation required. They
also reported Copy Debug Snapshot "did not give an immediate usable
result" on a real device, and separately supplied a delayed snapshot
showing a vacant seat with eligible candidates but no reservation —
explicitly warning not to over-interpret it given the capture's own
timing uncertainty.

**"Next Speaker Candidate"**: renamed the old frozen-only section to
"Selected / Committed" and added a new, prominent section above it
showing the live #1/#2 eligible RTS requester (from `pendingRequests`'
own already-correct ordering — most votes, tie → earliest active
request), reactive to vote changes, labeled "prospective — not reserved"
unless a real vacancy has already reserved them. No selection logic
changed — this was a display gap, confirmed by reading
`ensureActiveSelectionRound`'s own unchanged "don't reserve early"
behavior.

**Debug snapshot — two-phase T0/T1 redesign**: the tenth pass's own
version awaited the authoritative fetch before building anything,
including the client-only section that needs no `await` — and meant the
clipboard write only started well after the tap's own user gesture,
exactly the shape several mobile browsers can silently refuse or hang
on. Rewritten: client state captured synchronously at T0 (no await),
authoritative fetch under a 4s bounded timeout, clipboard write under a
3s bounded timeout with a visible, selectable fallback `<textarea>` that
opens automatically when the automatic copy doesn't land — the capture
is never lost regardless of clipboard behavior. Also reports `STATE
CHANGED DURING CAPTURE` and guards against duplicate concurrent
captures.

**Delayed vacancy snapshot — investigated live**: found `simulateOpenSeat`
(the SIM's own vacancy action) never calls a direct reconciliation
trigger — deliberately left out of scope in the ninth and tenth passes
— relying entirely on the production `useSpeakerSelectionReconciliation`
hook, mounted unconditionally in `EventRoom` regardless of SIM `running`
state. Reproduced the user's exact sequence live, repeatedly: reservation
happened correctly and near-instantly (0ms observed in one run) whether
the simulator was running or freshly stopped, confirming Stop does not
block authoritative reconciliation. Found and confirmed a real, distinct
mechanism: *claim completion* for a simulated identity specifically is
gated on `runningRef.current` (SIM-only machinery, no real browser tab
behind a fake identity) — reproduced directly, a reservation made right
before Stop stays legitimately "reserved, not occupied" indefinitely.
This is intended behavior (Stop halts fake-person actions including a
fake claim), not a bug, but wasn't previously documented this precisely.
**Could not reproduce the user's own "Reserved: none" state** through
diligent live testing — most consistent with the delayed snapshot's own
capture-timing uncertainty, reported honestly as unresolved rather than
concluded either way.

**Verification**: full suite (1082 tests, 80 files — up from 1070/80),
lint, tsc, build all clean. One pre-existing, unrelated test flake hit
again during this pass (the shared permanent test room polluted by this
session's own manual real-browser testing, same root cause as the tenth
pass) — cleared via `npm run dev:harness -- clear-sandbox`, not a
regression. Live browser: reproduced the exact "Next Speaker Candidate"
display fix, confirmed the two-phase capture's T0/T1 timing and content
in a real browser (376ms authoritative-fetch latency observed), and
conducted the vacancy-reproduction testing above. Not merged to `main`;
fresh preview deployed.

---

## 2026-08-30 — Session 51: Tenth corrective pass — full selection-trigger-matrix audit, dual-replacement/fallback proof, a live-replacement-queue diagnostics model, a real Reset race condition fixed, and a real-device debug-snapshot tool (issue #21)

**Goal**: real-device evidence during an *active* session (two occupied
seats, two eligible RTS requesters, already correctly vote-ordered)
showed selection diagnostics with no sense of who was next; a separate
post-Reset screenshot showed a leftover simulator comment despite SIM
reporting a clean slate. Explicit ask: a live replacement-queue model
distinct from reservation; a full trigger-matrix audit proving every
"vacant seat + eligible RTS + no reservation" transition reconciles
immediately, including dual-replacement/fallback chains; the real Reset
root cause; and a preview-only "Copy Debug Snapshot" tool for future
real-device reports.

**Diagnostics gap, not a selection bug**: `ensureActiveSelectionRound`
already refuses to freeze/reserve while no seat is open — exactly the
"don't reserve early" invariant this pass was told to preserve. During
an active session, `frozen_rank` is correctly `null` on every pending
request (nothing frozen yet), which is what made Candidates show
`rank —` — accurate for reservation, but the SIM never separately
surfaced what *is* already live and correct: the vote-count ordering
itself. Added a "Live Replacement Queue" to Selection Forensics — the
same already-correct ordering, shown once and explicitly labeled — plus
"Established mode" and a "Selected / Reserved" summary. No selection
logic changed.

**Trigger-matrix audit — five more real gaps, same shape as the ninth
pass's round-boundary fix**: `leaveSpeakerSeat`, `checkAndEvictInactiveSpeaker`,
`requestToSpeak`, `withdrawSpeakerRequest`, and `claimOpenSeat`'s
failed-claim path all had the identical gap — a vacancy/eligibility
change with nothing calling `ensureActiveSelectionRound` directly, left
entirely to the reactive client hook. Each now calls a new
`bestEffortReconcileSelection` helper (failure-swallowing, so a
successful primary action is never reported as failed over a transient
reconciliation problem), using the same service-client
`listActiveSpeakersAuthoritative` the ninth pass introduced.

**A genuinely new mechanism for failed claims**: nothing previously
released a candidate whose authorized claim itself failed — their
reservation just sat there, stuck, forever. New migration
00000000000039 (`release_failed_speaker_claim`) mirrors withdrawal's own
next-candidate advancement. Deliberately does *not* set
`selection_failed` (unlike withdrawal) — a claim failure is
presumptively transient, and that flag has no per-round scope, so it
would permanently disqualify the candidate from any later, independent
round. Flagged explicitly as a design decision, proven directly with a
real-database test showing the same candidate winning a later fresh
round on the merits. A real, related interaction surfaced along the
way: `reset_speaker_candidate_pool`'s bulk-expire being event-wide (not
round-scoped) — already an open question from the eighth pass — can
sweep a released-but-still-pending failed candidate into `expired` as a
side effect of a *different* seat's claim completing. Not fixed here;
sharper evidence for an already-open question.

**Dual-replacement/fallback — proven, not just claimed unchanged**: a
real-database test (two empty seats, three ranked candidates) confirms
the top two reserved distinctly, the third an undisturbed fallback; the
seat-1 winner cancelling correctly advances the fallback into their seat
while the seat-2 winner is untouched. A second test proves the same for
a genuinely failed claim.

**Reset root cause — a real ordering race, found by reading the actual
mechanism**: every scheduled SIM action already checks `runningRef.current`
right before firing, but a timer that fires an instant *before* Reset
flips that flag dispatches its write anyway — the in-flight call's
INSERT can land in the database *after* Reset's own DELETE already ran.
Genuinely Case A (the row really is in the database), not a stale guest-
id list (every control already draws from the same registered pool) and
not stale client rendering (DELETE reconciliation for these tables was
already fixed, migration 23). Fixed with a second, delayed sweep — same
call, same id snapshot, ~2s later, silent unless it finds something;
Reset itself stays one tap and immediate.

**Copy Debug Snapshot**: a preview-only button doing a fresh, read-only
authoritative fetch combined with current client state, diffed, copied
as human-readable text. Deliberately scoped down from the full request's
persisted 30-50-entry rolling event-history subsystem — flagged as
deferred, not silently dropped; points at the SIM's own existing
activity log instead for now.

**Verification**: full suite (1070 tests, 80 files — up from 1055/79),
lint, tsc, build all clean. New real-database test file
(`replacement-queue-and-triggers.test.ts`) covers the trigger matrix
items testable without a live request context (failed claim, dual/multi-
candidate reservation, cancel-fallback chains, tie-breaking, request-
after-vacancy and vacancy-after-request) — the five newly-fixed Server
Actions themselves wrap `resolveIdentity()` (real cookies) and so were
verified by direct code reading plus real-browser testing instead, the
same constraint the ninth pass's own test file worked around. Live
browser: reproduced the exact active-session diagnostics finding and
confirmed the fix; multiple live replacement cycles with reservation
observed in 27ms-2s; Copy Debug Snapshot confirmed copying in a real
browser; Reset follow-up sweep verified deterministically with fake
timers (a real-timing live-browser race is inherently non-deterministic
to force on demand). Not merged to `main`; fresh preview deployed.

---

## 2026-08-30 — Session 50: Ninth corrective pass — the round boundary never triggered selection itself; it depended on a separate reactive client round trip (issue #21)

**Goal**: a focused re-scope after discarding a prior investigation
branch entirely. One question only: at the shared-round boundary, why
isn't the highest-voted eligible RTS candidate authoritatively selected
for the vacant seat immediately? The ranking rule itself (most votes,
tie → earliest still-active) was already established, not to be
touched — follow the winner through reservation and promotion, name the
exact failing transition, and specifically check whether round
resolution performs selection itself or waits on a client noticing the
vacancy afterward.

**Root cause**: `resolveStageRoundAction`/`resolveSeatClosingAction`
(`room/actions.ts`) — the two authoritative functions that resolve a
round/closing-period boundary and create a vacancy — never themselves
called `ensureActiveSelectionRound`. Selection depended entirely on a
separate chain: DB write → Realtime delivery → a client's own
`useSpeakerSelectionReconciliation` React effect noticing it → that
effect's own separate Server Action call. Every hop is individually
fast; the chain itself was the measurable delay at the boundary
specifically.

**Fix**: both functions now call `ensureActiveSelectionRound` directly,
immediately after creating the vacancy — the exact same idempotent,
row-locked function the reactive hook already called, so this isn't a
second competing selection path, just closing the gap between "vacancy
created" and "selection triggered." The reactive hook is unchanged and
remains a bounded backstop for a missed delta or a since-disconnected
resolver.

**A real bug found while implementing the fix**: the first attempt
called the existing request-scoped `listActiveSpeakers` (reads cookies)
from the authoritative action, which threw `cookies was called outside
a request scope` under a bare test script — and was architecturally
fragile regardless, since round resolution isn't naturally scoped to
any one caller's session. Fixed by adding a service-client-based
`listActiveSpeakersAuthoritative` to `event-speakers.ts`, matching the
pattern `resolveStageRound`/`resolveSeatClosing` already use.

**Scope decision**: `checkAndEvictInactiveSpeaker`/`leaveSpeakerSeat`
have the identical gap (confirmed by reading both) but were deliberately
left untouched — this pass's own instructions repeatedly scoped the
investigation to the round boundary specifically and said not to start
unrelated work. Not treated as a QUESTIONS item; the scope itself
already answers it.

**Proof — the strongest evidence this pass produced**: a real-database
test ran 10 consecutive replacement cycles in one continuously-running
test event, no reset between cycles, fresh randomized candidates each
time, asserting for every cycle that the actual highest-voted candidate
was already reserved the instant `resolveStageRoundAction` returned.
Real measured latency: 719-824ms (avg 747ms), well under the 3-second
Going Live countdown and under the "effectively immediate" target. A
second test confirmed the tie-break rule with a real ~50ms `created_at`
gap between two equally-voted candidates — the earlier one won. Both
corroborated live in a real browser: two forced round-boundary
replacements, each promoting the correct top-ranked RTS candidate, with
the client observing the reservation in 548-559ms.

**New diagnostics**: Session Simulator gained a collapsible "Selection
Forensics" section (collapsed by default, per this pass's own "don't
dump raw JSON" instruction) showing, per seat: the one-time RTS ranking
frozen at the selection boundary versus the live current ranking (which
can keep changing afterward), the expected winner, the actual reserved
candidate (flagged if they diverge), and a `WAITING AT / BLOCKED
BECAUSE` reason for a still-vacant seat — extracted into a shared
`computeWaitingReason` helper so this and the existing "Selection
Timing" section can never disagree about why a seat is still waiting.

**Verification**: full suite (1055 tests, 79 files), lint, tsc, build
all clean. Also found and fixed one pre-existing, unrelated test flake
— the shared "permanent test room" fixture had leftover state from
earlier manual testing this session (an occupied seat, 46 stale
messages), causing `dev-harness.test.ts`'s clear-sandbox test to fail
on a unique-constraint violation; cleared via `npm run dev:harness --
clear-sandbox` (the literal fix that test exists to verify), re-ran
clean. Not a regression from this pass's own code — the new test file
uses its own dedicated, isolated event throughout.

**Real-device note**: an unrelated, pre-existing artifact was observed
during live-browser verification — the Session Simulator's background
"simulated audience" continued casting round-votes against a seat's
*old* occupancy row for a moment after a replacement, producing repeated
(harmless — correctly rejected server-side) "no active speaker
occupancy to vote on" console errors. Out of this pass's explicit scope
(round votes, not RTS selection); noted for a future pass, not fixed
here.

**Not merged to `main`; fresh preview deployed for the user's own
real-device review.**

---

## 2026-08-30 — Session 49: Eighth corrective pass — four real latency bugs found and fixed (stale Realtime state, simulator promotion gap, retry budget, stuck server-side round) (issue #21)

**Goal**: a real iPhone still showed "Selecting next speaker…" for an
extended period despite a visibly eligible candidate — the sixth pass's
reactive-promotion fix hadn't fully closed the gap. Explicit
instruction: diagnostic-first again, with specific attention to
multi-tab behavior; distinguish simulator-only causes from causes that
would affect a real user identically; do not patch another timer blind.

**Multi-tab audit (Sections 4-7)**: traced what multiple same-browser
tabs actually share (the guest cookie/identity) and what happens when
several `EventRoom` instances each run their own reconciliation/
promotion hooks. Multiple tabs racing to claim is safe (the existing
atomic RPC + authorization check make a losing claim fail harmlessly);
multiple tabs' reconciliation calls serializing behind the reservation
RPC's own row lock is real but resolves in a small multiple of a fast
transaction, not multi-second. Multi-tab was not the primary cause.

**Four real bugs found and fixed, each traced (not guessed) before
fixing**:

1. **Stale Realtime client state** — `useStageRound`/
   `useActiveSpeakerRequests` had on-SUBSCRIBED resync but no visibility/
   focus-triggered resync (the exact gap `useSeatReconciliation` already
   closed for seat occupancy). Reproduced live: a tab kept showing
   "Round 0 · awaiting pairing" long after the real round had advanced
   to round 2 and gone active; a fresh load immediately showed the
   correct state. Fixed by adding the same resync both hooks were
   missing.
2. **Simulated candidates had no reactive promotion path** —
   `useAutomaticPromotion`'s reactive fix only helps a real candidate's
   own browser tab; a simulated identity has none, so its claim
   depended solely on the simulator's own 4-6s poll. Two attempted
   fixes were each proven wrong live (one fired one call per
   reservation in parallel, one deduplicated by "already attempted" —
   both left a second simultaneously-open seat's reservation
   permanently unclaimed, since the underlying claim function always
   targets whichever reserved candidate it finds first, regardless of
   seat). The fix that held: a sequential drain — call, await, if
   claimed call again immediately, never tracking *which* reservation
   was attempted. A related bug in the same code: an unhandled
   rejection from any iteration silently disabled the whole mechanism
   for the rest of the run — closed with `try/finally`.
3. **Simulator startup retry budget too tight for this environment** —
   5 attempts × 150ms (750ms total) was less than a single ordinary
   reconciliation round trip sometimes takes (measured: 150-330ms
   each). Live-reproduced: this failed `Start Simulated Session`
   startup outright, silently disabling every subsequent promotion
   mechanism for that run. Widened to 20 × 300ms (6s ceiling).
4. **A genuine server-side bug, not simulator-specific** — live
   database inspection found a selection round stuck `active` forever
   with no live reservation and a withdrawn straggler that had never
   been reserved for any seat.
   `withdraw_speaker_request(_as_guest)`'s own "mark exhausted" check
   only ran when the *withdrawing* request was itself the reserved
   candidate — a frozen-but-never-reserved straggler withdrawing
   skipped it entirely, and because `freeze_speaker_candidates` is
   deliberately idempotent, a round stuck this way makes every
   later-arriving request permanently invisible to selection — for a
   real user identically to a simulated one. Fixed in migration
   00000000000038, applied to the linked project; no authorization
   check weakened.

**A related, deeper finding surfaced rather than fixed**:
`reset_speaker_candidate_pool`'s own "is there another reservation"
check is event-wide, not scoped to the current round, and a claimed
winner's own row never gets its `is_current_candidate` flag cleared —
in a long-running event this could make the bulk-expire cleanup step
keep finding an old, already-resolved round's own winner and skip
cleanup. Whether this is a real product problem and what the correct
fix is is a genuine design decision, not an obvious bug fix — see this
pass's own QUESTIONS/DECISIONS.

**Verification**: full suite, lint, tsc, build all clean. New tests:
visibility-resync coverage for both hooks, a sequential-drain
regression test for the simulator promotion fix, and a real-database
test proving migration 38 against the actual linked project. Manual
verification went well beyond the UI this pass — direct SQL/RPC calls
against the real database were what actually found and confirmed Bug 4.
Fresh preview deployed; stopping here for the user's review — not
merged to main.

---

## 2026-08-30 — Session 48: Seventh corrective pass — geometry-driven stage stacking, stage-first collapsed navigation, real Session Simulator Reset bug, SIM tactile feedback (issue #21)

**Goal**: address four UX/simulator issues found testing the sixth
pass's preview, before the user's next real-device pass. Explicit
instruction: preserve the sixth pass's speaker-selection latency fix
completely; surface (don't quietly decide) any consequential product
ambiguity.

**Responsive stage geometry (Sections 1-5)**: `SpeakerStage`'s root
became a real CSS size query container; its side-by-side tile
arrangement now switches to stacked via `@container stage (aspect-ratio
< 1.5)` instead of always being side-by-side regardless of how narrow
the stage got. **The first threshold (`< 2`) was wrong** — caught only
by loading the app in a real browser (Playwright, local dev server) at
real window sizes, since jsdom can't execute container queries at all:
`DesktopRoom`'s fixed-width sidebar means the stage's own aspect ratio
stays roughly constant across most desktop window sizes, so `< 2`
stacked even at a full 1920×1080, contradicting "wide desktop still
uses side-by-side." Recalibrated to `< 1.5` and reverified live across
four window sizes. The existing centered round-timer badge needed no
change — it was already positioned at the stage's geometric center,
which is the tile seam in either orientation.

**Stage-first collapsed navigation (Sections 8-15)**: the site-wide
header now hides unconditionally for the whole time a room is mounted
(previously only in one narrow short-landscape case — mobile portrait
had never gotten this treatment at all). A new `RoomInfoOverlay`,
rendered once by `EventRoom` as a sibling of the composition branch,
provides Home/Events navigation, room info, and account actions as a
dismissible overlay (mobile bottom sheet, desktop popover) — triggered
by the *existing* room-identity status pill (no new floating control)
and a new small button in `RoomHeader` on desktop. Verified live: the
round timer and comments kept updating underneath the overlay while
open, including a full round transition mid-overlay, and closing it
returned to the exact same live stage.

**The real Session Simulator Reset bug (Sections 16-19)**: traced
before fixing anything. The reported "Round 1 · awaiting pairing"
surviving Reset indefinitely was not a database problem (already
covered by extensive real-database tests from an earlier pass) — it was
`useStageRound`'s Realtime handler silently discarding every `DELETE`
event, the one production path that ever deletes that row at all (every
other transition only updates it), so the bug had likely never been
exercised before. Fixed via a pure, directly-tested reducer
(`applyStageRoundChange`). `EventRoom`'s `onSimulatorReset` also now
triggers an explicit `refetchSpeakers()` as defense in depth.

**One-tap Reset + real tactile feedback everywhere (Sections 20-26)**:
the two-tap confirmation is gone (a preview-only tool never needed it,
and may have been masking the actual bug — a user tapping once, seeing
nothing visibly happen, and concluding Reset silently failed). New
shared `SimButton` wraps all ~15 simulator buttons: real pointer-event-
tracked pressed state (never `:hover`, never bare `:active` — unreliable
on iOS Safari without a touch listener), and an automatic
disabled/executing state only for genuinely async actions (never for
quick deterministic generation actions, preserving intentional repeated
tapping) — this is what actually prevents a duplicate concurrent Reset,
not a second confirmation step.

**Verification**: full suite, lint, tsc, build all clean — exact count
in the commit. New tests: `use-stage-round.test.ts` (the reducer fix),
`sim-button.test.tsx`, `room-info-overlay.test.tsx`, plus updates across
every composition/header test file for the new trigger wiring and the
Reset confirmation removal. Manual verification went beyond unit tests
this pass — a local dev server plus a real Chromium browser (Playwright)
confirmed the actual responsive geometry, timer placement, and overlay
behavior no jsdom test can exercise; see DECISIONS.md for the specific
window sizes checked. Fresh preview deployed; stopping here for the
user's review — not merged to main.

---

## 2026-08-30 — Session 47: Sixth corrective pass — next-speaker latency traced to a client-side polling gap, "Joining…" seat label, real per-seat SIM timing (issue #21)

**Goal**: another real-device pass, diagnostic-first per explicit
instruction. Found: next-speaker promotion still "taking far too long"
after the fifth pass's seat-aware/atomic reservation fix — an
established stage, an empty seat (sometimes both), eligible
already-voted-for Request-to-Speak candidates visible, and an
unreasonable wait before a candidate actually landed. Instructed: trace
the whole pipeline first, instrument real timing, do not touch
selection rules/Vote UI/Continue-Replace thresholds, no merge to main.

**Traced before writing any fix**: read the real current source of
every pipeline stage rather than guessing. Two things from the fifth
pass were already correct and left untouched: `useSpeakerSelectionReconciliation`
already re-triggers selection reactively from any connected client's
own occupancy/pending-pool changes (not a timer, not dependent on one
candidate's own tab); `reserveSpeakerCandidatesForSeats` already
reserves both open seats' candidates in one atomic call, no
serialization between them. A new real-database timing test
(`two-seat-selection-fallback.test.ts`, Section 23) measured this
directly against the linked Supabase project: reservation for both
seats 440ms, seat 1 claim+authorize 432ms, seat 2 claim+authorize
448ms — confirming the server side was never the bottleneck.

**The actual bottleneck, found by reading `useAutomaticPromotion`**: the
hook that starts a *candidate's own* 3-second Going Live countdown
determined its own eligibility via a blind `setInterval(checkPromotionEligibility,
4000)` poll — completely disconnected from `pendingRequests`, the
Realtime-synced state (`is_current_candidate`/`reserved_seat_number`)
`EventRoom` already held live and wasn't even passing into the hook.
Worst case: up to ~4s of pure poll-wait stacked on top of the
intentional 3s countdown — the multi-second delay the real-device
report described, despite sub-second server-side work behind it.

**Fix — reactive first, poll as bounded backstop**: `EventRoom` derives
`isCurrentlyReservedCandidate` from its own live `pendingRequests` and
passes it in; the hook's polling effect checks this first and starts
the countdown immediately when true, no round trip. The 4s poll is
unchanged and stays as a backstop for the one gap a pure
occupancy-Realtime signal can't cover (a candidate's rank shifting from
a vote on a *different* request). `claimOpenSeat` is completely
untouched and still independently re-validates eligibility
server-side regardless of which path started the countdown — this
cannot reintroduce the seat-claim race the second corrective pass
closed.

**Companion truthfulness fix (Section 14)**: "Selecting next
speaker…" was staying visible through a candidate's entire Going Live
countdown even after selection had actually succeeded. `SpeakerStage`
gained a "Joining…" empty-seat state, checked before "Selecting…",
driven by the same `is_current_candidate`/`reserved_seat_number`
fields already in `pendingRequests` — the label now only ever means
selection is still genuinely in progress.

**New preview-only SIM diagnostics (Sections 2-3, 20-21)**:
`useSeatPromotionTiming` records real `Date.now()` timestamps per seat
(vacant → candidates found → reserved → occupied), reset each new
vacancy cycle — never an estimated value. The simulator panel renders
this as a compact per-seat timeline with real millisecond/second
deltas and a specific `WAITING AT: <reason>` line (Going Live countdown
/ reservation pending / no eligible requests / fallback open) whenever
a seat isn't yet occupied, replacing the old generic "Selecting…" a
screenshot used to show. Documented as client-observed only — can't
distinguish server-slow from this-tab's-own-Realtime-slow; the
real-database test is what isolates the server side.

**A lint-driven implementation note**: this codebase's
`react-hooks/set-state-in-effect` rule rejects a `setState` reached
synchronously from an effect body. Both the reactive fast path and the
new timing hook's recording effect were restructured to reach their
`setState` call only after a genuine microtask `await`, matching the
shape the pre-existing poll callback already used and the rule already
accepted — a real, previously-unencountered constraint in this
codebase's stricter React Compiler-oriented lint config, not a
suppression.

**Verification**: new tests for the reactive fast path
(`use-automatic-promotion.test.ts`), the timing hook itself
(`use-seat-promotion-timing.test.ts`, new file), the "Joining…" label
(`speaker-stage.test.tsx`/`speaker-tile.test.tsx`), the SIM timeline
display (`session-simulator-panel.test.tsx`), and the real-database
timing measurement above. Full suite, lint, tsc, build all clean —
exact count in the commit. Fresh preview deployed; stopping here for
the user's review — not merged to main.

---

## 2026-08-29 — Session 46: Fifth corrective pass — seat-aware selection, small-room fallback, atomic reservation, ambient comment redesign, Hide/Show comments (issue #21)

**Goal**: another real-device pass. Build "getting much closer" overall.
Found: replacement selection stuck for far too long despite eligible
Request-to-Speak candidates existing; needed explicit handling for both
seats empty at once; wanted a narrow small-room direct-join fallback
when both seats are empty and nobody's requesting; wanted the normal
live/ambient comments redesigned toward a livestream-app readability
pattern (avatar, name on its own line, wrapped comment below); wanted an
easy Hide/Show control for live comments. Do not redesign Vote UI.

**Root cause of the stuck-selection bug, traced before writing any
fix**: the selection model was event-wide, not seat-aware —
`speaker_requests_current_candidate_uniq` allowed at most one current
candidate per round, period. With two seats open simultaneously, only
one candidate could ever be reserved, and `reset_speaker_candidate_pool`
(Section E's own, still-correct-for-the-single-seat-case bulk reset)
unconditionally expired every *other* pending request the instant the
first candidate's claim succeeded — wiping out the second seat's own
already-ranked, already-voted candidate before they ever got a chance to
claim. That's the exact "both seats stuck on 'Selecting…' with eligible
candidates visible" state from the real-device report.

**Seat-aware selection (migration 00000000000032)**: `speaker_requests`
gained `reserved_seat_number` — up to two requests can be
`is_current_candidate` simultaneously now, one per open seat, never two
for the same seat (new unique index on `(selection_round_id,
reserved_seat_number)`). `reset_speaker_candidate_pool` defers its full
wipe whenever another request is still actively reserved for a
different seat — the full reset now runs once the *last* open seat's own
claim completes, not the first. `withdraw_speaker_request(_as_guest)`
advances only the withdrawing candidate's own seat's reservation, never
touching the other seat's. `lib/speaker-queue.ts`'s
`decideClaimEligibility` now targets a candidate's own
`reserved_seat_number` directly instead of `findOpenSeat`'s generic
"lowest-numbered open seat" — closes a real, related race where two
simultaneously-eligible candidates would have both computed the same
seat number and had to retry.

**Atomic reservation (migrations 00000000000036/37)**: Section 4's
explicit "use an atomic/transactional/locking approach, not client
state" requirement — a real-database concurrency test proved the
initial TypeScript-level "loop over open seats, one RPC call per seat"
approach could let two genuinely concurrent callers (two different
clients' own reconciliation polls) each decide the same top-ranked
candidate for two different seats from a stale snapshot. Replaced with
one atomic RPC, `reserve_speaker_candidates_for_seats`, that locks the
frozen round's own rows (`for update`) for the whole decision — a second
concurrent call blocks until the first commits, then sees the
now-current reservations. Migration 37 was a same-pass corrective fix
for an ambiguous-column-reference bug in 36's first version, caught
immediately by the real-database suite.

**Small-room fallback (migrations 00000000000033-35)**: once a stage is
established, a direct seat claim is legal again in exactly one case —
both seats empty *and* zero eligible pending requests. `stage_rounds`
gained `fallback_excluded_profile_ids`/`fallback_excluded_guest_ids`,
stamped by `ensure_stage_round` from `event_speakers`' own recent
`left_at` history the moment occupancy hits zero (an authoritative
lifecycle boundary, not a timer), cleared once a fresh pairing is
established. `claim_speaker_seat` enforces the whole thing itself — the
two just-removed speakers are rejected, everyone else succeeds, and a
real Request-to-Speak arriving at any point closes the fallback and
hands priority back to selection. A real-device-adjacent bug surfaced by
the test suite itself: the first version required *both* seats empty on
every claim, breaking the documented "fallback continues for the second
seat once the first is filled" case (migration 34) — and a bypass claim
needed to explicitly clear a lingering recovery flag so an unrelated,
later occupancy didn't inherit a stale exclusion episode (migration 35).
`joinOpenSeat` (room/actions.ts) reuses the exact same
`claimSpeakerSeat` call for this path, never a parallel bypass.

**Selection reconciliation backstop (Section 6)**: new
`reconcileSpeakerSelectionAction` + `useSpeakerSelectionReconciliation`
hook, same reactive-backstop shape the fourth pass's round-invariant
fix established — any connected client (not just a polling candidate)
re-triggers selection whenever its own view of occupancy or the pending
pool changes.

**Empty-seat display states (Sections 1-2, 15)**: `SpeakerStage` now
derives one of four states per empty seat — the original "Seat open"
(never established), "Selecting next speaker…" (eligible requests
exist), "Waiting for speaker requests…" (established, nobody eligible,
fallback not available here — new), or "Stage open" (fallback available
to this viewer — new, tappable via the same `onTapEmptySeat` handler).
Never shows "Selecting…" when there's nobody to select.

**Ambient comment redesign (Sections 19-24)**: rebuilt row structure —
avatar, display name on its own line (with a "requesting to speak"
badge beside it, not crammed into the same line as the message), full
comment text below, `line-clamp-2` instead of a single hard-truncated
line. Container height and top-edge mask-fade zone both grew slightly
(128px→160px, 28px→40px) to suit the taller two-line rows while staying
compact — the fade was verified to still read as a natural dissolve, not
a hard clip, at the new size. Expanded Comments deliberately unaffected.

**Hide/Show Live Comments (Sections 25-29)**: one-tap toggle, persisted
via `localStorage` (a lightweight per-browser preference, not new
schema, per explicit instruction) — hides only the floating ambient
feed; comments keep arriving, the composer/Expanded Comments/Request-to-
Speak are all untouched. A small restore pill stays visible whenever
hidden.

**Verification**: 3 real-database integration test files
(`two-seat-selection-fallback.test.ts` new — two-seat reservation, all
seven fallback cases A-G, and an explicit true-concurrency race test
proving the atomic RPC; `seat-claim-authorization.test.ts` and
`stage-round-invariant.test.ts` updated for the new
`ensureActiveSelectionRound(eventId, activeSpeakers)` signature) plus
component-level coverage for the new empty-seat states, the ambient
comment redesign, and Hide/Show. Full suite, lint, tsc, build all clean
— exact count in the commit. Fresh preview deployed; stopping here for
the user's review — not merged to main.

---

## 2026-08-29 — Session 45: Fourth corrective pass — bounded simulator startup, Case A/B seat seeding, reactive round-invariant backstop, composer focus, ambient fade (issue #21)

**Goal**: another real-device pass. Overall build working well (RTS
withdrawal, deterministic selection, post-initial-pairing seat
authorization, Continue/Replace voting, Vote UI all confirmed — do not
redesign). Three things to fix: the simulator could start into an
invalid state (both seats "Selecting next speaker…" while a shared round
counted down — an explicit invariant violation, not just slow
selection); toggling Request-to-Speak while typing dismissed the
keyboard; ambient comments hard-clipped at the top edge.

**Simulator startup invariant — traced, then closed structurally, not
patched**: `startSimulation` used to flip `running` and schedule every
natural-activity loop *before* seeding had even resolved, let alone
succeeded — the exact gap that could let the reported state occur,
whether from a seeding failure being silently ignored or a transient
stale-client-state race. Rather than commit to one unproven historical
trigger, built the explicit mechanism the instructions specified:
`establishInitialPairing`/`establishSeat`, a bounded state machine that
only reaches "running" after both seats are confirmed occupied by their
own real result *and* a fresh read of `stage_rounds` confirms the round
active — never trusting local `speakers`/`stageRound` props. A failure
at any step reports why (new preview-only "Startup" panel: Simulation/
Audience/Seat 1-2/Pairing/Shared round) and never half-starts. Found and
fixed a genuine regression of my own mid-pass, via the test suite: Stop
pressed while startup was still in flight was disabled (button gated on
`running`, which now only flips at the very end) and, even if pressed,
could be silently overridden once the in-flight startup finished — fixed
with a `startupTokenRef` generation guard plus enabling Stop throughout
the startup sequence, not just once fully running.

**Case A/B seat seeding — closing a simulator-only authorization
loophole**: a fresh, authoritative pre-check of `stage_rounds.round_number`
decides whether seeding may still use the direct-join bypass (Case A: a
genuinely new stage) or must go through the real Request-to-Speak →
selection → authorized-claim pipeline (Case B: already established) —
applied uniformly to Start's own seeding *and* the standalone "Seed 2
Speakers" button, per explicit instruction not to create a loophole
anywhere in the tool. Read migrations 24/27/28 end to end before writing
any of this to confirm `round_number >= 1` really is a sound "ever
established" signal (a purely-awaiting-pairing placeholder starts at 0,
confirmed in the actual current SQL, not assumed).

**Reactive round-invariant backstop**: new `reconcileStageRoundAction` +
`useStageRoundReconciliation` hook (wired into `EventRoom` alongside the
existing round-resolution hook) call the already-idempotent
`ensure_stage_round` whenever any connected client's own occupancy view
changes — closes the invariant gap generically, for any future path that
changes occupancy without itself calling it, not just the simulator's
own startup sequence.

**Composer focus + ambient fade**: `onMouseDown` `preventDefault()` on
the mic toggle button stops the browser's own default focus-shift before
it happens, so the comment draft/keyboard/cursor are never disturbed —
no compensating refocus (would still flicker). Ambient comment feed gets
a single container-level `mask-image`/`-webkit-mask-image` fade at the
top edge (Expanded Comments explicitly excluded — different surface,
different scroll model).

**Verification**: 3 new real-database integration tests
(`stage-round-invariant.test.ts`) prove the invariant directly against
the real linked project — zero/one occupied seats never show an active
round, exactly one new round begins once both are authoritatively
occupied, via both fresh Case-B re-seeding and the speaker-loss/
replacement path; existing `seat-claim-authorization.test.ts` (12 tests)
re-verified unmodified and still passing. Full suite, lint, tsc, build
all clean — full suite 949/949 (72 files). Fresh preview
deployed; stopping here for the user's review — not merged to main.

---

## 2026-08-29 — Session 44: Third corrective pass — deterministic selection, seat-claim authorization after stage established, avatars, tap-away Vote (issue #21)

**Goal**: real-device testing continued well, with five new observations:
missing avatars in Expanded Comments; Vote staying open when tapping
away; a request to simplify next-speaker selection to deterministic
highest-votes; Request-to-Speak withdrawal before/during promotion; and
the most significant — becoming the next speaker by tapping a newly-open
seat, bypassing Request-to-Speak entirely.

**Deterministic selection**: removed the weighted-random draw
(`lib/speaker-selection.ts`) entirely — `freeze_speaker_candidates`'
existing ranking (vote count desc, created_at asc, id asc) already *is*
the deterministic rule, so `ensureActiveSelectionRound` now just picks
rank 1; no new tiebreak logic needed. Confirmed `withdraw_speaker_request
(_as_guest)`'s existing "advance to next unfailed candidate by
frozen_rank" already used this same order, so withdrawal-during-Going-
Live composes correctly with zero SQL changes.

**Withdrawal before/during Going Live**: investigated before building
anything — `RoomControls`' existing Withdraw/Cancel buttons and
`ChatPanel`'s composer toggle already route through
`useAutomaticPromotion`'s `cancel()` → `withdrawSpeakerRequest`, which
already handles both cases correctly. No new implementation needed,
only new real-database verification tests.

**Seat-claim authorization (the significant fix)**: traced the bug to
`joinOpenSeat` having no way to know it was being used *after* initial
stage formation. Found the authoritative signal already existed —
`stage_rounds.round_number >= 1`, permanent once true — and enforced
authorization **inside `claim_speaker_seat` itself** (migration
00000000000029), not just as a `joinOpenSeat` pre-check, per explicit
"don't just hide the button" instruction: once established, only the
event's currently authorized selected candidate may claim a seat,
re-verified at the RPC regardless of caller. Proved with a real-database
test submitting an unauthorized claim *concurrently* with the authorized
one — unauthorized always loses. `SpeakerStage`/`SpeakerTile` stop
wiring `onTapEmptySeat` for an established-stage empty seat, showing
"Selecting next speaker…" instead.

**A second real Postgres gotcha, caught by the test suite**: adding
`claim_speaker_seat`'s new trailing parameter via `CREATE OR REPLACE`
created a genuinely new function overload rather than replacing in
place (confirmed via the regenerated types showing a duplicated `Args`
union) — the stale 5-argument overload skipped the new check entirely,
and the new 6-argument one didn't inherit the old grants, briefly
letting an ordinary authenticated (even anonymous) caller invoke it
directly. Both fixed in two follow-up migrations (drop the stale
overload; restate the original's grants explicitly) — worth remembering
generally for any future defaulted-parameter addition to a SECURITY
DEFINER function.

**Avatars**: no `profiles.avatar_url` column exists yet — built one
shared `ParticipantAvatar` component (image-ready, currently always
falling through to initials) and used it in both `ExpandedComments` and
`AmbientComments`, and refactored `SpeakerTile`'s four duplicated inline
initials circles onto it too — one canonical presentation, not a second
avatar system.

**Vote tap-away dismissal**: outside-pointerdown + Escape listeners,
active only while open; closing never erases the viewer's already-cast
vote.

**Verification**: new real-database test file
(`seat-claim-authorization.test.ts`, 12 tests) covering initial
formation, established-stage rejection, authorized-candidate success,
the concurrent race, the full end-to-end regression scenario, and
deterministic selection/tiebreak/withdrawal; extended
`session-simulator-panel.test.tsx`, `speaker-stage.test.tsx`,
`speaker-tile.test.tsx`, `speaker-vote-panel.test.tsx`,
`expanded-comments.test.tsx`, `ambient-comments.test.tsx`. Full suite
935/935 (71 files), lint, tsc, build all clean.

**Not built this pass**: no schema change for a real profile-image
column (out of scope, not requested — the component is ready for one).
Fresh preview deployed; stopping here for the user's review — not
merged to main.

---

## 2026-08-28 — Session 43: Second corrective pass — seeding race traced to a DB bug, timer repositioned, weighted-selection observable, Vote UI shows sentiment (issue #21)

**Goal**: continued real-device testing of Session 42's shared-round
build surfaced five more things, reported together with "address these
before adding unrelated features": the timer overlapped the room header;
a speaker wasn't replaced by the candidate expected; one simulation start
produced incomplete seating (fixed by Stop/Start); Continue/Replace vote
detail wasn't visible; and an explicit instruction to keep the simulator
a genuine end-to-end harness rather than a parallel fake implementation.

**Seeding race — traced, not patched with a retry**: confirmed the exact
mechanism before writing any fix. `seedTwoSpeakers` claimed both seats
concurrently (`Promise.allSettled`); `ensure_stage_round`'s cold-start
INSERT had no conflict handling, so two simultaneous claims on a brand-new
event could race an uncaught unique-constraint violation that silently
rolled back one seat's *entire* claim transaction — exactly why Stop/Start
"fixed" it (the second attempt's `stage_rounds` row already existed, no
race window left). Fixed in the database (migration 00000000000028: `ON
CONFLICT DO NOTHING` plus reading occupancy *after* the round row locks,
so Postgres's own blocking-on-conflicting-insert behavior serializes the
two transactions correctly). Verified with a new real-database test using
genuine `Promise.all` concurrency on a fresh event — the exact scenario
that used to fail. Seeding is now also sequential (not concurrent) in the
simulator itself, with per-step progress logging and the real error
message on a genuine failure.

**Timer placement**: root cause was two separate absolutely-positioned
overlays (the badge, the room's own event-title pill) sharing the same
top-of-screen coordinate — not a z-index problem. Moved the badge to dead
center of the stage box, which is always the seam between the two equal
`flex-1` tiles in both portrait and landscape, from one CSS rule.

**Replacement-selection — investigated before concluding anything**:
re-read `selectWeightedCandidate`'s rank-weighted odds (3/2/1 → 50/33/17
split) and its full wiring end to end. No bug found — a rank-1 candidate
losing the weighted draw exactly matches the already-agreed design.
Delivered observability instead of touching the algorithm, per explicit
instruction: the simulator now shows the frozen Top 3 with real weighted
odds, the selected candidate, and whether they're joining or have
promoted into a specific seat (cross-referenced against live seat
occupancy, never a separate guess).

**Reset**: fixed a real gap — the bulk seat DELETE never triggered
`ensure_stage_round`, leaving a stale round counter after every reset.
Now deletes `stage_rounds` outright when Reset leaves the stage empty
(the next pairing starts cleanly at Round 1), or resyncs it (never
deletes) when a real speaker is still seated, protecting their state.

**Vote UI**: added live Continue/Replace percentage display (a two-color
bar, polled only while the panel is open), a distinct "No votes yet"
zero-participation state, a locked "Replacement decided" presentation
once a speaker's Final 30s begins (buttons removed entirely, not just
disabled), and a "Vote · Ns" countdown label on the trigger during the
shared round's final ~10 seconds — all reusing the same
`speaker_round_votes`/`replacePercentage` authoritative path the resolver
and simulator already use.

**Verification**: new real-database tests for the concurrent-claim race
fix and Reset's stage_rounds cleanup/resync; rewrote/extended
`session-simulator-panel.test.tsx` and `speaker-vote-panel.test.tsx` for
every behavior above. Fixed a latent test-isolation gap this pass's own
new tests exposed (a `mockImplementation` override leaking across tests
via `vi.clearAllMocks()`, which doesn't reset custom implementations).
Full suite 919/919 (71 files), lint, tsc, build all clean.

**Not built this pass, explicitly deferred**: a client-side reactive
`ensureStageRound` backstop for seat-vacating paths that don't already
call it directly — same deferral as the previous pass; the database-layer
race fix removes the failure mode that made this urgent. Fresh preview
deployed; stopping here for the user's review — not merged to main.

---

## 2026-08-28 — Session 42: Corrective pass — seat-claim race, stuck self-preview, shared round model (issue #21)

**Goal**: real-device testing of Session 41's build hit three blockers,
reported together with an explicit "fix these before adding anything
else": Start Simulated Session only produced one occupied seat, and
tapping the remaining open seat let the simulator's background loop
claim it out from under a real join attempt; the lost real join left a
stuck self-preview with no way to leave the stage; and the round model
itself needed to change from independent per-speaker 60s timers to one
shared round per stage pairing (Continue/Replace still resolved
independently per speaker at that shared boundary).

**Root cause, traced before fixing anything**: an Explore-agent
investigation confirmed the real join path (`handleTapEmptySeat` →
`joinOpenSeat` → `claimSpeakerSeat`) and the simulator's automatic-
promotion loop call the *identical* `claim_speaker_seat` RPC — one code
path racing itself, not two different mechanisms. That RPC had no
optimistic-concurrency check at all: it unconditionally ended whichever
row was active for a seat and inserted a new one, with no exception to
either caller on a lost race.

**Fixed at the RPC layer, for every caller** (migration 24): `claim_speaker_seat`
now raises if the seat already has an active row — closing the race
generally, not with a simulator-specific patch. Two immediate follow-up
migrations fixed problems the real-database test suite itself caught:
migration 25 restores the pre-existing "release a logically-expired
occupant" behavior for the *target seat* (the new guard had started
blocking claims against a seat whose occupant was merely past its
disconnect/inactivity grace, never yet cleaned up — a real regression,
not just a test-fixture mismatch); migrations 26 and 27 fixed two
numbering bugs in the new shared-round bookkeeping (a fully-continuing
pairing never got a fresh deadline; every event's true first round
displayed as "Round 2" instead of "Round 1"), both caught by writing the
real-database round tests, not discovered live.

**Shared round architecture**: new `stage_rounds` table (one row per
event) holds the authoritative shared deadline; `event_speakers`' own
round columns stay unchanged in shape and now mirror it for the active
phase (individual narrow-loss closing periods are untouched, still
per-seat) — chosen specifically so the existing `cast_speaker_round_vote(_as_guest)`
RPCs needed zero changes. `ensure_stage_round` (idempotent, wired into
every claim/vacate/resolve path) decides whether the pairing is ready
for a fresh shared round or must wait. `resolve_stage_round` resolves
both occupied seats independently against the one boundary in a single
call.

**Real-user-precedence guard**: beyond the RPC-level race fix, the
simulator's own auto-advance-selection poll now pauses outright whenever
`EventRoom` reports a real join/promotion in flight
(`realJoinInProgress`, derived from existing `isJoiningSeat`/
`promotionCountdown` state) — real users get first refusal by design.
New `useReleaseStuckLocalMedia` hook (general, reuses existing
`EventRoom` state, not a second role system) closes the stuck-preview
finding by releasing local media whenever no legitimate reason to hold
it remains.

**Simulator panel rebuilt for the shared model**: one "Round N · Ns"
badge shown once (`StageRoundBadge` on `SpeakerStage`); `SpeakerTile`'s
own per-seat badge is now closing-only ("Final Ns"). Force
Continue/Narrow Loss/Replace now only configure a seat's vote split for
the next shared resolution; a new "Resolve Round Now" button
(`forceStageRoundDeadline`) advances the shared deadline and reports
both seats' real resolved outcomes at once.

**Verification**: replaced the old per-speaker `speaker-rounds.test.ts`
with `stage-rounds.test.ts` (real-database, covering the full shared-
round lifecycle including the two numbering-bug fixes above and the new
claim-race guard); fixed cascading fixture breakage in several
pre-existing real-database test files that had implicitly relied on the
now-removed silent-replace behavior as their own between-test cleanup
(`event-speakers-expiration`, `event-speakers-disconnect-grace`,
`event-speakers-transitions`, `event-speakers-guest-participation`, the
LiveKit webhook route test, and `reconnect-countdown-full-path`) —
confirmed each failure was a fixture assumption, not a masked product
bug, before patching it. Rewrote `session-simulator-panel.test.tsx` and
`speaker-tile.test.tsx`'s round-timer coverage for the new shared model.
Full suite 899/899 (71 files), lint, tsc, build all clean.

**Not built this pass, explicitly deferred**: a client-side reactive
`ensureStageRound` backstop for seat-vacating paths that don't already
call it directly (most do; a few — inactivity/disconnect release — were
not individually re-audited this round). Fresh preview deployed;
stopping here for the user's review per explicit instruction — not
merged to main.

---

## 2026-08-27 — Session 41: One-tap full session + closing the replacement loop (issue #21, fifth real-device follow-up)

**Goal**: the simulator could produce individual pieces of activity but
not a full, self-sustaining stage — Start still required a separate
Seed 2 Speakers press, and a replaced speaker's seat stayed open
forever since nothing could promote a new simulated candidate into it.

**Root finding, reported first**: production's automatic promotion
(`useAutomaticPromotion`/`checkPromotionEligibility`/`claimOpenSeat`)
resolves "who is asking" from the calling browser tab's own session —
it was never built to promote anyone but whoever's own tab is polling.
A simulated identity has no tab and no session, so no real pathway
could ever promote one, no matter how many votes its request earned —
a genuine, previously-unreachable gap, not a bug in anything built
before this pass.

**Implemented**: exported `ensureActiveSelectionRound` (identity-agnostic
freeze + weighted-pick, reused completely unmodified) and added a new
adapter, `simulateAdvanceSelection`, that performs the same claim/grant/
pool-reset sequence `claimOpenSeat` does but for an explicit target
identity. Its one safety-critical property: it only proceeds if the
round's real, authoritatively-selected winner is a known simulated guest
id — a real user's request winning the same pool (entirely possible in
a mixed pool) is left completely untouched, for their own tab to claim
normally. `startSimulation` now auto-seeds both speakers itself (the
same logic `Seed 2 Speakers` already had, called once automatically,
now tolerant of a seat already being occupied). Round voting now rolls
an independent continue-bias per *round* (not one fixed global bias),
since a single fixed bias reliably converges on Continue by the law of
large numbers and would never produce a narrow-loss/decisive-replace
outcome naturally. A new 4-6s polling loop calls
`simulateAdvanceSelection` whenever a seat is open, closing the loop:
Speaker A → natural voting → outcome → candidate selected → new speaker
→ next round, unattended. Enhanced Top Speaker Requests to show frozen
rank/vote-count and a "selected" marker.

**Verification**: 4 new real-database tests for `simulateAdvanceSelection`
— including one built specifically to try to break the safety property
(a real requester alone in the pool, guaranteed to win the pick,
confirmed left untouched: still `pending`, seat never claimed) — plus
component tests for auto-seeding on Start (including the
partial-failure-tolerant case), natural round voting and promotion
polling without force buttons, and a clean 2-speaker restart after
Reset. Full suite 891/891 (71 files), lint, tsc, build all clean. No
schema migration this pass.

**Not built this pass**: no visible "Going Live countdown" UI for a
simulated promotion — that countdown is genuinely private, client-local
state in production (only the promoted candidate's own tab ever renders
it), so there's nothing for a simulator operator watching as audience to
see regardless of how the promotion itself is triggered; not treated as
a gap. Fresh preview deployed; stopping here for the user's review — not
merged to main.

---

## 2026-08-27 — Session 40: Reset Session must also clear the visible feed (issue #21, fourth real-device follow-up)

**Goal**: real-device testing of Session 39's Reset Session found the
database side worked, but old simulated comments could remain visible
in the room — the live feed, Expanded Comments, and Top Speaker
Requests didn't reflect the deletion without a manual Safari refresh.

**Root cause**: reading every realtime hook this room depends on
(`useLobbyRealtime`, `useActiveSpeakerRequests`, `useActiveSpeakers`)
found none of them ever subscribed to Postgres `DELETE` events — only
`INSERT`/`UPDATE`. Never a bug before now: ordinary product usage never
hard-deletes a chat message, a request transitions status via `UPDATE`,
a speaker's departure sets `left_at` via `UPDATE`. Reset Session is the
first thing in this codebase to ever hard-delete these rows, exposing a
real, previously-latent gap in all three hooks — not something specific
to the simulator.

**Implemented**: migration 00000000000023 sets `REPLICA IDENTITY FULL`
on `event_chat_messages`, `event_chat_message_reactions`,
`speaker_requests`, and `event_speakers` — needed both so each hook's
existing `event_id=eq.<id>` server-side filter can evaluate on a DELETE
at all (a non-primary-key column must be present in the replicated
old-row data for that), and so the client-side aggregates keyed by
non-primary-key columns (reactions by `message_id`, speaker seats by
`seat_number`) have what they need in `payload.old`. Added new DELETE
handlers to all three hooks, each a pure exported function following the
codebase's existing INSERT/UPDATE convention exactly
(`removeMessage`/`removeReaction`, `removePendingRequest`,
`removeSpeaker`). Chose the general realtime fix over a
simulator-specific client refetch specifically because a refetch would
only fix the operator's own tab — a second tab watching the same room
would stay stale indefinitely; the realtime fix benefits every tab
uniformly and handles any future hard-delete this app ever adds too.

**Verification**: unit tests for all four new pure functions, plus
hook-wiring tests (mocked Realtime channel, matching
`use-active-speakers-resync.test.ts`'s established convention) proving
each hook's DELETE handler updates state correctly — including the
user's exact reported narrative as its own test: generate simulated
comments → confirm visible → delete them → confirm they disappear
without a reload → confirm a real comment survives → confirm a fresh
run's comment appears without resurrecting anything from the deleted
run. Full suite 879/879 (71 files), lint, tsc, build all clean. Ran
`supabase gen types` after the migration — no diff, as expected (replica
identity doesn't affect schema types).

**Not built this pass**: no change to Reset's own deletion logic
(already correct — this pass) or to which rows it targets. Fresh
preview deployed; stopping here for the user's review — not merged to
main.

---

## 2026-08-27 — Session 39: Session Simulator Reset Session (issue #21, third real-device follow-up)

**Goal**: Stop Simulation only ever halted future activity — old
simulated comments/votes/requests/seats piled up across test runs with
no way to clear them. Add a genuinely destructive "Reset Session,"
explicitly instructed to investigate the data model first and report the
approach before writing anything destructive, since "do not delete real
user-generated room activity" is the real constraint.

**Investigated first**: every table a simulated identity writes to
stores its guest id in the exact same shape as a real guest's (both bare
`crypto.randomUUID()` values) — no column anywhere distinguishes them,
so a broad filter would delete real audience participation. The prompt
suggested a `simulation_run_id` schema column as a good model if safe
cleanup wasn't otherwise possible. Concluded it wasn't necessary:
`SessionSimulatorPanel` already knows the exact set of guest ids it
generated this run — deleting by that exact list is precise identity
matching, not inference, and avoids a migration plus touching four
`SECURITY DEFINER` RPCs on the shared linked database. Reported this
reasoning explicitly rather than defaulting to the schema change.

**Implemented**: a new `resetSimulatorSession` Server Action deletes,
by exact guest-id list (accumulated across every Start/Stop cycle in a
new `allSimulatedGuestIdsRef`, never just the latest run's audience):
request votes, message reactions, round votes, speaker seats, and chat
messages, in an order correct with or without relying on the tables'
existing `ON DELETE CASCADE` FKs. `speaker_selection_rounds` is
deliberately left alone — no guest/profile column exists on it, its only
writer is a shared production RPC that can freeze a pool mixing real and
simulated candidates, and leaving an orphaned row is invisible/harmless
since nothing reads that table directly. The panel gained a "Reset
Session" button with an inline confirmation ("Reset simulated session?
Cancel | Reset," no native `confirm()` dialog) that stops the session,
deletes everything the run created, and clears every piece of local
state (log, tallies, pool-reset count, tracked identities) plus tells
`EventRoom` to clear its `simulatedGuestIds` placeholder-tag set via a
new `onSimulatorReset` callback — so the next Start genuinely begins
clean.

**Verification**: 5 new real-database integration tests
(`simulator-actions.test.ts`) against the linked Supabase project, each
pairing a simulated guest id with a same-shape "real" one to prove the
deletion precision comes from the exact list — covering comments, likes
(including cascade-deleting a real like on a deleted simulated comment),
speaker seats and their round votes (including a real voter's vote on a
now-gone fake round correctly cascading away, and a simulated voter's
vote on a real seat being explicitly removed), and speaker requests with
their votes. Plus 11 new component tests for the confirm/cancel flow,
accumulation across Start/Stop cycles, log/state clearing, no
background activity after reset, and a genuinely fresh next run. Full
suite 862/862 (70 files), lint, tsc, build all clean. No schema
migration this pass.

**Not built this pass**: no `simulation_run_id` column (see the
architecture decision above — not needed for the safety guarantee);
reset does not survive a hard page reload, since the guest-id list lives
in the tab's memory, same limitation every other piece of this panel's
state already has. Fresh preview deployed; stopping here for the user's
review — not merged to main.

---

## 2026-08-27 — Session 38: Session Simulator round-testing presentation — timer, occupied placeholder, per-seat forcing (issue #21, second real-device follow-up)

**Goal**: the compact/collapsible panel from Session 37 was usable on
mobile, but still didn't let the user clearly *test the round system* —
no visible per-seat round timer on the stage itself, no obvious signal
that a seeded fake speaker's seat was occupied (it fell into the same
"Camera off" placeholder a real permission failure shows, since a
simulated identity never opens a LiveKit connection), and one ambiguous
global Force Continue/Narrow Loss/Decisive-Replace control that acted on
"whichever round happens to be active first" — unworkable with two
independent per-speaker rounds. Scoped explicitly to simulator/test
presentation and deterministic controls — no voting, round-resolution,
or selection logic changed.

**Implemented**: the round-timer badge now shows "Round N · Ns" (active)
or "Final Ns" (closing) — added a `roundNumber` field to the existing
`useSpeakerRoundCountdown` display, still reading the seat's own
authoritative deadline, never a second timer. A new `isSimulated` prop on
`SpeakerTile` swaps the no-video placeholder's "Camera off" for an
unambiguous "Simulated speaker" label — purely cosmetic, driven by a
`simulatedGuestIds` set that lives in `EventRoom` (populated only via
`SessionSimulatorPanel`'s new `onSimulatedIdentitiesCreated` callback,
so it's always empty in production) and threaded through
`RoomLayoutProps` the same way `isPreviewBuild` already is. Every Force
Continue/Narrow Loss/Replace control now lives inside its own seat's
round-status block and targets that seat's `event_speakers.id` directly
— no shared "first active round" lookup left anywhere. A closing-phase
seat shows a single "Force Replace Now" instead (the real RPC rejects
votes once phase isn't 'active', so a three-way choice there would just
fail). `forceRoundDeadline` now returns the real resolver's own outcome
so the panel's forced-outcome feedback (e.g. "Seat 1 → Narrow Loss (60%
Replace)") always reflects what was actually decided, never just the
intended vote split. Added a "what would happen if this round ended now"
projection per seat, using the same pure decision function the real RPC
mirrors. "Seed 2 Speakers" now generates two dedicated identities once
per simulation run and reuses them on every subsequent click, instead of
drawing a fresh random pair each time.

**Incidental fix**: a stricter `react-hooks/purity`/`react-hooks/refs`
lint pass (newly enforced since the prior session, not introduced by
either recent round) flagged the panel's pre-existing prop-mirror ref
assignments and a direct `Date.now()` read. Fixed with this codebase's
own established idioms — an effect for the ref mirror, `useNow()` for
the clock read — the same fix `speaker-vote-panel.tsx` already used for
the identical issue class.

**Verification**: rewrote/extended `session-simulator-panel.test.tsx`
(29 tests — per-seat force-button isolation across two independent
seats, forced-outcome feedback matching the resolver's real return
value, closing-phase-only "Force Replace Now," stable seed-identity
reuse across clicks, `onSimulatedIdentitiesCreated` reporting every
generated id); extended `speaker-tile.test.tsx` (new round-number badge
case, three new "Simulated speaker" placeholder cases including a
defensive local-seat-never-shows-it case) and `speaker-stage.test.tsx`
(three new `simulatedGuestIds` threading cases). Full suite 844/844 (70
files), lint, tsc, build all clean.

**Not built this pass**: no change to real production authorization,
voting, or selection paths, per instruction; drag support on the
collapsed pill remains out of scope (unchanged from Session 37). Fresh
preview deployed; stopping here for the user's review — not merged to
main.

---

## 2026-08-27 — Session 37: Session Simulator UI — compact, collapsible, draggable (issue #21, real-device follow-up)

**Goal**: real-device testing of Session 36's work surfaced that the
simulator panel was too large on a phone, covering most of the actual
app and getting in the way of testing the room itself. Scoped
explicitly and narrowly: fix the simulator's presentation only — no
change to simulation behavior, voting logic, speaker-round logic,
comments, candidate selection, or any production code path.

**Implemented**: a minimize control (header `−` button) collapses the
panel to a small floating "SIM" pill (with a "•" dot while a simulation
is running, so it's clear at a glance whether one is active without
reopening); tapping the pill restores the full panel. Collapsing does
not stop the simulation — the running/audience/timer state lives outside
the collapsed/expanded render branch entirely, so generated comments,
votes, and requests keep arriving in the background exactly as before.
The expanded panel shrank from `70vh`/`w-80` to `min(55dvh,26rem)`/`w-64`
with an internally scrollable, `overscroll-contain`ed content region
(so scrolling the panel's log never chains into scrolling the room
behind it) and `env(safe-area-inset-*)`-aware positioning/padding so it
never sits under Safari's home-indicator area. The panel is now
draggable by its header using Pointer Events (works identically for
touch and mouse, no separate handlers), clamped to the visible viewport
on every move and re-clamped on resize/orientation change/collapse-
toggle so it can never be dragged or stranded fully offscreen.

**Verification**: 10 new component tests (minimize/restore, active dot
only while running, collapsing doesn't halt background activity under
fake timers, state survives collapse→expand, dragging repositions via
inline styles, drag is clamped at both extremes, minimize button doesn't
trigger a drag, orientation change re-clamps an existing position) plus
all 12 existing panel tests still passing unmodified — confirming no
behavior change to any deterministic/realistic-mode button. One
test-environment gap found (jsdom doesn't implement Pointer Capture
methods) and fixed with a defensive `typeof` guard in the component
itself, not papered over in the test. Full suite 829/829 (70 files),
lint, tsc, build all clean. No schema/migration changes this pass.

**Not built this pass**: dragging support on the collapsed pill itself
(only the expanded panel's header is a drag handle, per "do not overbuild
this"); an accelerated-timing simulator mode (still out of scope, not
requested here either). Fresh preview deployed; stopping here for the
user's review per explicit instruction — not merged to main.

---

## 2026-08-26 — Session 36: Per-speaker Continue/Replace rounds + preview-only Session Simulator (issue #21, Phase 2)

**Goal**: build the first real Continue/Replace round system (Sections
F–H deferred from Phase 1), plus a preview-only Session Simulator so the
user can exercise a near-real active session solo, ahead of scheduling
real multi-person testing of Phase 1 candidate promotion. Explicitly
instructed to architect round authority (deadlines, race-safety,
refresh-doesn't-restart, connection to Phase 1 selection) before writing
schema, and to stop and propose an alternative rather than add any
production-accessible testing backdoor if the simulator seemed to need
one.

**Architecture investigated and reported before coding**: round
authority reuses #18's exact `release_if_expired`/reconnect-grace
pattern — a deadline lives in the row, a trusted server RPC re-derives
the outcome from Postgres's clock, no client owns the decision. Rounds
are per-speaker (independent state per occupied seat), confirming and
finalizing the conflict flagged-but-not-yet-resolved-in-schema at the end
of Session 35. A genuine gap was found in the existing dev-tools gate:
it checks `NODE_ENV`, which Next.js force-sets to `production` for every
build including Vercel previews — meaning the simulator would have been
untestable on any deployed preview URL. Fixed with a new
`VERCEL_ENV`-based gate (`isPreviewOrDevBuild`), enforced server-side in
every simulator action; concluded no backdoor was needed.

**Implemented — round system**: `event_speakers` gained round columns
(migrations 00000000000021/22); `resolve_speaker_round` RPC decides
Continue (0 votes or Replace ≤50%, +60s, votes reset) / narrow-loss
(Replace >50% and <66%, 30s closing period, no further voting, guaranteed
replace after) / decisive-replace (Replace ≥66%, replaced at the round
boundary, no closing period) using integer cross-multiplication
thresholds, mirrored exactly in `lib/speaker-round.ts` for the pure
decision logic and centralized config
(`ROUND_DURATION_SECONDS`/`CLOSING_DURATION_SECONDS`/threshold
percentages/`ROUND_TIMER_REVEAL_SECONDS`). Replacement hands off to the
*existing* Phase 1 freeze/rank/weighted-selection/Going-Live path — no
second candidate system. `useSpeakerRoundResolution` schedules the
resolving action per seat's live deadline (tracking the deadline value,
not just the timer, since a Continue outcome reschedules on the same row
id). The Vote control is now real (`SpeakerVotePanel`, wired via a new
narrow `voteSlot` slot on `WatchModeControls` so Speaker View's separate
`micCameraSlot` path stays untouched) — compact by default, one current
Continue/Replace choice per speaker per round, changeable, reset on new
rounds. Round countdown display (`SpeakerRoundBadge`) is hidden in
production until the final 10 seconds, shown for the full round on
preview/dev builds via the new `isPreviewBuild` prop threaded through 5
layers.

**Implemented — Session Simulator**: preview-only panel
(`SessionSimulatorPanel`) generating a ~20-person simulated audience that
drives real production pathways — comments, likes, Request-to-Speak,
request voting (same exclusive-vote semantics as real users), and round
voting — via the same repository functions/Server Actions a real guest
uses, just with a generated identity instead of a cookie-derived one.
Deterministic buttons force each round outcome and open a seat for
guided testing. The single simulation-specific adapter,
`forceRoundDeadline`, backdates a round's deadline via the service client
then calls the real resolution action — the clock is faked, the decision
never is. Real-time (not accelerated) timing by default, per instruction.

**Verification**: 10 real-database integration tests for the round state
machine (caught two of my own test-authoring vote-math bugs, not RPC
bugs, via a shared `castNarrowLossVotes` helper); unit/component tests
for the decision logic, resolution hook, countdown display/hook, vote
panel, simulator pure-logic modules, simulator action gating, and the
simulator panel itself (Start/Stop, deterministic buttons calling the
correct real actions with correct arguments, stop halting future
scheduled activity). Full suite 819/819 (70 files), lint, tsc, build all
clean. Two migrations (00000000000021, 00000000000022) applied to the
real linked project — additive only.

**Not built this pass**: a seated speaker still has no UI to vote on a
co-speaker's round (Speaker View's `voteSlot` wasn't wired this pass,
reported as an explicit scoping limit); no accelerated-timing simulator
mode (left for later per instruction, real-time is the default and only
mode this pass). Fresh preview deployed; stopping here for the user's
review per explicit instruction — not merged to main, no further feature
work started.

---

## 2026-08-26 — Session 35: Request-to-Speak voting + ranked Top 3 + server-authoritative weighted selection (issue #21, Phase 1)

**Goal**: first functional audience-voting/speaker-selection loop.
Explicitly instructed to reconcile against existing architecture first
(flag conflicts, don't guess), resolve whether Continue/Replace is
per-speaker or per-pairing before touching that schema, and split into
phases if the full loop (request voting, weighted selection, 60-second
Continue/Replace blocks, Vote UI emphasis) was too large for one pass.

**Investigation surfaced two real findings, both reported before
coding**: an earlier per-*pairing* Continue/Replace sketch (2026-08-20)
conflicts with this prompt's unambiguous per-*speaker* language —
flagged as superseded per instruction, not silently followed or
silently discarded. And the existing promotion-eligibility mechanism
(`decideClaimEligibility`'s top-3-self-claim race) was already
documented, in its own code, as an explicit placeholder for "something
more deliberately audience-driven" — confirming this was the right
seam to replace, not a stable system to route around.

**Implemented (Phase 1 — Sections A–E only, per the user's own suggested
split)**: request votes with real transfer/toggle exclusivity (new
`speaker_request_votes` table, genuinely separate from ordinary comment
likes); Expanded Comments' Top Speaker Requests now ranks by real live
vote count instead of last round's FIFO placeholder; server-authoritative
weighted-random selection among the vote-ranked Top 3 when a seat opens
(`freeze_speaker_candidates` + `selectWeightedCandidate`, isolated
rank-based `[3,2,1]` weighting, stated before implementing); runner-up
advancement within the same frozen pool when the current pick withdraws;
full candidate-pool reset (bulk-expire, vote-clear) the instant a new
speaker successfully claims the seat, reusing the *existing* Going Live
countdown — no second winner/join system built.

**Verification**: 11 new integration tests against the real linked
Supabase project covering the full backend flow end-to-end (caught one
real test-setup bug of my own — forgetting to mark the winner's request
'granted' before reset, exactly mirroring what `claimOpenSeat` actually
does — before it could hide a real ordering bug); 13 unit tests pinning
the weighted-selection boundary math exactly; full suite (737/737, 60
files), lint, tsc, build all clean. Two migrations (00000000000019,
00000000000020) applied to the real linked project — additive only,
nothing destructive.

**Not built this pass, explicitly**: Sections F–H (60-second
Continue/Replace protected blocks, the Vote control's compact→emphasized
UI progression). Fresh preview deployed; stopping here for real-device/
product review before Phase 2.

---

## 2026-08-26 — Session 34: Live-stream feed, frozen Expanded snapshot, Top Speaker Requests, likes, swipe-to-close (issue #21)

**Goal**: real-device testing confirmed Discussion Expanded's foundation
works. This session refines the interaction model per explicit
direction — regular Watch Mode as a genuine live feed, Expanded
Comments as a deliberate, frozen reading surface, not a bigger version
of the live feed.

**Regular feed rebuilt**: `AmbientComments`' old self-expiring 3-bubble
stack (7s fade-out) replaced with a small, always-scrollable live-stream
feed — no more permanent removal (it conflicted with the requirement to
scroll back through history), same lightweight visual style/footprint,
same live-follow-vs-reading-history behavior a mature livestream chat
has (auto-scroll while at the edge, preserved position while reading,
auto-resume on scroll-back).

**Expanded Comments rebuilt**: newest→oldest, frozen `snapshot` taken on
open/refresh (replaces the previous round's live-follow/jump-to-latest
design outright), a compact "↻ N new comments" refresh control, a new
"Top Speaker Requests" section (up to 3, live not frozen — reasoning
reported in DECISIONS.md), double-tap-to-like (reuses the fully
existing `event_chat_message_reactions` schema/RLS/action — nothing new
needed, confirmed by inspection first), and grabber-handle
swipe-to-close (pointer handlers scoped to the handle only, so list
scrolling can never trigger a dismiss).

**Investigated before implementing, per instruction**: `speaker_requests`
has no ranking column — used documented temporary FIFO ordering, not
the existing (deliberately non-public) reputation RPC. Reactions schema
already fully supports likes — no schema/backend expansion proposal
needed.

**Verification**: lint/tsc/full suite (706/706, 58 files, +40ish new/
updated tests across ambient-comments, expanded-comments, and Speaker
View compatibility)/build all clean. Fresh feature-branch preview
deployed for real-device review — not merged, production untouched.

---

## 2026-08-26 — Session 33: Discussion Expanded (issue #21), post-public-beta

**Goal**: continue #21 on a feature branch after the public-beta-v1
release — an intentional, tap-opened surface for browsing the live
comment stream without permanently covering the stage or turning the
default mobile room into a conventional chat screen.

**Inspection first, per instruction**: checked `event_chat_messages`
(no self-referencing column anywhere in migrations or `database.ts`) —
one-level replies would need real migration/RLS/query work, not a small
additive change, so deferred; the new comment list is still structured
(flat, keyed by `message.id`) so a future `repliesByParentId` grouping
can slot in later.

**Built**: `ExpandedComments`, a tap-open bottom sheet — stage visible
above, independent scroll, its own composer instance reusing the exact
`ChatPanel`/`sendMessage`/`submitSpeakerRequest` path every collapsed
composition already has. Live-follow vs. reading-history: auto-scrolls
while at/near the newest comment; scrolling up preserves position and
shows a "new comments · jump to latest" indicator; scrolling back near
the bottom resumes following automatically. Opened from an ambient
comment bubble's tap (the `data-message-id` seam left for exactly this
since Phase 3) — a composer-focus trigger was tried first and reverted
after it broke the already-approved "tap, type, send" flow (see
DECISIONS.md). Wired into all four room compositions (portrait/
landscape × audience/speaker); desktop untouched (already has a
persistent sidebar). `commentsOpen` is local state per composition,
never lifted to `EventRoom` — no causal path to role/seat/media state,
so it can't recreate issue #18's synchronization bugs.

**Verification**: lint/tsc/full suite (681/681, 57 files, +30 new
tests) /build all clean. Fresh feature-branch preview deployed for
real-device review — not merged to `main`, production untouched.

---

## 2026-08-26 — Session 32: Production release — public-beta-v1

**Goal**: the user confirmed real-device testing of
`feature/social-stage-shell` HEAD (`c647cf6`, Session 31's self-healing
seat-reconciliation fix) passed with no complaints, and asked to put
that build live on the actual production Virtual Stage site for other
people to use/test.

**Release process**: clean working tree and exact approved HEAD
confirmed; lint/tsc/661 tests/build all re-run clean; confirmed all 18
migrations already applied on the linked Supabase project and
Production's Vercel env vars match Preview's (same Supabase/LiveKit
backends); tagged `public-beta-v1-stable` at `c647cf6` (existing
rollback checkpoints untouched); merged `feature/social-stage-shell`
into `main` with an explicit `--no-ff` merge commit (`4c43ff3`, no
history rewrite); pushed `main`, confirmed the Vercel Production
deployment's recorded SHA matched exactly.

**Production smoke test** (real browser automation against
https://project-stage-weld.vercel.app, not curl-only): homepage,
events list, and `/join` fast path all guest-accessible with no login
wall; landed in the Always-On Test Room as a guest ("Cheerful Raven");
claimed an open seat and Speaker View activated (Leave the stage,
mic/camera controls present — disabled only because the test
environment has no camera hardware); watched the 11-second inactivity
countdown run to completion and the seat release authoritatively back
to two open seats, confirming the expiration architecture is live in
production end-to-end; sent a comment and saw it render as an ambient
comment. Zero console errors/warnings throughout. Real-device (actual
phone) testing of the *production* URL specifically remains
unverified — the smoke test used browser automation, not a physical
touchscreen.

**Outcome**: issue #18 closed (acceptance criteria satisfied, real-device
confirmed) and its board card moved to Done. Issue #21 (remaining
Social Stage scope — voting, gifting, full comment/reaction system)
stays open; `main` is now the stable public-testing baseline, and
future work continues on feature branches with preview + real-device
approval before merging back.

---

## 2026-08-28 — Session 31: Issue #18 reopened — seat-role reconciliation made self-healing (the fix already existed, nothing triggered it automatically)

**Goal**: the split-layout bug reproduced again on the build confirmed
clean and closed the previous round. Decisive new evidence: tapping
"Join" a *second* time immediately fixed it — proving
`useActiveSpeakers`' `refetch()` mechanism was already correct; nothing
automatic ever called it. Issue #18 reopened and moved back to In
Progress.

**Fix, reusing the existing mechanism, no new role flag**: `mySeatNumber`
remains the one canonical value everything else derives from —
`participantRole`/the role routers/self-preview eligibility were never
the problem, they already correctly recompute the instant the data
source is corrected. What changed is how reliably that correction
happens:

1. Both seat-claim success paths (`handleTapEmptySeat`'s direct join,
   `useAutomaticPromotion`'s automatic-promotion claim — new
   `onClaimSucceeded` param) now call `refetchSpeakers()` immediately on
   success, instead of relying solely on a Realtime delta arriving.
2. New `useSeatReconciliation` watchdog: `canPublish` (LiveKit-confirmed
   speaker rights) contradicting the client's own `isSpeaker` — exactly
   the contradiction captured on-device — triggers a refetch
   automatically, once per contradiction episode. Covers both "LiveKit
   permission became speaker-capable" and "local publication starting"
   in one signal, since publishing is always gated on `canPublish`
   first.
3. The same hook also resyncs on `visibilitychange`/`focus` restoration
   — a backgrounded mobile tab is exactly where a Realtime socket can
   silently drop without the app ever knowing.
4. Realtime `SUBSCRIBED`/reconnect — already covered by the previous
   round's `useActiveSpeakers` fix, unchanged.

See DECISIONS.md's "Seat-role reconciliation made self-healing" entry
for the full design.

lint/tsc/build/full suite all pass (661/661, 56 files, +17 new tests
covering every scenario requested: a missed Realtime delta triggering
automatic refetch with no tap of any kind; the watchdog reacting only
to the genuine contradiction and never more than once per episode;
Speaker View replacing the split layout once reconciled data lands; and
no duplicate seat claim or media acquisition anywhere in any of these
paths). Deployed a fresh `feature/social-stage-shell` preview.

**Issue #18 reopened, not closed.** Per explicit instruction, does not
close until this automatic recovery survives repeated real-device
testing.

## 2026-08-27 — Session 30: Issue #18 confirmed clean on real-device retest — final diagnostic cleanup, issue closed

**Goal**: the user's real-device retest of commit `9e9309e` reported no
complaints and no reproduced issues — final cleanup only, no behavior
changes, per explicit instruction not to touch the underlying fixes.

**Removed** (all temporary, all specific to the #18 investigation): the
fuchsia `EventRoom` diagnostic strip; the cyan `SpeakerStage` diagnostic
strip; `SpeakerStage`'s instance-tracking registry (`useId`,
`useSyncExternalStore`-backed live cross-instance count, the
`parentComposition` prop and its five call-site wires) — built
specifically to rule out a double-mounted `SpeakerStage`, a theory now
conclusively ruled out; the amber diagnostic strips on the speaker's own
prompt and the audience tile, and the now-dead `reconnectDiagnostics`
helper plus its dedicated unit tests. Test coverage that existed only to
assert on the removed strips' own text went with them; the behavioral
tests underneath (tile/seat counts against the real DOM, countdown text,
resolving states, expiration enforcement, ownership reconciliation) are
untouched.

**Explicitly kept**: the dev-only `console.debug` composition trace in
`EventRoom` (ongoing dev tooling, not investigation-specific); the
`console.error` invariant assertions in `SpeakerStage` and `EventRoom`'s
ownership-contradiction handler (permanent "this should be impossible"
checks in this codebase's existing style, and part of the actual fix
logic, not throwaway diagnostics).

**ROADMAP.md**: both the original #18 tracking bullet and the #21
mega-entry's #18 status note updated to reflect the confirmed, closed
state.

lint/tsc/build/full suite all pass (644/644, 55 files — down from 656 by
exactly the removed diagnostic-only tests). Deployed a fresh
`feature/social-stage-shell` preview.

**Issue #18 closed.** No new issue started this pass, per explicit
instruction.

## 2026-08-27 — Session 29: The "split-layout" bug was client data staleness, not a rendering bug — `useActiveSpeakers` now self-heals

**Goal**: the previous round's instance-tracking diagnostics worked
exactly as designed — a real-device capture showed `liveInstances=1`
with a single, self-consistent `SpeakerStage` instance correctly
rendering the audience/two-tile composition because `EventRoom`'s own
`participantRole` said "audience." The same capture also showed "You're
already speaking" and a live self-preview for the same identity — proof
this was never a rendering bug, but an upstream ownership/role
synchronization contradiction: the client's own idea of "do I own a
seat" had diverged from the server's.

**Root cause**: `mySeatNumber` (`EventRoom`) is the one canonical value
`participantRole`/`isSpeaker`/Speaker View routing already all
correctly derived from — there was no second, independently-computed
role flag to find. The actual bug was upstream of all of that:
`useActiveSpeakers` only ever applied incremental Realtime deltas on top
of its initial state, with zero reconciliation mechanism. A routine
WebSocket drop/reconnect (mobile networks, this project's real-device
target) can silently cause one Postgres CDC event to never arrive,
after which this hook's state stays wrong for the rest of the session —
self-preview being visible while `mySeatNumber` said null was a symptom
of that staleness, not a second bug (self-preview is driven by LiveKit's
own permission push, an entirely separate channel).

**Fix, not another role flag**: `useActiveSpeakers` now performs a full
resync (replace, not patch) from the same `event_speakers_active` view
the server already trusts, on every Realtime `SUBSCRIBED` callback —
initial subscription and every reconnect — and exposes `refetch()` for
an explicit trigger. `joinOpenSeat`'s "already holds an active seat"
rejection is now a distinct, typed `already-speaking` result carrying
the real seat number, instead of a dead-end error string; `EventRoom`
treats it as definitive proof of the exact contradiction captured
on-device, logs it loudly, and reconciles immediately via `refetch()`.

See DECISIONS.md's "The split-layout bug was a client-state staleness
bug" entry for the full design.

lint/tsc/build/full suite all pass (656/656, 55 files, +10 new tests,
including the first test in this codebase to mock a Realtime channel's
subscribe-status callback — it reproduces the exact missed-delta
failure mode and proves the resync catches it, and a dedicated
`EventRoom` test reproduces the full contradiction end to end with no
dead-end error ever rendered). Deployed a fresh `feature/social-stage-
shell` preview.

**Next task**: real-device confirmation that the original split-layout
symptom doesn't reproduce (the diagnostics from the previous round stay
in place either way, per explicit instruction). Do not move #18 to Done
until confirmed.

## 2026-08-26 — Session 28: Split-layout instance diagnostics; found and fixed the real expiration-enforcement gap

**Goal**: the user reproduced both remaining #18 bugs on the
instrumented build with real evidence for the first time. (1) The
fuchsia/cyan diagnostics agreed Speaker View/solo mode was active while
the visible stage still showed the two-tile split layout. (2) The
countdown correctly reached "Tap to reconnect · 0s," but the old
occupant could still reconnect and keep the seat — proving the
countdown/render pipeline (already fixed) was never the actual problem;
enforcement was.

**Split-layout bug**: re-read `speaker-stage.tsx`'s render function a
third time — confirmed again it's structurally impossible for a single
mounted instance to render both layouts (one ternary, no shared path).
Per explicit instruction, did not attempt another speculative fix.
Instead added a `useSyncExternalStore`-backed module registry every
mounted `SpeakerStage` joins on mount and leaves on unmount: each
instance's diagnostic strip now shows a `useId()`-based instance id,
which composition mounted it (all 5 real call sites now self-identify),
a *live* cross-instance mount count (updates immediately on any
instance's mount/unmount, not just at its own), and the actual rendered
tile count/seat numbers, computed from the same `renderSolo` value the
JSX itself branches on. New tests prove the structural half directly.
**Not claimed fixed — instrumentation for the next capture.**

**Expiration enforcement — the real bug, found by reading the actual
code path**: `getActiveSeatForIdentity` (drives LiveKit token minting's
`canPublish`) and `listActiveSpeakers` (drives `findOpenSeat`) both only
ever checked `left_at is null` — with zero awareness that a row could be
*logically* expired but not yet physically released, since nothing
guaranteed `release_expired_inactive_speaker` ran at the exact deadline
moment. New `is_speaker_seat_active()` predicate + `event_speakers_active`
view (migration `00000000000018`) make every ownership-relevant read
expiration-aware; `release_if_expired`, folded into `claim_speaker_seat`
and `request_to_speak_internal`, does the same for the write side (an
identity's own stale row no longer blocks the unique index from a
legitimate re-entry). Also added: immediate `canPublish: false` push on
a successful eviction (the one path in the app missing this, per
ARCHITECTURE.md's own standing rule); a new
`useOwnSeatExpirationConfirmation` hook so a speaker alone in the room
(no one else to trigger the existing scheduled check) still gets their
own expiration confirmed promptly; and a "resolving" state on both
surfaces so the countdown never sits stuck at "· 0s."

See DECISIONS.md's "Split-layout instance diagnostics; real expiration
enforcement" entry for the full design.

lint/tsc/build/full suite all pass (650/650, 54 files, +30 new tests,
including 10 tests against the real linked database proving the
expiration fix end-to-end: a stale reconnect is rejected, a new
claimant can take the seat, the old identity can't reclaim it, the
guard is idempotent and doesn't affect a genuinely active seat).
Deployed a fresh `feature/social-stage-shell` preview.

**Next task**: real-device confirmation of exactly the user's stated
plan — reproduce Speaker View and check the expanded cyan diagnostics;
let inactivity count to zero; try to reconnect after zero; confirm
rejection/return to audience; confirm another participant can take the
expired seat. Do not move #18 to Done until confirmed.

## 2026-08-25 — Session 27: Unified inactive-speaker model shipped, reusing the existing 11s grace period for both LiveKit disconnect and both-media-off

**Goal**: continue #18 with a simplified product direction, explicitly
superseding the 30s-idle + 10s-warning architecture proposed (not built)
at the end of Session 26: "the important question is not whether
someone is technically connected; it is whether they are meaningfully
present on stage." One product-level `speakerPresence = active |
inactive`, reusing the *existing* 11-second grace period for both
causes — a genuine LiveKit disconnect, or staying connected with both
camera and mic off/muted (either alone stays active). Also asked to
trace the still-missing countdown once more with real evidence, and to
leave the split-layout diagnostics untouched.

**Schema** (migration `00000000000017`): `event_speakers.media_inactive_since`
— a second, independent clock alongside `disconnected_at`, not a
repurposing of it (the actual cause stays inspectable in storage, per
"continue distinguishing... where technically necessary"). Three new
`service_role`-only functions mirror migration 16's shape exactly:
`mark_speaker_media_inactive`/`mark_speaker_media_active` (called by the
speaker's own client, since mute state has no server-observable signal
in this app — a deliberate, documented difference in trust model from
the webhook-only disconnect pair) and `release_expired_inactive_speaker`
— one unified atomic release checking either clock. `left_reason`
gained a new `'inactive'` value. Applied via `supabase db push
--linked`; types regenerated.

**One collapsing point**: new `lib/speaker-presence.ts` — `inactiveSince()`
(the earlier of `disconnected_at`/`media_inactive_since`, whichever is
set) is the only value any countdown reads; `isLocalMediaInactive()` is
the pure client-side rule (`needsMediaActivation || (micMuted &&
camMuted)`, always false without `canPublish`). Every component reads
`inactiveSince(speaker)`, never either raw field — "camera off alone
stays active" is true by construction, not a rule to remember.

**New reporting hook**: `useSpeakerMediaPresenceReporting` (speaker-only,
no-op for audience) reports genuine transitions only — never on every
render, never from a meaningless tap. `useSpeakerReconnectGrace`'s
existing eviction-check scheduler now watches `inactiveSince()` too, so
a media-inactive seat gets the same "any connected viewer can trigger
the check" robustness a disconnected one already had.

**UI**: the speaker's own prompt branches — "Tap to reconnect · Ns"
(never activated, tappable) vs. "Resume speaking · Ns" (already
publishing but both muted, non-interactive — the real recovery action is
the existing mic/camera toggle buttons). The audience always sees
"Speaker inactive · Ns," never which cause applied. Diagnostics extended
to show both raw fields alongside the collapsed deadline.

Split-layout diagnostics (fuchsia/cyan): left exactly as they were, per
explicit instruction.

See DECISIONS.md's "Unified inactive-speaker model shipped" entry for
the full design.

lint/tsc/build/full suite all pass (624/624, 52 files, +28 new tests:
unit tests for the three `speaker-presence.ts` functions and the
reporting hook's transition logic, extended `useSpeakerReconnectGrace`
coverage, and 11 real-linked-database tests covering both causes'
countdown/recovery/release/reassignment-safety end to end). Deployed a
fresh `feature/social-stage-shell` preview.

**Next task**: real-device confirmation — whether the countdown now
reliably shows on both surfaces for a genuine disconnect and for
explicit both-media-mute, whether "Resume speaking" reads sensibly,
recovery via either camera or mic alone, and continued watch for the
split-layout bug. Do not move #18 to Done until confirmed.

## 2026-08-25 — Session 26: Reconnect-countdown root cause fixed; inactive-speaker timeout scoped and stopped per explicit instruction

**Goal**: continue #18 from Session 25's diagnostics-first pass. The user
reported the reconnect countdown was still missing on both surfaces on
real devices, asked for the *actual render path* traced with real
evidence (not re-verified math), asked to keep the split-layout
diagnostics as-is without another speculative fix, and asked for a new,
separate "inactive speaker" seat-timeout feature — with an explicit stop
condition if it needed broader schema/backend changes than expected.

**Reconnect countdown — a real root cause found and fixed**: traced
`SpeakerTile`'s branch-selection logic (not just the countdown math
again) and found a genuine divergence: `isReconnecting` was a *separate*
derivation (`useSpeakerReconnectGrace`'s `reconnectingIdentities`,
gated by the viewer's own `canConnect`) from the `disconnected_at` field
the countdown itself already reads — the hook's own doc comment already
flagged the `canConnect` gate as vestigial. Fixed by making `SpeakerTile`
OR the two together, so the seat's own authoritative field always wins —
"reconnect UI must take precedence over Camera off" is now true by
construction, not by keeping two independent computations in sync by
hand. Added a new unit test proving the fix: `disconnected_at` set,
`isReconnecting` prop explicitly `false`, reconnecting UI still shows.

**On-screen diagnostics added to both real render paths** (un-gated,
visible on the deployed preview): raw `disconnected_at`, parsed
timestamp, computed deadline, remaining seconds, and an active flag —
on both the speaker's own "Tap to reconnect" prompt and every occupied
audience tile. Deliberately reuse the *already-computed* remaining-
seconds value from the same `useReconnectCountdown` call driving the
visible text (an early draft used a second, independently-clocked
`useNow()` instead — a test caught it disagreeing by a second at a
rounding boundary, which would have made the diagnostic itself
misleading).

**Split-layout diagnostics (fuchsia/cyan)**: left exactly as they were,
per explicit instruction — no new speculative fix attempted.

**Inactive-speaker timeout — scoped, then stopped per the user's own
explicit condition**: walked the design through before writing any code
(per this project's standing rule). The core finding: disconnect
detection is server-authoritative because LiveKit's *own* webhook
reports it; mic/camera mute state has no equivalent server-observable
signal in this app, so "muted + camera off + no activity" can only be
client-observed and server-recorded — a genuinely new schema/backend
surface (a new column, new service-role functions, a new server action,
a new client activity-detection hook) comparable in size to the entire
disconnect-grace-period feature. The user's own instruction said to stop
and report the proposed architecture in exactly this situation, so this
session ends with a concrete design handed back for confirmation instead
of an unreviewed migration.

lint/tsc/build/full suite all pass (584/584, 50 files, +9 new tests).
Deployed a fresh `feature/social-stage-shell` preview.

**Next task**: user confirmation on the inactive-speaker architecture
proposal before any of it is implemented. Real-device confirmation of
the reconnect-countdown fix (both "Tap to reconnect · Ns" and "Speaker
reconnecting · Ns" actually showing correct numbers) and continued
watch for the split-layout bug (screenshot the fuchsia/cyan strips if it
reproduces). Do not move #18 to Done until confirmed.

## 2026-08-24 — Session 25: Real-device retest of #18 — all three findings still reported; audience countdown shipped, split-layout bug explicitly not resolved

**Goal**: pick up after the hydration-race fix and countdown work
(previous entry) with a real-device retest. The user retested on a
speaker phone and a separate audience/observer device and reported all
three original findings still present: (1) the split-layout bug still
occasionally reproduces alongside speaker-specific state; (2) the
returning speaker's "Tap to reconnect" prompt showed no countdown; (3)
the audience had no visibility into a disconnected speaker's remaining
grace time. Explicit instructions: no new speculative boolean/test
around `participantRole`; do not call the split-layout bug fixed on
unit tests alone; add real on-screen diagnostics if needed.

**Split-layout bug**: re-derived the entire render path from scratch a
second time (`EventRoom`, `participant-role.ts`,
`portrait-room.tsx`/`mobile-landscape-room.tsx`'s role routers,
`portrait-speaker-view.tsx`, `speaker-stage.tsx`) rather than trust the
previous pass's conclusion. Confirmed again that every prop in the
chain — `isSpeaker`, `participantRole`, `mySeatNumber`, `soloMode`,
`renderSolo` — is provably derived from the same single value in the
same render, with no memoization anywhere that could make a stale prop
plausible. No new mechanism found. Added two temporary, un-gated
on-screen diagnostic strips (visible on the actual Vercel preview) to
`EventRoom` and `SpeakerStage` showing the exact live values of every
variable the user asked to trace, so a future reproduction can be
screenshotted instead of guessed at again. **Not claimed fixed. Issue
#18 stays open.**

**Reconnect countdown**: ran a real verification script against the
linked Supabase project confirming `disconnected_at` correctly reaches
both a plain read and a live Realtime broadcast — ruling out the DB/
Realtime pipeline as the cause of the missing speaker-side countdown.
Implemented the audience-side countdown ("Speaker reconnecting · Ns")
in `SpeakerTile`, reusing the exact same `useReconnectCountdown` hook
and `disconnected_at` field the speaker's own prompt already used — one
timer, two displays. Added `reconnect-countdown-full-path.test.tsx`,
testing against the real linked database: a live disconnected row's
`disconnected_at`, fetched fresh, drives matching countdown text on
both the speaker and audience components; reopening ~5s in shows ~5s,
not a fresh 11; reconnect and expiration both clear the countdown on
both surfaces, with expiration additionally removing the row itself.

See DECISIONS.md's "Real-device retest reproduced all three #18
failures" entry for the full investigation detail.

lint/tsc/build/full suite all pass (575/575, 50 files, +11 new tests: 7
audience-countdown unit tests in `speaker-tile.test.tsx`, 4 real-DB
full-path tests). Deployed a fresh `feature/social-stage-shell` preview.

**Next task**: real-device confirmation only — the split-layout bug's
diagnostic strips (screenshot both if it reproduces again), "Tap to
reconnect · Ns" and "Speaker reconnecting · Ns" actually appearing with
correct/matching numbers, reconnect-before-expiry, and expiry-after-11s.
Do not move #18 to Done until confirmed.

## 2026-08-24 — Session 24: Speaker View (#18) designed and Phase 1 implemented

**Goal**: Pick up where Session 23 left off — Watch Mode's Phase 3 (ambient
comments) was confirmed on a real iPhone, and the user explicitly paused
"05 — Social Stage" Phases 4–7 to design the speaker-dominant role view
flagged in Session 23. This session covered that whole arc: dependency
verification, architecture assessment, layout-direction options, plan
approval, and Phase 1 implementation.

**#16/#17 verified complete and closed**: before touching #18, checked
both blocking dependencies' actual acceptance criteria against current
code rather than assuming "looks similar enough" — #16 (guest speaker
participation: schema, all four guest-specific `service_role` functions,
generalized app layer, the webhook route's fixed disconnect-cleanup
regression, PRODUCT.md's documented exception) and #17 (unified event/
lobby/room lifecycle: single persistent `EventRoom` tree, hooks-above-
phase-branch, lazy LiveKit, and — checked specifically since it'd be easy
to silently drop — the `/lobby`/`/room` redirect stubs are still real,
not deleted) were both fully satisfied. Closed both with a verification
comment citing the specific files/migrations checked; board cards moved
to Done.

**Architecture assessment produced, no code**: walked the design through
before writing anything, per this project's own standing rule for
data-model/cross-system changes. Found the "own camera small" half of
Direction B was already built (issue #22's dominant-video corrective
pass already suppresses a seated speaker's own big video in favor of the
existing `SelfPreview` corner) — the only real gap is the *other*
speaker's tile still being equal-sized instead of dominant, already
named three separate times in ARCHITECTURE.md/DECISIONS.md as deferred
to #18 specifically. Presented three layout directions (A: corner-swap,
B: full-bleed remote + floating self-preview, C: asymmetric grid) with
tradeoffs, without picking one, plus a recommended implementation
architecture (role as a derived value off already-live `isSpeaker`/
`hasPendingRequest`, no new hooks; role-branch inside each device
composition, not a new top-level `EventRoom` branch; same mounted
`SpeakerStage`/`SpeakerTile`/`SelfPreview` infrastructure, extended not
duplicated; landscape untouched).

**User chose Direction B** with six concrete decisions: keep commenting
available to speakers; add real mic/camera toggles using the *existing*
published LiveKit tracks (`.mute()`/`.unmute()`, never
`setMicrophoneEnabled`/`setCameraEnabled`'s reacquire-on-enable path);
`SpeakerControlBar` as a new purpose-built component, not another
`RoomControls` branch; portrait only; same underlying stage/LiveKit
infrastructure, not a duplicate room implementation; empty-other-seat
reuses the existing placeholder, no new "waiting" system. Issue #18
updated in place (retitled, body rewritten for Direction B, dependencies
cleared) rather than replaced. A 4-phase implementation plan was written
and approved, with only Phase 1 authorized to start.

**Phase 1 (static full-bleed layout) implemented on `feature/speaker-view`**
(branched from `feature/social-stage-shell`, not `main` — #21 Phases 4–7
are still pending, so `main` isn't ready to receive either branch yet;
checkpoint tag `prototype-pre-speaker-view-stable` cut at
`feature/social-stage-shell`'s Phase-3-confirmed HEAD first). `SpeakerStage`
gained one new optional prop, `soloMode` (default `false`, every existing
caller/test unaffected) — when the viewer holds a seat, renders only the
*other* seat's tile at full size via the exact same `renderTile()` used
for the ordinary two-tile layout (no new tile-rendering logic, no
divider). `PortraitRoom` gained a role router at the very top —
`isSpeaker` delegates immediately to a new `PortraitSpeakerView`
(minimal top chrome + full-bleed `SpeakerStage` only) before any of its
own Watch Mode JSX runs. `SelfPreview` and the empty-other-seat
placeholder are both reused completely unchanged — the existing
"recreated, never reacquired" `<video>` re-attach tolerance already
proven safe for every orientation/viewport composition swap is the same
mechanism covering this one; `EventRoom`/`useLiveRoomConnection` are
untouched, so the underlying LiveKit `Room`/subscriptions never move.

**Known, deliberate Phase 1 gap**: per the approved phase scope (no
`SpeakerControlBar`, no mic/camera controls yet), a seated speaker
currently has **no in-UI way to leave the stage** — Watch Mode's
"Leave the stage" button doesn't render in this composition at all until
Phase 3. Closing the tab still releases the seat via the existing
LiveKit-webhook disconnect path. Called out explicitly in the real-device
report so this isn't mistaken for a bug.

lint/tsc/build/test all pass (339/339, 38 files, +19 new tests: 6 new
`SpeakerStage` `soloMode` cases, a new `portrait-speaker-view.test.tsx`,
1 updated `portrait-room.test.tsx` case reflecting the role router).
Local production smoke test confirmed the built route serves the
homepage (200).

**Next task**: stop for the user's own real-device confirmation of Phase
1 specifically — full-bleed video for the other speaker on promotion,
self-preview continuity through the transition, empty-other-seat
behavior, clean return to Watch Mode on leaving the stage (via
disconnect, since there's no in-UI button yet), and no landscape
regression. Do not begin Phase 2 (speaker composer + ambient comments)
until explicitly approved.

**Phase 1 portrait transition confirmed correct on a real iPhone, but
real-device testing found two regressions**, fixed on the same branch
before Phase 2: (1) the self-preview appeared to disappear after editing
the guest-name chip — traced (not patched around) to two real causes:
the chip was positioned directly in `SelfPreview`'s own fixed top-right
corner, and `GuestNameEditor`'s edit input carried a `text-sm` override
that silently defeated `<Input>`'s own iOS-Safari-zoom-on-focus fix (the
same bug already fixed once for the Watch Mode composer, never checked
against this component). Fixed both directly — a new shared
`SpeakerViewTopChrome` keeps the status pill and guest chip anchored
left, away from the self-preview corner; `GuestNameEditor` no longer sets
any font-size class on its edit input. (2) Rotating a seated speaker to
landscape reverted to `MobileLandscapeRoom`'s ordinary audience
composition (equal-split tiles, full `RoomHeader`, Comments toggle) —
undoing the whole role hierarchy. Resolved with a new
`MobileLandscapeSpeakerView`, mirroring `PortraitSpeakerView` exactly
(same `soloMode`, same shared top chrome, same reused `SelfPreview`) —
the same role-router pattern already proven for portrait, not a
`soloMode` conditional threaded into `MobileLandscapeRoom`'s unrelated
audience JSX. `MobileLandscapeRoom` calls `useCommentsMode()`
unconditionally before its role check specifically because `isSpeaker`
can flip while it stays mounted — a genuine Rules-of-Hooks constraint,
not a style choice, with its own regression test. No new video/media
logic in either fix — same `soloMode`/`SelfPreview`/attach-not-reacquire
tolerance as Phase 1 itself. lint/tsc/build/test all pass (352/352, 40
files, +26 new tests). Local production smoke test confirmed the built
route serves the homepage (200).

**Next task**: stop for the user's own real-device confirmation of this
corrective pass specifically — self-preview surviving repeated name
edits, landscape Speaker View's role hierarchy and reduced clutter,
rotation both directions, and no regression to audience landscape. Do
not begin Phase 2 until explicitly approved.

**That corrective pass did not fix the actual bug** — real-device
retesting found the self-preview still disappearing after committing a
name edit while seated. Explicitly instructed to trace the real cause
this time, not guess again, with a fallback (disable name editing while
speaking) if the cause couldn't be confidently found. Traced it properly:
`node_modules/next/dist/docs/01-app/01-getting-started/07-mutating-data.md`'s
own "Cookies" section documents that setting a cookie inside a Server
Action re-renders the current page's Server Components and re-runs
effects whose dependencies changed. `setGuestName` sets a cookie;
`EventPage` re-runs and re-calls `getLiveKitToken`, which
(`AccessToken.toJwt()`) mints a genuinely different JWT string every
call, even for identical grants. `useLiveRoomConnection`'s connect
effect depended on that token's exact value — a changed string, even
while already connected, tore the effect down: a **real**
`room.disconnect()` (visible to the other participant too, not just a
local artifact), `localVideoTrack` nulled, then a reconnect that
re-published camera/mic via `setCameraEnabled`/`setMicrophoneEnabled` (a
genuine `getUserMedia` reacquisition) — and never restored
`localVideoTrack` through that path, permanently hiding the preview.
Fixed by depending on the token's presence, not its value, aligning the
implementation with this project's own already-stated principle that
permission changes are a live push, never a reconnect. New `Room`-mocking
tests in `use-live-room-connection.test.ts` assert a token-value-only
change never creates a second `Room` or calls connect/disconnect again,
while the documented null→real transition and a genuine `livekitUrl`
change still work correctly.

**Landscape site-header fix, same pass**: real-device testing separately
found the site-wide header still consuming too much of Speaker View's
landscape composition — the existing padding-only `room-active`
compaction wasn't enough once there's no sidebar/chat competing for
space. New `speaker-view-active` body class (tracks `isSpeaker`
specifically, a separate effect in `EventRoom` since the dependency is
real) hides the header outright under the same landscape+short-height
media query, only while actively speaking — ordinary audience landscape
keeps its existing treatment unchanged.

lint/tsc/build/test all pass (355/355, 40 files, +3 new tests targeting
the reconnect fix specifically). Local production smoke test confirmed
the built route serves the homepage (200).

**Next task**: stop for the user's own real-device confirmation —
self-preview surviving repeated name edits with no reconnect, landscape
header genuinely gone/collapsed while speaking, and no regression to
audience landscape or the LiveKit connection generally. Do not begin
Phase 2 until explicitly approved.

**The name-edit bug is confirmed fixed. A separate lifecycle bug found**:
leaving the room via the site header's "VIRTUAL STAGE" link and
returning left the self-preview gone, even when still landing back in
Speaker View as a seated speaker. Instructed to trace the actual
navigation/remount lifecycle and explicitly verify whether
seat-persistence-across-navigation was even intended before changing
anything, rather than assume.

**Verified, not assumed**: navigating away already vacates the seat as
designed — `EventRoom` unmounts (it lives inside the route's own tree,
`SiteHeader` doesn't), `useLiveRoomConnection`'s cleanup calls
`room.disconnect()`, and the existing LiveKit webhook
(`participant_left` → `endSpeakerSeat`) vacates the DB row. This was
already documented policy from Phase 1 itself. What looked like
"returning to a speaker state" is that webhook's own network latency —
a timing artifact of an already-correct mechanism, not a competing
feature. Nothing about this lifecycle was changed.

**The actual bug**: any fresh `useLiveRoomConnection` instance that
finds itself already seated (via that timing window, or genuine
re-promotion) needs one gesture-triggered `activateMedia()` call before
it republishes — by design, the same Safari-gesture protection used
everywhere else. But Speaker View Phase 1 has no UI that can ever
trigger it: `soloMode` never renders the local tile where that
affordance normally lives, and neither Speaker View renders
`RoomControls`. Not cosmetic — camera/mic were never actually
republished, so the *other* participant kept seeing "Camera off" too.
Fixed with a new shared `SpeakerMediaActivationPrompt` (visible only
when `needsMediaActivation` is true), calling the exact same
`activateMedia` already wired through both views — no new acquisition
logic, `RoomControls` deliberately not reused wholesale (would have also
introduced "Leave the stage" as a side effect, still explicitly Phase
3's job). lint/tsc/build/test all pass (364/364, 41 files, +11 new
tests). Local production smoke test confirmed the built route serves the
homepage (200).

**Next task**: stop for the user's own real-device confirmation —
navigate away and back while still entitled to the seat, confirm the
activate-media prompt appears and restores both the self-preview and
actual publication (checkable from the other participant's view), and
confirm the landscape corrections from the previous pass are still
intact. Do not begin Phase 2 until explicitly approved.

**Two more real-device issues found before Phase 1 could be approved.**
(1) Tapping the large empty remote seat while seated could bring back
the old split-screen composition. Traced exhaustively: `SpeakerStage`'s
own tap-gating (`viewerIsSpeaking ? undefined : onTapEmptySeat`) is
already correct and already tested — the empty tile is provably a
non-interactive `<div>`, no `onClick`, whenever `soloMode` is actually
engaged, and `joinOpenSeat` separately rejects an already-seated
identity server-side even in the worst case, so a genuine seat swap is
structurally impossible either way. Could not conclusively reproduce the
exact symptom from static analysis alone — reported that honestly rather
than claiming a root cause. Found and fixed one real, independently
worthwhile gap instead: `handleTapEmptySeat` (`EventRoom`) had no guard
of its own — for an already-published speaker, its unconditional
`prepareLocalMedia()` call would **not** have been the usual no-op (that
speaker's tracks already left `preparedTracksRef` on publish), so a
stray invocation would have acquired a second, unpublished track and
pointed `localVideoTrack` at it. Added an explicit `isSpeaker` early
return at the point the mutating action actually originates, not just
relying on a second, independently-re-derived check deep in
`SpeakerStage`. Added the user's literal required test (repeated taps,
still full-bleed, divider/local tile never returns) to
`speaker-stage.test.tsx`.

(2) Investigated whether `prepareLocalMedia`/`activateMedia` could be
called automatically on mount when already entitled, to skip the tap
prompt after a quick navigate-away-and-back. Concluded no, and explained
why rather than guessing: camera/mic *permission* persists across
navigation, but Safari's requirement that `getUserMedia()` run inside an
active gesture does not — it resets per fresh
`useLiveRoomConnection`/page-load instance, which is exactly this
scenario, and this project already has a real-device-proven history of
that exact silent failure mode. Not implemented — the existing
`SpeakerMediaActivationPrompt` stays the only path, per the user's own
anticipated fallback.

lint/tsc/build/test all pass (365/365, 41 files, +1 new test). Local
production smoke test confirmed the built route serves the homepage
(200).

**Next task**: stop for the user's own real-device confirmation —
repeatedly tapping the empty remote seat while seated should now be a
guaranteed no-op (both client and server layers), and the media-activation
prompt/button remain the only (correct, gesture-safe) recovery path. Do
not begin Phase 2 until explicitly approved.

**A much more precise report followed**: claiming the top seat reliably
works, claiming the bottom seat leaves the old split-screen composition
in place — asked to trace this specifically as a seat-index/local-seat
asymmetry, confirmed from the actual state/render path rather than
assumed. This time verified empirically rather than by re-reading code:
wrote and *ran* a throwaway probe test rendering `SpeakerStage` with the
viewer occupying seat 2 (both remote-empty and remote-occupied) before
concluding anything — it passed cleanly. Read `mySeatNumber`'s
computation, `EventRoom`'s `isSpeaker`, the role router in both
`PortraitRoom`/`MobileLandscapeRoom`, and `determineCanPublish` — all
five relevant pieces are provably symmetric, none branch on seat number.

Found one concrete, relevant fact while tracing: `findOpenSeat` (used by
both direct-tap and automatic-promotion claim paths) always prefers the
lowest-numbered open seat, and neither `onTapEmptySeat` nor the server
action it calls take a seat number at all — tapping *either* tile, when
both seats are genuinely open, assigns the *same* seat (1). A "bottom
seat" test only actually exercises seat 2 if seat 1 was already occupied
by something else at the time — flagged this to the user as a concrete
question rather than a guess.

Per instruction not to assume a cause, made **no speculative production
code change** this pass — added the full required test matrix instead
(both local-seat permutations × remote-occupied/empty × repeated taps ×
self-preview) across `speaker-stage.test.tsx`,
`portrait-speaker-view.test.tsx`, `mobile-landscape-speaker-view.test.tsx` —
closing a real, pre-existing gap (every previous soloMode test only ever
put "my" seat at seat_number 1). lint/tsc/build/test all pass (381/381,
41 files, +16 new tests, all passing — none needed for a fix, since none
revealed a failure).

**Next task**: stop for the user's own real-device confirmation, and
specifically to answer whether seat 1 was already occupied during the
"bottom seat" test — that would resolve whether the two tests actually
exercised different seat numbers at all, which the automated evidence
here couldn't settle on its own. Do not begin Phase 2 until explicitly
approved.

**The split-screen bug didn't reproduce on retest** — the user needs a
better way to stress-test the join/leave cycle to catch the actual
trigger, and explicitly paused further split-screen changes. Instead:
restored **Leave the stage**, the **composer**, and **ambient comments**
to Speaker View (both orientations) as stress-testing infrastructure.
New `SpeakerControlBar` (currently one pill) calls the *exact same*
`leaveSpeakerSeat` Server Action `RoomControls` already uses — no new
mutation path — deliberately not `RoomControls` itself (its `isSpeaker`
branch is the padded legacy block the user explicitly said not to bring
back). `ChatPanel` gained one new prop, `allowMicRequest` (default
`true`, no existing caller affected) — `false` hides the 🎙 toggle
entirely, since a seated speaker already holds the seat a request would
be for. Both Speaker Views now wrap `WatchModeControls`/`ChatPanel`/
`AmbientComments` in the same `StageOverlayShell`/`bottom-16 left-3`
positioning Watch Mode already established — zero new layout logic.
`SpeakerMediaActivationPrompt` moved from the bottom edge to vertically
centered, so it stays clear of the new bottom row regardless of its
rendered height. Landscape got the same additions (not portrait-only) —
the stress-test plan explicitly includes rotating mid-test, and leaving
landscape without a leave/composer would itself look like a new bug.

Two role-router tests (`portrait-room.test.tsx`,
`mobile-landscape-room.test.tsx`) had asserted "no composer/no leave
button" for a seated speaker — now stale, updated to assert the real
leave button exists while the legacy `RoomControls` block's text still
doesn't. lint/tsc/build/test all pass (402/402, 42 files, +22 new
tests). Local production smoke test confirmed the built route serves the
homepage (200).

**Next task**: stop for the user's own real-device stress-testing —
repeated join (top/bottom)/leave cycles, rotating during different
states, watching for exactly what precedes the split-screen issue if it
reappears. No further split-screen changes until a clearer trigger is
identified from that session. Do not begin further Speaker View scope
until explicitly approved.

**Phase 1 (everything shipped so far) approved on real-device stress
testing** — top/bottom join both work, self-preview works, Leave the
stage and commenting/ambient comments hold up under repeated cycles,
landscape is acceptable with the header hidden. The split-screen issue
did not reproduce; the user explicitly paused further investigation of
it pending a clearer trigger, rather than more speculative changes.

**Asked to "proceed to Phase 2"** — reconciled phase numbering before
writing code, per instruction: the original 4-phase plan's Phase 2
(composer + ambient comments) and Phase 3's leave-stage half were both
already delivered in the prior pass, framed as stress-testing
infrastructure rather than by their original numbers. The user's
"Phase 2" now maps to the plan's remaining **Phase 3 content: live
mic/camera mute toggles** — stated this mapping explicitly before
touching code.

**Implemented**: `useLiveRoomConnection` gained `microphoneMuted`/
`cameraMuted` state and `toggleMicrophone`/`toggleCamera`, backed by
`LocalTrack.mute()`/`.unmute()` on the already-published track — never
`setMicrophoneEnabled`/`setCameraEnabled`, which would stop and
reacquire the hardware track (a real `getUserMedia` call, the same class
of risk already investigated and avoided twice this session).
`SpeakerControlBar` (already existed with just the leave pill, whose own
doc comment had already anticipated this exact follow-up) gained two
toggle buttons, disabled until actually publishing
(`canPublish && !needsMediaActivation`). Mute state resets alongside
`localVideoTrack` on leaving, so a same-session rejoin's freshly
acquired track never inherits a stale mute flag. New `Room`-mocking
tests assert `.mute()`/`.unmute()` are called and `setMicrophoneEnabled`/
`setCameraEnabled`/`createLocalTracks` are not. lint/tsc/build/test all
pass (414/414, 42 files, +12 new tests). Local production smoke test
confirmed the built route serves the homepage (200).

**Next task**: stop for the user's own real-device confirmation of the
mic/camera toggles specifically — mute/unmute actually stops/resumes
audio and video for the other participant, no permission re-prompt, no
reconnect, buttons correctly disabled before publishing starts. Do not
begin the next Speaker View scope until explicitly approved.

**Mic/camera toggles confirmed working on real device.** Asked to
reconcile the original #18 plan against everything shipped across all
the corrective passes before doing more work — delivered that
reconciliation directly: every requirement in #18's own issue body is
now satisfied (full-bleed remote speaker, self-preview, ambient
comments + composer, `SpeakerControlBar` leave-stage + mic/camera,
empty-seat reuse); landscape is done too, though as an explicit
deviation from the issue's original "portrait only this pass" text, at
the user's own request; no meaningful #18 work remains; React/Vote/
Gift, Discussion Expanded, a fuller landscape redesign, and a desktop
Speaker View were all identified as belonging elsewhere (#21 or a new
issue), not #18. Recommended one final integrated real-device pass
before closing.

**Before that pass ran, real-device testing surfaced UI crowding/
clipping** (a screenshot: an ambient comment rendering behind the
speaker controls, plus top-right chip/self-preview crowding) —
paused the sign-off to fix layout, explicitly scoped as composition
cleanup, not another architecture change. Consolidated the mic/camera
toggles and "Leave the stage" from two separate control regions (a
floating row above the composer, plus the persistent bottom row) into
one: `SpeakerMediaToggles` (the *same* toggle buttons, relocated, not
reimplemented) now sits in `WatchModeControls`' new `micCameraSlot`,
replacing React/Vote for a seated speaker while Gift stays; ordinary
Watch Mode is unaffected (the slot defaults to today's React/Vote when
absent). `SpeakerControlBar` is back to just "Leave the stage."
`AmbientComments` gained a Speaker-View-specific `bottom-32` clearance
(up from a `bottom-16` it had wrongly inherited from Watch Mode's own,
shorter control stack) and the bottom overlay gained safe-area-aware
padding for the home-indicator region. `SpeakerViewTopChrome` now
reserves `SelfPreview`'s actual responsive footprint (`pr-20 sm:pr-24`,
mirroring `MobileLandscapeRoom`'s own already-proven pattern for the
exact same problem) with `min-w-0 flex-1` so the status pill genuinely
shrinks instead of overflowing into it, rather than relying on
left-anchoring alone (the earlier fix, which reduced but didn't
structurally prevent the collision). lint/tsc/build/test all pass
(431/431, 43 files, +17 new tests covering the row composition and the
specific CSS classes each fix depends on). Local production smoke test
confirmed the built route serves the homepage (200).

**Next task**: stop for the user's own real-device approval of this
cleanup pass specifically — Comment/Mic/Camera/Gift row, Leave Stage
with no collisions, ambient-comment clearance, top-right clearance,
keyboard behavior, toggling, leave/rejoin. #18 is not merged or closed
yet — that's still gated on this approval plus the originally-planned
integrated sign-off pass.

**The UI cleanup approved. One more integration issue surfaced during
that same sign-off pass, this time about #21, not #18**: rotating to
landscape as an *audience* member (not speaking) still fell back to the
legacy pre-05 interface — `RoomHeader`'s full status bar, the centered
"💬 Comments" toggle, `RoomChatPanel` — since portrait Watch Mode moved
past that model days earlier and nobody had come back to update
`MobileLandscapeRoom`'s audience branch. Explicitly scoped as a minimal
adaptation of the already-approved "05" shell, not a new design system,
and not a stretched-sideways portrait clone.

Rebuilt `MobileLandscapeRoom`'s audience/candidate branch to reuse the
*exact* components portrait Watch Mode and Speaker View already use —
`SpeakerViewTopChrome`, `AmbientComments`, `WatchModeControls` wrapping
the compact `ChatPanel`, `StageOverlayShell` — with the only genuine
orientation-specific difference being `SpeakerStage`'s own
`orientation="landscape"` (side-by-side tiles, two-speaker audience
viewing untouched). Reusing `SpeakerViewTopChrome` here (despite its
name) also closes the same self-preview-collision risk for a landscape
*candidate*'s prepared media that portrait's own inline top chrome still
has — deliberately left unfixed there this pass, since the user's own
verification plan required audience portrait to look unchanged.
`useCommentsMode` (and its test) deleted outright once this rebuild
removed its last import — confirmed `RoomChatPanel` stays alive via
`DesktopRoom`, so that component wasn't touched. With `useCommentsMode`
gone, this file no longer owns any hooks of its own, so the role router
can sit at the very top exactly like `PortraitRoom`'s, no "hooks above
the branch" ordering concern left to satisfy.

React/Vote/Gift stay exactly as inert as before; no Discussion Expanded,
reactions, voting, or gifting behavior added; `MobileLandscapeSpeakerView`
(working Speaker Landscape) untouched. lint/tsc/build/test all pass
(432/432, 42 files — one file fewer, `use-comments-mode.test.ts` deleted
along with the hook). Local production smoke test confirmed the built
route serves the homepage (200).

**Next task**: stop for the user's own real-device confirmation —
audience portrait unchanged, audience landscape now Social-Stage-styled
(not legacy), commenting and ambient comments both working in landscape,
rotating back to portrait intact, Speaker View (both orientations) still
working exactly as before. Neither #18 nor #21 merged or closed yet.

**Landscape rebuild confirmed much closer — one narrow follow-up**: the
site-wide header still consumed real height in audience landscape,
crowding the stage; Speaker Landscape already hid it outright but
audience never got that treatment. Broadened the existing header-hiding
mechanism instead of duplicating it: `EventRoom`'s body-class toggle,
previously gated on `isSpeaker` alone (`speaker-view-active`), now
triggers on `phase !== "upcoming" && !isDesktopViewport && orientation
=== "landscape"` — true exactly when `MobileLandscapeRoom` (either
branch) is the composition about to render, regardless of role. Renamed
to `mobile-landscape-live-active` to match its now-broader meaning; one
class, one CSS rule, not two near-duplicates. Portrait (either role),
desktop, and landscape outside the live room are all structurally
unaffected — the condition can only be true for the live room's mobile
landscape composition specifically. lint/tsc/build/test all pass
(432/432, 42 files — no test file changes, since `EventRoom` still has
no dedicated test file, same pre-existing limitation noted when this
class was first added). Local production smoke test confirmed the built
route serves the homepage (200).

**Next task**: stop for the user's own real-device confirmation — the
site header should now be fully gone in audience landscape (not just
shrunk), while the compact status pill, guest chip, two-speaker stage,
ambient comments, and composer/React/Vote/Gift row all stay visible;
audience portrait, landscape outside the room, and Speaker Landscape all
unchanged. Neither #18 nor #21 merged or closed yet.

**Header removal confirmed — one more small layout note**: the compact
composer stretched across most of the control row in landscape, pushing
React/Vote/Gift toward the far right instead of sitting immediately
after it. Root cause: the composer has no explicit width of its own in
`WatchModeControls`' row, so it grows to fill whatever the fixed-size
emblems don't claim — fine in portrait's narrow viewport, visibly
unbalanced in landscape's wide one. Fixed with a single Tailwind
`landscape:max-w-[40%]` on `ChatPanel`'s own compact-mode form —
confirmed safe to use bare (no desktop-exclusion clause needed, unlike
the app's own hand-written media queries elsewhere) since `compact`
mode structurally never renders outside the four mobile room
compositions. One change fixes both Watch Mode and Speaker View in
landscape at once, since both share this exact component; portrait is
provably unaffected. Still `flex-1`/`min-w-0` underneath — a cap, not a
fixed size. lint/tsc/build/test all pass (435/435, 42 files, +3 new
tests). Local production smoke test confirmed the built route serves
the homepage (200).

**Next task**: stop for the user's own real-device confirmation of the
composer width specifically — comfortably shows "Add a comment…" at
roughly 35–45% of the row, React/Vote/Gift (or Mic/Camera/Gift) sit
immediately after, portrait unchanged, no clipping at narrow landscape
widths. Neither #18 nor #21 merged or closed yet.

**Composer width confirmed — #18 sign-off/merge**: user approved commit
`9348972` as the final Speaker View state and asked for the #18
integration/sign-off merge: `feature/speaker-view` fast-forwarded into
`feature/social-stage-shell` (`a65c7f9..9348972`, 12 commits, zero
conflicts — confirmed `feature/social-stage-shell` hadn't moved since
the branch point before merging). lint/tsc/full suite/build all pass
unchanged (435/435, 42 files — a clean fast-forward changes nothing
already-tested). Local production smoke test confirmed. Pushed, deployed
a fresh preview from the merged branch, verified the deployment's `sha`
matched the merged HEAD exactly before handing over the link. #18 left
open, not moved to Done, per explicit instruction — the user wanted to
run their own integrated real-device test before sign-off.

**Real-device stress test surfaced an intermittent role/UI consistency
bug — treated as an architecture problem, not a boolean patch**: during
that pass, becoming a speaker sometimes activated Speaker View's
full-bleed composition while the bottom control row stayed on the
Audience set (React/Vote/Gift instead of Mic/Camera/Gift) — not reliably
reproducible. Per explicit instruction, investigated the actual
state/timing path before touching anything, rather than assuming a
cause. Traced every "am I a speaker" computation in the room tree:
`EventRoom`'s `isSpeaker` already drove both the composition choice and
(via which file renders) the control row within one render — provably
coupled, no divergence constructible there. But `SpeakerStage` itself
independently re-derived the same fact from raw `speakers`/`myIdentity`,
a real duplicate-derivation already flagged as a latent risk once before
(in `handleTapEmptySeat`'s own guard comment, for a different bug).
Reported this honestly: no concrete timing race could be proven against
the pre-fix code, but the duplication was a genuine violation of "one
authoritative role source" regardless.

Consolidated to a single computation: new `lib/participant-role.ts`
(`findMySeatNumber`, `deriveParticipantRole`) computes
`mySeatNumber`/`isSpeaker`/`participantRole` once in `EventRoom`; every
other consumer (`SpeakerStage`, the role routers) now receives these as
plain props instead of re-deriving them. `SpeakerStage`'s own internal
`viewerIsSpeaking`/`mySeatNumber` derivation is gone. Role routers key
off `participantRole === "speaker"`. Added a dev-only `console.error` in
`SpeakerStage` if `soloMode`/`isSpeaker` ever disagree (the one
remaining prop-level contract, kept as intentional defensive
redundancy, not independent derivation). Added `useRoleTransitionReset`
(new hook) so candidate-only local state (`hasPendingRequest`/
`micRequestMode`/`joinSeatMessage`) can't outlive the candidate role
regardless of which promotion path granted the seat. New
`role-consistency.test.tsx` adds the explicitly requested
transition-level coverage: promotion, leaving, repeated join/leave
cycles, promotion with stale composer state, and an approximated
"rotation" check (both orientation compositions compared against the
same speaker props) — documented honestly as not exercising a real
continuous device rotation or `EventRoom`'s own Realtime timing, since
`EventRoom` still has no dedicated test file. lint/tsc/full suite/build
all pass (469/469, 45 files — +34 tests, +3 files: `participant-role.
test.ts`, `use-role-transition-reset.test.ts`, `role-consistency.
test.tsx`). Local production smoke test confirmed.

**Next task**: deploy a fresh integrated preview from the merged
`feature/social-stage-shell` and stop for the user's own real-device
stress test, specifically trying to reproduce the original intermittent
report. This fix removes a genuine architectural redundancy and adds a
loud dev-mode signal for the one remaining prop-level contract, but does
**not** itself confirm the original report is resolved — that's
real-device-only, same as every other tier-3 claim this project makes.
#18 still not moved to Done.

**Role-consistency stress test passed — one UX finding before #18
close**: the countdown/status bar, ambient comments, composer, and
Audience controls could all be visible simultaneously during promotion,
making becoming a speaker read as just another notification instead of
a significant transition. Redesigned as a center-stage takeover: new
`CountdownOverlay` (large centered number, "Going live"/get-ready
copy, visually secondary Cancel, subtle per-tick pop animation via a new
`countdown-number-pop` keyframe) renders in place of the ordinary bottom
composer/controls/ambient comments in `PortraitRoom`/
`MobileLandscapeRoom` for exactly as long as `promotionCountdown !==
null` — explicitly a presentation change to `useAutomaticPromotion`'s
existing countdown state, not a new promotion system: no new timer, no
new state machine, `onCancelPromotion` unchanged. `SpeakerStage`'s
existing issue #21 scrim dims the stage behind it; top chrome stays
visible so it still reads as the same room. The existing role-router
structure (previous entry) already guarantees this can't coexist with
Speaker View — `promotionCountdown` is only ever non-null while
`!isSpeaker`, and the moment it flips the whole composition swaps to a
different file tree that never renders this component — so no new
invariant was needed to prevent overlap, just the presentation swap
itself. One shared component for both orientations, no landscape-
specific variant or legacy UI. New coverage: `countdown-overlay.test.tsx`
(the component in isolation), new describe blocks in `portrait-room.
test.tsx`/`mobile-landscape-room.test.tsx` (overlay replaces the bottom
row/ambient comments, scrim applies, top chrome persists, Cancel wired),
and countdown→speaker/countdown→cancel transition tests folded into
`role-consistency.test.tsx`'s existing invariant checks. lint/tsc/full
suite/build all pass (496/496, 46 files — +27 tests, +1 file). Local
production smoke test confirmed.

**Next task**: deploy a fresh integrated preview and stop for the
user's own real-device verification — countdown dominance, dimming,
animation restraint, and the landscape stage-area treatment are all
real-device-only judgments automated coverage can't make. #18 still not
moved to Done.

**Three issues found in that pass — a corrective fix, not new scope**:
(1) a brief flash of the old candidate UI right before the countdown
appeared; (2) Cancel during the countdown didn't reliably stay canceled;
(3) Speaker View's self-preview intermittently missing. Traced (1)/(2)
to a genuine confirmed mechanism: `useAutomaticPromotion`'s claim-success
handler used to reset `hasPendingRequest`/`countdown` itself, racing the
*independent* Realtime push that flips `isSpeaker` true — when the reset
won, the composition fell back to candidate UI for a frame before
`isSpeaker` caught up; and cancelling reset `countdown` while
`hasPendingRequest` was still momentarily true, which could re-arm the
polling effect and silently restart a canceled promotion before the
server-side withdrawal landed. Fixed by making `isSpeaker` the single
signal that ends this state (the countdown now reuses the existing
`useRoleTransitionReset` hook itself, resetting `countdown` on the same
transition `EventRoom` already resets `hasPendingRequest`/
`micRequestMode`/`joinSeatMessage` on — not a second mechanism) and
adding an `isCancelling` guard that suppresses re-polling for exactly the
window a cancellation is in flight. For (3), investigated each suspected
path (SelfPreview's own attach logic, the prepared-tracks publish
branch, the gesture-safety permission-sync guard) and found no proven
code-level gap, but a plausible unmodeled ordering among several
independent async completions — reported honestly rather than claiming
a confirmed cause. Added a defensive reconciliation effect in
`useLiveRoomConnection` (`shouldReconcileLocalVideoTrack`, pure and
fully unit-tested): if a live, unmuted camera publication already exists
but `localVideoTrack` state is null, adopts the existing track directly
— never re-acquires media, never reconnects, isn't a poll, keyed on the
existing LiveKit-level `canPublish` signal rather than a new role flag.
Logs a dev-only `console.error` whenever it actually fires. lint/tsc/full
suite/build all pass (513/513, 46 files — +17 tests; suite re-run twice
to check for fake-timer flakiness in the new cancel-race regression
test, stable both times). Local production smoke test confirmed.

**Next task**: deploy a fresh integrated preview and stop for the
user's own narrow real-device re-check — no flash, Cancel stays
canceled even after waiting, and self-preview consistently appears
across repeated promotions/camera toggles/rotation/leave-rejoin. #18
still not moved to Done.

**A real-device screenshot during that check showed one more issue**:
the compact "Request sent · Cancel" pill overlapping the composer and
ambient request comment once the bottom row got crowded — visibly
broken, not just redundant. Removed the pill entirely from
`PortraitRoom`/`MobileLandscapeRoom`; `ChatPanel`'s own 🎙 mic button now
carries a third, distinct pending state (a lighter pulsing accent,
alongside its existing idle/actively-composing states) and cancels the
request when tapped again in that state — wired to the same existing
`onCancelPromotion` action the removed bar's own Cancel button already
called, no new server-side capability needed. The existing badged
ambient "requesting the mic" chat message is preserved unchanged and is
already the social feedback that a request went through. lint/tsc/full
suite/build all pass (521/521, 46 files — +8 tests). Local production
smoke test confirmed.

**Next task**: deploy a fresh integrated preview and stop for the
user's own real-device re-check of this specific change — no overlap,
the pending mic-button state reads as clearly distinct from idle, and
tapping it while pending actually cancels the request. #18 still not
moved to Done.

**Two final changes before #18 sign-off**: (1) Speaker View's "Tap to
enable camera & mic" reworded to "Tap to reconnect" — confirmed (not
assumed) that this state only ever represents an already-seated
speaker's tab coming back fresh, never a genuine first-time activation,
since a real first promotion always runs `prepareLocalMedia` ahead of
time. Copy-only change. (2) The speaker disconnect "grace period" was
found to be entirely a client-side illusion: the LiveKit webhook called
`end_speaker_seat` the instant `participant_left` fired, no grace at
all server-side — a client-side hook only showed a cosmetic
"reconnecting" state on top of an already-vacated seat. Made it
genuinely server-authoritative: new migration `00000000000016` adds
`event_speakers.disconnected_at` plus three `service_role`-only
functions (`mark_speaker_disconnected`/`mark_speaker_reconnected`/
`release_expired_disconnected_speaker`), applied to the real linked
Supabase project via `supabase db push --linked` and regenerated types,
per the project's own established migration workflow. The webhook now
starts the clock on `participant_left` and clears it on a new
`participant_joined` handler instead of evicting immediately;
`checkAndEvictDisconnectedSpeaker` (room/actions.ts) now enforces the
real 11-second boundary via a single atomic `UPDATE ... WHERE` (race
safety is the WHERE clause itself, not a separate check-then-write) —
the old LiveKit `RoomServiceClient.getParticipant` live-check is gone
entirely. `useSpeakerReconnectGrace` redesigned to derive "who's
reconnecting" as a pure function of `disconnected_at` (already flowing
through the existing Realtime subscription) instead of comparing
against LiveKit's own live participant list — one fewer racy signal.
New `event-speakers-disconnect-grace.test.ts` verifies every requested
race scenario against the **real, live, linked database** (not mocks):
reconnect at ~10s retains the seat, no-return releases at 11s, a stale
release trigger arriving after a successful reconnect is a no-op, and a
late reconnect after the seat was reclaimed by someone else never
touches the new occupant. The webhook's own real-DB test file
(`route.test.ts`) extended to cover both event types; the hook's own
tests (mocked) cover the client-side scheduling/derivation separately.
lint/tsc/full suite/build all pass (540/540, 47 files — +2 files,
+19 tests). Local production smoke test confirmed.

**Next task**: deploy a fresh integrated preview and stop for the
user's own real-device verification — the reconnect copy, and
specifically a real disconnect/reconnect cycle (both inside and outside
the 11-second window) on an actual device, are the two things automated
coverage genuinely cannot confirm by itself. #18 still not moved to
Done.

**Two more issues before sign-off**: (1) an intermittent report of
Speaker View failing to activate on first/fresh load, most reproducible
right after a fresh deployment — investigated the full first-load
lifecycle as instructed rather than guessing. Server-side data and
`participantRole`'s own derivation were both ruled out with evidence
(checked this exact Next.js version's own bundled docs for the caching
model, rather than assuming from training data, since Cache Components
is off here). Found the real cause: `useOrientation`/
`useIsDesktopViewport` guess a mobile default for the client's first
hydration render (correct, to avoid a mismatch), and a genuine desktop
browser's post-hydration correction was switching `EventRoom` to
`DesktopRoom` — which has no role router at all, an already-approved
scope boundary (no Speaker View on desktop) — after briefly showing
Speaker View via a mobile composition first. New
`useHasMountedOnClient()` (the same `useSyncExternalStore` idiom the
other viewport hooks already use, not a new role flag) gates
`EventRoom`'s composition choice entirely: a brief neutral
"Reconnecting to stage…" state (only worded that way when already known
to be a speaker) shows until the client has genuinely settled, so a
wrong composition is never even briefly committed to. Dev-only
`console.debug` logging added around the composition-selection inputs.
New `event-room.test.tsx` (first dedicated test file for this
component) drives every hydration-order scenario requested directly.

(2) The reconnect prompt needed to show real remaining time, not just
"Tap to reconnect." `EventRoom` now threads the viewer's own active-seat
`disconnected_at` down; new `useReconnectCountdown`/
`remainingGraceSeconds` derive the display purely from that
authoritative deadline plus the existing 11-second grace period —
ticking is a `setInterval`, never a fresh client-invented timer. A
reopened tab partway through an existing window shows the correct
remainder immediately; reconnecting clears the countdown at once; the
whole prompt (and any countdown) disappears the moment Speaker View
itself unmounts, via the existing role-consistency guarantee — no new
mechanism needed for that part. lint/tsc/full suite/build all pass
(565/565, 49 files — +3 files, +25 tests; suite re-run twice for
fake-timer flakiness, stable both times). Local production smoke test
confirmed.

**Next task**: deploy a fresh integrated preview and stop for the
user's own real-device verification — specifically a first load
immediately after opening the preview while already a speaker, repeated
refresh/reopen while seated, and a real disconnect/reconnect cycle
watching the countdown. #18 still not moved to Done.

---

## 2026-08-23 — Session 23: Figma "05 — Social Stage" exploration finalized; real-device implementation begins (Phase 1)

**Goal**: Continuation of Session 22's Figma-only design-exploration work
(00 → 05e across the `Virtual Stage — UI Exploration` file). This session
finished that exploration, got it approved, then began translating it
into real code.

**Figma work completed this session** (all in the existing exploration
file, no Virtual Stage code touched until the implementation phase
below): installed the official Figma MCP plugin and, separately, the
official Playwright MCP server (needed for external-URL capture — the
Figma capture tool only supports localhost via script injection or
external URLs via Playwright, and editing source code to inject a
capture script was explicitly off-limits); captured the real deployed
production Watch Mode into Figma as the `00` baseline; built `01`
(Minimal Video-First), `02` (Social Video), `03` (Immersive Stage) and a
`03b` Discussion-Mode sketch; iterated based on user feedback into a
`04` "Social Stage" family (04/04a/04b/04c) merging the strongest ideas
from `02`/`03`/`03b`; then a final `05` family
(05/05a/05b/05c/05d/05e) incorporating: always-accessible quick
commenting (no mode gate), ambient ampule comments left / reactions
right, a persistent glass-style bottom row (composer · React · Vote ·
Gift), targeted double-tap reactions, and Gift as the fourth
participation action replacing a since-removed standalone Comments
emblem. Hit and recovered from a Figma Starter-plan rate limit
(20 calls/month) mid-session — user upgraded to a Pro/Dev seat
(200/day) to unblock. Caught and fixed several construction-only bugs
along the way (ambiguous `findOne` matches tinting the wrong node,
default-white auto-layout fills, an errant `resize()` locking a
callout to 1px) — all caught via screenshot review before being
reported as done, never left in the file.

**Real-device implementation approved and begun**: full architectural
survey before any code changed (see DECISIONS.md's 2026-08-23 entry for
the complete findings) — confirmed reactions today are durable/
per-message with no ambient concept, voting is entirely unbuilt (#25
territory), the composer's request-to-speak/send logic must be reused
not duplicated, `useLiveRoomConnection` already sits correctly above
all composition branching, and the "ephemeral broadcast, no row per
event" principle documented in ARCHITECTURE.md has zero existing
implementations. Produced a 7-phase implementation plan (static shell →
composer → ambient comments → Discussion Expanded → emoji broadcast →
double-tap targeting → Vote/Gift shells), approved with clarifications:
Discussion Expanded is an explicit, scoped exception to "Watch Mode
never resizes video" (governing invariant there is stable media
identity, not immutable geometry); Vote/Gift stay local-UI prototype
shells with zero backend; the emoji quick-set stays replaceable data,
not the final reaction architecture; ambient reactions need rate
protection when built. Checkpoint tagged
(`prototype-pre-05-implementation-stable` at `5c36d8b`, identical
content to `prototype-pre-figma-stable` — tagged again because it marks
a different milestone). Issue #21 retitled/re-scoped (kept, not
replaced — same underlying problem, mechanism changed twice) to own
Phases 1–4; Phases 5–6 and 7 proposed as two new issues to be created
only once those phases actually start, per explicit instruction not to
create speculative board churn.

**Phase 1 (static shell) implemented on `feature/social-stage-shell`**:
`PortraitRoom` rebuilt — video-first, minimal top chrome replacing
`RoomHeader` for this composition, lightweight top-anchored speaker
identity (portrait-only; landscape's own header-overlay would collide
with it, left unchanged), and the new persistent
composer/React/Vote/Gift control row (`WatchModeControls`, new), all
functionally inert (`disabled`) in this phase. `StageOverlayShell`
gained an opt-in `gradient={false}` and `GuestNameEditor` gained an
opt-in `variant="chip"` — both additive, no existing caller's
appearance changes. The old Comments Mode toggle/panel is removed from
`PortraitRoom` entirely (not run in parallel) — commenting/reading are
temporarily unavailable on this branch until Phases 2/4 restore them.
lint/tsc/build/test all pass (293/293, 35 files). Structural local
production smoke test confirmed `watch-composer`/`watch-status-pill`
present, `comments-toggle` gone, from the actual server-rendered route.

**Next task**: stop for the user's own real-device confirmation of
Phase 1's static layout on mobile portrait specifically — no chat/react/
vote/gift functionality to test yet, only that the video-first
hierarchy, top chrome, and inert control row look and feel right, and
that nothing existing (tap-to-join, camera/mic activation, leave-stage/
promotion-countdown, guest name editing) regressed. Do not begin Phase 2
until explicitly approved.

**Phase 1 confirmed on a real iPhone** — video-first direction, minimal
chrome, and the inert bottom controls all landed as intended; camera/mic
activation and being on stage both still work.

**Phase 2 (functional composer) implemented, same branch**: gave
`ChatPanel` an opt-in `compact` prop rather than a second component —
same `sendMessage`/`submitSpeakerRequest` actions, same
`micRequestMode` contract, same synchronous `onPrepareMedia()` submit
order, only the surrounding chrome differs (no message list, no
quick-emoji row, glass-pill styling). `WatchModeControls` gained a
`composer` slot; `PortraitRoom` wires the compact `ChatPanel` into it
using the same `RoomLayoutProps` fields `RoomChatPanel` already used
elsewhere. Mic-on state tints the pill/mic-icon accent-colored, no size
change. React/Vote/Gift remain `disabled`; no ambient comments,
Discussion Expanded, reactions, or voting/gifting yet — still out of
scope. lint/tsc/build/test all pass (305/305, 35 files). Local
production smoke test confirmed the real composer/mic-toggle markup
renders from the actual built route.

**Speaker View flagged as the next checkpoint, not started**: the
user's real-device Phase 1 test surfaced that a seated speaker's UI
still looks like the audience Watch interface, which isn't the intended
final behavior — scoped to existing issue #18, to be designed *after*
Phase 2 is confirmed and *before* Phases 3–7, since ambient comments/
Discussion Expanded/reactions/voting/gifting may need different
placement depending on audience-vs-speaker role.

**Next task**: stop for the user's own real-device confirmation of
Phase 2 specifically — ordinary comment sending, keyboard open/close
behavior, Request-to-Speak toggle/submission, that plain commenting
never triggers a camera/mic prompt, existing seat/stage behavior,
portrait → landscape → portrait, and returning to Watch after keyboard
dismissal. Do not begin Phase 3 or the Speaker View design/
implementation until explicitly approved.

**Phase 2 real-device testing found four issues, all fixed on the same
branch** (no Phase 3 work started): (1) the mic-on placeholder truncated
on the user's iPhone — shortened to "What's your topic?", compact mode
only. (2) A stale "still pending" UI with a non-functional Withdraw
persisted after leaving the stage — traced to its actual root, not
hidden cosmetically: `claimOpenSeat` succeeding never told the client
`hasPendingRequest` was stale (fixed in `useAutomaticPromotion`), and
`withdrawSpeakerRequest`'s underlying RPC raises an exception ("no
pending request found") when there's nothing pending to withdraw, which
used to surface as a silent-looking failure that never cleared the flag
(fixed in the repository layer, treating that specific exception as
`null`/success rather than an error). (3) The pending-request UI was
too visually heavy for Watch Mode — `RoomControls` gained a `compact`
mode for its two `hasPendingRequest` states specifically (not
`isSpeaker`), rendering a single-line "🎙 Request sent · Cancel" pill
instead. (4) The Gift emblem could clip on narrow phones — a broken
flexbox `min-width` shrink chain (the composer, the only element meant
to shrink, was missing `min-w-0` at two nested levels), not a genuine
width shortage; fixed by completing the `min-w-0` chain down to the
input. Deliberately not built: any comment-sent confirmation UI — the
user was explicit that Phase 3's ambient-comment feed is the intended
feedback mechanism, not a temporary duplicate.

lint/tsc/build/test all pass (315/315, 36 files, +10 new tests
targeting these fixes specifically). Local production smoke test
confirmed the `min-w-0` classes and new placeholder text render from
the actual built route.

**Next task**: stop for the user's own real-device retest of these four
fixes specifically. Do not begin Phase 3 or the Speaker View design
until explicitly approved.

**Real-device retest found a fifth issue**: focusing the compact
composer triggered iOS Safari's auto-zoom-on-focus, panning the page.
Investigated before touching anything, per explicit instruction not to
assume the cause: confirmed (not guessed) that this project has no
`tailwind.config`/`fontSize` overrides, so Tailwind's stock scale
genuinely applies — the compact `<input>` was `text-sm` (14px, under
Safari's 16px threshold). Checked for a compounding cause too: no
`transform`/`scale`/`zoom` anywhere in the room component tree, no
`scrollIntoView`/`visualViewport` code anywhere in the codebase — the
pan is Safari's own zoom mechanism, not a second bug. The shared
`<Input>` component already documents this exact fix
(`text-base`, not `text-sm`); the compact composer's raw `<input>`
(needed for the glass-pill layout `<Input>`'s fixed styling doesn't
support) had simply drifted from that convention. Fixed with one class
change, same input for both mic-off/mic-on. No `maximum-scale`/
`user-scalable` added — explicitly forbidden, and unnecessary once the
actual cause is fixed. Added a regression test pinning the rendered
class, explicitly caveated as not proving real Safari behavior.
lint/tsc/build/test all pass (317/317, 36 files).

**Next task**: stop for the user's own real-device retest of this fix
specifically, plus a quick pass confirming the four Phase 2 fixes are
still intact. Do not begin Phase 3 or the Speaker View design until
explicitly approved.

**Phase 2 confirmed on a real iPhone**: the zoom fix holds, keyboard
behavior is acceptable, Request-to-Speak works, and the stale
pending-request bug stays fixed.

**Phase 3 (ambient live comments) implemented, same branch**: new
`AmbientComments` component renders the last few live comments as a
small, self-expiring stack of translucent bubbles in Watch Mode's
lower-left, reusing the *same* `messages`/`useLobbyRealtime` stream
every other room composition already reads — no second comment
backend, no duplicated message state (see DECISIONS.md for the full
ambient-vs-data-lifecycle reasoning). Seeded from the last 3 messages
already present at mount; each message gets one ~7s fade-in/hold/fade-
out lifecycle the first time it's seen (`ambient-comment-fade` keyframe
in `globals.css`), tracked independently of the data's own permanence;
a burst evicts the oldest bubble immediately rather than growing past
3. Request-to-Speak comments reuse the existing 🎙 badge treatment.
Each bubble carries `data-message-id` — a deliberate seam for a later
Discussion Expanded tap handler, not implemented yet (no `onClick`).
Wired into `PortraitRoom` as an absolutely-positioned overlay
(`bottom-16 left-3`, click-through outside the bubbles, same pattern as
the existing top chrome), clear of the composer row and the speaker
identity treatment, reserving no layout space. lint/tsc/build/test all
pass (328/328, 37 files, +14 new tests). Local production smoke test
confirmed the built route serves the homepage (200).

**Next task**: stop for the user's own real-device review of Phase 3
specifically — another device's comment appearing ambiently; the
user's own comment appearing as quick confirmation; several comments in
succession staying readable with natural fade/expire; comments never
covering the composer or speaker identity; no video resize/reflow;
keyboard/sending and Request-to-Speak still working; portrait →
landscape → portrait regression check. Per explicit instruction, do
**not** auto-continue to Discussion Expanded after approval — the next
step is pausing to design/plan the Speaker View (issue #18) before any
further social-system phases.

---

## 2026-08-20 — Session 22: Video-first room redesign finalized; issues #19–#25 created

**Goal**: Continuation of Session 21's participation-friction design work,
now reconciled with a mobile UX direction the user specified: video stays
the stable visual foundation, chat/voting are revealed as layers over it
rather than causing the video to shrink/rearrange. Explicitly no
implementation this session — resolve the remaining open technical
questions, create the approved issues, update docs, then stop.

**Checkpoint reconfirmed**: `prototype-live-av-stable` (tag + prerelease)
verified still intact and unchanged — tag commit `397d3ff`, working tree
clean, no code shipped since. No new checkpoint needed.

**Architecture finalized** (full reasoning in DECISIONS.md, not duplicated
here): scrim/overlay layers over a geometrically stable video base (never
resizing the video element itself); a dead-zone-gated drag-handle gesture
for chat/voting focus, explicitly not scroll-snap or scroll-position
interpolation (both would reintroduce the nested-scroll bug already
diagnosed); `ChatPanel` as one continuously-mounted component so draft
text/scroll/mic-request-mode survive focus changes; self-preview spatial
stability falls out of the scrim architecture for free; voting-window
evaluation triggered by the two active speakers' clients plus opportunistic
vote-casting (not audience-wide polling — Vercel Cron and Supabase
`pg_cron` were both considered and rejected); recurring voting windows via
modular arithmetic on `pairing_start_time`, no stored timer state;
immediate (not held) eviction on a no-replacement vote outcome; a minimal
`events.format` column as the room-format seam, no rules-engine.

**Issues created and added to the project board** (Backlog column,
dependency order): #19 room format seam, #20 video-first room shell, #21
chat/voting focus interactions, #22 composer mic-request + candidate
readiness/self-preview, #23 direct-join + automatic promotion, #24 fresh
next-speaker ranking, #25 audience retention voting. #20 was split from a
single larger "layout" issue specifically so the stable video shell can be
verified on a real phone before the gesture layer (#21) is added on top.
ROADMAP.md's Phase 2 gained a new "Video-first participation redesign"
subsection listing all seven, sequenced ahead of issue #18 (now the final
step). Explicitly deferred, not created: candidate snapshot/profile-preview
icons, Roulette, Spotlight, Group Stage, avatars/VTubers, image/GIF chat
uploads, cosmetic animation/polish beyond functional interaction,
monetization.

**Issue #19 implemented, same session**: docs committed first via a
dedicated `chore/video-first-architecture-docs` branch (fast-forward merged
to `main`, no new checkpoint — a docs-only change). Confirmed #19's scope
was unchanged by the finalized architecture (nothing in #20/#21/#22
touches `event.format`) before starting. `feature/room-format-seam`:
migration `00000000000014_add_events_format.sql`
(`events.format text not null default 'main_stage' check (format in
('main_stage'))`, same pattern as `event_speakers.left_reason`), types
regenerated, and `format` added to the `events` repository's `Event`
domain type (a literal `"main_stage"` union, cast at the query boundary —
without this the column existed in the database but was unreachable from
application code). Verified directly against the linked database: existing
rows backfilled to `'main_stage'`, and the CHECK constraint actually
rejects an invalid value (not just assumed from the migration text).
lint/tsc/build/test all pass (150/150). Merged to `main`, pushed. Board
card moved to Done. No new checkpoint tag — this is incremental,
not a new verified-stable milestone.

**Issue #26 recorded, same session**: "Join Live Audience fast path" — a
landing-page direct-to-room entry point (distinct copy from "Join Now" to
avoid reading as account creation/signup/speaker join), routing straight
into the best currently-live/participatory room as an audience member,
no intermediate screens, no automatic mic/camera/mic activation. Room
selection deliberately simple (prefer an active room, else the best
enterable one, graceful empty-state) — no recommendation/matchmaking
infrastructure. Scoped to stay compatible with the format seam (#19)
without building any new format. Created as issue #26, added to the
board in Backlog, not implemented — independent of the #20–#25 sequence,
did not interrupt it.

**Issue #20 implemented, same session**: re-read fresh before starting —
confirmed unchanged from the approved architecture. `feature/video-first-
room-shell`: `SpeakerStage` restructured to fill essentially all space
below the header (full-bleed tiles, stacked in portrait/side-by-side in
landscape, no more `aspect-video`/gap/per-tile rounding), with controls
and a compact, height-constrained chat strip (the same `ChatPanel`
instance, not a placeholder) below it instead of chat filling the page.
Added three inert structural anchors: a speaker divider (plain
`aria-hidden` div, not a button yet — a non-functional button is worse
for assistive tech than no button), an empty self-preview slot, and a
scrim (`opacity-0`/`pointer-events-none` by default — verified this
matters now, not just later: without `pointer-events-none` it would
block taps on a tile underneath). `RoomDiagnostics` gated behind
`isDevToolsAvailable()` — verified directly against a real production
build/server that it's absent from a live room page's HTML while the
four new shell markers render correctly. `EventRoom`'s root containers
gained `overflow-hidden`, scoped to the room only. lint/tsc/build/test
all pass (155/155, 5 new). Merged to `main`, pushed, production
deployment confirmed. Board card moved to Done.

**Real-device test path was a dead end, same session — diagnosed and
fixed**: the user's first attempt at the #20 real-device journey hit
"Nothing scheduled right now" on `/events`. Root cause, confirmed against
the database, not assumed: every existing event (the three seeded ones)
has a `scheduled_start` from 2026-08-09/08-11, and `listUpcomingEvents`
only shows events within 2 hours of `scheduled_start`
(`getEventsListCutoffIso`) — by 2026-08-21 every seeded event was days
past that window. This is the same class of problem issue #11 ("Events
list hides events whose lobby is still open") already tracks, and the
same class of problem Session 20 hit for #17's retest — a real, recurring
gap in this project's test-fixture hygiene across sessions, not a one-off.

Fixed by creating a fresh event (`[dev-harness] Video-First Stage Test`,
id `0ad27bff-4816-4d1a-8dc8-48c5c4f95827`, phase `ready`) with one
synthetic speaker seated (seat 1, `alice@dev-harness.invalid`) and seat 2
left open — a mixed occupied/empty state so the deployed shell can
actually be exercised, not just viewed empty. Verified directly against
**production** (`curl` against `project-stage-weld.vercel.app`, not the
database and not a direct room URL): the landing page's "Browse events"
CTA → `/events` (no longer showing the empty-state message, the new
event's card present and correctly linked) → `/events/<id>` (renders as
a guest with no redirect, shows the seated speaker and the open seat, all
four #20 shell markers present, no diagnostics panel, "Request the mic"
control available for the user to test the open seat themselves). Will
stay listed for ~2 hours from creation — ample margin.

**Process correction, same session**: issue #20 had been marked Done on
the board and closed on GitHub based on automated/server-side
verification alone. The user correctly pushed back — a change that
specifically touches the real mobile room experience isn't done until
confirmed on a real device, which ARCHITECTURE.md's Testing & Definition
of Done section already implies (phone-width checks, live rotation,
guest walkthroughs) but wasn't applied strictly enough here. Reopened
issue #20, moved its board card back to Testing / Review, and
un-checked its ROADMAP.md line pending that confirmation. The code
itself is untouched — still merged, still deployed — this was a status
correction, not a revert. Applying this standard on every issue that
touches the live room going forward, not just when reminded.

**Next task**: same as before — real-device (iPhone) validation of the
shell, now against a working test path. Issue #21 does not start until
that happens.

**#20's real-device test came back negative, same session — replanned,
not yet re-implemented**: the user tested the working fixture above and
found #20 didn't meet its own stated bar. Three findings: (1) the default
room still reads as "video, then controls, then chat" stacked sections,
not a video-dominant livestream with layers over it — a genuine #20 gap,
not #21's to fix; (2) the empty-seat request flow (Request → type a
reason → submit → Claim) is high-friction for a seat nobody's contesting,
confirming the user's product intent for direct-join is worth pulling
forward; (3) the separate "why should you get the mic?" composer is
exactly the duplication #22 already exists to remove.

Re-read #20–#23 fresh, mapped each finding to the issue that actually
owns it, and proposed a revision the user approved in full:

- **#20 gets a corrective pass under the same issue** (not a new one) —
  controls/chat become a genuine bottom overlay over the video with an
  always-on legibility gradient, distinct from the still-inert
  `room-scrim` (still #21's job); self-preview slot moves to the
  top-right so the new overlay doesn't sit under it. Zero gesture/drag
  logic in this pass — confirms the fix belongs to #20, not #21, since it
  needed none of #21's actual mechanics to be correct.
- **#21's body tightened** to explicitly not own default-state
  compositing, so this exact ambiguity can't recur when #21 starts.
- **#23 split**: **#27** ("Direct join on an uncontested empty seat") is
  the readiness-independent half, pulled forward; #23 narrowed to
  automatic promotion for genuinely contested seats only, keeping its
  (now non-soft) dependency on #22.
- **Board/issue reorder**: #20 (corrective pass, stays Testing/Review) →
  #22 (Ready) → #27 → #23 → #21 (moved later — no dependency on
  #22/#23/#27, just lower priority than the friction those remove) → #24
  → #25 → #18, unchanged. Project board statuses and item positions
  updated to match; #24/#25 deliberately left untouched per explicit
  instruction not to start voting work.

**Plan approved and executed, same session**: issue bodies updated (#20
amended with the corrective-pass scope, #21 tightened to stop it from
absorbing default-state compositing, #23 narrowed to contested seats
only), **#27** ("Direct join on an uncontested empty seat") created and
split from #23, board statuses/positions updated to match the new order
(#20 stays Testing/Review; #22 → Ready; #27, #23, #21 → Backlog,
positioned in that order). #24/#25 deliberately left untouched.

**#20's corrective pass implemented**: portrait's controls + compact chat
strip are now an absolutely-positioned overlay anchored to the bottom of
the stage, over the video, instead of a shrink-0 flex sibling — the stage
gets 100% of the space below the header now, not ~65–70%. New
`.stage-overlay` class (`globals.css`) re-scopes theme color tokens
(`--foreground`/`--muted`/`--border`/`--accent`) to fixed dark values for
that subtree, so chat/controls stay legible against live video regardless
of the visitor's system theme — zero changes to `ChatPanel`/
`RoomControls`/`Input`/`Button` themselves, since they already reference
theme tokens Tailwind compiles to read the raw custom properties
directly. Self-preview slot moved to top-right. Landscape untouched
(not what the real-device test flagged). Zero gesture/drag logic added —
confirms the fix genuinely belonged to #20, not #21.

**Test fixture had disappeared entirely, same session — recreated**:
verifying the corrective pass against a local production build hit an
HTTP 404 for the event created for the previous real-device test — the
row was gone from the database outright (not just aged out of the list's
2-hour window; a direct `getEventById` query returned zero rows). Cause
not conclusively identified (most likely the user or another session ran
`dev-harness reset`), but the fix is the same either way: recreate the
fixture immediately before handing off, verify it exists right before
asking for a test, don't assume a fixture created earlier in the session
still exists later in it. New event created (id `b4f8403b-b39b-4dad-ac92-
b841ccbbab44`, same seeded structure — one seat occupied by
`alice@dev-harness.invalid`, one open), verified via a local production
build (HTTP 200, all shell markers present, self-preview-slot at
`top-3`), and will be re-verified against the actual deployed production
site before the user is asked to test again.

**Next task**: same acceptance bar as before, now against the corrective
pass. Stop for real-device confirmation — do not continue into #22
automatically.

**Test-room disappearance escalated to a permanent fix, same session**:
after the #20 corrective pass verification, the user hit the exact same
"Nothing scheduled right now" dead end a third time (Session 20's
retest, and twice already this session). They were explicit this could
no longer be a one-off fixture recreated per-session — the deployed app
needed a durable, database-level guarantee. Built and shipped: a
permanent `is_permanent_test` event row ("[DEV] Always-On Test Room",
migration `00000000000015`), enforced to be at most one by a partial
unique index, exempted from the events list's time-based visibility
cutoff, and excluded from both reset paths
(`dev-harness.mts`/`resetDevDemoEvents`) — full reasoning, including the
rejected cron-based alternative, in DECISIONS.md. New `clear-sandbox`
command tidies its transient state without deleting it. Verified with
two new integration tests against the real linked project (survives a
real `resetHarness` call; `clear-sandbox` removes chat/speaker rows but
not the event itself), plus direct verification against the deployed
production site (Browse Events → the room → unified room, no commands
run). lint/tsc/build/test all pass (160/160).

**Next task**: real-device confirmation of #20's corrective pass, now
against a permanently working test path — this problem should not
recur. Do not continue into #21/#22 until that confirmation happens.

**Redirected mid-session, same session**: the user paused the #20–#27
roadmap sequence entirely to solve one interaction at a time, starting
with issue #26 ("Join Live Audience"). Re-read #26 fresh — its body
already matched the requirements restated in the redirect exactly, no
drift, no update needed. Implemented: `findJoinableEvent`
(`lib/repositories/events.ts`) — prefers a joinable event with active
speakers, falls back to any joinable event (ordering reused from
`listUpcomingEvents`, no new scoring), falls back to `null` (→ Browse
Events) if nothing qualifies; `listEventIdsWithActiveSpeakers`
(`lib/repositories/event-speakers.ts`), the one new query; `/join`
(`src/app/join/route.ts`), a plain GET redirect, no page; the landing
page's `Hero` gained the "Join Live Audience" CTA (prominent) alongside
"Browse events" (secondary) and "See how it works" (demoted to tertiary,
its own line). No dedicated unit test — `findJoinableEvent` depends on
the cookie-based server client, which throws outside a real Next.js
request, the same reason no test file has ever existed for
`listUpcomingEvents`/`getEventById` either; verified instead via a local
production build/server (`/join` correctly 307-redirected to a real
room) before merging. lint/tsc/build/test all pass (160/160, no
regressions). Merged, pushed, production deployment confirmed, and the
real production journey (landing → Join Live Audience → room) verified
directly against the deployed site.

**Next task**: stop for the user's own real-device confirmation of the
Join Live Audience path specifically — landing page obviousness, one-tap
behavior, no Browse Events step, no login/signup, lands as audience, no
unexpected camera/mic, destination room works. Do not begin #20's
real-device confirmation or any other feature until this one is
confirmed — the user was explicit about doing one interaction at a time.

**Speaker-entry friction removed, same session (issues #22 partial +
#27 full)**: before coding, inspected the current implementation
(`RoomControls`, `SpeakerTile`, `ChatPanel`, `claim_speaker_seat`'s
actual concurrency mechanism) and re-read #22/#27/#23 fresh, mapping
each part of the requested change to the issue that owns it. Implemented
both together in one coordinated change (they share the same composer
and interact directly — a queue-exists result from tapping an empty
seat activates the composer's request mode), but scoped strictly to
#27 in full plus only #22's "composer-integrated request" design bullet
— none of #22's readiness/self-preview/promotion-without-reacquiring.

New `joinOpenSeat` server action: refuses if any pending
`speaker_requests` exist for the event (checked server-side, the actual
queue-protection boundary), otherwise reuses `claim_speaker_seat`
exactly as the existing `claimOpenSeat` does — confirmed via
`event_speakers_active_seat_uniq` (migration 00000000000005) that two
simultaneous taps on a genuinely empty seat still resolve to exactly one
winner, no new concurrency primitive needed. `ChatPanel` gained a 🎤
toggle switching the same input/button pair into request mode
(`submitSpeakerRequest`, a thin adapter over the existing
`requestToSpeak`); `micRequestMode`/`hasPendingRequest` lifted to
`EventRoom` as controlled state, since the composer and an empty-seat
tap are siblings that both need to drive them, and state that must
survive rotation can't live inside either alone. `RoomControls` lost its
standalone request-button state entirely — renders nothing for a plain
audience member now. 15 new/updated tests; lint/tsc/build/test all pass
(176/176).

**Verification-tier rule added to AGENTS.md, same session**: this was
the third time a change passed automated checks while still failing the
real journey. Added a permanent rule distinguishing automated /
production-interaction / real-device verification, requiring every
UI/UX handoff to report against all three explicitly rather than
rounding real-device items up to "verified." Full reasoning in
DECISIONS.md.

**Verification performed this session**: automated — full pass (see
above). Production interaction — the real landing→Join Live
Audience→room journey re-verified against the deployed site after this
change, plus structural confirmation (via fetched, server-rendered HTML)
that the standalone request button is gone, empty seats render as real
`<button>` elements, exactly one composer `<input name="body">` exists,
and the 🎤 toggle is present. Explicitly not claimed as verified: actually
tapping the empty seat, the queue-protection fallback with two real
users, guest-gated messaging, mic-mode toggling visually, or camera/mic
on real mobile Safari — all real-device territory, listed for the user
in this turn's response, not duplicated here.

**Next task**: stop for the user's own real-device confirmation of this
interaction specifically (see this turn's response for the exact
checklist). Do not begin #21, #23, #24, #25, or any other feature until
confirmed.

**Direct tap-to-join confirmed real-device verified by the user, same
session** — the first item to reach that bar. Immediately redirected to
a new problem from the same real-device pass: the speaker divider (and
its center dot) visibly painting on top of "Claim your seat"/"Withdraw"/
composer/chat in real screenshots.

**Root cause inspected before any code change**, per instruction:
`SpeakerStage`'s root was `relative` with no explicit `z-index` — which
does not establish a CSS stacking context (that needs position *and* a
non-`auto` z-index together). Without one, the divider's `z-index: 10`
escaped past the stage entirely to compete directly against
`stage-bottom-overlay` (no z-index of its own) at an ancestor stacking
level, and `10 > auto` put it on top regardless of DOM order. Fixed by
containment, not per-element z-index escalation (explicitly ruled out):
`SpeakerStage`'s root is now `relative z-0`, permanently confining
everything inside it; `stage-bottom-overlay` gets an explicit `z-10` for
an unambiguous outer ordering. The divider itself needed no z-index at
all once properly contained — removed along with its decorative center
dot (no function until #21/#25, part of the flagged clutter). Full
reasoning in DECISIONS.md.

lint/tsc/build/test all pass (180/180, 4 new regression tests). Merged,
pushed, production deployment confirmed. Zero behavior change to
LiveKit/video geometry/Join Live Audience/the test room/tap-to-join/
mic-mode composer — pure layering fix.

**Next task**: stop for the user's own real-device visual confirmation
that no divider/dot/decoration crosses foreground UI anywhere. Do not
begin #21, #23, #24, #25, or any other feature until confirmed.

**Divider layering confirmed real-device verified by the user, same
session.** Redirected to the manual "Claim your seat" step next — the
last friction point from real-device testing of the mic-request flow.

**Before coding, re-read #22/#23 fresh and mapped scope**, per
instruction: automatic promotion + countdown belongs to a *narrowed*
slice of #23, explicitly *without* pulling in #22 as a prerequisite —
the user was explicit that camera/mic publish should keep using "the
existing authorized path" (the current separate gesture-gated "Tap to
enable camera & mic" step), so #23's own stated dependency on #22's
readiness signal doesn't apply to this narrower version. Full reasoning
in DECISIONS.md.

**Implemented**: new `checkPromotionEligibility` (room/actions.ts,
read-only) and `claimOpenSeat` (unchanged behavior, now acts on it) share
one extracted `resolveClaimDecision` helper, so the eligibility the
countdown polls for and the eligibility the real claim enforces can never
diverge. New `useAutomaticPromotion` hook (src/hooks/) — called from
`EventRoom` above the orientation branch — polls every 4s while a
candidate has a pending request (polling, not purely Realtime-reactive:
rank can shift from reactions on a *different* candidate's request
without any `event_speakers` change), starts a 3-second "You're up next"
countdown once eligible, then calls the real `claimOpenSeat` (which
independently re-validates — the countdown itself has no authority).
Also self-evicts (reusing the existing `leaveSpeakerSeat`) a promoted
candidate who never activates media within a 30s grace period —
disconnection was already covered by the existing LiveKit webhook.
`RoomControls` lost `handleClaim` entirely; "Withdraw" and "Cancel" both
call the same `onCancelPromotion`.

**Race protections unchanged**: `claim_speaker_seat`'s partial unique
index remains the sole concurrency backstop, untouched by this change.

**Testing**: 15 new tests (8 for `RoomControls`' countdown/cancel states,
7 for the hook). One planned test (the full countdown-ticks-to-zero-
then-claims chain) was attempted with multiple fake-timer strategies and
dropped as unreliable in this test environment, not evidence of a real
bug — noted explicitly rather than forced or silently omitted. lint/tsc/
build/test all pass (188/188). Merged, pushed, production deployment
confirmed.

**Next task**: stop for the user's own real-device confirmation of the
automatic-promotion/countdown flow — see this turn's response for the
exact checklist. Do not begin #21, #24, #25, or any other feature
(including #22's remaining readiness/self-preview scope, which the user
explicitly deferred until after this) until confirmed.

**Automatic-promotion flow confirmed acceptable in real production use,
same session** — third checkpoint tagged, `prototype-auto-promotion-stable`
on `e934619` (same process as the prior two: two independent commit/
deployment checks, a fresh structural pass against the deployed site,
pushed, verified present remotely, GitHub Release created marked
prerelease). `prototype-live-av-stable` confirmed untouched, still at
`397d3ff` — this is an additional recovery point, not a relocation. Full
reasoning in DECISIONS.md.

**Next task**: begin investigating issue #22's remaining scope (candidate
media readiness, persistent local self-preview, promotion without
reacquiring media) — inspection first, per explicit instruction, report
back before writing code.

**Issue #22's remaining scope investigated and implemented, same
session**: inspection first, per instruction — confirmed the checkpoint
tag's presence remotely, re-read #22 and the current
`use-live-room-connection.ts`/`event-room.tsx`/`room-chat-panel.tsx`/
`use-automatic-promotion.ts`, and specifically checked whether #23's
now-implemented automatic promotion conflicted with #22's original
design. It didn't: `resolveClaimDecision` (the shared eligibility rule
`checkPromotionEligibility`/`claimOpenSeat` both use) depends only on
queue rank, never on media state — `needsMediaActivation`/`mediaError`
only feed the *grace-period self-eviction* effect, which reacts to
outcomes after promotion. No stale-design conflict found; implemented
without changing `useAutomaticPromotion`'s eligibility logic at all. See
DECISIONS.md for the full reasoning and the alternatives considered.

`feature/candidate-media-readiness`: `useLiveRoomConnection` gained
`prepareLocalMedia()` (one `createLocalTracks({ audio: true, video: true
})` call, idempotent, called from the mic-request composer's own
`onSubmit` — a real gesture, same Safari constraint `activateMedia`
already documents), `releaseLocalMedia()` (stops held-but-unpublished
tracks, wired to both "Withdraw" and "Cancel" via a small wrapper in
`EventRoom`), and `localVideoTrack` (the held camera track). New
`SelfPreview` component attaches it into #20's reserved top-right slot;
`SpeakerStage` now renders that component only when a track exists
(hidden entirely otherwise, not an empty placeholder). `applyPublishState`
checks for already-held prepared tracks first and calls `publishTrack()`
on them directly at promotion time — no second `getUserMedia()`, no
second permission prompt — clearing the prepared-tracks ref on success
(so a later re-request re-acquires fresh tracks) while leaving the
`localVideoTrack` state itself untouched, so the same mounted component/
track survives pending → countdown → published-speaker unchanged. The
existing `canPublish → false` reaction (unchanged) now also clears
`localVideoTrack` when a speaker actually leaves, so the self-preview
correctly disappears again at that point.

Neither existing "Tap to enable camera & mic" (`SpeakerTile`) nor
"Enable camera & mic" (`RoomControls`) control was removed — both remain
the correct recovery path for #27's direct join (which never
pre-acquires) and for a `prepareLocalMedia()` failure; on the normal
request→promotion path they simply stop appearing in practice, since
`mediaActivated` is already true by promotion time. `RoomControls`'
pending-request branch (previously silent about `mediaError` entirely)
gained its own error message + "Try again" retry action, since a
still-waiting candidate can now fail *before* ever reaching the
`isSpeaker` branch that used to be the only place this showed.

**Testing**: new/changed coverage across 7 files — 7 tests for the
hook's prepare/release behavior via `params: null` (no Room/WebRTC
mocking needed, same reasoning `shouldPublish`/`classifyMediaError` were
already tested standalone for), 5 for `SelfPreview`'s attach/detach
lifecycle, 3 for `RoomControls`' new pending-state media error/retry, 2
for `ChatPanel`'s submit-triggers-prepare gesture, 2 rewritten
`SpeakerStage` tests for the slot's now-conditional rendering; the rest
are call-site updates for the new required props. lint/tsc/build/test
all pass (205/205).

**Next task**: merge to `main`, deploy, verify against production, then
stop for the user's own real-device confirmation — do not begin #21,
#24, #25, or any other issue until confirmed. #22's own remaining scope
(role-specific dominant video, mic activity indicator) stays open and
narrowed in the issue body, not closed.

**Real-device #22 test came back mostly positive, same session — one
duplication bug found, fixed; a second finding recorded for later**:
local media acquisition and self-preview both worked on iPhone, but a
promoted speaker's own camera rendered twice — their own large tile in
the two-seat grid *and* the corner self-preview, the same underlying
track attached to two separate `<video>` elements independently. The
user explicitly ruled out a broad landscape redesign for this pass and
asked for inspection first: confirmed `isLocal` (already passed into
every `SpeakerTile`) is exactly the right signal — true only for the
local viewer's own seat, on their own client, never for an audience
member — and confirmed suppressing the local tile's own video is purely
presentational (the publication every other client subscribes to is
untouched).

`SpeakerTile` gained `showBigVideo = hasVideo && !isLocal` — the big
video only ever renders for a remote participant's tile now; the local
speaker's own occupied seat shows a neutral "You're live — see your
preview in the corner" placeholder instead (not "Camera off" — untrue,
the camera is genuinely on). No changes to `SpeakerStage`'s layout, grid
proportions, or the empty-seat tile — satisfies the explicit "preserve
the empty-seat state as dominant, don't enlarge my own preview to fill
space" requirement for free, since neither tile's sizing changed at all.
No changes to `useLiveRoomConnection`, track ownership, or publishing.
5 new/changed tests in `speaker-tile.test.tsx`. lint/tsc/build/test all
pass (209/209). Merged to `main` (fast-forward, same as every prior
pass), pushed, deployment confirmed via the GitHub deployments API.

**Second finding, recorded not fixed, per explicit instruction**: the
same real-device pass found landscape mode collapses the room into a
dashboard-style layout (small horizontal video strip, permanent
side-panel chat, full header) rather than staying video-first — the
opposite of this project's philosophy. Written up as a constraint for
whichever pass does the actual redesign (ARCHITECTURE.md's new
"Landscape must stay video-first too" subsection; issue #18, already
scoped to cover role-based/landscape UI, amended via comment rather than
scope-creeped into this pass). Zero landscape code touched this pass.

**Next task**: stop for the user's own real-device confirmation of the
duplication fix specifically — do not begin #18's broader redesign,
#21, #24, #25, or any other issue until confirmed.

**Real-device confirmation came back mostly positive again, same
session — two more findings, both fixed**: the duplication fix worked
and the self-preview correctly stayed the one canonical local view. But
(1) tapping an uncontested open seat directly (#27) didn't get the same
readiness treatment as requesting the mic — no pre-acquired self-preview,
back to the ordinary gesture-gated fallback — and (2) with one seat
occupied and the other open, the open "Tap to join" tile could end up
partly or fully under the bottom chat overlay in portrait, making it
untappable even though the seat was genuinely available.

Investigated both before changing anything, per instruction. (1) traced
to `EventRoom.handleTapEmptySeat` simply never calling
`prepareLocalMedia()` — the underlying publish machinery (`applyPublishState`
preferring already-held prepared tracks, `syncCanPublish` reacting to the
server's `canPublish` push) was already generic across entry points, so
no new abstraction was needed, just wiring the same call in from this
second gesture. (2) traced to the overlay's height (guest editor + error
text + `RoomControls` + a fixed `h-40` chat panel) reaching into the
stage's bottom half on a typical phone viewport, combined with having no
`pointer-events` distinction at all — even its purely decorative top
gradient padding captured taps meant for the stage beneath it.

Fixed: `handleTapEmptySeat` now calls `connection.prepareLocalMedia()`
synchronously, directly in the tile's own click handler (same Safari
gesture reasoning `ChatPanel`'s `onSubmit` already established), before
the async `joinOpenSeat` call — tracks are deliberately left held on any
join failure, not released, since the state the user returns to
(queue fallback, or a retry) can still use them. `SpeakerStage` now
visually promotes the open seat to the front (`order-first`, pure CSS)
whenever it's the viewer's one actionable target — exactly one seat
empty, viewer not already speaking — leaving both-empty/both-occupied/
active-speaker's-own-view all in natural seat-number order; reordering
is keyed identically to before, so React treats it as a move, never a
remount, confirmed zero LiveKit/track impact. `PortraitRoom`'s overlay
is now split into a `pointer-events-none` outer layer and a
`pointer-events-auto` inner wrapper around the actual controls/chat —
identical classes, redistributed — so the decorative margin no longer
swallows taps. Landscape has no equivalent overlay-over-stage occlusion
to fix (chat is already a separate side column there).

Also cleared, unrelated to the code change: this session's `npm test`
run hit a stale `event_speakers_active_seat_uniq` conflict in
`scripts/dev-harness.test.ts` from leftover real-device-testing
occupancy in the permanent test room — cleared via the project's own
`npm run dev:harness -- clear-sandbox` (3 stale speaker seats, 5 stale
chat messages), not a code fix.

7 new/changed tests (`speaker-stage.test.tsx`'s open-seat-priority
describe block, `portrait-room.test.tsx`'s click-through-overlay describe
block). lint/tsc/build/test all pass (216/216). Merged to `main`,
pushed, deployment confirmed via the GitHub deployments API.

**Next task**: stop for the user's own real-device confirmation of both
fixes — do not begin #18, #21, #24, #25, or any other issue until
confirmed.

**Real-device confirmation came back fully positive, same session — the
responsive-room correction was requested next**: direct open-seat join,
media readiness, self-preview, publishing, and the reachable open seat
all confirmed working on iPhone. Before any further feature work, the
user asked for the responsive-room layout to be fixed — landscape's
dashboard-style drift (recorded as a constraint in ARCHITECTURE.md two
passes ago) needed to actually be built, with an explicit governing
rule: same product model, different composition by form factor. Mobile
portrait and mobile landscape must share the video-first philosophy;
desktop is allowed — expected — to differ, since it has real width to
spare. Explicit constraint: never infer desktop from `width > height`;
an iPhone in landscape is still mobile.

Investigated before changing anything, per instruction. Root cause:
`EventRoom` picked between `PortraitRoom`/`LandscapeRoom` purely on
`useOrientation()` — but `orientation: landscape` matches a desktop
browser window exactly the same as a phone rotated sideways, so both
got the identical sidebar-dashboard composition. No width-based signal
existed anywhere in the room's structural branching. Confirmed CSS
media queries are sufficient for *styling* decisions within a
composition, but only JS can decide *which component tree* mounts —
same reasoning `useOrientation` itself was already built on.

Implemented: new `useIsDesktopViewport()` (`min-width: 1024px`, the
same `matchMedia`/`useSyncExternalStore` shape as `useOrientation` —
deliberately width-based, never `width > height`, so an iPhone in
landscape stays classified as mobile regardless of aspect ratio).
`EventRoom` now branches three ways. `LandscapeRoom` renamed to
`DesktopRoom` — its sidebar structure was never wrong for desktop, only
wrong when reachable from mobile landscape too; internals otherwise
unchanged. New `MobileLandscapeRoom` reuses `PortraitRoom`'s
video-first/overlay philosophy (never a permanent sidebar) adapted for
a wide-short box: `SpeakerStage` gets `orientation="landscape"`
(side-by-side seats), a compact `RoomHeader` (new optional `compact`
prop — every piece of information, including connection-lost warnings,
stays, only the size shrinks), and a shorter `h-24` chat panel vs.
portrait's `h-40`. `StageOverlayShell` extracted from `PortraitRoom`'s
existing overlay markup (the prior pass's click-through-outer/
interactive-inner fix) once `MobileLandscapeRoom` needed the identical
structure. The site-wide `SiteHeader` (root layout, can't read route or
viewport state on its own — it's a server component) compacts on a
short mobile-landscape viewport specifically while inside a room via a
`document.body` class (`room-active`, toggled by `EventRoom` for its
mount lifetime) combined with a `(orientation: landscape) and
(max-height: 500px)` media query in globals.css — padding only, no
navigation removed, no client-component conversion needed. The room's
own `RoomHeader` deliberately stays in normal document flow (not also
`position: fixed`) to avoid a new collision risk with the site header —
noted as the next lever to pull if real-device testing finds this
insufficient, not built defensively now.

Self-preview stability, no-track-reacquisition, and the no-duplicate-
self-video fix are all inherited for free — `SpeakerStage`/`SpeakerTile`
are reused unchanged by all three room compositions, so role-specific
presentation rules didn't need any new code this pass.

17 new/changed tests across 6 files (`use-desktop-viewport.test.ts`,
new `mobile-landscape-room.test.tsx`/`desktop-room.test.tsx`/
`stage-overlay-shell.test.tsx`, `room-header.test.tsx`'s compact-mode
cases). lint/tsc/build/test all pass (237/237). Cleared stale test-room
seat occupancy again (unrelated to this change, same `dev:harness
clear-sandbox` command as the prior two times this session) before the
suite went green. Merged to `main`, pushed, deployment confirmed via the
GitHub deployments API, structural production check against the
deployed test room confirmed no regressions.

**Next task**: stop for the user's own real-device confirmation —
iPhone portrait, iPhone landscape, and a desktop browser specifically.
Do not begin #18, #21, #24, #25, or any other issue until confirmed.

**Full responsive-room confirmation came back positive, same session —
fourth checkpoint tagged, then #21's first slice implemented**: portrait,
landscape, and desktop all confirmed on real devices, including
everything built across the whole session (direct join readiness,
open-seat reachability, no-duplicate-self-video, the three-way
responsive split). Before starting the next pass, per explicit
instruction: re-read #18/#20/#21/#22/#23/#24/#25/#27's current bodies,
AGENTS.md, ARCHITECTURE.md, DECISIONS.md, and the commits since the
three-composition split — and tag a rollback checkpoint on the confirmed
state *before* editing anything. Process note: the checkpoint instruction
was re-read carefully only after implementation had already started
(files written, nothing yet committed) — since `main` was still
untouched, tagging `ff540b0` at that point remained exactly equivalent
to tagging it first; recorded transparently rather than treated as
already having been done correctly.

`prototype-responsive-mobile-landscape-stable` tagged on `ff540b0` (two
independent checks: matches `origin/main` and the latest successful
Vercel deployment), GitHub Release created marked prerelease.

**Problem for this pass**: mobile landscape's chat/composer overlay,
though it never resized the stage, was still visually dominant at rest,
and the room's own header plus the site-wide header together still cost
real document-flow height on an already-short viewport. Governing rule
set explicitly before implementation: video geometry is stable — the
comments-focus interaction changes only what's layered *over* the live
video, never the video's own size.

Investigated per instruction, 8 specific questions answered in full in
this turn's response (not duplicated here — see DECISIONS.md for the
complete write-up): confirmed `StageOverlayShell` was already 100%
overlay (zero stage-shrinking contribution) and the *only* document-flow
space above the stage came from `SiteHeader`/`RoomHeader`; confirmed #20
already built exactly the primitives #21 needed (`room-scrim`, inert
since #20, and a *separate* always-on legibility gradient — the two
never conflated); confirmed no existing #21 gesture infrastructure to
duplicate (this is the actual first implementation); confirmed the
transition could be built entirely via scrim opacity + one existing
wrapper `<div>`'s height, with zero LiveKit/track remounting.

Implemented: new `useCommentsFocus()` hook (dead-zone + commit-threshold
drag math via a pure, directly-unit-tested `computeDragProgress`
function; a `draggedRef` flag so tap and drag can't double-toggle each
other) drives `SpeakerStage`'s now-controllable `scrimOpacity`/
`scrimInstant` props (both optional, default `0`/`false` — zero change
for `PortraitRoom`/`DesktopRoom`) and one wrapper `<div>`'s height inside
`MobileLandscapeRoom`'s existing `StageOverlayShell` — collapsed state
is byte-identical to the pre-pass height (zero regression at rest),
expanded state reveals meaningfully more chat history for free
(`ChatPanel`'s own scroll region already adapts). The gesture handle is
a small, dedicated `<button>` (`touch-action: none`, `setPointerCapture`)
— never the message list, so scrolling chat and the collapse gesture
never compete, and normal taps elsewhere in the room never trigger it.
`RoomHeader` moves from a document-flow sibling to an absolutely-
positioned top overlay, `MobileLandscapeRoom`-only, reclaiming its
footprint for the stage — `PortraitRoom` completely untouched, matching
the explicit no-regression requirement. `RoomControls` left unchanged in
both states (real functional info, not decoration — not worth the size-
reduction risk).

**Desktop anti-squashing**: investigated and fixed with one isolated
CSS class — a fixed 320px sidebar left the two tiles pathologically
narrow right at the 1024px desktop threshold; `w-64 xl:w-80` on
`DesktopRoom`'s sidebar fixes the cramped zone, nothing else touched.

**Deliberately not built**: the second-level "full comments view" with
genuinely compressed video (an architectural seam is left via the same
hook, per instruction not to prematurely build it); wiring this
interaction into `PortraitRoom` (scoped to mobile landscape only this
pass); the divider's voting-focus direction (#25, still fully inert);
any #18/#24/#25/voting work.

22 new/changed tests across 5 files (`use-comments-focus.test.ts` — 11
for the pure drag-math function and the hook's tap/drag/no-double-toggle
behavior; `speaker-stage.test.tsx`'s scrim-opacity describe block;
`mobile-landscape-room.test.tsx`'s header-overlay and comments-focus
describe blocks; `desktop-room.test.tsx`'s sidebar-width test).
lint/tsc/build/test all pass (259/259). Merged to `main`, pushed,
deployment confirmed via the GitHub deployments API, structural
production check against the deployed test room confirmed no
regressions.

**Next task**: stop for the user's own real-device confirmation —
iPhone portrait (no regression), iPhone landscape (the new comments-
focus interaction and reduced chrome), and desktop (unchanged, plus the
anti-squashing fix at a few widths). Do not begin #18, #24, #25, voting,
or the second-level full-comments view until confirmed.

**Real-device testing found three more problems, same session, worked in
priority order**: (1) a seated speaker who hard-refreshed and tapped
"Enable camera & mic" published correctly but never saw their own
self-preview return, recoverable only by leaving and rejoining; (2) that
same finding exposed a real gap — the LiveKit webhook evicts a seat the
instant it sees `participant_left`, no application-level grace period at
all; (3) the comments-focus handle from the previous pass revealed
`GuestNameEditor`, not comments.

**Part 1 investigated and fixed**: traced the full refresh lifecycle —
identity/seat/token are all already correct (`page.tsx` calls
`getLiveKitToken` fresh every request, deriving `canPublish` from
current `event_speakers` occupancy), and there's no cleanup effect
wrongly destroying anything — a hard refresh legitimately resets all
client state by design. The actual bug: `activateMedia()` called
`applyPublishState(true)` directly, whose fallback branch
(`setCameraEnabled`/`setMicrophoneEnabled`) acquires and publishes in
one LiveKit call but never sets `localVideoTrack` — publishing worked,
self-preview didn't. `activateMedia()` now just delegates to
`prepareLocalMedia()` (issue #22's own acquisition path) — one
mechanism for every activation entry point instead of two. Found for
free in the same trace: a failed attempt used to permanently hide the
retry button (`mediaActivated` was set unconditionally, immediately);
now it only flips true on genuine success, so retry stays available.

**Part 2 investigated and implemented**: confirmed via
`api/livekit/webhook/route.ts` that eviction on `participant_left` is
immediate, no grace period — and confirmed via the LiveKit server SDK
(`RoomServiceClient`, already used for live permission pushes) that
`getParticipant(room, identity)` can independently verify presence.
New `checkAndEvictDisconnectedSpeaker` (room/actions.ts) re-validates
via that query before calling the same `endSpeakerSeat` the webhook
uses — a caller can never force an eviction of a still-connected
speaker, since only the server's own independent check decides. New
`useSpeakerReconnectGrace` hook (reusing `useAutomaticPromotion`'s own
grace-period shape, not a second timer system) watches every other
occupied seat for a DB-vs-LiveKit presence gap and calls that action
after 25s (tunable) if it persists; reconnecting first cancels the
pending call locally, before it ever reaches the server. Runs for every
connected viewer, not just the other speaker (unlike #25's own
heartbeat, scoped to avoid *continuous* polling) — this is a one-shot
deferred call per disconnect, not a recurring interval, and broader
scope is what guarantees a solo speaker's seat still eventually
releases. `SpeakerTile` shows "Speaker reconnecting…" during the watch,
threaded through `SpeakerStage` and all three room compositions. No new
SQL.

**Part 3 investigated and fixed**: confirmed the chat wrapper's height
math was already correct — the bug was ordering:
`GuestNameEditor`/`joinSeatMessage` and `RoomControls` sat between the
handle and the chat, so the handle's own immediate neighbor was the
guest-name control. Reordered so that metadata sits above the handle,
fixed-size, outside the expand/collapse relationship entirely; the
handle now sits directly against the chat wrapper. Part 4's
compact-💬-emblem fallback deliberately not built — that's the user's
own judgment call after testing this correction, per explicit
instruction, not something to build speculatively in parallel.

One real bug hit and fixed while writing tests: the hook's own
`setReconnecting` call unconditionally produced a new `Set` reference
even when contents were unchanged, which combined with an unstable
`getParticipant` reference in a test (a realistic-enough scenario to
guard against, not just a test artifact) caused a genuine infinite
render loop (`node --max-old-space-size` OOM crash during `vitest run`);
fixed with a content-comparing functional update in the hook itself, not
just patched around in the test.

23 new/changed tests across 6 files (`use-live-room-connection.test.ts`'s
`activateMedia` describe block, new `use-speaker-reconnect-grace.test.ts`,
`speaker-tile.test.tsx`'s reconnecting describe block, `speaker-stage.test.tsx`'s
reconnect-grace describe block, `mobile-landscape-room.test.tsx`'s
corrected-focus-target tests). `checkAndEvictDisconnectedSpeaker` itself
has no dedicated unit test, consistent with this file's other server
actions — verified structurally/in production instead. lint/tsc/build/test
all pass (277/277). Merged to `main`, pushed, deployment confirmed via
the GitHub deployments API, structural production check against the
deployed test room confirmed no regressions.

**Next task**: stop for the user's own real-device confirmation —
refresh-while-seated recovery, a real temporary disconnect (grace period
holding the seat, then releasing it if it doesn't return), and the
corrected comments-focus target. Do not begin #18, #24, #25, voting, the
second-level full-comments view, or the compact-💬 fallback until
confirmed.

**Real-device testing clarified the #21 interaction was described wrong
from the start, same session — the handle-driven design replaced, not
patched**: refresh recovery confirmed working; reconnect grace confirmed
mostly working (not yet multi-user stress-tested); but the comments
interaction still didn't feel right — the user identified the root
cause as architectural, not a tuning problem: requiring a user to find
and grab a small handle isn't "the room feels naturally vertically
navigable," the actual product intent all along. Explicitly authorized
concluding the existing implementation was the wrong abstraction rather
than defending sunk work.

Investigated 13 specific questions before writing any code (full
answers in DECISIONS.md, not duplicated here): confirmed the dead-zone/
commit-threshold math (`computeDragProgress`) was still correct and
reusable, but the hook's *surface-facing API* (bundling `onClick` into
handlers meant for one small element) was the wrong shape for a broad,
room-level gesture — concluded **replace, not patch**. Worked through
why a separate transparent overlay-on-top (an earlier idea) is a
dealbreaker, not a tuning question: hit-testing picks whichever element
is visually topmost, so an overlay layered above real buttons would
swallow every touch and never let it reach them — only a genuine DOM
ancestor, relying on event bubbling, lets `event.target` still reflect
the actual button the user touched, which is what makes excluding it
possible at all. Also caught, mid-investigation, a real CSS footgun: the
"obvious" fix for iOS Safari's native scroll competing with the drag
(`touch-action: none` on the shared stage-wrapper ancestor) would have
also disabled the *message list's* own scrolling, since `touch-action`
for a given element is the *intersection* of its own value and every
ancestor's — worked around with `event.preventDefault()` inside
`onPointerMove`, but only once a drag has already started tracking (i.e.
already passed the interactive-element/message-list exclusion check),
explicitly flagged as the one real-device-unverified piece of this
design rather than presented as equally solid.

**Rewrote `useCommentsFocus`**: now returns `openComments`/
`closeComments` (plain setters for the explicit toggle) and
`surfaceProps` (four pointer handlers meant for one broad ancestor,
replacing the old single-element `handleProps`) — `onPointerDown` checks
`event.target.closest('button, a, input, textarea, select,
[role="button"], [contenteditable], [data-gesture-ignore]')` before
tracking anything, so real controls (empty-seat tap-to-join, camera/mic
activation, the composer, `GuestNameEditor`'s own button, the new
toggle) are never touched. `ChatPanel`'s message list gained
`data-gesture-ignore` + `touch-pan-y`. Drag direction flipped to match
the corrected description (`deltaY = currentY − startY`, positive =
moved *down* = reveal — not the previous pass's Maps/Music "drag up"
convention). `MobileLandscapeRoom` spreads `surfaceProps` on its own
stage wrapper (the video/header/chat-overlay's shared ancestor) and
renders one `comments-toggle` button in the same spot the old handle
occupied — same `open`/`progress`/`dragging` state driving the
(unchanged) scrim-opacity/chat-height mechanics either way. Removed the
old tap-vs-drag double-toggle-suppression logic (`draggedRef`) entirely
— unnecessary now that the drag and the explicit tap live on different
elements rather than competing for the same one.

Also confirmed (per instruction, before touching anything): refresh
recovery and the reconnect grace period were both left completely
untouched — nothing about either needed to change for this rebuild.

15 changed/rewritten tests across 2 files (`use-comments-focus.test.ts`
fully rewritten for the new API and exclusion behavior;
`mobile-landscape-room.test.tsx`'s comments-focus describe blocks split
into an explicit-toggle group and a new room-level-drag group, exercised
via real `fireEvent.pointerDown/Move/Up` sequences against real DOM
nodes — required stubbing `Element.prototype.setPointerCapture`, which
jsdom doesn't implement at all, the same way `scrollTo` was already
stubbed in this file). lint/tsc/build/test all pass (283/283). Merged
to `main`, pushed, deployment confirmed via the GitHub deployments API,
structural production check against the deployed test room confirmed no
regressions.

**Next task**: stop for the user's own real-device confirmation —
specifically whether the broad-surface drag actually feels natural now,
whether it reliably avoids stealing taps from real controls, whether the
message list scrolls without fighting the room gesture, and whether the
`preventDefault()`-based scroll suppression holds up against iOS
Safari's own native behavior. Do not begin #18, #24, #25, voting, the
second-level full-comments view, wiring this into `PortraitRoom`, or any
further gesture refinement (velocity/flick, drag-to-close) until
confirmed.

**Real-device confirmation came back negative** — the room-level drag
above failed too: "dragging downward produced no meaningful transition,"
and, independently of the gesture itself, comments/composer still
permanently occupied too much of the stage in both orientations (in
portrait's case because it had never received any of this issue's work
at all). Explicit instruction: treat this as a failed UX experiment, not
a tuning problem, and change strategy — build two reliable, tap-driven
states now, revisit the progressive drag only after Figma defines what
those states should look like.

**Investigation before writing any code** (six questions, full answers
in DECISIONS.md): confirmed every part of `useCommentsFocus` was
gesture-only (dead-zone/commit-threshold math, `computeDragProgress`,
`INTERACTIVE_SELECTOR`, the four pointer handlers) — nothing in it
represented open/closed state on its own. Confirmed removing it was safe:
it only ever touched `SpeakerStage`'s presentational `scrimOpacity`/
`scrimInstant` props and the chat wrapper's own height, never LiveKit/
media/seat/reconnect/reaction state. Found the actual root cause of the
"still cluttered" complaint independent of the gesture: `MobileLandscapeRoom`
animated the chat wrapper's height but never actually removed it from the
DOM (96px "collapsed" still showed the composer and a message sliver),
and `PortraitRoom` had a fixed, always-visible `h-40` panel with zero
Watch/Comments-state concept at all. Confirmed one shared hook could
drive both orientations' *logical* state without forcing identical
layouts (each keeps its own height constant and control placement).

**Stable checkpoint created first**: verified `main`/`origin/main`/latest
successful Vercel deployment all matched at `2e5966a` (the failed
room-level-gesture commit), then tagged `prototype-media-refresh-reconnect-stable`
(annotated, pushed, GitHub prerelease) documenting what's preserved
(refresh recovery, reconnect grace, responsive branching, seat/media
flows) versus what's being retired (the gesture UX) — confirmed via
`git ls-remote --tags` that the earlier `prototype-responsive-mobile-landscape-stable`
(`ff540b0`) checkpoint was untouched.

**Implemented**: `git rm src/hooks/use-comments-focus.ts
use-comments-focus.test.ts`, replaced with `use-comments-mode.ts` — a
plain `useState(false)` boolean with `openComments`/`closeComments`,
nothing else (its own doc comment frames this as the deliberate,
temporary foundation the eventual drag composes back onto later).
`MobileLandscapeRoom`: dropped `surfaceProps`/`progress`/`dragging`
entirely, chat wrapper switched from always-mounted-but-height-animated
to `{commentsOpen && <RoomChatPanel .../>}`, scrim opacity now a
two-value constant instead of a continuous interpolation.
`PortraitRoom`: got the same Watch/Comments split built from scratch
(comments-toggle button, conditional chat mount at a taller 320px vs.
landscape's 208px, scrim wiring) — it had never had any #21 code before
this. `chat-panel.tsx`: removed `data-gesture-ignore`/`touch-pan-y` and
their doc comment — no gesture surface left to exempt the message list
from. `DesktopRoom`: confirmed untouched, never used the gesture hook.
`SpeakerStage`: no code changes — `scrimOpacity`/`scrimInstant` were
already generic presentational props.

**Documented the Future Figma seam** (DECISIONS.md, new top entry): the
eventual Watch Mode → progressive drag → Comments Mode vision is
unchanged, just deferred until both states have a real Figma-defined
visual target — building gesture physics against a target that itself
needed to change is the throughline behind both real-device failures.
ARCHITECTURE.md, ROADMAP.md, and CHANGELOG.md updated to match (old
gesture entries kept, not deleted, for history — new entries added
describing the retirement and current state).

**Tests rewritten**: `use-comments-mode.test.ts` (new, 4 tests: starts
closed, open/close, and an explicit assertion that no
`progress`/`dragging`/`surfaceProps` exist — a guard against gesture
creep back into this hook). `mobile-landscape-room.test.tsx`: removed
the room-level-drag describe block and its `fireEvent.pointerDown/Move/Up`
tests plus the now-unneeded `setPointerCapture`/`releasePointerCapture`
stubs; rewrote the toggle tests to assert the chat panel/composer is
completely absent from the DOM in Watch Mode (not just short), present
with message history and the reaction/emoji affordance in Comments Mode,
and that `SpeakerStage`'s own DOM node/class list are unchanged by the
toggle. `portrait-room.test.tsx`: new Watch/Comments Mode describe block
mirroring the same coverage, since portrait never had any before;
existing composer-dependent tests updated to open Comments Mode first.
`speaker-stage.test.tsx`: two stale doc-string references to the retired
hook corrected (no behavior change — the props were already generic).

**Verification**: lint clean, `tsc --noEmit` clean, full test suite
277/277 passing (33 files, no stale `event_speakers_active_seat_uniq`
conflict this run), production build succeeded.

**Next task**: stop for the user's own real-device confirmation of the
new tap-based Watch Mode / Comments Mode states, on both iPhone portrait
and iPhone landscape, plus a check that desktop's dedicated layout is
unaffected. Do not begin #18, #24, #25, voting, or another downward-drag
gesture attempt until confirmed — that gesture returns only once Figma
has defined both endpoints' visual design.

**Watch Mode / Comments Mode confirmed on real devices** — the user
verified the tap-based states on iPhone portrait and landscape and
directed that this now be treated as the stable interaction foundation
for the upcoming Figma-assisted redesign, not something to be altered as
a side effect of unrelated work. ROADMAP.md's #21 entry checked off on
this basis (the progressive drag itself remains deliberately unbuilt).

**Small follow-up fix, same session**: `GuestNameEditor` (unrelated to
the mode toggle — it renders inside the overlay both modes share, but
its own bug predates this issue's work) could be left visually stuck in
editing mode after tapping "change name," editing the text, and then
tapping elsewhere or dismissing the keyboard — it only ever exited on
its own form's `onSubmit`, with no `onBlur` handling at all. Fixed by
committing on blur instead of adding a document-level click-outside
listener: every "tap outside" interaction (Comments, a speaker tile, the
stage) already fires a native blur on the input first, so that's the one
event already common to all of them, per explicit instruction to prefer
the simplest conventional fix over a new gesture mechanism. Routed
Enter/Done through the identical path (`onSubmit` now just calls
`inputRef.current?.blur()` rather than saving independently) so there's
one commit code path, not two racing ones. `<Input>`
(`src/components/ui/input.tsx`) gained `forwardRef` support — purely
additive, no existing caller passes a ref — so `GuestNameEditor` can
blur its own input imperatively. Existing empty-name validation/fallback
left untouched (still just declines to exit editing mode on error, same
as before). Did not touch LiveKit, comments-mode state, Watch Mode
layout, speaker geometry, responsive branching, or reconnect behavior —
confirmed via lint/tsc/build passing and the full test suite (283/283,
33→34 files) with no other file changed besides `guest-name-editor.tsx`,
its new test file, and `input.tsx`'s ref forwarding. Merged to `main`,
pushed, deployment confirmed via the GitHub deployments API.

**Next task**: stop for the user's own real-device confirmation of this
specific fix (tap "change name," edit, tap away/dismiss keyboard,
confirm it commits and returns to the normal display). Still not
beginning #18, #24, #25, voting, or the Figma-assisted redesign.

---

## 2026-08-18 — Session 21: Second checkpoint (two-device AV verified), then participation-friction design work

**Goal**: The user personally verified real two-device LiveKit audio/
video, closing the one gap the first checkpoint left open. Asked for a
second checkpoint using the same process, then to shift focus from
infrastructure verification to reducing participation friction — a
first-time tester found "getting on stage" confusing, and the user's
own testing surfaced several unnecessary clicks/steps.

**Checkpoint 2**: `prototype-live-av-stable` tagged on commit
`397d3ffa496ace5dd7eeb2fa21b1617049e4715e` (tip of `main`, the previous
checkpoint's own docs commit — no code changed since). Confirmed via
the same two independent checks as the first checkpoint (`vercel
inspect` + GitHub's deployments API for the SHA, matching Vercel
deployment IDs exactly), pushed, and a GitHub Release created from it
marked prerelease. Issues #15/#16/#17 stay open — this doesn't close
them. See DECISIONS.md.

**Participation-friction design work**: investigated the existing
queue/request/chat/room architecture before proposing anything, per the
user's explicit request not to implement until approved. Covered in
full in this turn's response to the user, not duplicated here — see the
conversation itself and the follow-up session entry once implementation
actually starts for the settled design.

---

## 2026-08-18 — Session 20: Real-device #17 retest — stale test data, and the request-mic control buried below the fold

**Goal**: The user's real-device retest of #17 hit two blockers and
explicitly refused a direct-link substitute: the test event wasn't
discoverable via the actual "Landing page → Browse events" journey, and
the request-mic control wasn't reachable from the unified room.

**Finding 1 (not a code bug)**: reproduced the events-list query
directly against the anon key — it correctly excludes events whose
`scheduled_start` is more than 2 hours old, by design. The handed-off
test events had been created under a stale date assumption; real
wall-clock time had moved roughly two days forward since. The direct
room link (no time filter) kept working the whole session and masked
this — exactly the risk the user's "don't substitute a direct link"
instruction was guarding against. No code changed; created fresh test
data and reconfirmed it in the deployed "Browse events" page.

**Finding 2**: traced the full render-condition chain — phase, the
guest-participation flag, identity type, pending-request state,
active-speaker state — all correctly resolved to `RoomControls`
rendering "Request the mic," confirmed present in the actual deployed
HTML. The gap was position, not logic: `RoomControls` sat after the
chat panel (variable height) with the temporary diagnostics panel
stacked below that, so reaching it on a real phone meant scrolling past
however much content came first — the same shape of bug the earlier
tile-placement fix (#15) already found once. Fixed by moving
`RoomControls` above `RoomChatPanel` in `PortraitRoom` (position no
longer depends on chat height) and collapsing `RoomDiagnostics` to a
single-line toggle by default (it was itself a real, measurable
contributor to the problem, on top of already being flagged as "not a
product feature").

**Files changed**: `components/room/portrait-room.tsx` (control order),
`components/room/room-diagnostics.tsx` (+test, collapsed by default),
`components/site-header.tsx` (defensive `shrink-0`), DECISIONS.md,
SESSION_LOG.md (this entry).

**Tests run**: lint clean, tsc clean, 150/150 tests passing, build
succeeds.

**Known issues**: None new. #15/#16/#17 all stay open/Testing-Review —
not marking anything Done until the user confirms the complete deployed
journey (landing → browse → tap → unified room → chat/reactions/request
mic → guest becomes speaker → media publishes → a second device sees
it) themselves.

**Current build status**: Deployed to `main` → Vercel; verified
server-side that the fresh test event is discoverable via the deployed
"Browse events" page before handing off the landing-page URL.

**Recommended next task**: wait for the user's real-device confirmation
of the full journey via the landing page, not a deep link. Not starting
#18.

**Addendum, same day**: the user's real-device confirmation arrived —
the full landing-page → Browse Events → tap → unified room → chat/
reactions/request-mic → guest-claims-seat → camera/mic-activates journey
all worked on their iPhone, and they called this "the first state of
the project I consider a stable, usable mobile prototype." Before any
further feature work, they asked for this exact state preserved as a
recovery point. Tagged `prototype-mobile-single-device-stable` on commit
`1e72311e20efb195e5d63d6e7e8f6b6d7ca06d65` — confirmed via two
independent checks (not assumed) that this is exactly what's live in
production: `vercel inspect` on the current production deployment
(`dpl_3ncVAw1JEPQHRamaaxMXVNw1gdZA`) and GitHub's own deployments API
for that SHA, which recorded the identical Vercel deployment ID. Pushed
the tag and created a GitHub Release from it, explicitly marked
prerelease (a checkpoint, not a production version). No code changed.
Full verified/not-yet-verified list recorded in DECISIONS.md and the
release notes — the key unverified piece remaining is a genuine
two-device live-media test (another participant actually receiving
audio/video). Issues #15/#16/#17 stay open; this checkpoint doesn't
close them, per the user's explicit instruction.

---

## 2026-08-16 — Session 19: Unified event/lobby/room lifecycle (issue #17)

**Goal**: With #15/#16 mid-validation, the user asked to pause that loop
and address #17 directly — real-device testing had made the three-route
event→lobby→room split an active usability failure (roughly three taps
before anything interactive), not something to defer as polish.

**Design, walked through before implementing (per the user's explicit
ask and this project's own standing rule)**: inspected the actual route/
component structure first — `/events/[id]` (countdown + "Enter Lobby"),
`/events/[id]/lobby` (a separate `LobbyRoom` component: chat + presence
+ countdown sidebar, no speaker stage, no request-mic control), and
`/events/[id]/room` (the full room layout, phase-gated to `"ready"`
only). Found that the room's *existing* layout already satisfied nearly
every requirement the user listed (seat placeholders, chat, request-mic
control, status) — the actual bug was that layout being gated behind an
extra click and unreachable before `"ready"`, not that anything was
missing from it. Proposed and implemented the smallest consolidation:
one URL, one persistent component (`LiveRoom` renamed `EventRoom`)
owning phase as a fourth unconditional piece of state alongside the
three hooks already there, sitting above the orientation branch —
exactly the pattern already proven for rotation. `useLiveRoomConnection`
already handled a `null → real params` transition by design, so gating
`canConnect` by `phase === "ready"` (instead of always-true-if-configured)
was enough to make the room "go live in place" with no remount.

**A real, deliberate gap this design surfaced, not silently absorbed**:
making `RoomControls` reachable before `"ready"` (so requesting the mic
works pre-show, per the user's explicit ask) also made *claiming* a seat
reachable from the same screen before the scheduled start — which would
let the live conversation begin early. Named this explicitly before
implementing, then added a server-enforced phase check to `claimOpenSeat`
itself (not just a hidden button) — requesting/withdrawing stay available
from `lobby_open` onward, unchanged.

**Implemented**: `EventRoom` (`components/room/event-room.tsx`, replacing
`live-room.tsx`) computes `phase` via the same `useNow()`-driven pattern
`EventCountdown` already used, using a server-computed `initialPhase` for
correct first paint (so an already-live shared link lands live
immediately, not on a placeholder). Renders a lightweight countdown-only
view before `lobby_open`, then the full `PortraitRoom`/`LandscapeRoom`
layout from `lobby_open` onward — unchanged in structure, just reachable
earlier. `RoomHeader` gained an optional countdown string appended to the
room status. `/events/[id]/page.tsx` now fetches everything (speakers,
messages/reactions, a LiveKit token, pending-request status)
unconditionally regardless of phase, replacing three separate phase-gated
fetches. `/events/[id]/lobby` and `/events/[id]/room` became
backward-compatible `redirect()` stubs. `LobbyRoom` and `EventEntryStatus`
were deleted as dead code once nothing rendered them;`GuestNameEditor`
moved into the unified layout (shown for guests in both the pre-lobby
view and the main room).

**Files changed**: `app/events/[id]/page.tsx` (rewritten),
`app/events/[id]/lobby/page.tsx`/`room/page.tsx` (reduced to redirects),
`app/events/[id]/room/actions.ts` (claimOpenSeat's phase gate),
`components/room/event-room.tsx` (new, replaces `live-room.tsx`),
`components/room/{portrait,landscape}-room.tsx`, `room-header.tsx`,
`room-controls.tsx`, `types.ts` (phase/countdownText threading + guest
name editor placement), deleted `components/lobby/lobby-room.tsx` and
`components/events/event-entry-status.tsx`, plus tests for all of the
above, PRODUCT.md/ARCHITECTURE.md/DECISIONS.md/ROADMAP.md/CHANGELOG.md/
SESSION_LOG.md (this entry).

**Tests run**: `npm run lint` clean, `npx tsc --noEmit` clean, `npm test`
— 149/149 passing (up from 145 at the end of Session 18, reflecting new
coverage for the countdown rendering and the claim-seat phase gate),
`npm run build` succeeds.

**Known issues**: None new. `claimOpenSeat`'s phase-gate enforcement
itself isn't covered by a dedicated unit test — Server Actions in this
project aren't unit-tested directly (the `next/headers` `cookies()`
dependency), consistent with existing precedent; covered instead by the
`RoomControls` UI-level tests for the *display* logic, with the actual
server enforcement to be confirmed by the user's real-device test.

**Current build status**: Deployed to `main` → Vercel per the normal
workflow; not yet confirmed on a real device as of this entry. #15/#16
remain open in Testing/Review per the user's explicit instruction to
keep them there while #17 stabilizes.

**Recommended next task**: the user's real-device confirmation that one
tap from the event list reaches the room, chat/request-mic are
immediately available, and the waiting state becomes live in place with
no extra navigation steps. Resume the #15/#16 validation loop after
that, still not starting #18 until #15/#16 close.

---

## 2026-08-16 — Session 18: Two more real-device #15 failures diagnosed and fixed, then guest speaker participation (issue #16)

**Goal**: Continue from Session 17's camera/mic gesture fix through
however many real-device retest cycles it took to actually reach working
media, per the user's explicit instruction not to mark #15 done on
anything short of their own iPhone confirmation. Three distinct
real-device failures surfaced in sequence, each requiring a fresh trace
rather than another guess — plus a full re-evaluation of the #15/#16
dependency relationship once the third failure revealed guest speaking
was now a prerequisite, not just next in line.

**Retest 1 — LiveKit itself unreachable in production.** After Session
17's gesture fix deployed, camera/mic still didn't work. Traced by
downloading and grepping every JS chunk the deployed room page
references for a literal LiveKit `wss://` hostname (found none —
`NEXT_PUBLIC_LIVEKIT_URL` wasn't actually inlined), then adding a
temporary, safe diagnostics panel (`components/room/room-diagnostics.tsx`
— booleans/enums only, never secrets) and reading its server-rendered
values directly off the live page: `LiveKit client URL configured:
false`, `Server issued a token: false`, `connection status: unavailable`.
Root cause: the LiveKit credentials on Vercel looked configured (present
as keys, per `vercel env ls`) but weren't actually valid/non-empty —
Vercel's "Sensitive" var type can't be read back to verify, the same
limitation Session 16 already found once for a different variable. Not
fixable from an agent session — the user re-entered fresh
`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/`NEXT_PUBLIC_LIVEKIT_URL` values
on Vercel. Added a second temporary diagnostic
(`/api/livekit/diagnostics`, a real `RoomServiceClient.listRooms()`
call) specifically because token minting alone can't prove credentials
are *valid*, only *present* — JWT signing never contacts LiveKit's
servers. Confirmed the fresh credentials server-side
(`{"credentialsConfigured":true,"reachable":true}`) before asking for
another phone round trip.

**Retest 2 — the fix worked, but the control was invisible.** With
LiveKit genuinely connected, diagnostics showed `needsMediaActivation:
true` and a successful direct `getUserMedia` test, yet the user still
only saw "camera off" — the account-only speaker's own "Enable camera &
mic" button (Session 17's fix) rendered correctly, but only inside
`RoomControls`, a strip at the bottom of the room, while the user was
looking at their own tile. Confirmed via the render tree, not guessed:
`RoomDiagnostics` and `RoomControls` read the identical
`needsMediaActivation`/`isSpeaker` values from one shared source, ruling
out a logic bug. Fixed by putting the activation control directly on the
local participant's own `SpeakerTile` placeholder — same `activateMedia()`
call, same real-gesture discipline, just where the user's attention
actually was. `RoomControls`' button stayed as a redundant secondary
path.

**Retest 3 — the user's own session was a guest, and guests couldn't
become speakers at all.** With account-based speaking now fully proven,
the third real-device diagnostics showed `Identity type: guest`,
`Recognized as seated speaker: false`, `canPublish: false` — not a #15
regression, but #16's gap (guest speaking didn't exist yet) surfacing
through #15's own acceptance criteria, since the user's stated testing
philosophy is guest-first (no login required during this prototype
phase). Rather than ask the user to work around this by logging back in,
did the full re-evaluation the user asked for: walked the complete
journey end to end, named which issue owns each remaining gap, confirmed
#16 is now a genuine prerequisite for #15's *own* final validation (not
just next in sequence for its own sake), confirmed #17/#18's relative
order didn't need to change (no new dependency between #16 and #17;
#18 already depended on both), and wrote the exact end-to-end acceptance
test (guest opens link → requests mic → claims seat → activates camera/mic
→ another device receives live video+audio → rotation survives) that
now gates #15 closing. Recorded all of this on the GitHub issues before
writing any code.

**Issue #16 implemented this session**: guest speaker participation, an
explicit, reversible prototype-testing exception
(`PROTOTYPE_CONFIG.guestParticipationEnabled`, already existed unused,
apparently set up in advance for exactly this). Migration
`00000000000012` — `event_speakers`/`speaker_requests` gained a nullable
`guest_id` column each, XOR-constrained against `profile_id` (the same
pattern `event_chat_messages` already used for guest chat authorship,
applied to the speaking tables for the first time); `claim_speaker_seat`/
`end_speaker_seat` widened in place (still `service_role`-only, still no
`anon`/`authenticated` grant); `request_to_speak`/`withdraw_speaker_request`
left untouched for accounts, with separately-named `service_role`-only
guest siblings added instead of one unified signature, because the
authorization *mechanism* genuinely differs (no `auth.uid()` equivalent
for a guest) — reasoned through and documented in DECISIONS.md as the
resolution to the signature question the user explicitly deferred to
this session. Repository layer (`event-speakers.ts`, `speaker-requests.ts`),
`lib/speaker-queue.ts`'s `decideClaimEligibility`, `lib/livekit/permissions.ts`'s
`syncPublishPermission`, the LiveKit webhook route, and the UI's identity
computations (`LiveRoom`, `SpeakerStage`, `RoomControls`) all generalized
from profile-only to either identity shape.

**A real, live security regression this caught, not just risked**: right
after applying the migration, the existing "not callable by an ordinary
authenticated user" integration tests failed for real against the linked
project. Recreating `claim_speaker_seat`/`end_speaker_seat` (required —
Postgres won't `CREATE OR REPLACE` a changed parameter list) silently
reset them to PUBLIC-execute-by-default, the exact mistake issue #13
already hit once (migration 6 → fixed by 8). Fixed within minutes via a
forward migration (`00000000000013`), verified directly against
`pg_proc.proacl`, not just the test passing. See DECISIONS.md — recorded
at length since this is the second time this exact class of bug has
bitten this project, worth a standing checklist reflex, not just a fix.

**Files changed**: `supabase/migrations/00000000000012_*.sql`,
`00000000000013_*.sql`, `src/types/database.ts` (regenerated),
`lib/repositories/event-speakers.ts`, `lib/repositories/speaker-requests.ts`,
`lib/speaker-queue.ts`, `lib/livekit/permissions.ts`,
`app/api/livekit/webhook/route.ts`, `app/events/[id]/room/actions.ts`,
`app/events/[id]/room/page.tsx`, `components/room/live-room.tsx`,
`components/room/speaker-stage.tsx`, `components/room/room-controls.tsx`,
`lib/repositories/dev-demo.ts`, plus this session's earlier files
(`room-diagnostics.tsx`, `api/livekit/diagnostics/route.ts`,
`speaker-tile.tsx`, `speaker-stage.tsx`, `room-header.tsx`) and their
tests, PRODUCT.md, ARCHITECTURE.md, DECISIONS.md, ROADMAP.md,
CHANGELOG.md, SESSION_LOG.md (this entry).

**Tests run**: `npm run lint` clean, `npx tsc --noEmit` clean, `npm test`
— 145/145 passing (up from 120 at the start of this session's retest 1,
reflecting new coverage for the LiveKit connectivity diagnostic, tile
activation, and issue #16's full guest path including the
PUBLIC-execute regression itself), `npm run build` succeeds.

**Known issues**: None new from this session's own code. The temporary
diagnostics (`RoomDiagnostics`, `/api/livekit/diagnostics`) are still
deployed on purpose — removal is planned for right after the full
end-to-end acceptance test passes, not before.

**Current build status**: Migrations 12/13 applied to the live linked
project and verified (`supabase migration list --linked`, plus a direct
`pg_proc.proacl` check for the regression fix). Code deployed to `main`
→ Vercel per the normal workflow; not yet confirmed on a real device as
of this entry.

**Recommended next task**: the user's own end-to-end real-device test
(guest, no login, request mic → claim seat → camera/mic → another device
receives live video+audio → rotation survives) — this is what actually
closes #15, not automated checks. Not starting #17 until that happens,
per explicit instruction.

---

## 2026-08-13 — Session 17: Real iPhone testing findings + camera/mic activation fix (issue #15)

**Goal**: Respond to the user's real hands-on iPhone testing of the
deployed app (Session 16's first real-device test), which surfaced four
categories of problems: account-required guest testing friction, a
fragmented event→lobby→room flow, camera/mic never activating, and an
undifferentiated audience/speaker UI. Per this project's standing rule
("walk the design through out loud before implementing"), this session's
first half was pure investigation and design — no code — followed by
approval, GitHub issue creation, and implementation of the first
approved issue only.

**Investigation** (before any code): read every file in the actual
guest-identity/event-lifecycle/LiveKit-connection/room-UI path — not
from memory — to trace exactly why camera/mic silently failed, exactly
what "account-only speaking" enforces today and where, and exactly what
route/hook structure the lobby→room split has. Found:
- The camera/mic root cause: `useLiveRoomConnection` triggered
  `getUserMedia` from an async LiveKit event callback, never a user
  gesture — invisible on desktop Chrome (no such restriction), fatal on
  iOS Safari.
- `mediaError` was already computed in that hook and never read anywhere
  — a second, independent silent-failure bug.
- Guest speaking is blocked at the schema level
  (`event_speakers.profile_id not null references profiles`), not just
  in application code — confirmed this was a deliberate, documented
  design choice (migration 00000000000005's comment, PRODUCT.md
  Principle 3's "requesting the mic is the clearest account-only action
  in the product"), not an oversight — meaning enabling it is a stated
  product-principle change, not a silent bug patch.
- `lib/config.ts` already had an unused `PROTOTYPE_CONFIG.guestParticipationEnabled`
  toggle, seemingly set up in advance for exactly this kind of decision.
- `RoomChatPanel`'s `featuredSlot` seam (for future pinned/featured
  comments) already exists and is already unused — nothing new needed to
  preserve it, just don't touch it.

**Design proposal presented and approved**, with one explicit reordering
by the user: the four-issue split (camera/mic fix, guest speaking,
unified lifecycle, role-based UI) must be built **sequentially**, each
tested on the real deployed app on a phone before the next begins — not
the parallel A/C split originally proposed. Locked product decisions from
the user: guest speaking is an explicit, reversible testing-phase
exception (not a permanent principle change) governed by the existing
`PROTOTYPE_CONFIG` flag; mic requests should work during the pre-show
waiting phase too, not just once live; guest identity loss on
cookie-clear/device-switch is an accepted prototype limitation, no
seat-recovery infrastructure yet; the Postgres function-signature
question (overload vs. replace) is deferred to whichever preserves
existing security guarantees with the smallest API, decided when that
issue is actually implemented.

**GitHub issues #15–#18 created** with their dependency chain documented
in each body, added to the Project board in Ready, in dependency order.
`gh` was confirmed available and authenticated this session (the
project's standing instruction to check before assuming otherwise, not
ask the user to create issues manually).

**Issue #15 implemented this session** (the only one approved to start):
- `hooks/use-live-room-connection.ts`: `useLiveRoomConnection` no longer
  auto-publishes on `RoomEvent.Connected`/`ParticipantPermissionsChanged`.
  It now exposes `canPublish` (the server's grant, tracked live as
  before), `needsMediaActivation` (true once granted but not yet
  activated in this tab), and `activateMedia()` — which must be called
  directly from a real click handler. Once the first gesture-triggered
  call resolves, later `canPublish` changes resync automatically without
  another tap (permission persists for the tab's session once granted;
  disabling never needed a gesture and still happens automatically).
  `classifyMediaError` (newly exported, unit-tested) maps
  `getUserMedia`'s own `DOMException.name` into
  `permission-denied`/`no-device`/`device-unavailable`/`init-failed`,
  per camera/microphone independently.
- `RoomLayoutProps`/`LiveRoom`/`PortraitRoom`/`LandscapeRoom`/`RoomControls`:
  threaded `mediaError`/`canPublish`/`needsMediaActivation`/`activateMedia`
  through the same way `connectionStatus` already flows, down to
  `RoomControls`, which now shows an explicit "Enable camera & mic"
  button and specific, source-aware error/status copy for a seated
  speaker instead of a silent generic placeholder.
- Deliberately did not touch `SpeakerTile`'s layout or build any
  speaker-specific UI redesign — that's issue #18, kept out of scope here
  to stay narrowly focused on the activation bug itself.

**Files changed**: `hooks/use-live-room-connection.ts` (+test),
`components/room/types.ts`, `components/room/live-room.tsx`,
`components/room/portrait-room.tsx`, `components/room/landscape-room.tsx`,
`components/room/room-controls.tsx` (+test), `ARCHITECTURE.md`,
`DECISIONS.md`, `CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Tests run**: `npm run lint` clean, `npx tsc --noEmit` clean, `npm test`
— 115/115 passing (up from 105 at Session 15, reflecting the new
`classifyMediaError` and `RoomControls` media-state tests), `npm run
build` succeeds.

**Known issues**: None new. Issue #15's fix is scoped to activation +
error surfacing within the existing room layout — the speaker-specific
layout redesign (large other-speaker view, small self-preview, etc.) is
explicitly issue #18's job, not built here.

**Current build status**: Merged to `main` (`ac8346a`, fast-forward from
`fix/livekit-media-activation`, `closes #15`) and pushed — GitHub
auto-closed issue #15 on the push, confirmed via `gh issue view`. Vercel
auto-deployed it (`dpl_Ax5e8B4C64kadP1VPaHM2JpMErTK`, created ~7 minutes
after the push, aliased to the canonical
`project-stage-weld.vercel.app`) — confirmed via `vercel inspect`, not
just assumed from the push succeeding. Board card for #15 initially sat
in **Testing / Review** after the merge — the exact stale-board gap
DECISIONS.md already flagged once before — caught and corrected to
**Done** in the following session before doing anything else.

**Recommended next task**: hand the user the public test link + a short
iPhone camera/mic checklist (below), then wait for their real-device
confirmation before starting issue #16 (guest speaker participation) —
not before, per their explicit instruction.

---

## 2026-08-13 — Session 16: First deployment (Vercel) + live LiveKit wiring

**Goal**: Get the app onto a public HTTPS URL for phone/multi-tester
usability testing, then finish wiring LiveKit so the live video room
actually works there too — stopping short of any new product milestone.

**Completed work — deployment**:

- Inspected existing state first, per the user's explicit ask, before
  changing anything: no `.vercel` link, no prior deploy, GitHub repo
  private, Supabase's `[auth]` config.toml section already looked
  drifted from the real project's dashboard settings (local file said
  `enable_confirmations = false`; the real, working confirmation-email
  flow implied otherwise) — decided *not* to use `supabase config push`
  for the Auth redirect URL update because of that drift risk, guiding
  the user through the dashboard step instead.
- Vercel CLI device-code login took three attempts before working — the
  first two failed because backgrounding the login process incorrectly
  (a shell-level `&` inside a compound command, and a `timeout`-wrapped
  call) killed the underlying process before the user could approve the
  code. Fixed by using the harness's real `run_in_background` tracking
  instead of shell tricks, which kept the device-auth polling alive long
  enough to actually complete.
- User imported the repo via Vercel's dashboard (which set up the GitHub
  auto-deploy integration as a side effect — the reason a dashboard
  import was preferred over a bare CLI deploy) and added the six env
  vars the app already needed for local dev. Linked the local checkout
  to the resulting project (`vercel link --project project-stage`),
  confirmed via `vercel env ls` that all six were present as expected.
- Set `NEXT_PUBLIC_SITE_URL` explicitly to the stable production domain
  after realizing the code's existing `VERCEL_URL` fallback resolves to
  a per-deployment hash, not a stable identity — see DECISIONS.md.
  Triggered a rebuild for it to take effect (`NEXT_PUBLIC_*` vars are
  build-time inlined, not read at request time).
- Verified end-to-end against the real deployment via HTTP requests
  (landing/events/login/signup pages all 200; `/dev` 404s): created a
  real test event through the CLI harness and confirmed it appeared on
  the deployed `/events` list and rendered correctly in its room page as
  a guest — proving Supabase connectivity from the live app, not just
  that routes respond.
- Confirmed auto-deploy on push to `main` with a real push (a small
  `.gitignore` fix), not just a "Git repo connected" status message —
  watched a new deployment appear and go Ready within ~30 seconds.

**Completed work — LiveKit**:

- Reviewed the three code paths needing LiveKit config directly from
  source (`token.ts`, `permissions.ts`, `webhook/route.ts`) rather than
  from memory, confirming exactly `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`/
  `NEXT_PUBLIC_LIVEKIT_URL` plus a dashboard-configured webhook are the
  full requirement — nothing else in the app is LiveKit-gated.
  Instructed the user on exactly what to create in LiveKit Cloud
  (project, API key pair, webhook pointing at the new public URL) and
  which Vercel env vars to set — never asked for the values themselves.
- Rebuilt production once the vars were added, then attempted to verify
  them server-side by pulling the real values locally
  (`vercel env pull`) to replay the app's own token-minting/webhook-
  signing logic against the real LiveKit project. Every var came back as
  literal text `[SENSITIVE]` — discovered that Vercel's "Sensitive" env
  var type (the default for anything added through the dashboard/CLI)
  cannot be read back by anyone, including the owner, once set. Not a
  bug; a real, useful thing to know before trying this approach again.
  Cleaned up the now-useless scratch script and pulled placeholder file
  immediately.
- Pivoted to verifying through the deployed app's own observable
  behavior instead: confirmed the live room page's SSR output shows no
  trace of `getLiveKitToken`'s "Couldn't connect" fallback (proves the
  vars are present, non-empty, and local JWT signing succeeds — token
  minting itself never calls LiveKit's API, so this doesn't prove
  network reachability on its own); confirmed the deployed webhook route
  correctly returns 401 for both a bogus signature and a missing one,
  proving it's live, publicly reachable, and genuinely verifying
  signatures rather than accepting anything.
- Explicit, stated limit rather than a glossed-over gap: a validly-signed
  webhook payload being *accepted*, and the actual client-side WebRTC
  connection (camera/mic prompts, real video/audio, two real devices,
  reconnect behavior, phone orientation) cannot be verified without
  either the real secret (which should never be pasted anywhere,
  including into an agent session) or a real browser with camera/mic
  hardware, neither of which this environment has. Handed back to the
  user as a precise, scoped hands-on checklist rather than claiming
  false coverage.

**Files changed**: `README.md` (new "Deployment" section, LiveKit webhook
note updated), `ARCHITECTURE.md` (Deployment section rewritten from "not
yet deployed", tech stack table row), `DECISIONS.md` (the
`NEXT_PUBLIC_SITE_URL`/`VERCEL_URL` finding and the Sensitive-env-var
finding), `CHANGELOG.md`, `SESSION_LOG.md` (this entry). No application
code changed this session — every fix was environment/dashboard
configuration.

**Known issues**: None in what was verified. Not yet verified (requires
the user's own hands-on testing, handed off explicitly, not silently
skipped): guest audience connection, authenticated speaker connection,
camera/mic permission flows, real two-speaker video/audio, live
permission-change reactions, reconnect behavior, and phone
portrait/landscape behavior, all over the real deployed URL.

**Tests run**: No code changed, so the existing suite wasn't expected to
need re-running — confirmed anyway that `main`'s last known state
(95/105 → 105/105 from Session 15) is what's actually deployed, via the
Vercel deployment log matching the pushed commit.

**Current build status**: Deployed and Ready on Vercel; `main` unchanged
except for this session's doc updates.

**Recommended next task**: the user's own hands-on LiveKit verification
checklist (below, given directly in this session's final response, not
duplicated here) — no new product milestone until that's done, per this
session's explicit instruction.

---

## 2026-08-12 — Session 15: `/dev` browser-based usability-testing UI

**Goal**: The dev harness CLI (Session 13) still required terminal
commands to reach the core experience. Build a lightweight, dev-only
browser UI so usability testing doesn't need CLI commands at all — the
smallest solution that adds no backend feature and leaves production
behavior unchanged.

**Completed work**:

- **Design review before implementation**: the CLI harness achieved zero
  production footprint by living entirely outside `src/`, never HTTP-
  reachable. A UI-reachable tool can't make that claim by construction —
  it has to be a real Next.js route. Proposed `src/app/dev/`, gated by
  `process.env.NODE_ENV !== "production"` → `notFound()` (reliable
  because Next.js itself force-sets `NODE_ENV=production` for every
  build/start), with the same guard independently re-checked inside
  every Server Action (an action's endpoint is reachable regardless of
  whether the page that renders its trigger ever rendered). User
  approved with explicit requirements: reuse `claimSpeakerSeat` and the
  existing service client, no new schema/RLS/RPC, share the CLI
  harness's tagging convention, reuse existing login/signup rather than
  a new auth flow, keep synthetic second-speaker creation in the CLI,
  keep the UI intentionally plain, and test both the production guard
  and the reset safety boundary.
- **`src/lib/dev-demo.ts`**: extracted the CLI harness's tagging
  constants (`[dev-harness] ` prefix, `@dev-harness.invalid` domain),
  phase-timing helper, and a new `isDevToolsAvailable()` guard predicate
  into one shared, pure module — no Supabase, no I/O. Refactored
  `scripts/dev-harness.mts` to import from it instead of keeping its own
  copies (one source of truth, so the CLI's `reset` and `/dev`'s
  "Reset all demo events" clean up each other's data), moving the
  corresponding tests to `src/lib/dev-demo.test.ts`.
- **`src/lib/repositories/dev-demo.ts`**: the `/dev` page's data layer —
  `listDevDemoEvents`, `createDevDemoEvent`, `resetDevDemoEvents`, and
  `seatCurrentUserAsSpeaker` (a thin wrapper directly calling issue #13's
  `claimSpeakerSeat`, deliberately bypassing issue #14's production
  request-queue/ranking gate — the same bypass the CLI's `seat` command
  already established as acceptable for testing). Added as a documented
  caller of `lib/supabase/service.ts` (which now lists all four current
  callers, catching that the doc comment had already drifted — issue
  #14's `speaker-requests.ts` was a caller that was never added).
- **`src/app/dev/page.tsx` + `actions.ts`**: intentionally plain —
  create-event form, a list of demo events with room/event links and
  live seat status, per-event "Seat me in seat 1/2" (profile identities
  only; guests see the existing `/login`/`/signup` links, never a new
  prompt), and a reset button. Plain `<form action={...}>` bindings
  throughout (the same `sendMessage.bind(null, eventId)` pattern the
  lobby chat panel already uses) — no client components needed anywhere
  on this page.
- **A real, reproducible test-infrastructure bug found and fixed, not a
  flaky network blip**: once `dev-demo.test.ts` existed alongside
  `dev-harness.test.ts` — two independent integration test files both
  creating `[dev-harness] `-tagged fixtures and both running their own
  "delete everything tagged" reset — Vitest's default parallel file
  execution let one file's reset delete the other's still-in-use
  fixtures mid-run. Confirmed by reproducing it, then fixed with
  `fileParallelism: false` in `vitest.config.mts` (documented reasoning
  in DECISIONS.md), and re-ran the full suite three consecutive times
  clean to build confidence before moving on.
- **Verified manually**, working around this session's lack of a
  browser: seeded a demo event via the CLI, confirmed `/dev`'s read path
  rendered it correctly (title, room/event links, "Seat 1: open · Seat
  2: open") for a guest, confirmed the guest view shows no seat buttons
  (only the login/signup prompt) — and, the safety-critical check, built
  for production and started it on a spare port, confirmed `/dev`
  returns a real 404 while `/events` stays healthy. Cleaned up the
  seeded event afterward.
- Tests: `dev-demo.test.ts` (tagging predicates + `isDevToolsAvailable`
  across `production`/`development`/`test`), `actions.test.ts` (each
  Server Action rejects synchronously under a stubbed
  `NODE_ENV=production`, proving the guard is actually wired in, not
  just correct in isolation), and a live integration suite
  (`repositories/dev-demo.test.ts`) mirroring the CLI harness's own
  safety-boundary proof — an untagged "real" event fixture survives
  `resetDevDemoEvents` untouched while every tagged one is gone.
- Documented in README.md (a restructured "Development test harness"
  section covering both tools, with the browser walkthrough up front),
  ARCHITECTURE.md (folder structure, `service.ts`'s caller list),
  DECISIONS.md (the gating-model reasoning and the test-parallelism
  finding).
- **No GitHub issue** — same precedent as the CLI harness: dev tooling,
  not tracked product scope, a `chore` commit.

**Files changed**: `src/lib/dev-demo.ts` (+test), `src/lib/repositories/dev-demo.ts`
(+test), `src/app/dev/page.tsx`, `src/app/dev/actions.ts` (+test),
`scripts/dev-harness.mts`, `scripts/dev-harness.test.ts`,
`src/lib/supabase/service.ts`, `vitest.config.mts`, `README.md`,
`ARCHITECTURE.md`, `DECISIONS.md`, `SESSION_LOG.md` (this entry).

**Known issues**: None. Full interactive click-through (submitting the
create/seat/reset forms via a real browser) wasn't verified in this
environment — no browser available — but every piece of logic those
forms invoke is covered by the live integration tests, and the
page/guard rendering was verified via direct HTTP requests against both
a dev and a production server.

**Tests run**: `npm run lint` (clean), `npx tsc --noEmit` (clean),
`npm run build` (clean — `/dev` appears in the route table; confirmed
separately that it 404s when actually served in production mode),
`npx vitest run` — **105/105 passing, zero skipped**, run three times
consecutively clean after the `fileParallelism` fix.

**Current build status**: Lint clean, typecheck clean, build clean, full
test suite passing (105/105, no skips, verified non-flaky).

**Recommended next task**: an actual usability testing session using
`/dev` — create a demo event, seat yourself, invite a second tester (or
use the CLI to create a synthetic second speaker) into the room. Product
milestones after that: Emergency leave (ROADMAP's last open Phase 2
item) or continuing Phase 3.

---

## 2026-08-12 — Session 14: Issue #14 — speaker request queue

**Goal**: Review whether issue #4 (audience viewing) was still meaningful
independent scope after issue #3, recommend the next issue, then design
and ship the speaker request queue — the first issue to give
`claim_speaker_seat` (issue #13) a real production caller.

**Completed work**:

- **Reviewed #4/#5 against issue #3's actual shipped code** (not just
  memory): confirmed both are fully subsumed — `room/page.tsx` never
  gates on a session, guests get a full audience experience, and
  audience count already comes from LiveKit's own roster. Recommended
  moving to Phase 3's speaker queue over Phase 2's remaining "Emergency
  leave" item, since the queue is what the last several sessions have
  all been building toward and unlocks the first real end-to-end user
  flow; user agreed.
- **`gh` CLI became available mid-session** — installed and authenticated
  by the user after earlier sessions, just not yet on this session's
  PATH (a fresh shell picks it up; this session kept using the full
  path, `C:\Program Files\GitHub CLI\gh.exe`). First real board access
  this project has had. Used it to: close #4 and #5 with comments
  explaining the supersession (including #5's real deviation from its
  original Realtime-Presence scope); create issue #14 with the full
  approved design as its body; and discover + fix a real board-hygiene
  gap — issues #13 and #3 were closed on GitHub but still showed
  `Status: Backlog` on the Project board (`closes #N` closes the issue,
  never the board's custom Status field — two separate systems). Fixed
  all four stale/missing cards, and moved #14 through
  In Progress → Testing / Review deliberately this session rather than
  assuming the commit message would handle it. See DECISIONS.md.
- **Design review before implementation**: reviewed PRODUCT.md's queue/
  comment/reputation sections in full. Proposed the core reframe — a mic
  request is a chat message with a flag, not a generic waiting-list
  table — plus a `speaker_requests` lifecycle table, three functions at
  three authorization tiers (mirroring issue #13's split exactly), and a
  top-3-eligible self-service claim as the answer to "who actually gets
  promoted." User approved with two adjustments: (1) frame top-3
  eligibility explicitly as an MVP selection policy, not a permanent
  rule, documenting the durable concepts (audience support raises
  requests, only elevated requests become eligible, promotion mechanism
  may evolve) so a future redesign has something to preserve; (2) make
  request creation atomic via a DB function/RPC, not two independent
  application-level writes — no orphaned message-without-request or
  request-without-message, ever.
- **Migration `00000000000011`**: `event_chat_messages.is_speaker_request`
  (permanent marker, set once) + `speaker_requests` table (lifecycle
  only, FK to the message that carries the actual content) + three
  `security definer` functions — `request_to_speak` (self-service,
  atomic — the message and request insert happen in one function call,
  so a losing concurrent call's message insert rolls back with it),
  `withdraw_speaker_request` (self-service, same shape as
  `leave_speaker_seat`), `rank_pending_speaker_requests`
  (trusted-server-only, reaction-count → reputation → recency).
  **Every function's `PUBLIC` execute grant was explicitly revoked in
  this same migration** — applying issue #13's lesson proactively this
  time instead of needing a follow-up bug-fix migration. Verified
  directly against `pg_proc.proacl` immediately after pushing, before
  writing any application code — confirmed clean on the first attempt.
- **`lib/speaker-queue.ts`**: `findOpenSeat`, `isEligibleToClaim`, and —
  added during implementation, not part of the original design write-up
  — `decideClaimEligibility`, a pure extraction of `claimOpenSeat`'s
  actual authorization decision. Pulled out specifically because the
  issue's own Definition of Done asked for a test proving the top-3 gate
  rejects an ineligible claim, and the Server Action itself can't be
  unit-tested directly (`resolveIdentity()` needs a real Next.js request
  for `cookies()`) — same reasoning already applied to
  `determineCanPublish`/`shouldPublish`/`applySpeakerChange`.
- **`lib/repositories/speaker-requests.ts`** and three new Server Actions
  in `room/actions.ts` (`requestToSpeak`, `withdrawSpeakerRequest`,
  `claimOpenSeat`). A successful claim pushes `canPublish: true` live via
  `syncPublishPermission` — the moment issues #2, #13, #3, and #14
  finally connect into one real loop: request → rank → claim → seat →
  immediate publish, no reconnect.
- **`RoomControls`** redesigned from "speaker-only" to four states
  (speaker/guest/no-request/pending-request), always rendered now rather
  than gated behind `isSpeaker`. Guests see the identical "Request the
  mic" button everyone does; PRODUCT.md's scripted account prompt
  appears inline only on click, never as a standing banner — matching
  its explicit "never interrupt speculatively" wording rather than the
  more literal reading that would've shown guests a permanent "you
  can't do this" strip. `MessageItem` (shared by lobby and room chat)
  gained a small 🎤 badge for `is_speaker_request` messages.
- Tests: `speaker-queue.test.ts` (pure functions, including
  `decideClaimEligibility`'s every rejection path), `room-controls.test.tsx`
  (new component test, mocking the Server Actions module — guest prompt
  only appears after a click, pending/claim/withdraw state transitions),
  and `speaker-requests.test.ts` — a live integration suite against the
  real project proving: atomic creation via a genuine race (two
  concurrent `request_to_speak` calls from the same profile, then
  asserting the message count exactly equals the request-row count — the
  actual invariant atomicity guarantees, not just "it returned
  successfully"), rejection of a second pending request, rejection of a
  request from an already-active speaker, withdrawal + re-request,
  ranking order by reaction count, and `rank_pending_speaker_requests`
  correctly rejecting an ordinary authenticated caller (42501) — proving
  the trusted-server-only tier holds, not just documenting it. All 9
  integration tests passed on the first run.
- **Manually verified end-to-end** using last session's dev harness: `dev:harness
  create` for a live test event, then a one-off signed-in RPC call to
  `request_to_speak` (the harness itself doesn't have a "request" command
  — a direct script call reusing its exported `getServiceClient`), then
  curled the room page as a guest and confirmed the request message
  rendered with its badge, author name, and body, alongside "Seat open"
  placeholders and "Waiting for speakers" status, plus the "Request the
  mic" button present with no proactive account-prompt text in the raw
  SSR HTML. Cleaned up via `dev:harness reset` afterward.
- Documented in ARCHITECTURE.md (Data model, Realtime plan, folder
  structure, a new "Speaker request queue" section), DECISIONS.md (the
  comment-driven design + atomicity + MVP-policy framing; the board
  Status-field finding as its own entry), ROADMAP.md, CHANGELOG.md.

**Files changed**: `supabase/migrations/00000000000011_speaker_requests.sql`,
`src/types/database.ts`, `src/lib/repositories/speaker-requests.ts`
(+test), `src/lib/speaker-queue.ts` (+test),
`src/lib/repositories/chat.ts`, `src/hooks/use-lobby-realtime.ts`,
`src/components/lobby/message-item.tsx`,
`src/components/room/room-controls.tsx` (+test),
`src/components/room/portrait-room.tsx`,
`src/components/room/landscape-room.tsx`,
`src/components/room/live-room.tsx`, `src/components/room/types.ts`,
`src/app/events/[id]/room/actions.ts`,
`src/app/events/[id]/room/page.tsx`, `ARCHITECTURE.md`, `DECISIONS.md`,
`ROADMAP.md`, `CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: Reputation-score mutation still doesn't exist anywhere
(ranking's tiebreak is currently a no-op for every profile) — accepted,
not a blocker, same class of gap issue #13 already left for a future
session. Comment reply threads confirmed non-blocking but not built. The
pinned/featured comment UI itself (the `featuredSlot` consumer) is still
unbuilt — this issue only proves the seam works.

**Tests run**: `npm run lint` (clean), `npx tsc --noEmit` (clean),
`npm run build` (clean — `/events/[id]/room` unchanged in the route
table, no new routes added by this issue), `npx vitest run` —
**95/95 passing, zero skipped**.

**Current build status**: Lint clean, typecheck clean, build clean, full
test suite passing (95/95, no skips). Board: #4, #5, #13, #3 corrected to
Done; #14 in Testing / Review pending merge.

**Recommended next task**: Emergency leave (ROADMAP's last open Phase 2
item) or continuing Phase 3 (continue/replace voting, live reactions,
general comments + the pinned/featured UI this issue's `featuredSlot`
and `is_speaker_request` ranking were built to support) — a real
prioritization call for the next session to make with the user, not
something to default on.

---

## 2026-08-11 — Session 13: Development test harness

**Goal**: Before starting the next product milestone, build the smallest
development-only tooling needed to create, seat, list, and reset live
test events — closing the gap where becoming a speaker (by design) has
never been possible through the app itself, and every prior verification
of the room required a one-off service-role test script.

**Completed work**:

- **Design review before implementation**: reviewed `lib/supabase/service.ts`,
  the issue #13 speaker-transition primitives, `supabase/seed.sql`, and
  how the app's own integration tests already drive real fixtures via the
  service client + Auth admin API. Proposed a single standalone
  `scripts/dev-harness.mts`, run via Node's native `--env-file`/
  `--experimental-strip-types` (confirmed working against this project's
  installed Node 22.23.1 before proposing it, rather than assuming) —
  zero new dependency, zero new application code. User approved with
  explicit safety requirements: tag every harness-created resource,
  `reset` must never touch anything else, seating a real account must
  leave it untouched by `reset`, and tests for the safety boundary where
  practical.
- **`scripts/dev-harness.mts`**: four commands (`create
  [--phase=ready|lobby_open|upcoming]`, `seat <email-or-label> <1|2>
  [eventId]`, `list`, `reset`), built entirely from already-existing,
  already-authorized primitives — a plain `events` insert via the service
  client, and the `claim_speaker_seat` RPC from issue #13 (no new backend
  capability, this script is simply one more trusted server-side caller
  of it). Deliberately does **not** import `lib/supabase/service.ts`
  directly, despite the near-identical client construction — that module
  documents an exact, short list of legitimate callers, and this script
  isn't part of the application, so it gets its own copy of the same few
  lines rather than becoming an undocumented fourth caller.
- **Safety design**: every harness-created resource is tagged (`[dev-harness] `
  event title prefix; the reserved, non-routable `@dev-harness.invalid`
  email domain for auto-created throwaway accounts) and `reset` only
  ever acts on tagged resources. `seat` **refuses to auto-create an
  account for an email that isn't already a real profile and isn't
  harness-tagged**, rather than silently creating an untagged account
  `reset` could never find — this is what makes seating your own real
  dev account safe: pass a real email, it gets reused (never created or
  deleted), pass a bare label and it expands to a throwaway
  `@dev-harness.invalid` account that `reset` will clean up.
- **A real, minor implementation finding**: `tsc --noEmit` rejects an
  explicit `.mts` extension in an import specifier by default (`TS5097`),
  which the test file needs (Node's own ESM resolution requires that same
  extension when the script runs directly, so both need to agree). Fixed
  with `allowImportingTsExtensions: true` in `tsconfig.json` — confirmed
  safe project-wide given `noEmit: true` was already set, and that
  Next.js's own build doesn't type-check through this exact path either
  way.
- **Manually verified end-to-end against the real linked project** before
  writing the automated test: `create` (all three phases), `seat`
  (auto-creating a throwaway account, and reusing an existing one),
  `list`, and `reset` — including deliberately creating an untagged
  "simulated real" event and account first, confirming `reset` left both
  completely untouched while removing every harness-tagged resource, then
  cleaning up the simulated fixtures by hand afterward (since `reset`
  correctly wouldn't touch them). Also verified `seat` refuses to
  auto-create an account for an unrecognized non-harness email, with a
  clear error.
- **`scripts/dev-harness.test.ts`**: unit tests for the tagging predicates,
  `timingForPhase`'s phase boundaries, and `parseArgs`, plus an
  end-to-end integration suite (skips gracefully without
  `SUPABASE_SERVICE_ROLE_KEY`) that automates the exact manual
  verification above — creates untagged "real" fixtures alongside
  harness-tagged ones, runs the actual `resetHarness`, and asserts the
  untagged fixtures survive while the tagged ones are gone. This is the
  test that actually proves the safety boundary, not just the
  tag-matching predicates in isolation.
- Documented in README.md (new "Development test harness" section: Node
  version requirement, full command usage, safety model), ARCHITECTURE.md
  (folder structure), DECISIONS.md (full design reasoning, the
  `tsc`/`allowImportingTsExtensions` finding), CHANGELOG.md.

**Files changed**: `scripts/dev-harness.mts`, `scripts/dev-harness.test.ts`,
`package.json` (added `dev:harness` script — no new dependency),
`tsconfig.json` (`allowImportingTsExtensions: true`), `README.md`,
`ARCHITECTURE.md`, `DECISIONS.md`, `CHANGELOG.md`, `SESSION_LOG.md` (this
entry).

**Known issues**: none — every manual and automated verification passed,
including the safety-boundary proof against the real project. Testing an
actual two-person conversation still needs two separate browser sessions
(one per seated speaker); the harness prepares the data, it doesn't
automate the browser.

**Tests run**: `npm run lint` (clean), `npx tsc --noEmit` (clean),
`npm run build` (clean — route table confirms no harness-related route
exists), `npx vitest run` — **69/69 passing, zero skipped** (13 new,
including the live end-to-end safety-boundary test against the real
project).

**Current build status**: Lint clean, typecheck clean, build clean, full
test suite passing (69/69, no skips).

**Recommended next task**: the next product milestone — Phase 3's
queue/voting design remains the standing prerequisite for
`claim_speaker_seat` to get a real *production* caller; this harness is
what makes manually testing that milestone's work practical once it
lands.

---

## 2026-08-11 — Session 12: Issue #3 — two-speaker live room UI

**Goal**: Build the browser-based live room (LiveKit client, two-speaker
stage, unlimited audience, orientation-aware layout) — the first complete
live conversation experience — starting from an architecture review and
an explicit design proposal before implementing, per the user's now-
standing practice.

**Completed work**:

- **Design review before implementation**: confirmed the issue is scoped
  to the browser client/presentation layer only, with no changes to the
  server-side authorization model. Proposed a component hierarchy
  (`LiveRoom` owning every live hook, `PortraitRoom`/`LandscapeRoom` as
  pure presentation below it), deriving current speakers from LiveKit's
  own published tracks, and deriving audience count from LiveKit's
  participant list.
- **The user corrected the speaker-source design mid-review**: current
  speakers must come from `event_speakers`, never from LiveKit's
  participant/track state, so the database stays authoritative even if a
  speaker mutes, loses camera permission, or has a connection hiccup.
  Audience-count-from-LiveKit was approved as proposed.
- **Implementing that correction surfaced a real gap, flagged before
  writing code**: `profiles` RLS never grants `anon` a read, so a guest
  viewer would have no way to resolve a seat's `profile_id` into a
  display name. Proposed denormalizing `display_name` onto
  `event_speakers` (same pattern `event_chat_messages.author_display_name`
  already established for the identical problem), populated by
  `claim_speaker_seat` itself from `profiles.display_name` — approved,
  with the explicit ask to document that `display_name` is intentionally
  denormalized for public/guest rendering while `profile_id` stays the
  durable identity reference. See DECISIONS.md.
- **Migration `00000000000010`**: added `event_speakers.display_name`
  (not null, no backfill needed — confirmed zero rows in the live project
  first), updated `claim_speaker_seat` to populate it via a `profiles`
  lookup (guarding against a nonexistent profile with a clear error
  instead of a bare FK-violation), and added `event_speakers` to the
  `supabase_realtime` publication.
- **`lib/room-status.ts`**: pure `getRoomStatus(activeSpeakerCount)` →
  `"waiting"` / `"selecting"` / `"live"`, with human-readable labels — the
  explicit room-state communication the user asked for, derived the same
  way `event_speakers` decides everything else in the room.
- **Three new hooks**, each following an existing precedent rather than
  inventing a new shape:
  - `use-active-speakers.ts` — Postgres Changes on `event_speakers`,
    same shape as `use-lobby-realtime.ts`. The merge logic
    (`applySpeakerChange`) is a pure, exported, unit-tested function —
    same reasoning as `determineCanPublish`.
  - `use-live-room-connection.ts` — owns the `livekit-client` `Room`
    connection lifecycle, auto-publishes camera/mic based on
    `shouldPublish(permissions)` (a pure, tested decision function) on
    connect and again on every `RoomEvent.ParticipantPermissionsChanged`
    targeting the local participant — the client-side half of issue
    #13's `syncPublishPermission` push, so requirement 6 ("react to a
    live permission change") was mostly free once that issue's design
    paid off. Read the installed SDK's actual type definitions
    (`RoomEvent`, `Track.Source`, `Participant`/`LocalParticipant`
    methods) rather than relying on training data, given how often this
    project's other newer dependencies have diverged from it.
  - `use-orientation.ts` — `matchMedia('(orientation: portrait)')`.
- **Every room component built presentation-only below `LiveRoom`**
  (the one place all four live hooks are called, per ARCHITECTURE.md's
  mobile-orientation rule): `SpeakerTile` (an occupied seat with no
  available video renders a named "camera off" placeholder; an empty
  seat renders a distinct "Seat open" placeholder — never blank either
  way), `SpeakerStage`, `RoomHeader` (event title, room status, audience
  count, and — only when degraded — this viewer's own connection
  status), `RoomControls` (exactly one control: "Leave the stage," giving
  issue #13's `leaveSpeakerSeat` action its first real caller — manual
  mic/camera mute toggles were deliberately left out, matching
  requirement 5's "automatic" framing rather than expanding scope),
  `RoomChatPanel` (reuses the lobby's `ChatPanel` as-is — `event_chat_messages`
  was already event-scoped, not lobby-phase-scoped, so the same
  conversation continues into the room; reserves a `featuredSlot` prop,
  always `undefined` today, for a future pinned Featured Comments section
  per the user's ask to prepare the layout without building it).
- `src/app/events/[id]/room/page.tsx`: redirects to the lobby before the
  event is `"ready"` (same precedent as the lobby's own early-visitor
  redirect), otherwise awaits the event, identity, chat history, active
  speakers, and an initial LiveKit token server-side and hands them to
  `LiveRoom`. The lobby's "ready" phase banner now links into the room
  instead of showing a "not open yet" placeholder.
- **Two real testing-infrastructure gaps found and fixed, not product
  bugs** — this was the project's first component-rendering test file
  and first `matchMedia`-subscribing hook:
  - React Testing Library wasn't being cleaned up between tests
    (`vitest.setup.ts` now calls `cleanup()` in `afterEach` — this
    project doesn't set `test.globals: true`, which is what Testing
    Library's own auto-cleanup normally relies on).
  - A first draft of `useOrientation` (and part of
    `useLiveRoomConnection`) set state synchronously inside `useEffect`,
    which `react-hooks/set-state-in-effect` correctly flags — the exact
    issue `useNow`'s own comment already documents. Fixed
    `useOrientation` with `useSyncExternalStore` (matching `useNow`'s
    established pattern) and removed the redundant `setState` calls from
    `useLiveRoomConnection`'s effect, leaving every state update there
    inside a genuine LiveKit event callback.
- Tests: `room-status.test.ts`, `use-orientation.test.ts` (a hand-rolled
  `matchMedia` fake per test, since jsdom doesn't implement it at all),
  `use-active-speakers.test.ts` (the pure reducer), `use-live-room-connection.test.ts`
  (the pure `shouldPublish` decision function), `speaker-tile.test.tsx`
  and `room-header.test.tsx` (this project's first component-render
  tests, using React Testing Library) — covering the "never blank"
  placeholder requirement and the DB-stays-authoritative-even-with-media-
  issues requirement concretely, not just by code review. Extended
  `event-speakers-transitions.test.ts` for `display_name` snapshotting
  and the new "profile doesn't exist" guard.
- Manually smoke-tested against the user's already-running dev server
  (localhost:3001) rather than fighting over the port: confirmed the room
  page renders the event title, two distinct "Seat open" placeholders,
  "Waiting for speakers" status, and an audience-count element for a real
  past event with no seated speakers, with no server error; confirmed a
  nonexistent event 404s. Full browser/WebRTC verification (camera/mic
  permission prompts, an actual two-person connection, live rotation)
  isn't possible in this environment — same accepted limitation as every
  other LiveKit-touching issue so far.
- Documented in ARCHITECTURE.md (Data model, Realtime plan, Video plan, a
  new "Live room UI" section, folder structure, Testing & Definition of
  Done), DECISIONS.md (the speaker-source-of-truth correction and
  `display_name` denormalization; the two testing-infrastructure
  findings), ROADMAP.md, CHANGELOG.md.

**Files changed**: `supabase/migrations/00000000000010_event_speakers_display_name_and_realtime.sql`,
`src/types/database.ts`, `package.json`, `package-lock.json` (added
`livekit-client`), `src/lib/room-status.ts` (+test),
`src/hooks/use-orientation.ts` (+test), `src/hooks/use-active-speakers.ts`
(+test), `src/hooks/use-live-room-connection.ts` (+test),
`src/components/room/` (`live-room.tsx`, `portrait-room.tsx`,
`landscape-room.tsx`, `speaker-stage.tsx`, `speaker-tile.tsx` (+test),
`room-header.tsx` (+test), `room-controls.tsx`, `room-chat-panel.tsx`,
`types.ts`), `src/app/events/[id]/room/page.tsx`,
`src/components/lobby/lobby-room.tsx`,
`src/lib/repositories/event-speakers.ts`,
`src/lib/repositories/event-speakers-transitions.test.ts`,
`src/lib/repositories/event-speakers.test.ts`, `src/lib/livekit/token.test.ts`,
`vitest.setup.ts`, `ARCHITECTURE.md`, `DECISIONS.md`, `ROADMAP.md`,
`CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: `claim_speaker_seat` still has no production caller —
by design (Phase 3's queue/voting owns that gate) — so the room correctly
shows two open seats until one is manually seeded; nothing in this issue
changes that. The room's audience count and reconnect handling
(`livekit-client`'s built-in `RoomEvent.Reconnecting`/`Reconnected`)
haven't been exercised against a real multi-participant LiveKit session,
only unit-tested at the decision-logic level and smoke-tested for
server-render correctness — the same class of limitation issue #2/#13
already accepted for anything requiring a live LiveKit connection this
environment can't establish.

**Tests run**: `npm run lint` (clean), `npx tsc --noEmit` (clean),
`npm run build` (clean — `/events/[id]/room` appears correctly in the
route table), `npx vitest run` — **56/56 passing, zero skipped**.

**Current build status**: Lint clean, typecheck clean, build clean, full
test suite passing (56/56, no skips).

**Recommended next task**: Phase 3's queue/voting design — the remaining
prerequisite for `claim_speaker_seat` to get a real caller and for this
room to ever show an actual seated speaker outside of manual testing.
Emergency leave (a broader "get out of the room" affordance, distinct
from "Leave the stage") is still an open, unchecked ROADMAP item.

---

## 2026-08-09 — Session 11: Issue #13 — speaker seat state transitions

**Goal**: Ship the write path `event_speakers` didn't have — atomic seat
assignment/replacement, self-service voluntary leave, live LiveKit
permission sync, and disconnect-webhook cleanup — starting from an
architecture review and explicit assumptions before implementing, per the
user's now-standing practice.

**Completed work**:

- **Design review before implementation**, surfacing a real authorization
  question rather than picking an approach unilaterally: every write to
  `event_speakers` needs *some* PostgREST-facing authorization, and this
  app has no role between `anon`/`authenticated` and `service_role`.
  Proposed self-service claiming (`auth.uid()` alone authorizes claiming
  *any* contested seat) as the initial design; the user approved it but
  added an explicit constraint after further review: the seat-claim
  function must not become a generally exposed production action any
  authenticated user can invoke — Phase 3's queue/voting (not built) is
  what should gate who's allowed to claim a seat. Revised the design
  accordingly before writing any code — see DECISIONS.md for the full
  three-function authorization split this produced.
- **Migration `00000000000006`**: a second partial unique index
  (`event_speakers_active_profile_uniq`) closing a real gap in issue #1's
  schema (nothing stopped one profile holding two seats in the same event
  at once), plus three `security definer` functions —
  `leave_speaker_seat` (self-service, `auth.uid()`-gated, granted to
  `authenticated`), `claim_speaker_seat` and `end_speaker_seat` (atomic
  assignment/replacement and reason-coded ending of someone else's
  occupancy — deliberately **not** granted to `anon`/`authenticated`,
  service-client-only). Applied via `supabase db push --linked` and
  verified with `supabase migration list` (local/remote match); types
  regenerated.
- **`lib/supabase/service.ts`**: this project's first use of the
  `service_role` key — a deliberate, narrowly-scoped exception to the
  prior "never use it" stance (see DECISIONS.md for why), imported by
  exactly three call sites, each independently gated before touching it.
- **`lib/livekit/permissions.ts`**: `syncPublishPermission()`, pushing
  `canPublish` live to an already-connected participant via
  `RoomServiceClient.updateParticipant()`. Best-effort by design — logs
  and swallows failures rather than throwing or retrying, since
  `mintLiveKitToken` (issue #2) is the eventual-consistency fallback and
  building a retry queue would be exactly the "prematurely introduce
  distributed infrastructure" ARCHITECTURE.md's Vendor portability section
  warns against for a prototype.
- **`lib/repositories/event-speakers.ts`** gained `leaveSpeakerSeat`,
  `claimSpeakerSeat`, `endSpeakerSeat` — thin wrappers over the three RPC
  functions, each using the client tier its underlying function's grant
  actually requires (session-bound client for `leaveSpeakerSeat`, service
  client for the other two). `src/app/events/[id]/room/actions.ts` gained
  a `leaveSpeakerSeat` Server Action composing the repository write with a
  live permission push — no UI calls it yet (issue #3/#6), a tested
  primitive like issue #1/#2's unwired functions before it.
  `claimSpeakerSeat` deliberately has **no** Server Action wrapper at all
  — creating one would itself be "generally exposing" it, contradicting
  the user's constraint; only tests call it, via the same service-client
  tier a real future caller would need.
- **LiveKit webhook route** (`src/app/api/livekit/webhook/route.ts`):
  verifies LiveKit's webhook signature (`WebhookReceiver`, the `Authorize`
  header — confirmed by reading the installed SDK's source rather than
  assuming the header name), parses `participant_left` events back into
  `event_id`/`profile_id` via new inverse functions
  (`parseParticipantIdentity`/`parseRoomName` in `lib/livekit/token.ts`,
  returning `null` rather than throwing on malformed input — a webhook
  payload is untrusted even after signature verification), and calls
  `end_speaker_seat` with `reason: 'disconnected'`. No live permission
  push follows the disconnect — the participant's already gone, so
  there's nothing connected left to push to.
- Tests: `event-speakers-transitions.test.ts` (real fixture rows — test
  accounts created via the Auth admin API, not fake UUIDs, since these
  functions write through real foreign keys) covering atomic
  assignment, replacement history preservation, the second-seat rejection,
  race safety (two concurrent claims for one open seat — exactly one
  wins), disconnect/no-op safety, and — directly proving the user's
  exposure constraint holds, not just documenting it — that
  `claim_speaker_seat`/`end_speaker_seat` return `42501` for an ordinary
  authenticated user while `leave_speaker_seat` succeeds for one's own
  seat. `route.test.ts` signs real webhook payloads with `jose` (mirroring
  `livekit-server-sdk`'s own `WebhookReceiver`/`TokenVerifier` scheme,
  read from its source) to exercise the actual signature-verification
  path, not a bypassed one. `permissions.test.ts` proves the best-effort
  contract holds under every failure mode reproducible without a live
  connected participant. All of the above `describe.skipIf` gracefully
  without `SUPABASE_SERVICE_ROLE_KEY` configured. `token.test.ts` gained
  round-trip/malformed-input cases for the new parse functions.
- Documented in ARCHITECTURE.md (Data model, folder structure, Video plan,
  a new "Who may transition a seat, and how" subsection under LiveKit
  authorization model, Testing & Definition of Done), DECISIONS.md (a full
  ADR on the authorization-model split and the `service_role` exception),
  ROADMAP.md, README.md (service_role setup, webhook configuration note),
  `.env.local.example`, CHANGELOG.md.

- **`SUPABASE_SERVICE_ROLE_KEY` was added to `.env.local` partway through
  this session** (the user added it themselves, per this project's
  standing rule that credential-entering steps are never done through an
  agent), which unblocked running the integration tests for real instead
  of relying on their skip path. Doing so caught **three genuine bugs**
  that reasoning about migration `00000000000006`'s SQL alone hadn't —
  each fixed as its own forward migration rather than editing an already-
  applied one, per this project's migration discipline:
  - `service_role` had no table grants at all (this project's setup
    doesn't inherit Supabase's usual default-privilege bootstrap for it) —
    `service.from("events").insert(...)` failed with "permission denied
    for table events." Fixed in `00000000000007` with an explicit grant
    plus a matching `alter default privileges` for future tables.
  - **`claim_speaker_seat`/`end_speaker_seat` were actually callable by
    any authenticated (or anon) request**, despite never being granted to
    `anon`/`authenticated` — PostgreSQL grants `EXECUTE` on a new function
    to `PUBLIC` by default, and migration `00000000000006` added the
    intended explicit grants but never revoked that default. This is
    exactly the exposure the user's constraint on this issue was written
    to prevent, happening silently — caught by the test written
    specifically to prove that constraint held (it expected `42501` and
    got a successful call instead). Fixed in `00000000000008`.
  - `end_speaker_seat`'s no-op case (no active seat to end) returned a
    JSON object with every field `null`, not `null` itself — a PL/pgSQL
    unassigned-composite-variable subtlety compounded by how PostgREST
    serializes a non-`SETOF` composite function's result. Fixed in
    `00000000000009` (PL/pgSQL `FOUND` check) plus a matching guard in
    `endSpeakerSeat()` (checking the row's `id` field, since even a
    function that genuinely returns SQL `NULL` still arrives over
    PostgREST as one row of null fields).
  - Also caught and fixed: the race-safety test's own first draft asserted
    the wrong invariant (that exactly one of two concurrent claims must be
    rejected) — not a product bug, a test bug. `claim_speaker_seat`'s
    "replace whoever's there" semantics mean both calls can legitimately
    fulfill if they land closely enough together (the second cleanly
    replaces the first's brand-new row); a true collision is the other
    valid outcome, where the unique index rejects the loser. Rewrote the
    assertion to check what's actually invariant regardless of
    interleaving — never more than one active row for the seat, and every
    non-active row cleanly closed out as `'replaced'`.
  - Full writeup of all three (plus the test-assertion fix) in
    DECISIONS.md; the `PUBLIC`-execute-by-default gotcha is now a standing
    warning in ARCHITECTURE.md's Data model section for any future
    `security definer` function.
  - Also fixed along the way: the transitions test file's own first draft
    called `listActiveSpeakers()` (the Next-request-bound repository
    function) directly from a plain Vitest process, which fails on
    `cookies()` outside a request scope — same limitation
    `event-speakers.test.ts`'s existing comment already documented, just
    missed when writing the new file. Replaced with a direct service-
    client read. And the webhook route test originally required *real*
    LiveKit project credentials to run at all, even though signature
    signing/verification is a local HMAC/JWT check with no LiveKit API
    call involved — switched to `vi.stubEnv`-ed fake credentials (same
    pattern `token.test.ts` already uses for token minting), so it runs in
    any environment, not just one with a live LiveKit project configured.

**Files changed**: `supabase/migrations/00000000000006_speaker_seat_transitions.sql`
through `00000000000009_fix_end_speaker_seat_null_return.sql` (four
migrations total for this issue), `src/types/database.ts`,
`src/lib/supabase/service.ts`, `src/lib/livekit/permissions.ts`,
`src/lib/livekit/permissions.test.ts`, `src/lib/livekit/token.ts`,
`src/lib/livekit/token.test.ts`, `src/lib/repositories/event-speakers.ts`,
`src/lib/repositories/event-speakers-transitions.test.ts`,
`src/app/events/[id]/room/actions.ts`,
`src/app/api/livekit/webhook/route.ts`,
`src/app/api/livekit/webhook/route.test.ts`, `ARCHITECTURE.md`,
`DECISIONS.md`, `ROADMAP.md`, `README.md`, `.env.local.example`,
`CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: `claim_speaker_seat` has no production caller — by
design, not an oversight (see above) — so, same shape of limitation issue
#2 accepted for its `canPublish: true` branch, it's only exercised by
tests, not walked through the real app end-to-end. The webhook route
isn't reachable from local dev without a public tunnel (no LiveKit project
can call `localhost`); verified instead by constructing real signed
payloads (with fake-but-consistent credentials — see above).

**Tests run**: `npm run lint` (clean), `npx tsc --noEmit` (clean),
`npm run build` (clean — `/api/livekit/webhook` appears correctly in the
route table), `npx vitest run` — **28/28 passing, zero skipped**, once
`SUPABASE_SERVICE_ROLE_KEY` was configured and the three bugs above were
fixed (was 16/28 passing with 12 skipped before the key was added).

**Current build status**: Lint clean, typecheck clean, build clean, full
test suite passing (28/28, no skips).

**Recommended next task**: Issue #3 (room UI, `livekit-client`) — the
first thing with an actual page to build against `getLiveKitToken` and,
once a queue/authorization gate exists, `claimSpeakerSeat`. Phase 3's
queue/voting design is the remaining prerequisite for `claim_speaker_seat`
ever getting a real caller.

---

## 2026-08-09 — Session 10: Issue #2 — LiveKit token endpoint (split from #13)

**Goal**: Design and ship the LiveKit token endpoint — the enforcement
point for who may publish audio/video — starting from a full
authorization-model review before implementing, per the user's request.

**Completed work**:

- **Design review before implementation**, covering all nine points the
  user asked about: how audience members join as viewers, how current
  speakers get publish rights, how a newly-selected speaker transitions
  from audience to speaker, how a replaced speaker loses publish rights,
  reconnect handling, race conditions between near-simultaneous seat
  claims, token expiration/renewal, future moderator actions, and
  multi-room readiness. Core design: `canPublish` decided server-side
  from *current* `event_speakers` occupancy; token expiry deliberately
  not the revocation mechanism; live `updateParticipantPermissions()`
  pushes are what actually revoke/grant rights on already-connected
  participants.
- **Found a genuine scope gap while working through the design, and
  stopped to explain it rather than expanding scope unilaterally**:
  issue #2's own body already assumed a "become a speaker" write path,
  but designing that write path properly (atomic assignment, race
  safety, live permission sync, hard-disconnect cleanup via LiveKit
  webhooks) turned out to be substantially more surface area than "SDK
  install + token endpoint." Proposed splitting it out; user approved.
- Created **issue #13** for the write path, with the 8 scope points the
  user specified, and positioned it in the Project board's item order
  directly after #2 and before #3/#4 (`updateProjectV2ItemPosition` via
  raw GraphQL — `gh project` has no CLI flag for item ordering; verified
  the resulting order by re-listing items: #1 → #2 → #13 → #3 → #4).
- Implemented **issue #2 narrowly**, per the user's explicit scope list:
  - Installed `livekit-server-sdk` only (not `livekit-client` — deferred
    to issue #3, the first thing that actually connects to a room),
    continuing the project's existing discipline against installing
    dependencies before something uses them.
  - `lib/livekit/token.ts`: `getRoomName()` (`event:<id>:main`,
    multi-room-ready), `getParticipantIdentity()` (namespaced
    `guest:`/`profile:` identities), `determineCanPublish()` (a pure
    function over an already-fetched occupancy record, deliberately
    separated from the DB lookup so it's unit-testable without a live
    fixture — `event_speakers` has no write grant, so nothing can seed
    an "active speaker" row through the app's own client), and
    `mintLiveKitToken()` (4-hour TTL, `canPublishData: false` since chat
    already goes through Supabase Realtime).
  - `src/lib/repositories/event-speakers.ts` gained
    `getActiveSeatForProfile()` — a targeted read, not a filter over
    `listActiveSpeakers()`.
  - `src/app/events/[id]/room/actions.ts`'s `getLiveKitToken` Server
    Action — thin glue: resolve identity, look up occupancy (guests skip
    the DB call entirely, since they can never have one), mint token.
    No `room/page.tsx` exists yet (issue #3); the action file doesn't
    need a page to exist to be valid Next.js.
- **Real bug caught and fixed while writing tests**: minting a token
  under the project's default `jsdom` Vitest environment failed with an
  opaque "payload must be an instance of Uint8Array" error — `jose`
  (which `livekit-server-sdk` uses for signing) needs real Node
  WebCrypto, which jsdom shims incompatibly. Fixed with a per-file
  `// @vitest-environment node` override; documented in ARCHITECTURE.md
  so the next test that signs/verifies anything doesn't hit this fresh.
- Tests (`token.test.ts`, 7 cases) cover the pure logic
  (`determineCanPublish`, naming functions) and the actual JWT output
  (decoded and asserted, for both a guest/no-seat case and an
  active-speaker case using a constructed — not DB-fetched — occupancy
  record) — all without needing the user's real LiveKit credentials,
  since minting signs a JWT locally and never calls LiveKit's API.
- Documented the model in ARCHITECTURE.md (new "LiveKit authorization
  model" section, LiveKit added as a third documented Vendor-portability
  exception alongside Auth/Realtime), a DECISIONS.md ADR (the #2/#13
  split and why), README.md (optional LiveKit credential setup, since
  nothing in the app connects to a room yet), AGENTS.md (server-decides-
  publish-rights standing rule, plus generalizing the
  "walk the design through before implementing" practice into a standing
  rule of its own — it's caught real gaps twice now), and ROADMAP.md.

**Files changed**: `src/lib/livekit/token.ts`,
`src/lib/livekit/token.test.ts`, `src/app/events/[id]/room/actions.ts`,
`src/lib/repositories/event-speakers.ts`, `package.json`,
`package-lock.json`, `ARCHITECTURE.md`, `DECISIONS.md`, `README.md`,
`AGENTS.md`, `ROADMAP.md`, `CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: None for issue #2's own scope. The token endpoint's
`canPublish: true` branch can't be exercised end-to-end through the real
app yet (nothing can create an active `event_speakers` row until #13
lands) — covered by the unit test using a constructed occupancy record
instead, same reasoning as issue #1's read-path tests not needing a live
fixture either. The user's real LiveKit project credentials aren't
configured in this environment — not required for anything issue #2
ships (token minting signs locally), only for issue #3 onward.

**Tests run**: `npm run lint`, `npx tsc --noEmit`, `npm run build`,
`npx vitest run` (10 tests across 3 files, including the 7 new LiveKit
ones) — all clean.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing (10/10).

**Recommended next task**: Either issue #13 (speaker state transitions —
unblocks real dynamic speaker promotion) or issue #3 (room UI, which can
proceed against hand-seeded `event_speakers` rows without #13, per the
dependency analysis above). #12 and #1 are already Done.

---

## 2026-08-09 — Session 9: Issue #1 — `event_speakers` table

**Goal**: Design and ship the `event_speakers` schema — the Phase 2
foundation everything else (LiveKit integration, the live room, audience
viewing) depends on — starting from a product-philosophy review rather
than jumping straight to columns.

**Completed work**:

- Moved issue #1 to **In Progress**, branched `feature/event-speakers-table`.
- **Design review before writing any schema**, per the user's request:
  walked through what an event speaker represents (an append-only
  occupancy episode, not a scheduled assignment or a mutable "current
  speaker" pointer), how it relates to Events/Profiles/future Live Rooms
  (account-only, deliberately room-agnostic like `events` itself), how
  replacement preserves history (end one row, insert another, never
  overwrite), how it supports reputation/reliability/moderation/analytics
  (the `[joined_at, left_at)` interval and a constrained `left_reason`
  give Phase 4 what it needs without extra columns), and which fields are
  derived vs. persisted (active/duration/current-speakers are all query-
  time computations, matching `events`' own computed-phase discipline).
  Presented for approval before implementing — see DECISIONS.md for the
  full reasoning, including why the other two framings were rejected.
- **Checked for a genuine prerequisite before treating it as one**: the
  obvious next question — "who's allowed to write to this table, and does
  that logic exist yet?" — turned out to already be scoped into issue #2
  (its own body already says the token-minting flow checks
  occupancy/entitlement). Confirmed this by re-reading the existing issue
  rather than assuming, so no new issue was needed and scope wasn't
  expanded.
- User approved the design with one change: `left_reason` as a
  constrained vocabulary, not free text.
- Migration `00000000000005_event_speakers.sql`: append-only occupancy
  episodes, `CHECK`-constrained `left_reason` (`voluntary` / `replaced` /
  `moderator_removed` / `event_ended` / `disconnected` — each traceable to
  already-scoped work, not guessed), a partial unique index enforcing one
  active occupant per seat per event (historical rows unrestricted), RLS
  with a public `SELECT` policy and **no write grant** (matching `events`'
  own first-migration precedent), applied via `supabase db push --linked`
  and verified (RLS/policies/grants all confirmed via `db query --linked`).
- `src/types/database.ts` regenerated. `lib/repositories/event-speakers.ts`
  ships `listActiveSpeakers()` only — no write functions, since there's no
  RLS policy or design to support them yet (that's issue #2).
- **New test infrastructure**: Vitest now loads `.env.local` (via Vite's
  `loadEnv`) so tests can use real credentials. `event-speakers.test.ts`
  is the project's first integration-style test — hits the real linked
  Supabase project (not a mock), confirms reads work and, more
  importantly, that a raw insert attempt is actually rejected with
  `42501` — proving the "read-only for now" design decision is enforced,
  not just documented. Skips gracefully if credentials aren't configured.
- Documented the design in ARCHITECTURE.md's Data model section and a new
  DECISIONS.md ADR; checked off the item in ROADMAP.md's Phase 2.

**Files changed**: `supabase/migrations/00000000000005_event_speakers.sql`,
`src/types/database.ts`, `src/lib/repositories/event-speakers.ts`,
`src/lib/repositories/event-speakers.test.ts`, `vitest.config.mts`,
`ARCHITECTURE.md`, `DECISIONS.md`, `ROADMAP.md`, `CHANGELOG.md`,
`SESSION_LOG.md` (this entry).

**Known issues**: None. The table is intentionally inert from the app's
perspective until issue #2 adds a write path — `listActiveSpeakers()`'s
only caller so far will be issue #4's audience viewing.

**Tests run**: `npm run lint`, `npx tsc --noEmit`, `npm run build`,
`npx vitest run` (3 tests: the existing update-depth regression test plus
two new `event_speakers` RLS tests, all against the real linked project) —
all clean.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing (3/3). Migration applied and verified live.

**Recommended next task**: Issue #2 (LiveKit SDK integration and token
endpoint) — the first consumer of `event_speakers`, and where its write
path (who's allowed to occupy a seat) actually gets designed.

---

## 2026-08-09 — Session 8: Issue #12 — Supabase CLI migration workflow

**Goal**: Replace the manual SQL-Editor-copy-paste workflow with a proper
Supabase CLI migration workflow, so the repository becomes the actual
source of truth for schema changes — without touching or risking the live
project's existing schema and data.

**Completed work**:

- Moved issue #12 to **In Progress**, branched
  `feature/supabase-cli-migration-workflow` from `main`.
- Installed the Supabase CLI as a project-local dev dependency
  (`npm install -D supabase` — global installs are blocked by the CLI
  itself) and ran `supabase init` (scaffolds `supabase/config.toml`;
  confirmed it didn't touch the existing `migrations/`/`seed.sql`).
- User ran `supabase login` and `supabase link --project-ref
  xuzlgcfuwlcpejhctofv` themselves, interactively, in their own terminal —
  deliberately not attempted through a non-interactive tool call, so the
  database password/CLI auth token never passed through anything that gets
  logged.
- **Verified before changing anything irreversible**: no Docker in this
  environment, so `supabase db diff`'s local-shadow-database comparison
  wasn't available, but `supabase db query --linked` (direct SQL via the
  Management API, no Docker needed) was enough to compare the live schema
  against the three existing migration files directly — table/column
  shapes, RLS-enabled flags, every policy, every meaningful grant, the
  profile-provisioning trigger, and Realtime publication membership. All
  matched exactly.
- Only after that verification: `supabase migration repair --status
  applied 00000000000001 00000000000002 00000000000003` — bookkeeping
  only (writes to `supabase_migrations.schema_migrations`), no SQL
  executed, confirmed via `supabase migration list` showing `local`/
  `remote` in sync, and confirmed no data moved (`events`/messages/
  `profiles` row counts unchanged before and after).
- **Proved the forward workflow end-to-end** with a real (low-risk)
  migration: `00000000000004_table_comments.sql` (adds `COMMENT ON TABLE`
  documentation to all four tables, mirroring ARCHITECTURE.md), applied
  via `supabase db push --linked`, confirmed live via `db query --linked`.
- **Switched `src/types/database.ts` from hand-written to generated**
  (`supabase gen types typescript --linked`) — removes the exact bug class
  hit earlier (missing `Relationships`/`Views`/`Functions` fields) instead
  of relying on remembering the shape by hand. Verified against real
  Postgres foreign keys, which are more accurate than the hand-written
  version's placeholder `Relationships: []` ever was.
- Documented the full workflow — one-time setup, creating/applying
  migrations, regenerating types, verifying status, seeding, and the
  local-vs-linked distinction for `db reset` (with an explicit warning
  never to run `--linked` against the shared project, which has no staging
  copy) — in ARCHITECTURE.md (new Migration workflow section), README.md
  (new Database migrations section + updated Getting Started), and
  AGENTS.md (standing rules). DECISIONS.md records the reconciliation
  strategy and why it was safe.

**Files changed**: `supabase/config.toml`, `supabase/.gitignore`,
`supabase/migrations/00000000000004_table_comments.sql`,
`src/types/database.ts` (generated, not hand-edited going forward),
`package.json`, `package-lock.json`, `ARCHITECTURE.md`, `README.md`,
`AGENTS.md`, `DECISIONS.md`, `ROADMAP.md`, `CHANGELOG.md`,
`SESSION_LOG.md` (this entry).

**Known issues**: Docker isn't installed in this environment, so local dev
(`supabase start`, `supabase db reset --local`, `supabase db diff`'s
shadow-database comparison) remains unavailable — all CLI operations
target the linked project directly. Not blocking normal migration work,
but means there's no local sandbox to rehearse a risky migration against
before it hits the real database. Flagged in ARCHITECTURE.md and
ROADMAP.md, not silently worked around.

**Tests run**: `npm run lint`, `npx tsc --noEmit`, `npm run build`,
`npx vitest run` — all clean after switching to generated types. Migration
workflow itself verified end-to-end against the live project (see above),
not just documented.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing. Live schema, migration tracking, and `database.ts` all
confirmed in sync.

**Recommended next task**: Pick up issue #1 (`event_speakers` table) —
it's the first migration to go through the newly-verified CLI workflow for
real feature work, not just a documentation-only proof.

---

## 2026-08-09 — Session 7: GitHub Projects + Issues workflow

**Goal**: Add GitHub Issues + a Project (Kanban) board as the visible
planning/task-management layer for the repo, before starting Phase 2.

**Completed work**:

- Installed and authenticated the GitHub CLI (`gh`), including the
  `project` scope (not part of `gh`'s default auth scopes — needed
  `--scopes "repo,project"`, done interactively by the user since it's a
  browser-based login).
- Created a private GitHub Project ("Virtual Stage",
  [github.com/users/Rapscallion12/projects/1](https://github.com/users/Rapscallion12/projects/1))
  and linked it to the repo.
- Replaced the board's default Status options (Todo/In Progress/Done —
  not deletable as a field, since it's a built-in one, but its options are
  editable via the GraphQL API) with the requested five: Backlog, Ready,
  In Progress, Testing / Review, Done.
- Created 12 issues and added all of them to the board:
  - **Phase 2 (the live room), broken into a dependency-ordered chain**:
    #1 `event_speakers` table, #2 LiveKit SDK + token endpoint, #3
    two-speaker live room UI, #4 audience viewing, #5 audience count, #6
    emergency leave. Each issue states its dependencies and links back to
    the relevant ARCHITECTURE.md/PRODUCT.md sections rather than
    restating them.
  - **Outstanding backlog items**: #7 moderator flag, #8 GIF support, #9
    image uploads, #10 un-reacting, #11 the `/events` list's 2-hour
    cutoff hiding still-open lobbies (bug), #12 Supabase CLI setup.
  - #1 and #12 set to **Ready** (unblocked, next up); the rest to
    **Backlog**.
- Documented the full workflow (issue → board → branch → commits →
  checks → review → merge → close) in AGENTS.md and README.md's new
  "Project management" section, plus a light cross-reference from
  ROADMAP.md tying its phase-level items to the corresponding issue
  numbers.
- **Adopted `feature/` as the branch-naming prefix going forward**
  (previously `feat/`), per the user's explicit new convention — existing
  `feat/*` branches aren't being renamed retroactively.

**Files changed**: `AGENTS.md`, `README.md`, `ROADMAP.md`,
`SESSION_LOG.md` (this entry). No application code changed this session.

**Known issues**: None. The board and issues are net-new and haven't yet
been exercised by a real feature branch under the new workflow — the
first real test of it is whichever issue gets picked up next (#1 or #12).

**Tests run**: `npm run lint` (docs-only session; no build/typecheck/test
changes expected or needed).

**Current build status**: Unchanged from Session 6 — lint clean, build
clean, test suite passing.

**Recommended next task**: Pick up issue #1 (`event_speakers` table) or
#12 (Supabase CLI setup) from the board — both are in **Ready**. Move the
chosen one to **In Progress**, branch as `feature/<description>`, and
follow the documented flow through to **Done**.

---

## 2026-08-09 — Session 6: Scheduled events + pre-show lobby, repository refactor, update-depth bug fix

**Goal**: Deliver the "Public Scheduled Events + Pre-Show Lobby Foundation"
milestone — the full guest-accessible entry path (landing → browse events
→ event detail → countdown/status → pre-show lobby with live chat) —
explicitly *not* the live conversation system (no LiveKit, no speakers, no
voting). Mid-session, apply a new standing vendor-portability principle to
the just-built data layer, then find and fix a real runtime bug surfaced
during verification.

### Part 1 — Events + pre-show lobby feature

**Data model** (`supabase/migrations/00000000000003_events_and_lobby.sql`):
`events` (no room/speaker columns — a single event may later host multiple
simultaneous rooms, kept as a schema *addition* not a redesign),
`event_chat_messages`, `event_chat_message_reactions`. Guest-eligible via
the `author_profile_id` XOR `author_guest_id` pattern already documented
in ARCHITECTURE.md, enforced by RLS at insert time (a relaxed `not both`
`CHECK` rather than a strict "exactly one," to survive a future account
deletion cascading `author_profile_id` to null without violating the
constraint). Reactions are insert-only for everyone — a guest-safe delete
policy would need to verify *which* guest is asking, which an anon-key
request can't prove, and opening delete to any anon request naming any
reactor id is a real griefing vector, not an accepted limitation. Every
table got an explicit `GRANT` and was added to the `supabase_realtime`
publication (both lessons from earlier migrations' bugs, applied
proactively this time instead of discovered the hard way again).

**Guest identity, implemented for real** (previously just designed in
ARCHITECTURE.md): `src/proxy.ts` mints a `vs_guest_id` cookie for
unauthenticated visitors; `resolveIdentity()` (`lib/identity.ts`) is the
one place "who is making this request" gets resolved, account or guest;
guests get a deterministic "Adjective Animal" display name, renameable via
a `vs_guest_name` cookie, without affecting already-sent messages
(display-name snapshots).

**Pre-show lobby**: live text chat (Server Action + Supabase Realtime
Postgres Changes), native emoji input + a quick-emoji row, insert-only
upvote reactions (deduplicated via a `COALESCE(profile_id, guest_id)`
unique index), live attendee count via Realtime Presence, a phase banner
("lobby hasn't started" / "starting now"), computed — not stored — event
phase (`upcoming` / `lobby_open` / `ready`) from two timestamps. Root
layout switched to `h-dvh` + `overflow-y-auto` on `body` so the lobby's
chat panel scrolls internally instead of growing the whole page.

**Deferred, at the user's explicit agreement**: GIF support and image
uploads (both phrased conditionally in the original request; neither
required by its Definition of Done; both would add meaningful scope —
a new external API key for GIFs, a Storage bucket + RLS + moderation
review for uploads). Documented as fast-follows in ROADMAP.md, not
abandoned. Also deferred: un-reacting (removing your own reaction) — same
guest-can't-prove-identity problem as reaction deletes generally.

**Landing page**: repointed the Hero's primary CTA from the `#how-it-works`
anchor placeholder to `/events`, closing a gap flagged in Session 2's
ROADMAP notes.

### Part 2 — Vendor portability refactor

The user introduced a new standing principle mid-session: Supabase is
today's backend, not a permanent commitment, and durable-data access
should be centralized behind repository/service abstractions rather than
scattered `createClient().from(...)` calls in pages/actions. Refactored
the just-built feature (before it was ever committed) into
`lib/repositories/{events,chat,profiles}.ts`, returning plain domain types
never aliased from the Supabase-generated schema type. Auth and Realtime
were deliberately left un-abstracted and documented as such — both have
provider-specific API shapes deep enough that a generic wrapper would just
rename Supabase's API, and building one now (before there's a second
provider to actually support) would be the same over-engineering mistake
the "don't prematurely introduce distributed infrastructure" half of the
same instruction warns against. Documented at length in ARCHITECTURE.md's
new "Vendor portability" section, including the realtime-vs-durable-writes
distinction (message reactions persist individually on purpose — dedup
needs identity; the *future* live-room reactions must not copy that
pattern, they're the actually high-frequency case).

**Found and fixed along the way**: `src/types/database.ts` was missing
`Relationships: []` per table and top-level `Views`/`Functions` keys —
`@supabase/postgrest-js` requires this exact shape and silently types
every query result as `never` without it, with no error pointing at the
cause. This was a latent bug since the very first migration; nothing had
ever exercised a typed `.from(...).select()` call until this session's
repositories did.

### Part 3 — "Maximum update depth exceeded" in the lobby

**Bug report**: entering an event lobby crashed with "Maximum update depth
exceeded," reported stack pointing at `page.tsx` → `<LobbyRoom />`, with
`initialMessages={messages.slice().reverse()}` flagged as a suspect
(a new array reference every render).

**Investigation**: read `use-lobby-realtime.ts`'s subscription effect
(deps `[eventId]` only), `LobbyRoom`, `ChatPanel`'s two effects (deps
`[pending, state]` and `[messages.length]`), and `MessageItem` — none of
them use `initialMessages`, `identity`, or `event` as an effect dependency,
and `useState(initialMessages)` only consumes its argument on mount, so a
new array reference per parent render doesn't retrigger anything. The
component-stack pointing at `page.tsx` turned out to just be where
`<LobbyRoom>` is instantiated in JSX, not where the loop originated —
`page.tsx` is an async Server Component and doesn't "re-render" in the
client sense at all.

**Root cause**: `grep`ping every `useEffect` in the codebase found only
three, none matching the hypothesis — but `use-now.ts`'s `useSyncExternalStore`
call was the real site: `getSnapshot()` returned `Date.now()` directly.
`useSyncExternalStore`'s contract requires `getSnapshot()` to return a
value stable between calls unless the external store actually changed —
React calls it both before and after every commit to check for "tearing,"
and a value that changes on nearly every call (time always advances) makes
React perceive a change on almost every check, forcing an immediate
re-render, which checks again, sees another new value, and so on. `useNow()`
is consumed by `LobbyRoom`, `EventCountdown`, and `EventEntryStatus` — the
lobby's larger render tree just reliably gives enough time between the two
snapshot checks for the millisecond to tick over, which is why it
reproduced there specifically rather than on the simpler event list/detail
pages (though the same latent bug existed there too, just less reliably
triggered).

**Confirmed, not assumed**: a first regression-test attempt (plain
`renderHook(() => useNow())`) passed even against the buggy code — a
synchronous test render is too fast for `Date.now()` to actually differ
between the two internal checks, so the race didn't reproduce reliably.
Rewrote the test to force `Date.now()` to increment on every single call
(`vi.spyOn(Date, "now")`), which reproduced the exact reported error
deterministically, with React's own diagnostic confirming the cause
verbatim: *"The result of getSnapshot should be cached to avoid an
infinite loop."*

**Fix**: `src/hooks/use-now.ts` now caches the clock value at module scope,
only updating it inside the `subscribe` interval's callback — `getSnapshot`
reads the cached value instead of calling `Date.now()` itself, so it's
stable between calls except when the interval actually fires. No
`eslint-disable`, no dependency removal, no added guards/timeouts — the
actual contract violation was fixed.

**Regression test infrastructure**: this was the first test in the
project, so it needed a runner. Added Vitest + React Testing Library +
jsdom (`vitest.config.mts`, `vitest.setup.ts`, `npm test`) — chosen over
Jest for lower App-Router/ESM friction. `src/hooks/use-now.test.tsx`
reproduces the bug against the old code and passes against the fix.

**Browser verification** (by the user, since no browser automation is
available in this environment): using the existing seeded "Strangers,
Unscripted" event (its lobby has no expiry — the lobby route only blocks
entry *before* `lobby_opens_at`, never after `scheduled_start` — so it
remained enterable directly by URL even after falling off the `/events`
list page's 2-hour display cutoff; no new test data was created). Guest
lobby entry, authenticated lobby entry, sending messages, reactions,
history persisting across refresh, and repeated navigation into/out of the
lobby — all confirmed working, no crash.

**Files changed**: migration `00000000000003`, `supabase/seed.sql`,
`src/types/database.ts`, `src/proxy.ts`, `src/lib/{config,events,guest,identity}.ts`,
`src/lib/repositories/{events,chat,profiles}.ts`, `src/app/events/**`,
`src/app/not-found.tsx`, `src/components/{events,lobby}/**`,
`src/components/site-header.tsx`, `src/components/landing/hero.tsx`,
`src/app/layout.tsx`, `src/hooks/{use-lobby-realtime,use-now}.ts`,
`src/hooks/use-now.test.tsx`, `vitest.config.mts`, `vitest.setup.ts`,
`package.json`, `ARCHITECTURE.md`, `AGENTS.md`, `DECISIONS.md`,
`ROADMAP.md`, `CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: None open. The `/events` list page's 2-hour post-start
display cutoff is a minor rough edge (an event whose lobby is still
enterable can silently disappear from the browsable list) — not a bug in
this milestone's scope, flagged for whenever an "ended" event state is
designed.

**Tests run**: `npx vitest run` (1/1 passing, including the update-depth
regression test), `npm run lint`, `npx tsc --noEmit`, `npm run build` — all
clean. Guest-path RLS verified directly against the live Supabase project
(insert succeeds; impersonating an authenticated author is rejected;
duplicate reactions are rejected; reaction deletes are rejected — all via
raw PostgREST calls with the anon key). Realtime broadcast delivery
confirmed via a throwaway Node script using the real `@supabase/supabase-js`
client (deleted after use, never committed). Full guest + authenticated
browser verification completed by the user against the running dev server.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing (1 test). Lobby confirmed stable in a real browser, guest
and authenticated.

**Recommended next task**: Phase 2 — LiveKit integration and the live
room. Apply the vendor-portability pattern from the start this time
(repository functions from the first commit, not refactored in after the
fact) and the mobile-orientation architecture decided in Session 5 (live
state owned above the orientation branch). Also worth: fixing the
`/events` list cutoff rough edge noted above, and setting up the Supabase
CLI before Phase 2 adds more migrations (friction noted in Session 3/4,
still unresolved).

---

## 2026-08-06 — Session 5: Mobile orientation behavior principle

**Goal**: Document a new permanent product/architecture principle from the
user, specific to the live room's smartphone experience: portrait and
landscape must be two intentional presentation modes of the same session,
not the same layout rotated — and rotating between them must never drop
the live video connection or reset chat/vote/timer state.

**Completed work**: Pure documentation — no application code exists yet for
this to apply to (the live room is Phase 2+, not yet built).

- **PRODUCT.md**: new Principle 13 and a new top-level "Mobile orientation
  behavior" section (portrait vs. landscape priorities, the no-reload/
  no-state-loss requirement), matching the weight given to the two prior
  standing principles (responsive design, progressive authentication).
- **ARCHITECTURE.md**: new "Mobile orientation implementation" section
  naming the specific failure mode to design against (a naive
  `isPortrait ? <A/> : <B/>` split that owns live state — LiveKit
  connection, chat subscription, vote/reaction state, timers — inside
  either branch, which React unmounts on rotation) and the rule that
  prevents it (that state must be owned by a hook/context in a component
  that renders unconditionally, above the orientation branch). Also added
  a dedicated Testing & Definition of Done checklist item requiring the
  live room be rotated mid-session in both directions, not just checked
  once per orientation in isolation.
- **AGENTS.md**: standing rule warning against the naive per-orientation
  component-tree approach, before whoever builds Phase 2 writes that code.
- **ROADMAP.md**: cross-referenced from the Phase 2 section, matching how
  the other two standing principles are already threaded through the
  roadmap.
- **DECISIONS.md**: full ADR — added for consistency with how the other
  two standing principles were recorded, though not explicitly requested
  this time.

Caught and fixed one mistake while editing: an early edit to
ARCHITECTURE.md accidentally deleted the "## Testing & Definition of Done"
heading text (old_string/new_string boundary error) — noticed immediately
via `grep -n "^## "` and restored before it could ship.

**Files changed**: `PRODUCT.md`, `ARCHITECTURE.md`, `AGENTS.md`,
`ROADMAP.md`, `DECISIONS.md`, `SESSION_LOG.md` (this entry).

**Known issues**: None — this is a design commitment for Phase 2, not
working code. There is nothing to test yet; the checklist item added to
ARCHITECTURE.md will apply once the live room exists.

**Tests run**: `npm run lint` and `npm run build` — both pass (docs-only
change; route table unchanged).

**Current build status**: Lint clean, build clean.

**Recommended next task**: Unchanged — Phase 1 (scheduled events) is next.
When Phase 2 (live room) eventually starts, the orientation architecture
decided here should shape the very first component structure, not be
retrofitted after a naive version ships.

---

## 2026-08-06 — Session 4: Live Supabase connection, confirm-route fix, progressive-auth audit

**Goal**: Resolve the local runtime blocker (no Supabase credentials), connect
a real Supabase project end to end, and — before calling the foundation
done — verify the implementation actually matches PRODUCT.md's progressive
authentication model rather than assuming it still does.

**Completed work**:

- Diagnosed a port conflict (an unrelated "Magic Layers" project's dev
  server was holding port 3000); started Virtual Stage on the Next.js
  auto-selected fallback (3001) instead of touching the unrelated process.
  Updated README so it no longer implies port 3000 is guaranteed.
- Walked the user through creating a Supabase project, finding the Project
  URL and anon key (explicitly steering away from `service_role`), and
  scaffolding `.env.local` — filled in everything except the two secret
  values myself, so those never had to pass through chat.
- Caught two false starts before they caused confusion: `.env.local` was
  initially still empty when the user believed it was configured (found by
  checking key-name/value-length only, never printing secrets), and the
  first migration attempt left the `profiles` table not actually created.
  Both were re-verified rather than assumed fixed.
- Verified live Supabase connectivity directly (`/auth/v1/settings`
  returned 200; confirmed `email` auth is enabled) before restarting the
  dev server, and confirmed the original 500 was gone on `/`, `/login`,
  `/signup`.
- **Found and fixed a real bug via the `profiles` table check**: the table
  existed but had no Postgres-level `GRANT` for the `authenticated` role —
  Supabase's SQL Editor doesn't auto-apply the privileges the Table Editor
  UI would have. Added `supabase/migrations/00000000000002_profiles_grants.sql`
  (`grant select, update on public.profiles to authenticated;`), matching
  exactly what the existing RLS policies already declared.
- **Found and fixed a second real bug from reading dev-server logs during
  the user's manual browser smoke test**: the confirmation email link used
  Supabase's PKCE `?code=` style, but `src/app/auth/confirm/route.ts` only
  handled the older `token_hash`+`type` style, so every confirmation click
  landed on `/login?error=confirmation-failed` instead of logging the user
  in directly. The account was still getting confirmed (Supabase does
  that server-side before redirecting to us), so manual login afterward
  worked — masking the bug — but the intended UX (click link → land logged
  in) was broken. Fixed by handling `code` via `exchangeCodeForSession`,
  falling back to the old `verifyOtp` path for any non-PKCE flow.
- User completed the full manual browser smoke test: signup → email
  confirmation → login → logout → login again, all successful.
- **Audited the entire codebase against PRODUCT.md's progressive
  authentication model**, at the user's request, before finalizing this
  milestone rather than assuming the earlier (Session 2) correction still
  held after subsequent changes:
  - Full route surface (`find src/app -type f`): only `/`, `/login`,
    `/signup`, `/auth/confirm` exist. Events, event details, joining as a
    guest, watching, and reactions are Phase 1–3 features (ROADMAP.md) —
    **not yet implemented**, so there was nothing there to audit or break;
    they're already documented as guest-eligible for when they're built.
  - Grepped every `redirect(...)`, `getUser()`, and `auth.uid()` call in
    `src/`: every redirect is either a post-login/post-logout landing
    redirect or part of the confirm-route flow itself — none of them gate
    a page behind authentication. `getUser()` is only used to refresh the
    session (`proxy.ts`) or to decide which buttons the header shows
    (`site-header.tsx`) — never to block rendering.
  - Grepped for `useRouter`/`router.push`/`window.location`: no
    client-side redirect logic exists anywhere.
  - **Conclusion: no violations found.** Nothing needed to change in code.
    The Session 2 correction still holds.
- Updated ROADMAP.md's Phase 0 checklist: "Real Supabase project
  connected" is now checked off, with the verification steps listed.

**Files changed**: `README.md` (port note, from a prior turn), `.env.local`
(not committed — git-ignored, confirmed via `git check-ignore`),
`supabase/migrations/00000000000002_profiles_grants.sql` (new),
`src/app/auth/confirm/route.ts` (PKCE fix), `ROADMAP.md`, `SESSION_LOG.md`,
`CHANGELOG.md`.

**Known issues**:

- None currently open for Phase 0. The two bugs found this session
  (missing grants, missing PKCE handling) are both fixed and were each
  re-verified after the fix (grants: re-checked via PostgREST, going from
  `PGRST205` table-not-found → `42501` permission-denied → fixed;
  confirm route: hot-reloaded and confirmed it no longer crashes on
  missing/invalid codes, though a full live re-click of a real confirmation
  email post-fix was offered to the user but not required to close this
  out, since the fix is a direct application of Supabase's own documented
  pattern).

**Tests run**:

- `npm run lint` — passes.
- `npm run build` — passes, type-checks clean, route table unchanged
  (`/`, `/login`, `/signup`, `/auth/confirm`).
- Live Supabase connectivity verified via direct API calls
  (`/auth/v1/settings`, `/rest/v1/profiles`).
- Full manual browser smoke test by the user: signup, email confirmation,
  login, logout, login again — all successful.
- Codebase-wide grep audit for auth-gating patterns — zero violations.

**Current build status**: Lint clean, build clean, live Supabase project
connected and verified, no known route-protection violations of the
progressive authentication model.

**Recommended next task**: Phase 1 (scheduled events). When building the
`events` table and event list/detail pages, keep them guest-viewable from
the first commit (per ROADMAP.md's per-item guest-eligibility notes) rather
than defaulting to an auth-gated pattern and correcting it later. Also a
good moment to consider setting up the Supabase CLI migration workflow the
user asked about (edit migration locally → commit → apply via CLI → shared
migration history) instead of continuing to hand-paste SQL into the
dashboard, now that a second migration has shown the friction of the manual
approach firsthand.

---

## 2026-08-06 — Session 3: GitHub remote + dev server port fix

*(Logged retroactively while writing up Session 4 — these two small,
back-to-back milestones shipped without a session entry at the time,
against this project's own standing rule. Backfilled from git history
rather than skipped.)*

**Goal**: Establish a GitHub remote and backup for the repository; then fix
a local dev-server annoyance (an unrelated project occupying port 3000).

**Completed work**:

- Confirmed the local repo was clean, created a private GitHub repository
  (`Rapscallion12/project-stage`), added it as `origin`, pushed `main`
  (Git Credential Manager handled auth with no manual token entry needed),
  and verified the push with `git log origin/main` / `git ls-remote`.
- Documented the git workflow in README.md (branching model, commit
  conventions, push/pull steps) for future contributors/sessions.
- Diagnosed `localhost:3000` opening an unrelated "Magic Layers" project
  (identified by its process command line, left untouched since killing it
  wasn't necessary); started Virtual Stage on Next.js's auto-selected
  fallback port (3001) instead.
- Updated README so it points readers at whatever port the terminal
  actually prints rather than hardcoding 3000.

**Files changed**: `README.md` (both commits).

**Tests run**: `npm run lint` before each commit.

**Current build status**: Lint clean. No functional code changed — both
commits were docs/config only.

**Recommended next task**: (superseded by Session 4, logged above.)

---

## 2026-08-06 — Session 2: Progressive authentication correction

**Goal**: Correct a product mistake from Session 1 — authentication had
been built as a mandatory entry gate (landing page's primary CTA led
straight to signup, with no guest path into the product at all). The user
specified a progressive authentication model: guests can fully watch,
react, vote, and view chat with no account; an account is required only for
actions needing persistent identity (mic request, comments, reputation).

**Completed work**:

- Audited the existing auth implementation for anything that assumed every
  visitor must log in. Found: `src/proxy.ts` only refreshes the session and
  never redirects (confirmed clean — no code change needed there); the
  actual violation was `src/components/landing/hero.tsx`, whose only two
  CTAs were "Join the audience" → `/signup` and "Log in" → `/login`, i.e.
  100% of the landing page's primary actions routed through auth.
- Refactored `Hero`: primary CTA now points at an on-page `#how-it-works`
  anchor (no auth required); added a low-key, benefit-framed account prompt
  below it ("No account needed to watch. Create an account to request the
  mic, comment, and start building reputation.") instead of a second
  full-weight auth button.
- Added a guest-access rule and an id anchor to `HowItWorks`
  (`src/components/landing/how-it-works.tsx`) so the new CTA has somewhere
  to land, and so the guest/account split is stated on the page itself, not
  just in docs.
- `SiteHeader`'s login/signup nav links were reviewed and left as-is — a nav
  link is not a gate; a guest can ignore it and use the product fully.
- Rewrote the documentation suite for the new model:
  - **PRODUCT.md**: new "Progressive authentication model" section (guest
    vs. account capability lists, the funnel, required account-prompt tone,
    guest identity limits), new Principle 12, Principle 3 footnoted,
    "Authentication" MVP scope line reworded, Core entities section
    rewritten to distinguish Guest from Account holder.
  - **ARCHITECTURE.md**: Auth flow section rewritten around "gating happens
    at the action, not the route"; new Guest identity section (planned
    cookie-based anonymous session, deliberately outside Supabase Auth);
    new Rate limiting & abuse prevention section (dedup via a DB unique
    constraint, per-identity rate limits, no IP blocking in the MVP); Data
    model section annotated per-table for guest eligibility; Testing &
    Definition of Done gained a "walk it through as a guest" checklist item.
  - **README.md**: new "Design principle: authentication is an upgrade, not
    a gate" section, mirroring the existing responsive-design section.
  - **ROADMAP.md**: every phase item annotated guest-eligible vs.
    **(account-only)**; added a Phase 2 item for the guest session cookie
    mechanism; added a Known gaps entry noting the Hero's CTA is a
    placeholder anchor until Phase 1's event list gives guests somewhere
    real to land.
  - **AGENTS.md**: new rule at the top of the project-specific list —
    authentication is an upgrade, not a gate, with a pointer back to this
    correction so a future session doesn't reintroduce a login wall.
  - **DECISIONS.md**: full ADR for this correction (problem, alternatives,
    decision, two "reason" entries — why progressive auth at all, and why a
    cookie-based guest identity specifically — and tradeoffs).

**Files changed**: `PRODUCT.md`, `ARCHITECTURE.md`, `README.md`,
`ROADMAP.md`, `DECISIONS.md`, `AGENTS.md`, `SESSION_LOG.md` (this entry),
`src/components/landing/hero.tsx`, `src/components/landing/how-it-works.tsx`.

**Known issues**:

- The guest identity mechanism (session cookie, rate limiting, duplicate
  vote/reaction prevention) is a documented design, not implemented code —
  there's no guest-facing write yet for it to protect (that's Phase 3).
  Whoever builds Phase 3 must implement it then, not assume it already
  exists.
- The Hero's primary CTA is an on-page anchor link, not a real guest-join
  flow, because Phase 1 (events) doesn't exist yet. Tracked in ROADMAP.md's
  Known gaps.
- Same live-credentials gap as Session 1: no real Supabase project
  connected in this environment.

**Tests run**:

- `npm run lint` — passes, no warnings.
- `npm run build` — passes, type-checks clean. Route table unchanged from
  Session 1 (`/`, `/login`, `/signup`, `/auth/confirm`), as expected — this
  session changed copy/navigation and documentation, not routes.
- No new automated tests — this was a copy/navigation/documentation
  correction, not new application logic.

**Current build status**: Lint clean, build clean. Same "no live Supabase
credentials" limitation as Session 1 — not a regression.

**Recommended next task**: Unchanged from Session 1's recommendation — get a
real Supabase project connected and smoke-test signup → confirm → login →
logout — but when Phase 1 (scheduled events) starts, build the guest
session cookie mechanism (ARCHITECTURE.md's Guest identity section)
alongside it rather than deferring it further, since Phase 2's audience
viewing and Phase 3's guest voting/reactions both depend on it.

---

## 2026-08-06 — Session 1: Bootstrap, landing page, authentication

**Goal**: Stand up the repository from an empty directory and deliver the
first vertical slice of the MVP (landing page + authentication), per the
project's standing instructions.

**Completed work**:

- Initialized git repo (`main` as default branch).
- Scaffolded Next.js 16 + TypeScript + Tailwind CSS v4 via `create-next-app`
  (worked around the tool's npm-name restriction — see DECISIONS.md — since
  the working directory is `Virtual Stage`, not a valid package name).
- Read Next.js 16's bundled docs (`node_modules/next/dist/docs/`) before
  writing routing/auth code, since the version is newer than training data.
  Found and adopted the Middleware → Proxy rename (`src/proxy.ts`) before it
  could cause a silent bug.
- Installed `@supabase/supabase-js`, `@supabase/ssr`, `zod`, `clsx`,
  `tailwind-merge`. Deliberately did not install LiveKit yet (see
  DECISIONS.md).
- Built the `src/lib/supabase/{client,server}.ts` factories, `src/proxy.ts`
  session refresh, and `src/types/database.ts` (hand-written, mirrors the
  migration until a real Supabase project exists to generate from).
- Wrote `supabase/migrations/00000000000001_profiles.sql`: `profiles`
  table, RLS policies, and an auth-trigger that provisions a profile row on
  signup.
- Built UI primitives (`Button`/`ButtonLink`, `Input`/`Label`), the landing
  page (hero + how-it-works), and full auth flow (signup with email
  confirmation, login, logout, session-aware header) as Server Actions.
- **Mid-session, the user gave a permanent architecture/product
  instruction**: responsive design (desktop and mobile both first-class,
  intentionally designed per screen size, graceful degradation on poor
  networks) is a standing principle, not a per-feature judgment call. Wrote
  it into PRODUCT.md, ARCHITECTURE.md (with a testing/Definition-of-Done
  checklist), README.md, AGENTS.md, and ROADMAP.md; retrofitted the
  already-built landing/auth UI (mobile CTA stacking, 16px inputs to avoid
  iOS auto-zoom-on-focus, 44px minimum touch targets on buttons).
- Wrote the full documentation suite: README, PRODUCT, ARCHITECTURE,
  ROADMAP, DECISIONS, CHANGELOG (this entry's companion).

**Files changed**: this is the initial commit — see `git log` /
`git show --stat` rather than enumerating here, since the whole tree is new.

**Known issues**:

- No live Supabase project — `.env.local` does not exist in this
  environment (no credentials were available). Verified manually: running
  `npm run dev` without it produces a clear, correct error ("Your project's
  URL and Key are required to create a Supabase client!") from
  `src/proxy.ts`, not a silent failure or a crash elsewhere — so the
  failure mode is at least legible for the next session. Auth has **not**
  been exercised end-to-end against a real backend.
- The responsive design principle was adopted partway through this session.
  Landing/auth pages use responsive Tailwind utilities throughout and were
  retrofitted for the specific mobile issues caught on review (see above),
  but have not been walked through the full manual device/network testing
  checklist in ARCHITECTURE.md — no real devices or network throttling
  available in this environment. Flagged in ROADMAP.md Phase 0.

**Tests run**:

- `npm run lint` — passes, no warnings.
- `npm run build` — passes (Next.js 16 + Turbopack), type-checks clean.
- Manual smoke test: started `npm run dev`, confirmed `/` returns HTTP 500
  with the expected "URL and Key are required" Supabase error (proving the
  proxy's error path is reachable and correctly attributed) since no real
  Supabase credentials exist yet; confirmed the build's static/dynamic
  route table looks correct (`/`, `/login`, `/signup`, `/auth/confirm` all
  present, all dynamic due to per-request auth state in the header).
  Stopped the dev server afterward. No automated tests exist yet — none
  were warranted for this UI/plumbing-heavy slice; the first logic worth
  unit-testing (e.g. queue ordering) arrives in Phase 3.

**Current build status**: Lint clean, build clean, app not runnable
end-to-end yet for lack of real Supabase credentials (expected, tracked
above — not a regression to fix next session, just a prerequisite).

**Recommended next task**: Get a real Supabase project connected
(`.env.local` from `.env.local.example`), apply
`supabase/migrations/00000000000001_profiles.sql`, and smoke-test
signup → email confirmation → login → logout end to end before starting
Phase 1 (scheduled events). Then walk the landing/auth pages through the
responsive testing checklist in ARCHITECTURE.md now that real
devices/network throttling are presumably available outside this sandboxed
environment.
