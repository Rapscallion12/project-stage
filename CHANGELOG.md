# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Dates are session dates, not deploy dates — every push to `main` deploys
automatically (see README.md's Deployment section), so there's no
separate release cadence to track here.

## [Unreleased]

### Changed

- **Compact composer capped to ~40% width in mobile landscape** — it
  previously grew to fill most of the control row before React/Vote/Gift
  (or Mic/Camera/Gift for a speaker), reading as unbalanced. A single
  `landscape:max-w-[40%]` on `ChatPanel`'s compact-mode form fixes both
  Watch Mode and Speaker View at once, since both share this exact
  component — portrait is unaffected. Still `flex-1`/`min-w-0`
  underneath, so it grows/shrinks normally up to that cap rather than
  becoming a fixed size. See DECISIONS.md.

- **Site-wide header now hidden for audience landscape too, not just
  Speaker View** — the header-hiding CSS (previously
  `body.speaker-view-active`, speaker-only) is broadened into
  `body.mobile-landscape-live-active`, toggled whenever
  `MobileLandscapeRoom` (audience or speaker branch) is the actual
  composition rendering, regardless of role. One class/rule instead of
  two near-duplicates. Portrait (either role), desktop, and landscape
  outside the live room are all unaffected — the condition can only be
  true for the live room's mobile landscape composition specifically.
  See DECISIONS.md.

- **Audience landscape rebuilt onto "05 — Social Stage" (issue #21)** —
  rotating to landscape as an audience member no longer falls back to
  the legacy interface (`RoomHeader`'s full status bar, the centered
  "💬 Comments" toggle, `RoomChatPanel`). `MobileLandscapeRoom`'s
  audience/candidate branch now reuses the *exact* components portrait
  Watch Mode and Speaker View already use — `SpeakerViewTopChrome`,
  `AmbientComments`, `WatchModeControls` wrapping the compact
  `ChatPanel` — with the only genuine difference being `SpeakerStage`'s
  own `orientation="landscape"` (side-by-side tiles, two-speaker
  audience viewing unchanged). React/Vote/Gift remain exactly as inert
  as before; no reactions/voting/gifting behavior added. Portrait Watch
  Mode and the working Speaker Landscape composition are untouched.
  `useCommentsMode` (and its test) deleted outright — nothing referenced
  it once this landed. See DECISIONS.md.

- **Speaker View (issue #18) UI cleanup: one control row, not two** —
  mic/camera toggles moved out of `SpeakerControlBar`'s own floating row
  and into the persistent bottom row (`WatchModeControls`' new
  `micCameraSlot`), replacing React/Vote in that row for a seated speaker
  (Gift stays). Same toggle logic, relocated via a new
  `SpeakerMediaToggles` component, not reimplemented.
  `SpeakerControlBar` is back to just "Leave the stage." `AmbientComments`
  now clears Speaker View's taller control-region footprint
  (`bottom-32`, up from the shared `bottom-16` it previously — incorrectly
  — reused from Watch Mode) and the bottom overlay adds safe-area-aware
  padding for the iPhone home-indicator region. `SpeakerViewTopChrome`
  now reserves `SelfPreview`'s own responsive footprint via
  `pr-20 sm:pr-24` (mirroring `MobileLandscapeRoom`'s own header overlay,
  which already solved this same problem), with `min-w-0 flex-1` so the
  status pill actually shrinks under that budget instead of overflowing
  into it. Ordinary Watch Mode is unaffected — all of this is
  Speaker-View-specific. See DECISIONS.md.

### Added

- **Speaker View (issue #18): live microphone/camera mute toggles** — the
  remaining half of the original plan's Phase 3 (leave-stage already
  shipped). `SpeakerControlBar` gained two toggle buttons alongside
  "Leave the stage," calling new `toggleMicrophone`/`toggleCamera` on
  `useLiveRoomConnection`. Implemented via `LocalTrack.mute()`/`.unmute()`
  on the already-published track, never `setMicrophoneEnabled`/
  `setCameraEnabled` — those would stop and reacquire the underlying
  hardware track (a real `getUserMedia` call, not guaranteed to succeed
  without a fresh gesture on iOS Safari). Buttons disable when nothing is
  actually publishing yet (`canPublish && !needsMediaActivation`). See
  DECISIONS.md.

- **Speaker View (issue #18) Phase 2: Leave the stage, commenting,
  ambient comments** — a seated speaker can now leave voluntarily via a
  new `SpeakerControlBar` pill, reusing the *same* `leaveSpeakerSeat`
  Server Action `RoomControls` already uses (no new mutation path). The
  compact `ChatPanel` composer and `AmbientComments` are both restored
  in Speaker View (portrait and landscape), reusing the exact components
  Watch Mode already uses, positioned the same way. `ChatPanel` gained
  one new prop, `allowMicRequest` (default `true`, no existing caller
  affected) — `false` hides the 🎙 request-to-speak toggle entirely,
  since a seated speaker already holds the seat a request would be for.
  React/Vote/Gift remain inert. `SpeakerMediaActivationPrompt` moved from
  the bottom edge to vertically centered, to stay clear of the new
  bottom row. See DECISIONS.md.

- **Speaker View (issue #18) Phase 1: full-bleed remote speaker, portrait
  and landscape** — when the viewer holds a seat, both `PortraitRoom` and
  `MobileLandscapeRoom` now route to a dedicated Speaker View composition
  instead of their ordinary audience content: the *other* speaker's video
  fills the entire stage (no divider, no equal-sized tile for the
  viewer's own seat), while the viewer's own camera stays in the existing
  floating `SelfPreview` corner, reused unchanged. `SpeakerStage` gained
  one new optional prop, `soloMode` (default `false`, every existing
  caller unaffected), reusing its existing per-tile rendering logic
  rather than a new stage implementation — an empty other seat still
  shows the ordinary "Seat open" placeholder, no separate "waiting for a
  partner" UI. Rotating between portrait and landscape while seated no
  longer reverts to the old audience-like split-stage composition.
  Desktop is untouched. Deliberately not yet included, per the approved
  phased plan: `SpeakerControlBar` (mic/camera toggles, leave-the-stage),
  the speaker composer, and ambient comments — a seated speaker currently
  has no in-UI way to leave the stage; closing the tab still releases the
  seat via the existing disconnect webhook. See DECISIONS.md.

### Changed

- **Speaker View, landscape: the site-wide header is now hidden (not just
  shrunk) in short landscape viewports while actively speaking** —
  Speaker View's landscape composition has no sidebar/chat competing for
  space the way the audience composition does, so the site header was
  proportionally the largest remaining non-video element. A new
  `speaker-view-active` body class (tracks `isSpeaker`, gated behind the
  same landscape+short-height media query the existing `room-active`
  padding compaction already uses) hides it outright. Ordinary audience
  landscape is unaffected — it keeps its existing padding-only
  compaction. See DECISIONS.md.

### Fixed

- **`handleTapEmptySeat` hardened with its own `isSpeaker` guard** — it
  previously trusted `SpeakerStage`'s independently-re-derived
  `viewerIsSpeaking` check to be the only thing preventing a seated
  speaker from ever reaching it, with no guard of its own. Closed the
  gap at the source: an already-seated identity now short-circuits
  before `prepareLocalMedia()` (which, for an already-published speaker,
  would **not** have been a no-op — it would have acquired a second,
  unpublished track and pointed `localVideoTrack` at it) or `joinOpenSeat`
  (already separately rejected server-side) are ever called. Could not
  conclusively reproduce the exact real-device symptom from static
  analysis — every path traced was already inert or already guarded — so
  this is reported as a defense-in-depth fix, not a confirmed root
  cause. See DECISIONS.md.

- **Investigated auto-restoring camera/mic on a fresh, still-seated
  mount — not implemented, kept the existing button.** Camera/mic
  *permission* persists across navigation, but Safari's requirement that
  `getUserMedia()` run inside an active user gesture does not — this
  project's own prior real-device finding already established that
  requirement holds independently of whether permission was previously
  granted, and only resets once per fresh page/hook-instance lifecycle
  (exactly the scenario here). Auto-calling `prepareLocalMedia()` on
  mount would violate an invariant documented elsewhere as absolute, with
  a real, previously-proven risk of silently reproducing the original
  "camera/mic never activates" bug and no reliable way to detect failure
  in advance. See DECISIONS.md.

- **Speaker View had no way to re-enable camera/mic after navigating away
  and back** — a fresh `useLiveRoomConnection` instance (any real route
  remount, e.g. leaving via the site header link and returning while
  still entitled to the seat) always needs one gesture-triggered
  `activateMedia()` call before it auto-publishes, by design — but
  neither `PortraitSpeakerView` nor `MobileLandscapeSpeakerView` rendered
  any control that could trigger it (`SpeakerStage`'s `soloMode` never
  shows the viewer's own tile, where that affordance normally lives, and
  neither view renders `RoomControls`). Not just cosmetic — camera/mic
  were never actually republished, so the *other* participant kept
  seeing "Camera off" too. New shared `SpeakerMediaActivationPrompt`
  (visible only when needed) calls the exact same `activateMedia` already
  wired through both views — no new acquisition logic. Confirmed, not
  assumed: seat-vacate-on-navigation itself is already the intended,
  already-documented lifecycle (the existing LiveKit-webhook disconnect
  path) — unchanged by this fix. See DECISIONS.md.

- **Self-preview actually disappeared after committing a guest-name edit
  while seated — traced to a real LiveKit reconnect, not a CSS issue.**
  A previous pass fixed two real but unrelated defects (a corner overlap
  with the guest-name chip, a reintroduced iOS-zoom bug) that didn't
  actually explain the symptom. The real cause: editing the name sets a
  cookie inside a Server Action, which — per Next.js's own documented
  behavior — re-renders the current page's Server Components, re-running
  `getLiveKitToken` and minting a fresh (but permission-equivalent) JWT.
  `useLiveRoomConnection`'s connect effect depended on that token's exact
  string value, so a refreshed token — even while already connected —
  tore down and reconnected the entire LiveKit `Room` (a real disconnect
  visible to the other participant too), reacquired camera/mic via
  `setCameraEnabled`/`setMicrophoneEnabled`, and never restored
  `localVideoTrack` afterward, permanently hiding the self-preview. Fixed
  by depending on the token's *presence*, not its value — a token
  refreshed for reasons unrelated to permissions was never supposed to
  be a reconnect signal (this project's own LiveKit authorization model
  already documents permission changes as a live push, not a
  reconnect). See DECISIONS.md.

- **Self-preview appeared to disappear after editing the guest-name chip
  in Speaker View** — two real, independent causes, both from Phase 1's
  top chrome copying Watch Mode's layout without accounting for
  `SelfPreview` always being present in Speaker View: (1) the guest-name
  chip was positioned in `SelfPreview`'s own fixed top-right corner; (2)
  `GuestNameEditor`'s edit `<Input>` carried an explicit `text-sm` that
  silently overrode `<Input>`'s own iOS-Safari-auto-zoom-on-focus fix —
  the same zoom bug already fixed once for the Watch Mode composer,
  reintroduced here. Fixed both directly: a new shared
  `SpeakerViewTopChrome` keeps the status pill and guest chip anchored
  together on the left, away from `SelfPreview`'s corner, in every
  Speaker View composition; `GuestNameEditor` no longer sets any
  font-size class on its edit input, in either variant. Real but not the
  actual cause of the persisting bug — see the entry above. See
  DECISIONS.md.

- **"05 — Social Stage" Phase 3: ambient live comments in mobile
  portrait Watch Mode** — the room's live chat stream now surfaces as a
  small, self-expiring stack of translucent bubbles in the stage's
  lower-left, instead of being invisible until Discussion Expanded
  exists. New `AmbientComments` component reuses the *same*
  `messages`/`useLobbyRealtime` stream every other room composition
  already reads — no second comment backend, no duplicated message
  state. Seeded from the last 3 messages already present at mount (a
  viewer arriving mid-conversation sees the room is inhabited
  immediately, not a blank corner); each message gets a single ~7s
  fade-in/hold/fade-out lifecycle (`ambient-comment-fade` keyframe,
  `globals.css`) the first time it's seen, tracked independently of the
  underlying data's own permanence; a burst evicts the oldest visible
  bubble immediately rather than growing past 3 at once. Own
  Request-to-Speak comments reuse the existing 🎙 badge treatment. Each
  bubble carries a stable `data-message-id` — a deliberate seam for a
  later Discussion Expanded tap handler, not implemented yet (no
  `onClick`). Positioned as an absolutely-positioned overlay (`bottom-16
  left-3`, click-through outside the bubbles themselves, matching the
  room's existing pointer-events pattern) — reserves no layout space and
  never resizes/reflows the video underneath it. See DECISIONS.md.

### Fixed

- **Focusing the compact Watch Mode composer triggered iOS Safari's
  auto-zoom-on-focus** — its raw `<input>` used `text-sm` (14px,
  confirmed via project config — Tailwind's stock scale, no overrides
  exist), under Safari's 16px threshold. Verified no compounding cause
  first (no `transform`/`scale`/`zoom` anywhere in the room tree, no
  app-level `scrollIntoView`/`visualViewport` code anywhere in the
  codebase) before fixing: `text-sm` → `text-base`, matching the
  existing convention the shared `<Input>` component already
  documents. Same input renders for both mic-off and mic-on states, so
  one change fixes both. No global viewport restriction added.

- **Stale "Request to speak is pending" UI after leaving the stage** —
  a granted request that got claimed (`claimOpenSeat`) never told the
  client its `hasPendingRequest` flag was now stale; leaving the stage
  afterward resurrected the old pending-request UI for a request that
  no longer existed. Root-caused and fixed in `useAutomaticPromotion`
  (clears the flag on a successful claim) and `withdrawSpeakerRequest`/
  `withdrawSpeakerRequestAsGuest` (treat "no pending request found" as
  success, not a thrown error, matching what "Withdraw" should do when
  there's genuinely nothing left to withdraw).
- **Bottom control row (composer + React/Vote/Gift) could clip the
  rightmost emblem on narrow phones** — a broken flexbox `min-width`
  shrink chain, not an actual width shortage; fixed by adding `min-w-0`
  at every nested flex level between the row and the composer's input.

### Changed

- **Compact pending-request feedback** — `RoomControls`' two
  `hasPendingRequest` states render as a single-line "🎙 Request sent ·
  Cancel" pill in Watch Mode instead of the original paragraph+button
  block, which real-device testing found occupied too much of the
  video. Same information, same action; `isSpeaker`/Leave-the-stage
  unaffected.
- **Request-to-Speak composer placeholder shortened** to "What's your
  topic?" (was truncating on narrower phones) — compact mode only; the
  full `ChatPanel` keeps its original text.

- **"05 — Social Stage" Phase 2: the persistent Watch Mode composer is
  now functional** — real sending, real Request-to-Speak, reusing
  `ChatPanel`'s existing actions/gesture-safety logic verbatim via a
  new opt-in `compact` prop (message list and quick-emoji row hidden,
  form re-styled as a small glass pill) rather than duplicating any of
  it. `WatchModeControls` gained a `composer` slot for this.
  Mic-on state tints the pill/mic-icon accent-colored without changing
  size. React/Vote/Gift remain inert; no ambient comments, Discussion
  Expanded, reactions, or voting/gifting yet. See DECISIONS.md.

- **`PortraitRoom` rebuilt for the approved "05 — Social Stage" model,
  Phase 1 of 7 (static shell only)** — video-first Watch Mode replaces
  the tap-toggle Watch Mode / Comments Mode split entirely (not
  alongside it). `RoomHeader` replaced by a minimal top-chrome status
  pill + guest-identity chip; `SpeakerTile`'s name label moved from a
  bottom gradient bar to a lightweight top-anchored dot+name in
  portrait (landscape unchanged — its own header overlay would collide
  with the new style); new `WatchModeControls` renders the persistent
  composer + React/Vote/Gift emblems, all `disabled` in this phase.
  `StageOverlayShell` gained an opt-in `gradient={false}` and
  `GuestNameEditor` gained an opt-in `variant="chip"` — both additive,
  every existing caller unaffected. Commenting/reading are temporarily
  unavailable on this feature branch until Phases 2/4 restore them —
  not merged to `main` yet. See DECISIONS.md for the full architecture
  survey and 7-phase plan this begins.

### Fixed

- **`GuestNameEditor` no longer gets stuck in editing mode after tapping
  away** — the editor only ever exited editing mode from its own form's
  `onSubmit`; tapping Comments, a speaker tile, the stage, or dismissing
  the on-screen keyboard never called anything, leaving it visually
  open. Now commits on `blur` (the one event every "tap outside"
  interaction already produces), with Enter/Done routed through the same
  path (`onSubmit` now just blurs the input rather than saving
  independently) so there's one commit path, not two. `<Input>` gained
  `forwardRef` support (purely additive) so the editor can blur its own
  input imperatively. Existing empty-name validation/fallback is
  unchanged. This is a status confirmation, not a design change: the
  tap-based Watch Mode / Comments Mode states themselves passed
  real-device verification on iPhone portrait and landscape this same
  pass and are now the stable interaction foundation the Figma-assisted
  redesign builds on. See DECISIONS.md.

### Changed

- **Comments gesture retired; Watch Mode / Comments Mode rebuilt as a
  plain tap toggle** — a second real-device pass found the room-level
  drag gesture below produced no meaningful transition on an actual
  iPhone, and, independently, that neither orientation actually hid the
  chat panel at rest: landscape only shortened it (still always mounted,
  96px↔160px), and portrait had never received any of this issue's work
  at all, still showing a fixed `h-40` panel from issue #20. Deleted
  `use-comments-focus.ts` outright and replaced it with
  `use-comments-mode.ts` — a plain boolean (`open`/`openComments`/
  `closeComments`), no drag tracking, no `progress`, no pointer handlers.
  Both `MobileLandscapeRoom` and `PortraitRoom` (built from scratch for
  portrait) now share this hook: **Watch Mode** renders no chat panel in
  the DOM at all (not shortened — absent) plus a compact `💬 Comments`
  toggle; **Comments Mode** mounts the existing, unchanged chat/composer
  UI and darkens the stage scrim to a constant opacity. `chat-panel.tsx`'s
  `data-gesture-ignore`/`touch-pan-y` markers are gone with the drag they
  existed to exempt the message list from. `DesktopRoom` untouched.
  Video geometry unaffected, same as before — `SpeakerStage` stays a
  sibling of the overlay, never remounted or resized by this toggle. This
  is a deliberate, temporary foundation: the progressive downward-drag
  reveal is deferred, not abandoned, until Watch Mode and Comments Mode
  both have a Figma-defined visual design to transition between — see
  DECISIONS.md's "Future Figma seam" entry.

- **Comments reveal rebuilt as a room-level gesture, not a handle**
  (superseded by the retirement above, kept for history) —
  real-device testing clarified the product intent was described wrong:
  requiring a user to grab a small dedicated handle isn't "the room
  feels naturally vertically navigable." `useCommentsFocus` was
  rewritten (not patched) so its pointer handlers attach to one broad
  DOM ancestor (`MobileLandscapeRoom`'s own stage wrapper) instead of a
  tiny button — a downward drag started from almost anywhere on the
  video/background reveals comments, with `event.target`-based exclusion
  (buttons/links/inputs/the message list, via `data-gesture-ignore`)
  deciding whether a given touch starts the room gesture or is left
  alone for its own control. A single always-present `comments-toggle`
  reaches the exact same state as the gesture — never a second, parallel
  UI. Ownership between "room reveal" and "comment-history scroll" is
  decided by where a touch starts, not motion heuristics; no drag-to-
  close was built once open, only the explicit toggle, per an explicit
  "reliability over cleverness" instruction. Video geometry is still
  completely unaffected — only scrim opacity and the chat wrapper's
  height animate. See DECISIONS.md for the full investigation, including
  the one deliberately-simplified, real-device-unverified piece
  (`preventDefault()`-based scroll suppression instead of a blanket
  `touch-action: none`, which would have also broken the message list's
  own scroll due to CSS's ancestor-intersection rule).

### Fixed

- **Refresh recovery restores a seated speaker's own self-preview** — a
  seated speaker who hard-refreshed and tapped "Enable camera & mic"
  published correctly (every other participant saw/heard them) but their
  own self-preview stayed empty, recoverable only by leaving and
  rejoining. Root cause: the fallback activation path
  (`setCameraEnabled`/`setMicrophoneEnabled`) acquires and publishes in
  one LiveKit call but never sets `localVideoTrack`. `activateMedia()`
  now delegates to the existing `prepareLocalMedia()` — the same
  acquisition path #22 already built — unifying every activation entry
  point onto one mechanism that gets self-preview right. Side effect,
  also fixed: a failed activation attempt used to permanently hide the
  retry button; it now correctly stays available since `mediaActivated`
  only flips true on genuine success. See DECISIONS.md.
- **Comments-focus handle now reveals comments, not the guest-name
  editor** — the drag/tap handle sat above `GuestNameEditor`, with
  `RoomControls` between it and the chat, so the literal thing it
  revealed was low-priority metadata. `GuestNameEditor`/`joinSeatMessage`/
  `RoomControls` now sit above the handle, fixed-size and outside the
  expand/collapse relationship; the handle sits directly against the
  chat wrapper it actually controls. See DECISIONS.md.

### Added

- **Speaker reconnect grace period** — the LiveKit webhook used to evict
  a seat the instant it saw `participant_left`, no grace period, so any
  brief disconnect (not just a refresh) risked losing a seat outright.
  New `useSpeakerReconnectGrace` hook watches every other occupied seat
  for a gap between DB occupancy and LiveKit's live participant list;
  after 25s (tunable) of that gap persisting, calls a new,
  server-re-validated `checkAndEvictDisconnectedSpeaker` action — which
  independently confirms absence via LiveKit's own `RoomServiceClient`
  before calling the same `endSpeakerSeat` the webhook uses, so no
  caller can force an eviction of a still-connected speaker. Reuses
  `useAutomaticPromotion`'s own grace-period pattern rather than a
  second timer system. `SpeakerTile` shows "Speaker reconnecting…"
  instead of the generic "Camera off" for a seat currently watched this
  way. See DECISIONS.md.

### Checkpoints

- **`prototype-responsive-mobile-landscape-stable`** (2026-08-22, commit
  `ff540b0`) — known-good recovery point covering the three-composition
  responsive room split (below), the direct-join media-readiness
  convergence, the open-seat-reachability fix, and the no-duplicate-
  self-video fix — all confirmed working on real devices (iPhone
  portrait, iPhone landscape, desktop) before starting #21's comments-
  focus interaction. See DECISIONS.md.

### Added

- **#21, first slice: comments-focus overlay for mobile landscape,
  video geometry never resizes** — the chat/controls overlay's default
  state is unchanged in size (byte-identical to the prior fixed height)
  but now expands on a tap or drag of a dedicated handle, darkening
  `SpeakerStage`'s own scrim as it does — the scrim itself was already
  built inert by #20, just never driven until now. New
  `useCommentsFocus()` hook (dead-zone + commit-threshold drag math,
  exported as a pure, directly-tested function) owns the gesture; a
  `draggedRef` flag prevents the tap and drag paths from double-toggling
  each other. The gesture handle is a small, dedicated element —
  `touch-action: none`, `setPointerCapture` — never the message list
  itself, so scrolling chat never fights the collapse gesture and normal
  taps elsewhere in the room never trigger it. `RoomHeader` also becomes
  an absolutely-positioned top overlay specific to `MobileLandscapeRoom`,
  reclaiming its document-flow footprint for the stage; `PortraitRoom`
  is completely untouched by this pass. See ARCHITECTURE.md and
  DECISIONS.md.

### Fixed

- **Desktop's two-tile stage no longer gets pathologically narrow right
  at the desktop width threshold** — a real-device finding: a fixed
  320px sidebar left only ~700px for two side-by-side video tiles at
  1024px, cropping video heavily via `object-cover`. One isolated,
  responsive width class (`w-64 xl:w-80`) on `DesktopRoom`'s sidebar —
  narrower only below 1280px, unchanged above it. See DECISIONS.md.

### Changed

- **Three room compositions instead of two: mobile portrait, mobile
  landscape, and desktop are no longer conflated by orientation alone**
  — real-device testing found rotating a phone into landscape landed on
  the same dashboard-style layout (permanent 320px chat sidebar, video
  reduced to a strip, full site header) a desktop browser window also
  got, since `orientation: landscape` matches both. New
  `useIsDesktopViewport()` hook (`min-width: 1024px`, same
  `matchMedia`/`useSyncExternalStore` shape as the existing
  `useOrientation`) adds device-class as an independent axis from
  orientation — deliberately width-based, never `width > height`, so an
  iPhone in landscape stays classified as mobile. `EventRoom` now
  branches three ways: `DesktopRoom` (renamed from `LandscapeRoom`,
  internals otherwise unchanged — its sidebar structure was always
  correct for desktop, just wrongly reachable from mobile too), new
  `MobileLandscapeRoom` (the same video-first/overlay philosophy
  `PortraitRoom` already has, adapted for a wide-short box: side-by-side
  seats, a shorter/more compact chat overlay, a compact room header),
  or `PortraitRoom` (unchanged). `StageOverlayShell` extracted from
  `PortraitRoom`'s overlay markup now that `MobileLandscapeRoom` needed
  the identical click-through-outer/interactive-inner structure. The
  site-wide `SiteHeader` also compacts specifically on a short
  mobile-landscape viewport while inside a room — a `document.body`
  class (`room-active`, toggled by `EventRoom`) plus a
  `(orientation: landscape) and (max-height: 500px)` media query
  (globals.css) do this entirely without converting the header to a
  client component; only padding changes, no navigation is removed. See
  ARCHITECTURE.md and DECISIONS.md.

### Fixed

- **Direct join now acquires media readiness the same way as requesting
  the mic; the open seat can no longer be blocked by chat** — two
  real-device findings from the previous pass. Tapping an uncontested
  open seat (issue #27) now calls the same `prepareLocalMedia()` #22
  already built for the composer's mic-request submit, from the tile's
  own click handler (same Safari gesture requirement) before the
  `joinOpenSeat` call — no new abstraction, both entry points converge
  onto the identical readiness/publish machinery, so a direct-joiner
  gets the same pre-acquired self-preview and publish-without-a-second-
  prompt behavior a composer requester already had. Tracks are
  deliberately preserved (not released) on any join failure. Separately,
  `SpeakerStage` now visually promotes an open seat to the front
  (`order-first`) whenever it's the viewer's one actionable target
  (exactly one seat empty, viewer not already speaking) — pure CSS
  ordering, no seat/track identity change, no remount — and
  `PortraitRoom`'s bottom overlay is split into a click-through outer
  layer and an interactive inner wrapper, so its purely decorative top
  margin no longer swallows taps meant for the stage beneath. Together
  these keep the open seat reachable regardless of chat/controls height,
  without touching seat numbering, LiveKit, or track ownership. See
  DECISIONS.md and SESSION_LOG.md.
- **Speaker's own video no longer duplicated on stage** (issue #22
  dominant-video corrective pass) — real-device testing of the previous
  pass found a promoted speaker's camera rendering twice: once as their
  own large tile in the two-seat grid, again in the persistent corner
  self-preview. `SpeakerTile` now never renders the big video for the
  local participant's own occupied seat (`showBigVideo = hasVideo &&
  !isLocal`) — a neutral "You're live — see your preview in the corner"
  placeholder shows there instead. Presentation-only: the local
  participant's own tile is the only thing affected, on their own
  client only — track publication and what every other participant
  actually sees are untouched, and an audience member's view of both
  real speaker tiles is unaffected. Landscape's dashboard-style drift
  (small horizontal video strip, permanent side-panel chat, full header)
  found during the same test pass is recorded as a constraint for a
  later pass (ARCHITECTURE.md, issue #18), not fixed here. See
  DECISIONS.md and SESSION_LOG.md.

### Added

- **Candidate media readiness + persistent self-preview, promotion
  without reacquiring media** (issue #22, remaining scope) — submitting
  the mic-request composer is now itself the gesture that acquires
  camera/mic (`useLiveRoomConnection`'s new `prepareLocalMedia`, one
  `createLocalTracks({ audio: true, video: true })` call, combined
  permission prompt), instead of waiting for the separate "Tap to enable
  camera & mic" step post-promotion. The acquired tracks are held in a
  ref and exposed as `localVideoTrack`; a new `SelfPreview` component
  renders them into #20's reserved top-right slot — hidden entirely
  (not an empty placeholder) for an ordinary audience member with no
  local media, visually labeled "You", and the *same* component/track
  stays mounted across the whole pending → countdown → published-speaker
  transition, so it's never re-created or reacquired. `applyPublishState`
  now checks for already-held prepared tracks first and calls
  `publishTrack()` on them directly at promotion time — no second
  `getUserMedia()` call, no second permission prompt — falling back to
  the existing `setCameraEnabled`/`setMicrophoneEnabled` gesture-gated
  path unchanged for anyone who never pre-acquired (issue #27's direct
  join). Withdrawing ("Withdraw"/"Cancel", both routed through the same
  `onCancelPromotion`) now also releases any held-but-unpublished tracks
  (`releaseLocalMedia`); leaving the stage after actually publishing is
  unaffected — that already went through the existing
  `canPublish → false` reaction, which now also clears the self-preview.
  Deliberately **no new server-side "ready" field** — readiness is
  represented entirely by whether the client currently holds valid local
  tracks; automatic promotion's own eligibility rule
  (`resolveClaimDecision`) is untouched, and its existing grace-period
  self-eviction is what a promoted-but-unpublishable candidate still
  falls back to, unchanged. A candidate whose acquisition fails sees the
  same specific error copy `RoomControls` already had for a seated
  speaker, now shown while still pending too, with its own "Try again"
  retry action — the existing "Tap to enable camera & mic"/"Enable
  camera & mic" controls are both left in place as the recovery path for
  exactly that failure case and for #27's direct join, neither is
  provably redundant. The larger "make the *other* speaker's video
  dominant once I'm on stage" redesign is explicitly deferred (possibly
  #18), not built here — the self-preview stays the local feed only.
  See DECISIONS.md and SESSION_LOG.md.

### Checkpoints

- **`prototype-auto-promotion-stable`** (2026-08-22, commit `e934619`) —
  known-good recovery point covering everything built since
  `prototype-live-av-stable`: the video-first room shell and its
  divider-layering fix, the permanent always-on test room, direct
  empty-seat join, composer-integrated mic-request mode, and automatic
  server-authorized promotion (no more manual "Claim your seat"). Does
  **not** move or replace `prototype-live-av-stable` — a newer, additional
  tag, not a relocation. Tagged prerelease, at the user's explicit
  request, after production use confirmed this interaction flow works
  well enough to build the next piece (issue #22's remaining scope) on
  top of. See DECISIONS.md and SESSION_LOG.md.
- **`prototype-live-av-stable`** (2026-08-18, commit `397d3ff`) — the
  one item `prototype-mobile-single-device-stable` explicitly left
  unverified: the user personally confirmed real two-device LiveKit
  audio/video working between two real devices connected to the same
  live event. Everything from the first checkpoint still holds
  underneath it. Tagged as a known-good recovery point, not a
  production release; see the GitHub Release marked prerelease. Issues
  #15/#16/#17 remain open — this checkpoint doesn't close them.
- **`prototype-mobile-single-device-stable`** (2026-08-18, commit
  `1e72311`) — the first state of the project the user personally
  confirmed as a stable, usable mobile prototype, verified end to end on
  a real iPhone against the live deployment: landing page, Browse
  Events, discovering a test event through that page, one-tap entry
  into the unified room, chat, reactions, request-the-mic, the full
  guest-speaker request→claim flow, and camera/microphone both
  activating. A real two-device live-media test (another participant
  actually receiving audio/video, and vice versa) is explicitly **not**
  yet verified — see DECISIONS.md. Tagged as a known-good recovery
  point, not a production release; see the GitHub Release marked
  prerelease. Issues #15/#16/#17 remain open — this checkpoint doesn't
  close them.

### Added

- **Automatic server-authorized promotion, manual "Claim your seat"
  removed** (issue #23, narrowed) — a pending requester now sees a
  "You're up next / Going live in N…" countdown once the server
  determines they're eligible, and the actual seat claim happens on its
  own at the end of it. New `checkPromotionEligibility` (room/actions.ts)
  is a read-only counterpart to `claimOpenSeat`, sharing the exact same
  decision via a new `resolveClaimDecision` helper so the two can never
  disagree about what "eligible" means. The countdown itself is
  explicitly not an eligibility mechanism — a pure client-side timer; the
  real claim at the end independently re-validates, unchanged, and a
  stale/lost-race outcome just silently resets to waiting. New
  `useAutomaticPromotion` hook polls while a candidate is waiting (rank
  can shift from reactions on a *different* candidate's request, so
  purely Realtime-on-`event_speakers` would miss real eligibility
  windows) and self-evicts (reusing the existing `leaveSpeakerSeat`) a
  promoted candidate who never activates media within a 30s grace
  period — disconnection was already covered by the existing LiveKit
  webhook. Does not (yet) factor in issue #22's readiness signal —
  camera/mic activation stays on the existing separate gesture-gated
  "Tap to enable camera & mic" step, per explicit instruction to keep
  using the existing authorized path rather than pull #22 in as a
  prerequisite. Not marked Done pending the user's own real-device
  confirmation. See DECISIONS.md and SESSION_LOG.md.

### Fixed

- **Speaker divider bleeding across chat/controls** — root cause:
  `SpeakerStage`'s root was `relative` with no explicit `z-index`, which
  does not establish a CSS stacking context; the divider's own
  `z-index: 10` escaped past it to compete directly against
  `stage-bottom-overlay` (which had none), painting on top regardless of
  DOM order. Fixed by containment (`relative z-0` on the stage's root,
  a real value so it actually creates its own stacking context) rather
  than raising individual foreground controls' z-index to outrank it —
  everything inside the stage, now and whatever #21/#25 add later, is
  permanently contained and can't escape again. `stage-bottom-overlay`
  gets an explicit `z-10` for the same reason, not a value chosen to
  just barely win. The divider's decorative center dot (no function
  until #21/#25) is removed; the bar itself is unchanged. See
  DECISIONS.md.

### Added

- **Speaker-entry friction removed** (issues #22 partial + #27 full) —
  two convergent entry points replace the standalone "Request the mic"
  control entirely, both server-authoritative. Tapping a visibly empty
  seat tile now attempts to join directly (new `joinOpenSeat` action) —
  checks for any pending `speaker_requests` server-side first (never
  trusted from the client) and falls back to the composer's request mode
  if a queue exists, so a bystander can never cut ahead of a real queue;
  reuses `claim_speaker_seat`'s existing race safety
  (`event_speakers_active_seat_uniq`), no new database primitive. The
  chat composer gained a 🎤 toggle switching the same input/button pair
  into speaker-request mode, submitting through the existing
  `requestToSpeak` path (new `submitSpeakerRequest`, a thin
  `useActionState` adapter, no logic duplicated) — `micRequestMode` and
  `hasPendingRequest` are now controlled state lifted to `EventRoom` so
  the composer and an empty-seat tap can both drive them. `RoomControls`
  lost its fourth state (the standalone button + justification form)
  entirely; the "Claim your seat"/"Withdraw" pair for an already-
  contested queue is unchanged (still issue #23's job to automate).
  Camera/mic activation remains a separate second tap once seated (issue
  #15's existing flow, unchanged) — collapsing that into one gesture is
  #22's remaining scope, not done here. Not marked Done pending the
  user's own real-device confirmation. See DECISIONS.md, SESSION_LOG.md,
  and AGENTS.md's new verification-tier rule (added this session after
  repeated automated-pass/real-UX-fail incidents).
- **"Join Live Audience" one-click fast path** (issue #26) — a prominent
  landing-page CTA (not "Join Now," which reads as signup/registration/
  speaker-join) links to `/join`, a plain GET redirect with nothing to
  render: no confirmation screen, no account requirement, exactly one
  tap from the landing page into a room. `findJoinableEvent`
  (`lib/repositories/events.ts`) prefers a joinable room with active
  speakers, falls back to any joinable room (the permanent test room
  guarantees this tier is normally never empty during development), and
  falls back to Browse Events if genuinely nothing is joinable — no
  recommendation/matchmaking/scoring. Lands with the same guest identity
  and audience-by-default state as tapping an `EventCard` does; `/join`
  only chooses which room, never touches mic/camera/seat state. Not
  marked Done pending the user's own real-device confirmation. See
  issue #26 and SESSION_LOG.md.
- **Permanent, always-discoverable test room** — real-device testing
  repeatedly hit "Nothing scheduled right now" on the deployed Browse
  Events page (a dev-harness fixture aged past the list's 2-hour
  visibility cutoff, or a reset deleted it between sessions). Migration
  `00000000000015` adds `events.is_permanent_test` and inserts one
  fixed-id row, "[DEV] Always-On Test Room" — enforced to be at most one
  by a partial unique index, verified directly (a second insert
  correctly raises a unique-constraint violation). `listUpcomingEvents`
  exempts it from the events list's time-based cutoff and sorts it
  first; `scheduled_start` is pinned to migration-apply time and needs
  no special-casing to stay "ready" forever, since `getEventPhase`
  already treats any past `scheduled_start` that way. Both reset paths
  (`scripts/dev-harness.mts`'s `resetHarness`, the `/dev` page's
  `resetDevDemoEvents`) now explicitly exclude it — verified with new
  integration tests against the real linked project. New `clear-sandbox`
  command clears its chat/speaker state without deleting the row. See
  README.md's Development test harness section and DECISIONS.md.
- **Video-first room shell, corrective pass** (issue #20) — the first
  pass (below) shipped a compact-but-still-separate footer below the
  video; real-device testing found that didn't meet the issue's own bar
  ("chat/voting reached by revealing layers over it"). Portrait's
  controls + compact chat strip are now an absolutely-positioned overlay
  anchored to the bottom of the stage, over the video, instead of a
  shrink-0 flex sibling — the stage now gets 100% of the space below the
  header, not ~65–70%. An always-on bottom gradient
  (`bg-gradient-to-t from-black/90 via-black/60 to-transparent`) gives
  the overlaid text legibility — a different, always-on layer from the
  existing `room-scrim`, which stays exactly as built (`opacity-0`,
  inert), still #21's job. New `.stage-overlay` class (`globals.css`)
  re-scopes the theme's color tokens to fixed, dark-appropriate values
  for this subtree only, so `ChatPanel`/`RoomControls`/`Input`/`Button`
  render legibly against video regardless of the visitor's own
  light/dark preference — none of those components changed, they already
  use theme tokens that pick up the re-scoped values via CSS cascade.
  Self-preview slot moved to the top-right (bottom-right now sits under
  the new overlay). Landscape untouched — not what real-device testing
  flagged. Zero gesture/drag logic added, confirming this was #20's gap,
  not #21's. Still in Testing/Review pending another real-device
  confirmation. See DECISIONS.md and SESSION_LOG.md.
- **Video-first room shell** (issue #20) — replaces the room's stacked
  header/speaker-grid/controls/chat blocks with a video-dominant layout:
  `SpeakerStage` now fills essentially all remaining space below the
  header (full-bleed, no `aspect-video` constraint, no gap, no per-tile
  rounding), stacked top/bottom in portrait and side-by-side in
  landscape, with controls and a compact (height-constrained, not
  page-filling) chat strip in a small footer below it — the same
  `ChatPanel` instance used there as before, just visually smaller, so a
  later issue can make it expandable without ever remounting it. Adds
  three inert structural anchors for upcoming issues to attach real
  behavior to: a speaker divider (#25), an empty self-preview slot (#22),
  and a scrim spanning the stage (#21) — `opacity-0`/`pointer-events-none`
  by default, which is load-bearing today, not just a placeholder default:
  without it this layer would block taps on a tile underneath (e.g. issue
  #15's "tap to enable camera & mic" control). `RoomDiagnostics` (issue
  #15's temporary panel) no longer mounts in the normal room UI at all —
  gated behind `isDevToolsAvailable()`, the same guard `/dev` uses —
  verified directly against a real production build/server, not just
  asserted. `EventRoom`'s root containers gained `overflow-hidden`,
  scoped to the room only (`layout.tsx`'s body-level scroll is untouched,
  since other routes still need it). Second of seven issues (#19–#25)
  from the video-first room redesign.
- **Room format seam** (issue #19) — `events.format`, an additive text
  column defaulted and CHECK-constrained to `'main_stage'` (migration
  `00000000000014`), so Main Stage's two-seat/voting/ranking assumptions
  don't become inseparable from "what a room is" once other formats
  (Roulette, Spotlight, Group Stage — documented, not built) exist.
  Existing rows backfilled to `'main_stage'` automatically; constraint
  verified directly against the linked database to actually reject an
  invalid value, not just assumed from the migration text. Exposed on the
  `events` repository's `Event` domain type as a literal union, cast at
  the query boundary the same way `event_speakers.left_reason` already is.
  First of seven issues (#19–#25) from the video-first room redesign — see
  DECISIONS.md and ROADMAP.md's Phase 2.
- **One event URL** (issue #17) — `/events/[id]` is now the entire event
  experience: tapping an event from the list lands directly in it, no
  "Enter Lobby"/"Enter the room" clicks. The same mounted component
  (`EventRoom`, renamed from `LiveRoom`) shows a lightweight countdown
  before the lobby opens, then the full room layout (chat, seat
  placeholders, request-mic control, event status) from `lobby_open`
  onward — the same layout that already existed for the live room, just
  reachable earlier, not a new "waiting room" surface. LiveKit connects
  in place once the event goes live, using the token already fetched at
  page load — no remount, no redirect, no dropped Realtime subscription.
  `/events/[id]/lobby` and `/events/[id]/room` redirect to the unified
  URL for backward compatibility. Claiming a seat (not requesting)
  stays server-enforced to the event's actual start time, since the
  request/claim controls are now reachable before the show technically
  begins. See DECISIONS.md.
- **Guest speaker participation** (issue #16) — an explicit, reversible
  prototype-testing exception (`PROTOTYPE_CONFIG.guestParticipationEnabled`,
  `lib/config.ts`) letting guests request the mic, get promoted, and
  publish camera/mic through the same server-authoritative path an
  account holder already used — no client of any kind can grant itself a
  seat or publish rights. `event_speakers`/`speaker_requests` gained a
  nullable `guest_id` column each, XOR-constrained against `profile_id`
  (migration `00000000000012`). `claim_speaker_seat`/`end_speaker_seat`
  widened in place (still `service_role`-only); `request_to_speak`/
  `withdraw_speaker_request` kept their existing self-service path and
  gained separately-named guest siblings instead. Caught and fixed a
  real, live regression the same session: recreating
  `claim_speaker_seat`/`end_speaker_seat` (required, since their
  parameter list changed) silently reset them to PostgreSQL's
  PUBLIC-execute-by-default, the exact mistake issue #13 already hit
  once — fixed within minutes via a forward migration
  (`00000000000013`), caught by the existing integration test suite
  against the real linked database. See DECISIONS.md.
- **First deployment — Vercel Hobby, live at
  [project-stage-weld.vercel.app](https://project-stage-weld.vercel.app)**.
  GitHub-integrated (every push to `main` auto-deploys, confirmed with a
  real push). `NEXT_PUBLIC_SITE_URL` set explicitly to the stable domain
  rather than left to the code's `VERCEL_URL` fallback, which turned out
  to resolve to a per-deployment hash that changes on every build — would
  have silently shifted auth email links on every push. Supabase Auth's
  Redirect URLs allowlist updated additively (existing localhost entry
  untouched) to accept the new domain. LiveKit wired in for the first
  time against a real public HTTPS URL: credentials added as Vercel env
  vars, and — only possible now that a public URL exists —
  `/api/livekit/webhook` configured in the LiveKit Cloud dashboard, then
  confirmed live (a bogus signature and a missing one both correctly
  return 401 from the deployed URL). `/dev` confirmed 404ing in
  production both immediately after deploy and after a later
  auto-triggered rebuild. See DECISIONS.md for the full reasoning,
  including a real limit worth knowing: Vercel's "Sensitive" env var type
  can't be read back once set, by anyone, which changes how a credential
  like this can be verified (through the deployed app's behavior, never
  by fetching the value back out).
- **`/dev` browser-based usability-testing UI** — create a live demo
  event, open its room, and seat your logged-in account in seat 1 or 2
  without any CLI commands. Complements (doesn't replace) the CLI dev
  harness — the CLI is still how you create a synthetic second speaker's
  account. `notFound()`-gated on `NODE_ENV !== "production"` (reliable
  since Next.js force-sets that for every build/start), with every
  Server Action independently re-checking the same guard, since an
  action's endpoint is reachable regardless of whether its trigger page
  ever rendered. Verified both ways directly: a production
  build/start on a spare port confirms `/dev` 404s while real routes
  stay healthy, and a unit test confirms each action rejects under a
  stubbed `NODE_ENV=production`. No new schema/RLS/RPC/authorization
  path — reuses `claimSpeakerSeat` (issue #13) directly, bypassing issue
  #14's production request-queue gate on purpose, the same bypass the
  CLI harness's `seat` command already established as acceptable for
  testing. The CLI's tagging convention moved to a shared
  `lib/dev-demo.ts` module so the CLI and the UI clean up each other's
  data. Found and fixed a real (reproducible) test-infrastructure bug
  along the way: two independent integration test files sharing that
  tag both ran their own "delete everything tagged" reset, and Vitest's
  default parallel file execution let one delete the other's in-progress
  fixtures — fixed with `fileParallelism: false` in `vitest.config.mts`.
  See DECISIONS.md.
- **Speaker request queue** (issue #14) — the first issue to give
  `claim_speaker_seat` (issue #13) a real production caller, closing the
  loop from request to live seat. Deliberately not a generic waiting-list
  table: a mic request is a chat message
  (`event_chat_messages.is_speaker_request`, a permanent marker) with its
  lifecycle (`pending`/`granted`/`withdrawn`) tracked separately in a new
  `speaker_requests` table that never duplicates the message content —
  this is what lets a future pinned/featured comment surface render the
  same rows through `RoomChatPanel`'s existing `featuredSlot` (issue #3)
  without a schema change. Three new `security definer` functions
  (migration `00000000000011`): `request_to_speak` (self-service,
  **atomic** — the chat message and the request row are created in one
  function call, so a losing concurrent request can never leave an
  orphaned message or an orphaned request row, proven by a live race
  test), `withdraw_speaker_request` (self-service, same shape as issue
  #13's `leave_speaker_seat`), and `rank_pending_speaker_requests`
  (trusted-server-only, ranks by reaction count on the request's message,
  then `profiles.reputation_score` as a tiebreak — currently always `0`
  for everyone, harmless no-op, not a blocker — then recency). Every new
  function explicitly revokes `PUBLIC` execute in its own migration this
  time (the lesson from issue #13's bug), verified directly against
  `pg_proc.proacl`, not just asserted. `claimOpenSeat` (the room's Server
  Action) gates self-service seat-claiming on a pure, unit-tested
  decision (`lib/speaker-queue.ts`'s `decideClaimEligibility`): caller
  has a pending request, a seat is open, and the caller ranks within the
  top 3 eligible requests — an **explicit MVP selection policy, not a
  permanent product rule** (documented at length in `lib/speaker-queue.ts`
  and DECISIONS.md: it solves the "absent top requester blocks the seat
  forever" failure mode without new background-job infrastructure, using
  `claim_speaker_seat`'s existing race-safety as the tiebreak). A
  successful claim pushes `canPublish: true` live
  (`syncPublishPermission`), so publishing starts immediately with no
  reconnect — the first time issues #2, #13, #3, and #14 connect into one
  real end-to-end flow. `RoomControls` gained request/withdraw/claim
  states; guests see the same "Request the mic" button as everyone else,
  with PRODUCT.md's scripted account prompt appearing inline on click,
  never a proactive banner. No dedicated queue screen — a request is just
  a badged message in the existing chat feed.
- **Development test harness** (`scripts/dev-harness.mts`,
  `npm run dev:harness --`) — create/seat/list/reset live test events
  from the command line, without hand-writing SQL or waiting on a
  scheduled start time. Standalone: outside `src/`, never imported by
  application code, no new route/schema/RLS/grant, confirmed absent from
  `npm run build`'s route table. Authenticates with the existing
  `SUPABASE_SERVICE_ROLE_KEY` and drives the same trusted
  `claim_speaker_seat`/`leave_speaker_seat`/`end_speaker_seat`
  primitives issue #13 already built and authorized — not a new
  capability, one more legitimate caller of an existing one. Every
  resource it creates is tagged (`[dev-harness] ` title prefix for
  events, the reserved `@dev-harness.invalid` domain for auto-created
  throwaway accounts) so `reset` can only ever delete what the harness
  itself made; seating your own real account is safe by construction,
  since `seat` refuses to auto-create an account for any email that
  isn't already a real profile and isn't harness-tagged. Requires Node
  22.6+ (native `--env-file`/`--experimental-strip-types`, no new
  dependency) — documented in README.md along with full usage.
  `tsconfig.json` gained `allowImportingTsExtensions: true` (safe given
  `noEmit: true` was already set) so the harness's own test file can
  import it. See DECISIONS.md for the full design and the end-to-end
  safety-boundary test (`scripts/dev-harness.test.ts`) that proves
  `reset` leaves untagged events/accounts completely untouched.
- **Two-speaker live room UI** (issue #3) — `livekit-client` installed,
  `src/app/events/[id]/room/page.tsx` + `components/room/` (`live-room.tsx`,
  `portrait-room.tsx`/`landscape-room.tsx`, `speaker-stage.tsx`/
  `speaker-tile.tsx`, `room-header.tsx`, `room-controls.tsx`,
  `room-chat-panel.tsx`). Current speakers render entirely from
  `event_speakers` (via a new `hooks/use-active-speakers.ts`, Realtime-
  subscribed — migration `00000000000010` adds the table to the
  `supabase_realtime` publication), never from LiveKit's own
  participant/track state — an explicit correction made mid-design; see
  DECISIONS.md. `event_speakers` also gained a `display_name` column
  (same migration), a denormalized snapshot of `profiles.display_name`
  written by `claim_speaker_seat` itself, so guests (who can't read
  `profiles` under RLS) can still see who's speaking. An occupied seat
  with no available video renders a named "camera off" placeholder; an
  empty seat renders an intentional "Seat open" placeholder — never
  blank either way. Explicit room status ("Waiting for speakers" /
  "Selecting next speaker" / "Live", `lib/room-status.ts`) derived purely
  from active-speaker count. `hooks/use-live-room-connection.ts` owns the
  LiveKit `Room` connection and auto-publishes camera/mic whenever the
  server-issued token's `canPublish` is true — on connect, and again live
  on every permission change pushed by issue #13's `syncPublishPermission`
  — so a participant with `canPublish: false` never has a code path that
  attempts to publish, and a participant who loses `canPublish` while
  connected stops immediately. `hooks/use-orientation.ts` (portrait/
  landscape via `matchMedia`, `useSyncExternalStore`) selects between the
  two layouts in a component that renders unconditionally above them, so
  rotation never remounts the LiveKit connection, chat subscription, or
  speaker roster. The lobby's "ready" phase banner now links into the
  room instead of showing a "not open yet" placeholder. `RoomChatPanel`
  reserves a `featuredSlot` prop (always `undefined` today) so a future
  pinned/expandable Featured Comments section is an addition, not a
  layout restructure. `RoomControls` ships exactly one control — "Leave
  the stage," issue #13's `leaveSpeakerSeat` action getting its first
  caller; manual mic/camera mute toggles were deliberately left out of
  scope.
- Building this surfaced and fixed two shared test-infrastructure gaps,
  not product bugs: React Testing Library's DOM wasn't being cleaned up
  between tests (`vitest.setup.ts` now calls `cleanup()` in `afterEach`
  — this project's first component-rendering tests are what surfaced
  it), and a first draft of `useOrientation` set state synchronously
  inside `useEffect` (rewritten to `useSyncExternalStore`, the same
  pattern `useNow` already established). See DECISIONS.md.
- **GitHub Issues + a Project (Kanban) board** as the visible planning
  layer: Backlog → Ready → In Progress → Testing / Review → Done. 12
  initial issues covering Phase 2 (the live room, broken into a
  dependency-ordered chain) and outstanding backlog items. Documented in
  AGENTS.md and a new "Project management" section in README.md.
- **Supabase CLI migration workflow**, replacing hand-pasting SQL into the
  dashboard: installed as a project-local dev dependency, linked to the
  live project. `src/types/database.ts` is now generated
  (`supabase gen types typescript --linked`) instead of hand-maintained.
  New migration (`00000000000004_table_comments.sql`, schema-level
  documentation) applied end-to-end via `supabase db push --linked` as
  proof the forward workflow works. Full setup and day-to-day commands
  documented in README.md and ARCHITECTURE.md's new Migration workflow
  section.
- **`event_speakers` table** (issue #1, migration `00000000000005`) —
  append-only occupancy episodes (who occupied which seat, when, and why
  they left), not a scheduled-speaker table or a mutable "current
  speaker" pointer — see DECISIONS.md for why both alternatives were
  rejected. Account-only, room-agnostic (matching `events`' own
  precedent), publicly readable, no write grant yet (deferred to issue
  #13's write-path issue by design — see below). `left_reason` is a
  `CHECK`-constrained vocabulary, not free text. `lib/repositories/event-speakers.ts`
  ships the read path (`listActiveSpeakers`); a committed regression test
  verifies both that reads work and that writes are actually rejected by
  RLS (`42501`), against the real linked project.
- First integration-style tests against the live Supabase project
  (`event-speakers.test.ts`) — skip gracefully if `.env.local` isn't
  configured rather than hard-failing. Vitest now loads `.env.local` for
  tests that need real credentials.
- **LiveKit token minting** (issue #2, `lib/livekit/token.ts` +
  `getLiveKitToken` Server Action) — server-authoritative, read-only:
  mints a scoped JWT from *current* `event_speakers` occupancy, never
  from anything the client sends. Guests always come back
  `canPublish: false` (structurally — `event_speakers` is account-only).
  Namespaced participant identities (`guest:<id>` / `profile:<id>`),
  room naming (`event:<event_id>:main`, multi-room-ready), and a
  generous token TTL (expiry is deliberately not the revocation
  mechanism — see ARCHITECTURE.md's LiveKit authorization model for what
  is). The atomic seat-assignment write path, live permission sync, and
  disconnect cleanup are split into a new issue (#13) rather than bundled
  here — see DECISIONS.md for why.
- **Speaker seat state transitions** (issue #13, migration
  `00000000000006`) — the write path `event_speakers` didn't have until
  now, as three `security definer` Postgres functions with three
  different authorization models rather than one generic "update a seat":
  `leave_speaker_seat` (self-service voluntary leave, `auth.uid()`-gated,
  granted to `authenticated`), and `claim_speaker_seat`/`end_speaker_seat`
  (atomic assignment/replacement and reason-coded ending of someone else's
  occupancy — deliberately **not** granted to `anon`/`authenticated`,
  callable only via a new `service_role` client, `lib/supabase/service.ts`
  — the first use of `service_role` in this project; see DECISIONS.md for
  why granting these broadly would let any authenticated user seize the
  microphone at will, and why `service_role` was judged the right
  trusted-server mechanism over a hand-rolled alternative). A second
  partial unique index (`event_speakers_active_profile_uniq`) now stops
  one profile from holding two seats in the same event at once — a real
  gap issue #1's schema had. `lib/livekit/permissions.ts`'s
  `syncPublishPermission()` pushes `canPublish` changes live to an
  already-connected participant via `RoomServiceClient.updateParticipant()`
  (best-effort — `mintLiveKitToken` is the eventual-consistency fallback
  if it fails). A new LiveKit webhook route
  (`src/app/api/livekit/webhook/route.ts`) verifies LiveKit's webhook
  signature and ends a disconnected participant's occupancy
  (`left_reason: 'disconnected'`), fixing the "stuck seat" problem — no
  live permission push follows since there's no connected participant
  left to push to. `claim_speaker_seat` has no production caller yet by
  design (Phase 3's queue/voting is what will decide who's allowed to call
  it); integration tests exercise it directly, and skip gracefully
  (`describe.skipIf`) without `SUPABASE_SERVICE_ROLE_KEY` configured.
  Running those tests for real caught three genuine bugs, each fixed as
  its own forward migration rather than editing `00000000000006` in
  place: `service_role` had no table grants at all in this project
  (`00000000000007`); `claim_speaker_seat`/`end_speaker_seat` were
  actually callable by anyone, because PostgreSQL grants `EXECUTE` to
  `PUBLIC` by default and migration `00000000000006` never revoked it
  (`00000000000008` — the exact exposure the user's constraint on this
  issue set out to prevent, caught by the test written to prove that
  constraint held); and `end_speaker_seat`'s no-op case returned a
  garbage all-null object instead of `NULL` (`00000000000009`, plus a
  matching fix in `endSpeakerSeat()` for how PostgREST serializes a
  composite-returning function's `NULL`). See DECISIONS.md for the full
  writeup of all three.
- `livekit-server-sdk` installed (server-side only; `livekit-client`
  deferred to issue #3, the first thing that actually connects to a
  room). New Vitest environment-override pattern documented
  (`// @vitest-environment node`) for tests needing real Node WebCrypto,
  which jsdom's shimmed crypto breaks for JWT signing.

- Project bootstrap: Next.js 16 (App Router) + TypeScript + Tailwind CSS v4,
  scaffolded via `create-next-app`.
- Full documentation suite: README, PRODUCT, ARCHITECTURE, ROADMAP,
  DECISIONS, CHANGELOG, SESSION_LOG.
- Supabase integration plumbing: browser client, server client, and a
  session-refresh proxy (`src/proxy.ts` — Next.js 16 renamed Middleware to
  Proxy).
- `profiles` table migration with RLS policies and an auto-provisioning
  trigger on new `auth.users` rows.
- Landing page (hero + "how it works" section reflecting the product
  principles).
- Authentication: sign up (with email confirmation), log in, log out, all
  as Server Actions using `useActionState` for pending/error UI.
- Responsive design established as a permanent, first-class product
  principle (desktop and mobile both intentionally designed, not one
  stretched/compressed into the other), documented in PRODUCT.md,
  ARCHITECTURE.md, README.md, AGENTS.md, and ROADMAP.md, and applied to the
  UI primitives and landing/auth pages built this session (16px form inputs
  to avoid iOS auto-zoom, 44px minimum touch targets, mobile-first CTA
  stacking).
- **Scheduled events and the pre-show lobby** (Phase 1): `events`,
  `event_chat_messages`, `event_chat_message_reactions` tables (RLS +
  explicit grants + Realtime publication); event list and detail pages
  with a computed (not stored) countdown/phase; a pre-show lobby with live
  text chat, native emoji + quick-emoji buttons, insert-only upvote
  reactions, and live attendee count via Realtime Presence — all
  guest-accessible, no account required. Guest identity is now
  implemented for real (a `vs_guest_id` cookie minted in `src/proxy.ts`,
  `resolveIdentity()` in `lib/identity.ts`, a deterministic "Adjective
  Animal" guest name, renameable). GIF support and image uploads in chat
  are deliberately deferred as documented fast-follows (ROADMAP.md) — both
  were conditional in the original request and would have added meaningful
  new-dependency scope (an external GIF API, a Storage bucket + moderation
  review) beyond what that milestone's Definition of Done required.
- First test in the project: Vitest + React Testing Library + jsdom
  (`npm test`), added specifically to regression-test the update-depth
  bug described below.

### Changed

- **Authentication is now a progressive upgrade, not an entry gate.**
  Corrected a Session 1 mistake: the landing page's only calls to action
  previously routed every visitor through signup/login. The hero's primary
  CTA no longer requires an account; account creation is now presented as
  an optional, benefit-framed upgrade ("Create an account to request the
  mic, comment, and start building reputation"), surfaced without blocking
  the guest experience. Full guest/account capability split, the intended
  funnel, and the account-prompt tone are documented in PRODUCT.md's new
  Progressive authentication model section; the guest identity mechanism
  (anonymous session cookie, rate limiting, duplicate-vote prevention) is
  designed in ARCHITECTURE.md, pending Phase 3 implementation.
- **Durable data access is now centralized behind `lib/repositories/`**,
  not scattered `createClient().from(...)` calls in pages/actions —
  Supabase is today's backend, not a permanent commitment (see
  ARCHITECTURE.md's new "Vendor portability" section). Auth and Realtime
  remain direct, documented exceptions. Refactored the events/lobby
  feature into this shape before it was ever committed.

### Fixed

- **Camera and microphone never activated for a seated speaker on real
  iPhone Safari** (issue #15) — found via hands-on testing of the deployed
  app. Root cause: `useLiveRoomConnection` called
  `setMicrophoneEnabled`/`setCameraEnabled` from LiveKit's async
  `RoomEvent.Connected`/`ParticipantPermissionsChanged` callbacks, never
  from a real user tap; Safari silently refuses to even show the
  permission prompt for a `getUserMedia` call outside a gesture's call
  stack. A second bug compounded it: the hook already computed a
  `mediaError` value that nothing in the UI ever read. Fixed by requiring
  an explicit "Enable camera & mic" tap (`RoomControls`, calling the
  hook's new `activateMedia()` directly from `onClick`) for the *first*
  activation only — subsequent server-driven `canPublish` changes still
  resync automatically, since browser media permission persists for the
  rest of the tab's session once granted — and by classifying/surfacing
  `getUserMedia` failures via their `DOMException.name` (permission
  denied / no device / device unavailable / init failed) instead of a
  generic silent placeholder. See DECISIONS.md.
- **Project board Status field left stale after closing an issue.**
  Closing a GitHub issue via `closes #N` in a commit message closes the
  *issue*; it never touched the Project board's custom Status
  single-select field, a separate piece of state. Issues #13 and #3 had
  both been merged and closed for a while but still showed
  `Status: Backlog` on the board. Found while reviewing the board before
  starting issue #14 (the user asked whether #4/#5 were already
  satisfied by #3 — checking that surfaced this too). Fixed retroactively
  for #13, #3, and the newly-closed #4/#5; treating the board Status
  update as its own explicit step going forward, not something
  `closes #N` handles. See DECISIONS.md.
- **"Maximum update depth exceeded" crash entering an event lobby.**
  `src/hooks/use-now.ts`'s `useSyncExternalStore` call returned
  `Date.now()` directly from `getSnapshot()`, which changes on nearly
  every call — violating the hook's contract that `getSnapshot()` must be
  stable between calls unless the store actually changed, which made React
  perceive a change on almost every internal consistency check and loop
  re-rendering. Fixed by caching the clock value and only updating it when
  the subscribed interval actually fires. Reproduced deterministically
  with a new regression test before fixing (`src/hooks/use-now.test.tsx`)
  — see DECISIONS.md and SESSION_LOG.md for the full investigation.
- `src/types/database.ts` was missing `Relationships: []` per table and
  top-level `Views`/`Functions` keys, silently typing every Supabase query
  result as `never` with no error explaining why — a latent bug since the
  first migration, only exercised once this session's repositories added
  the first real `.from(...).select()` calls.
- `profiles` table was missing an explicit `GRANT` for the `authenticated`
  role — Supabase's SQL Editor doesn't auto-apply the privileges the Table
  Editor UI would. Added
  `supabase/migrations/00000000000002_profiles_grants.sql`. Without this,
  authenticated requests to `profiles` failed with `42501 permission
  denied`, even though the RLS policies were correct.
- Email confirmation links use Supabase's PKCE `?code=` style on this
  project, but `src/app/auth/confirm/route.ts` only handled the older
  `token_hash`+`type` style, so every confirmation click landed on an error
  page instead of logging the user in. Fixed by handling `code` via
  `exchangeCodeForSession`, with the old `verifyOtp` path kept as a
  fallback for any non-PKCE flow.
- README no longer implies the dev server always runs on port 3000 — it
  now points readers at whatever port the terminal actually prints, since
  Next.js falls back to 3001+ when 3000 is already taken.

### Verified

- Connected a real Supabase project end to end: URL/anon key validity,
  `profiles` table existence and grants, and a full manual browser smoke
  test (signup → email confirmation → login → logout → login again) all
  confirmed working.
- Repository-wide audit against the progressive authentication model
  (every `redirect()`/`getUser()`/`auth.uid()` call, plus a check for any
  client-side redirect logic): no route-protection violations found. The
  current route surface (`/`, `/login`, `/signup`, `/auth/confirm`) never
  gates a page behind authentication.
- Connected the project to GitHub (`Rapscallion12/project-stage`, private)
  as `origin`, with the workflow documented in README.md.
- Guest-path RLS for the lobby verified directly against the live project:
  guest inserts succeed, impersonating an authenticated author is
  rejected, duplicate reactions are rejected, reaction deletes are
  rejected for everyone. Realtime broadcast delivery confirmed via a
  throwaway script against the real Supabase Realtime service. Full guest
  and authenticated browser verification of the lobby (entry, sending
  messages, reacting, history persisting across refresh, repeated
  navigation) completed after the update-depth fix, with no crash.

### Known limitations

- LiveKit is not yet integrated (deferred to Roadmap Phase 2 — see
  DECISIONS.md). Live speakers, the speaker queue, continue/replace
  voting, and reputation-affecting actions (Phases 2–4) remain unbuilt.
- GIF support and image uploads in the pre-show lobby are deliberately
  deferred fast-follows (see ROADMAP.md), as is un-reacting to a message.
- The `/events` list page hides events more than 2 hours past their
  `scheduled_start`, even though their lobby remains enterable directly by
  URL indefinitely (no "ended" state exists yet) — a minor UX rough edge,
  not a bug in the lobby itself.
- No Docker in this environment, so `supabase start` / local Postgres /
  `db reset --local` remain unavailable — all CLI operations go against
  the linked (live) project directly, which works for migrations/queries
  but means there's no local sandbox to test destructive changes against.
