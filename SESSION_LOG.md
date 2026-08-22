# Session Log

Newest entry first.

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
