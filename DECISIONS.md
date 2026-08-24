# Decisions

Architecture Decision Record. Newest first. Format: Problem, Alternatives
considered, Decision, Reason, Tradeoffs.

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
