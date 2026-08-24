# Roadmap

Phased by dependency order — each phase's features generally require the
data model or infrastructure from the previous phase. Within a phase, order
is a suggestion, not a requirement.

Check off items as they're completed and update this file in the same
commit as the feature. See SESSION_LOG.md for session-by-session detail.

This file is the phase-level narrative plan. Day-to-day, granular tracking
happens on the [GitHub Project board](https://github.com/users/Rapscallion12/projects/1)
via Issues — see README.md's "Project management" section and AGENTS.md
for that workflow. Phase 2's items below correspond to issues #1–#6;
Phase 1 fast-follows and other outstanding items correspond to issues
#7–#12.

Every item below is subject to the [responsive design principle](./PRODUCT.md#responsive-design-principle)
and its [testing checklist](./ARCHITECTURE.md#testing--definition-of-done) —
not repeated per line item to avoid clutter, but not optional either.

Every item is also subject to the
[progressive authentication model](./PRODUCT.md#progressive-authentication-model):
unless explicitly marked **(account-only)** below, a feature must work for a
guest with no session at all. When in doubt about a specific line item's
guest eligibility, PRODUCT.md's guest/account capability lists are the
source of truth, not this file.

Every item touching durable data is also subject to
[ARCHITECTURE.md's vendor portability rule](./ARCHITECTURE.md#vendor-portability):
new tables/queries get a `lib/repositories/` function, not a direct
Supabase call scattered into a page or action.

## Phase 0 — Foundation

- [x] Repository, Next.js/TS/Tailwind scaffold, documentation suite
- [x] Supabase client setup (browser + server) and session-refresh proxy
- [x] `profiles` table + auto-provisioning trigger
- [x] Landing page (guest-first — no signup/login funneling as the primary
      call to action; see DECISIONS.md for the correction that drove this)
- [ ] "Join Live Audience" one-click fast path (issue #26) — `/join`
      redirects straight into the best currently-joinable room (prefers
      one with active speakers, falls back to any joinable room, falls
      back to Browse Events if genuinely nothing is joinable), no
      intermediate screen, lands as audience with the same guest identity
      any other entry point uses. **Not checked off as fully done** —
      pending the user's own real-device confirmation from the actual
      landing page. See SESSION_LOG.md.
- [x] Authentication, as an **optional account upgrade** (sign up, log in,
      log out) — not an entry gate. No route redirects an unauthenticated
      visitor away.
- [x] Real Supabase project connected and verified: URL/anon key valid,
      `profiles` table exists with correct grants, and signup → email
      confirmation → login → logout → login-again all completed
      successfully in a real browser. See SESSION_LOG.md.
- [ ] Manual responsive/device verification of landing + auth pages against
      the testing checklist. The responsive design principle was adopted
      partway through the session that built these pages; layouts use
      responsive Tailwind utilities throughout, but the full checklist
      (real phone widths, throttled network, etc.) has not been walked yet
      in a real browser — see SESSION_LOG.md.

## Phase 1 — Scheduled events & pre-show lobby

- [x] `events` table + migration — no room/speaker/video columns by
      design, so a single event can later host multiple simultaneous
      conversation rooms without a schema redesign (see ARCHITECTURE.md's
      data model).
- [x] Event list / event detail pages — guest-viewable, no account
      required. Phase/countdown is computed from timestamps at read time,
      not a stored status column.
- [x] Pre-show lobby — not a passive waiting room: live text chat, native
      emoji input + quick-emoji buttons, message upvote reactions,
      live attendee count (Realtime presence), and a clear "the live
      conversation hasn't started yet" indicator. Guest-viewable *and*
      guest-participable, no account required.
- [x] Guest session mechanism: anonymous session cookie (`vs_guest_id`,
      minted in `src/proxy.ts` — see
      [ARCHITECTURE.md's guest identity design](./ARCHITECTURE.md#guest-identity)),
      used for lobby chat/reaction attribution+dedup and presence. Built
      here rather than deferred to Phase 2 as originally planned, since
      the lobby needed it immediately — Phase 2 can lean on it as-is.
- [ ] Basic moderator flag on `profiles` **(account-only, by definition —
      moderators are accounts)** (needed before moderator controls in
      Phase 3, cheap to add alongside events)

### Pre-show lobby fast-follows

Deliberately deferred out of the Phase 1 milestone — both were phrased
conditionally in the original request ("if it can be implemented
cleanly" / "without excessive complexity"), and neither was required by
that milestone's Definition of Done. Documented here as planned
enhancements, not abandoned scope — see SESSION_LOG.md for the full
deferral rationale.

- [ ] GIF support in chat — needs a new external API integration (e.g.
      Tenor or GIPHY), with its own provisioned key the user would need to
      set up, similar friction to the Supabase/LiveKit env vars.
- [ ] Image uploads in chat — would need a Supabase Storage bucket + RLS
      policies + a moderation-safety pass (anonymous, untraceable file
      uploads are a real abuse surface); Storage is already in the stack,
      but the safety review is real work, not just wiring.
- [ ] Un-reacting (removing your own reaction to a message) — reactions
      are currently insert-only for *everyone*, guest and account holder
      alike. See ARCHITECTURE.md's Rate limiting section: a guest-safe
      delete policy needs a way to verify which guest is asking, which
      doesn't exist yet without real guest-aware RLS (a bigger design
      task, not a quick addition).

## Phase 2 — Live room (two speakers + audience)

This phase is also where [PRODUCT.md's mobile orientation
behavior](./PRODUCT.md#mobile-orientation-behavior) first applies —
portrait and landscape are two intentional modes of the live-room UI, not
one layout rotated, and rotating must never drop the video connection or
reset chat/vote/timer state. See
[ARCHITECTURE.md's implementation notes](./ARCHITECTURE.md#mobile-orientation-implementation)
before building the room's layout. The pre-show lobby is a concrete
precedent for the *other* half of that rule — see
[ARCHITECTURE.md's mobile orientation implementation](./ARCHITECTURE.md#mobile-orientation-implementation)
for why the lobby itself doesn't branch by orientation, and don't let that
precedent bleed into the live room, which genuinely does need to.

- [x] `event_speakers` table (issue #1) **(account-only** — speakers must
      have an account; see PRODUCT.md). Append-only occupancy episodes,
      room-agnostic. See ARCHITECTURE.md's Data model section and
      DECISIONS.md.
- [x] LiveKit SDK (server) + token endpoint (issue #2) — mints tokens from
      *current* `event_speakers` occupancy; server-authoritative
      `canPublish`, generous TTL (expiry isn't the revocation mechanism).
      See ARCHITECTURE.md's LiveKit authorization model.
- [x] Speaker state transitions (issue #13 — split out of #2 after
      designing the full authorization model surfaced it needed its own
      issue; see DECISIONS.md): atomic seat assignment/replacement
      (`claim_speaker_seat`), self-service voluntary leave
      (`leave_speaker_seat`), live permission sync
      (`syncPublishPermission`/`RoomServiceClient.updateParticipant()`),
      and disconnect-webhook cleanup (`end_speaker_seat` +
      `/api/livekit/webhook`). `claim_speaker_seat`/`end_speaker_seat` are
      deliberately trusted-server-only (`service_role`, no
      anon/authenticated grant) with no production caller yet — see
      ARCHITECTURE.md's LiveKit authorization model and DECISIONS.md for
      why. Real dynamic speaker promotion still needs Phase 3's
      queue/voting to decide *who* gets to call `claim_speaker_seat`;
      #3/#4 below can be built and manually tested against hand-seeded
      `event_speakers` rows without that.
- [x] Two-speaker live audio/video room (`livekit-client`, room UI —
      issue #3): `app/events/[id]/room/page.tsx` +
      `components/room/`, portrait (chat-maximized) and landscape
      (discussion-maximized) layouts that never remount on rotation (see
      ARCHITECTURE.md's Live room UI and Mobile orientation
      implementation sections), automatic publish/unpublish driven
      entirely by the server-issued token and live permission pushes,
      explicit room status ("Waiting for speakers" / "Selecting next
      speaker" / "Live"), and an intentional "Seat open" placeholder for
      an empty seat rather than blank space. Current speakers are
      rendered from `event_speakers` (Realtime-subscribed), never from
      LiveKit's own participant/track state — see DECISIONS.md for why
      that was a correction to the initial design. Adaptive video
      quality (`adaptiveStream`/`dynacast`) enabled at the LiveKit
      client level. `livekit-client`'s own reconnect handling covers
      flaky networks (`RoomEvent.Reconnecting`/`Reconnected`, surfaced in
      `RoomHeader`). Camera/microphone activation itself didn't actually
      work on real mobile Safari until issue #15 below — this issue's
      `mediaError` state existed but was never surfaced anywhere in the
      UI, an untested gap only caught by real-device testing.
- [x] Camera/mic activation fix (issue #15) — found via real iPhone
      Safari testing of the deployed app: camera/mic silently never
      activated because `getUserMedia` was triggered from an async
      LiveKit event callback rather than a user gesture, which Safari
      requires. Fixed with an explicit "Enable camera & mic" tap
      (`activateMedia()`, `useLiveRoomConnection`) for the first
      activation only; later server-driven `canPublish` changes still
      resync automatically. `mediaError` failures are now classified via
      `getUserMedia`'s own `DOMException.name` and surfaced in
      `RoomControls` with specific copy instead of a silent placeholder.
      See DECISIONS.md.
- [x] Audience viewing (join a live room as a non-speaker) — guest-viewable,
      no account required (part of issue #3 above)
- [x] Audience count — part of issue #3 above, but **not** a dedicated
      Supabase Realtime presence channel as originally scoped here:
      everyone (speakers and audience alike) already connects to LiveKit
      to subscribe to the speakers' tracks, so the room's own LiveKit
      participant count *is* the audience count — see ARCHITECTURE.md's
      Realtime plan for why a second, duplicate presence mechanism would
      have been redundant infrastructure for data LiveKit already has.
- [ ] Emergency leave — available to guests and account holders alike
      (distinct from issue #13/#3's "Leave the stage," which only ends a
      seated speaker's occupancy — this is a still-unbuilt, broader
      "get out of the room" affordance)

### Real-device-testing follow-on (issues #16–#18)

First real iPhone testing of the deployed app (Session 17) surfaced
product/UX problems beyond the camera/mic bug (issue #15, above): account
creation getting in the way of testing, a fragmented event→lobby→room
flow, and an undifferentiated audience/speaker UI. Scoped as three
sequential issues, each deployed and tested on a real phone before the
next starts (per the user's explicit instruction — no stacking unverified
changes) — see DECISIONS.md for the full design reasoning and
PRODUCT.md's testing-phase guest-participation exception.

- [x] Guest speaker participation (issue #16) — **explicit, reversible
      testing-phase exception** to the account-only speaking rule above,
      gated behind `PROTOTYPE_CONFIG.guestParticipationEnabled`
      (`lib/config.ts`, defaults to enabled). Guest writes stay on the
      same trusted-server (`service_role`-only) tier
      `claim_speaker_seat`/`end_speaker_seat` already use — no new `anon`
      grant anywhere; `request_to_speak`/`withdraw_speaker_request` kept
      their existing self-service `auth.uid()` path unchanged and gained
      separately-named `service_role`-only guest siblings instead of a
      unified signature (see DECISIONS.md for why). `event_speakers`/
      `speaker_requests` gained a nullable `guest_id` column each,
      XOR-constrained against `profile_id`, same pattern
      `event_chat_messages` already used for guest authorship. A guest
      can request the mic, get promoted, and receive `canPublish: true`
      through the exact same server-authoritative path an account holder
      does. Requesting the mic during the pre-show waiting phase (not
      just once live) is still gated on issue #17's unified lifecycle
      landing — today's `RoomControls` only renders inside the room page,
      reachable once the event is "ready".
- [x] Unified event/lobby/live-room lifecycle (issue #17) — collapsed
      `/events/[id]`, `/lobby`, and `/room` into one persistent client
      experience (`components/room/event-room.tsx`, renamed from
      `live-room.tsx`); the waiting room becomes the live room in place
      (a genuine state transition, phase computed the same
      `useNow()`-driven way as `EventCountdown`, sitting above the
      orientation branch alongside the other live hooks — never a
      redirect) with chat/presence/LiveKit connection surviving the
      transition, same discipline the orientation architecture already
      required. `/lobby`/`/room` kept as backward-compatible redirect
      stubs. Requesting the mic works from `lobby_open` onward; claiming
      a seat stays server-enforced to `ready` only (see DECISIONS.md) so
      the scheduled start time still means something now that
      `RoomControls` is reachable earlier.
- [ ] Role-based Audience/Candidate/Speaker UI (issue #18) — a speaker
      gets a purpose-built layout (other speaker prioritized, own preview
      small, controls immediately reachable), not the audience UI with
      their own video added. Preserves the `featuredSlot`/reply-thread
      seams without implementing them.

### Video-first participation redesign (issues #19–#27)

Design work following the two-device AV checkpoint (`prototype-live-av-stable`,
Session 21) — reduces participation friction (direct-join, composer-integrated
mic requests, automatic promotion) and replaces the room's stacked-block
layout with a video-first, overlay/scrim-based one, ahead of #18's visual
polish. Sequenced by dependency, not left as one large "build the live room
UX" issue — see DECISIONS.md for the full design reasoning (scrim vs. video
opacity, dead-zone gesture mechanism, voting-evaluation scaling, the
room-format seam). #18 is now the final step in this sequence, not a
separate one.

**Reordered after #20's first real-device test (2026-08-21)** — automated
checks passing had let #20 quietly under-deliver on its own stated bar
("chat/voting reached by revealing layers over it") without anyone
noticing until a real phone made it obvious. #20 got a corrective pass
under the same issue number rather than a new one; #23 got split once
real-device use showed its two halves have different urgency and
different dependencies. Current order:

1. **#20 corrective pass** (below)
2. **#22** — composer-integrated mic request + readiness/self-preview
3. **#27** — direct join on an uncontested empty seat (new, split from #23)
4. **#23** — automatic ranked promotion, narrowed to contested seats only
5. **#21** — chat/voting focus interactions, moved later: no dependency
   relationship with #22/#23/#27 in either direction, just lower priority
   than the friction those issues remove
6. #24, #25, #18 — unchanged

- [x] Room format seam (issue #19) — additive `events.format` column,
      defaulted/constrained to `'main_stage'` today, so Main Stage's
      two-seat/voting/ranking assumptions don't become inseparable from
      "what a room is" once Roulette/Spotlight/Group Stage exist. Those
      three formats are documented, not built.
- [ ] Video-first room shell (issue #20) — video-dominant base layer that
      stays geometrically stable across focus changes, a scrim/overlay
      compositing primitive (opacity/transform only, never resizing the
      video element itself), a fixed self-preview slot, a structural
      (inert) speaker divider, and removal of issue #15's diagnostics
      panel from normal UI (kept dev-only). First pass merged/deployed but
      **not checked off** — real-device testing found the default state
      still read as a webpage with video embedded, not a layered
      livestream. Corrective pass merged/deployed too: controls/chat are
      now a true bottom overlay over the video (portrait) with an
      always-on legibility gradient (distinct from the still-inert
      `room-scrim`, still #21's job), self-preview slot moved to the
      top-right. Third pass: fixed the divider bleeding across chat/
      controls (a missing CSS stacking context on the stage's own root —
      `relative` alone doesn't establish one, `relative z-0` does), and
      removed the divider's decorative center dot (no function until
      #21/#25, was contributing to visual clutter). **Still not checked
      off** — stays in Testing/Review until confirmed on a real iPhone
      against the original gut-check bar. See SESSION_LOG.md and
      DECISIONS.md.
- [ ] Composer mic-request + candidate readiness/self-preview (issue
      #22) — **composer-integrated request and candidate
      readiness/self-preview/promotion-without-reacquiring all shipped**.
      Submitting the mic-request composer now acquires camera/mic itself
      (`createLocalTracks`, one combined permission prompt); the acquired
      tracks power a persistent, spatially-stable `SelfPreview` in #20's
      top-right slot — hidden entirely with no local media, the same
      mounted component/track from candidate through countdown through
      published speaker; promotion calls `publishTrack()` on the
      already-held tracks directly, no second `getUserMedia()` call, no
      second permission prompt. Deliberately no new server-side
      "readiness" field — local track possession is the whole signal, and
      #23's automatic-promotion eligibility rule is unchanged by this.
      **Real-device testing found and fixed a duplication bug**: a
      promoted speaker's own video was rendering twice (own large tile +
      self-preview) — `SpeakerTile` now never shows the big video for
      the local participant's own seat, a neutral placeholder shows
      there instead; presentation-only, no track/publish changes, no
      grid resizing, no landscape changes. **A second real-device pass
      found direct join (#27) bypassed this issue's readiness path
      entirely** — fixed by having `EventRoom`'s empty-seat tap handler
      call the same `prepareLocalMedia()` the composer already uses,
      from the tile's own gesture, before the join call; no new
      abstraction, both entry points now converge on one readiness path.
      **Remaining, narrowed further**: literal asymmetric grid sizing
      (the *other* speaker's tile visually enlarged, not just
      decluttered — deliberately deferred, possibly #18) and a mic
      activity indicator. Stays in Testing/Review pending real-device
      confirmation. See SESSION_LOG.md and DECISIONS.md.
- [x] Three room compositions by form factor, not two by orientation
      (2026-08-22, real-device follow-up to #20's video-first shell) —
      mobile landscape's dashboard-style drift (recorded as a constraint
      in ARCHITECTURE.md during the previous pass) is now fixed: new
      `useIsDesktopViewport()` (width-based, never `width > height`)
      makes device class an axis independent from `useOrientation`, so
      `EventRoom` picks `DesktopRoom` (renamed from `LandscapeRoom`, real
      sidebar, unchanged internals), `MobileLandscapeRoom` (new — same
      video-first/overlay philosophy as `PortraitRoom`, adapted for a
      wide-short box via a shared `StageOverlayShell`), or `PortraitRoom`
      (unchanged). The site-wide header also compacts on a short
      mobile-landscape viewport specifically while inside a room (CSS
      media query + a route-scoping body class, no navigation removed).
      **User-confirmed on real devices** (iPhone portrait, iPhone
      landscape, desktop browser) — see the
      `prototype-responsive-mobile-landscape-stable` checkpoint. A
      follow-up real-device pass on the same composition found the
      chat/composer still felt dominant and the headers still cost real
      space — see the #21 first-slice entry below and the desktop
      anti-squashing fix. See ARCHITECTURE.md, DECISIONS.md, and
      SESSION_LOG.md.
- [ ] Direct join on an uncontested empty seat (issue #27) — split from
      #23 after real-device testing: with a seat open and no pending
      requests, tapping the tile directly attempts to join it — no
      request message, no separate Claim button. Falls back to the
      composer's mic-request mode if a queue exists, checked
      server-side (never trusted from the client). Reuses
      `claim_speaker_seat`'s existing race safety, no new DB primitive.
      **Now also acquires camera/mic readiness the same way the composer
      does** (see #22's note above) and, when it's the viewer's one
      actionable open seat, gets visual priority over the bottom chat
      overlay (`SpeakerStage`'s `order-first`, plus a click-through/
      interactive layer split on the overlay itself) so it can't end up
      unreachable underneath it — pure presentation, no seat-number or
      LiveKit change. **Not checked off as fully confirmed** — real-
      device confirmation of the actual tap/queue-protection/guest-
      gating/readiness/reachability behavior is still pending; see
      SESSION_LOG.md.
- [ ] Automatic ranked promotion for contested seats (issue #23,
      narrowed further) — **shipped, narrowed below its own original
      scope**: a pending requester now sees an automatic "You're up
      next" countdown once server-eligible, and the actual seat claim
      happens on its own — no manual "Claim your seat" button. The
      countdown is explicitly not an eligibility mechanism (a pure
      client-side timer; the real claim independently re-validates,
      unchanged); disconnection during the wait is already covered by
      the existing LiveKit webhook, and a promoted-but-never-activates-
      media candidate self-evicts after a 30s grace period. Its own
      eligibility rule (`resolveClaimDecision`) is untouched by #22's
      later readiness work — a candidate who pre-acquired media now
      typically auto-publishes and clears `needsMediaActivation` almost
      immediately after promotion, so the grace period rarely fires for
      that path in practice, but the mechanism itself is exactly the one
      built here, composing rather than being replaced. **Not checked
      off** — pending the user's own real-device confirmation. See
      SESSION_LOG.md and DECISIONS.md.
- [ ] Social Stage (05) interaction shell (issue #21) — **gesture retired;
      rebuilt as Watch Mode / Comments Mode, a plain tap toggle
      (2026-08-22), both mobile orientations**: real-device testing of
      the room-level drag gesture (previous approach, kept below for
      history) came back negative a second time — "dragging downward
      produced no meaningful transition" — and, independently, found
      that neither orientation actually hid the chat panel at rest:
      landscape only shortened it (always mounted, 96px↔160px), and
      portrait had received none of this issue's work at all, still
      showing a fixed `h-40` panel from issue #20. Per explicit
      instruction, this was treated as a failed UX experiment rather than
      something to keep tuning — `useCommentsFocus` deleted outright,
      replaced with `useCommentsMode`: a plain boolean (`open`/
      `openComments`/`closeComments`), no drag tracking, no `progress`,
      no pointer handlers. Both `MobileLandscapeRoom` and `PortraitRoom`
      (built from scratch for portrait) now share this hook and the same
      two-state model: **Watch Mode** renders no chat panel in the DOM at
      all (not shortened — absent) plus a compact `💬 Comments` toggle;
      **Comments Mode** mounts the existing, unchanged chat/composer UI
      (history, reactions, mic-request composer) and darkens
      `SpeakerStage`'s `room-scrim` to a constant opacity. Video geometry
      still completely unaffected — `SpeakerStage` stays a sibling of the
      overlay, never resized/remounted by the toggle. `chat-panel.tsx`'s
      `data-gesture-ignore`/`touch-pan-y` markers removed along with the
      drag they existed to exempt the message list from. **Remaining**:
      the *voting*-focus direction (still #25's job, still fully inert);
      the progressive downward-drag reveal, deliberately deferred until
      Watch Mode and Comments Mode both have a Figma-defined visual
      design — see DECISIONS.md's "Future Figma seam" entry; the eventual
      second-level "full comments view" with genuinely compressed video
      (still not implemented, seam only). **Checked off (2026-08-22)** —
      the tap-based Watch Mode / Comments Mode states passed the user's
      own real-device confirmation on iPhone portrait and landscape and
      are now the stable interaction foundation the upcoming Figma-
      assisted redesign builds on; the progressive drag gesture itself
      remains deliberately unbuilt until that redesign happens. A small
      same-day follow-up fixed `GuestNameEditor` not exiting its editing
      state on blur/outside-tap (unrelated to the mode toggle itself —
      see the entry below).
      **Superseded (2026-08-23), unchecked again**: the confirmed
      tap-based Watch Mode / Comments Mode above went through a full
      Figma exploration pass (00 → 05e) and the resulting "05 — Social
      Stage" interaction model is now being implemented as real code in
      its place, phased across 7 stages, one real-device-tested
      milestone at a time. **Phase 1 (static shell) shipped**: video-first
      Watch Mode, minimal top chrome (replacing `RoomHeader` for this
      composition), lightweight top-anchored speaker identity (portrait
      only — landscape unchanged), and the persistent
      composer/React/Vote/Gift control row — all visually final, all
      functionally inert until their own later phase. Commenting/reading
      are both temporarily unavailable on the feature branch until
      Phases 2/4 restore them with the new model — not merged to `main`
      until real-device confirmed. See DECISIONS.md's 2026-08-23 entry
      for the full architecture survey, phased plan, and issue mapping.
      **Phase 1 confirmed on a real iPhone.** **Phase 2 (functional
      composer) shipped**: the persistent bottom composer now sends
      real comments and Request-to-Speak submissions, reusing
      `ChatPanel`'s existing actions/gesture-safety logic verbatim (a
      new opt-in `compact` prop, not a duplicate implementation).
      React/Vote/Gift still inert; ambient comments, Discussion
      Expanded, reactions, and voting/gifting all still out of scope.
      A **Speaker View** design checkpoint (scoped to existing #18) is
      now queued between Phase 2 and Phase 3 — real-device testing
      found a seated speaker's UI still looks like the audience Watch
      interface, which needs to be settled before the remaining phases
      decide their audience-vs-speaker placement.
      **Phase 2 confirmed on a real iPhone. Phase 3 (ambient live
      comments) shipped**: recent comments now render as a small,
      self-expiring stack of translucent bubbles lower-left on the
      stage, reusing the existing `messages`/`useLobbyRealtime` stream
      with no new backend — see DECISIONS.md's 2026-08-23 entry.
      Discussion Expanded, reactions, and voting/gifting remain fully
      out of scope; per explicit instruction, the Speaker View (#18)
      design checkpoint above stays next after Phase 3's real-device
      confirmation, not Discussion Expanded.
      **Phase 3 confirmed on a real iPhone. Speaker View (#18) design
      checkpoint completed**: #16/#17 verified genuinely complete (not
      just similar) and closed; a 4-phase Speaker View plan approved for
      Direction B (full-bleed remote speaker). **Speaker View Phase 1
      shipped, on a new `feature/speaker-view` branch** (off
      `feature/social-stage-shell`, since `main` doesn't have Phases 1–3
      yet): a seated speaker now sees the other speaker's video full-bleed
      via `SpeakerStage`'s new `soloMode` prop, with the existing
      `SelfPreview` corner and empty-other-seat placeholder both reused
      unchanged. No composer, ambient comments, or control bar yet — see
      DECISIONS.md's 2026-08-24 entry. "05 — Social Stage" Phases 4–7
      remain paused on `feature/social-stage-shell` during this work.
      **Phase 1 corrective pass**: real-device testing found the
      self-preview disappearing after editing the guest-name chip (traced
      to a real corner collision plus a reintroduced iOS-zoom bug, both
      fixed directly) and landscape reverting to the old audience
      composition on rotation while seated (fixed with a new
      `MobileLandscapeSpeakerView`, mirroring the portrait role-router
      pattern). See DECISIONS.md's second 2026-08-24 entry.
      **Second corrective pass**: the self-preview bug persisted — root
      cause traced to `useLiveRoomConnection` reconnecting the entire
      LiveKit `Room` whenever a guest-name edit's cookie write triggered
      a page-level Server Component re-render that minted a fresh
      LiveKit token, which the connect effect treated as a reconnect
      signal. Fixed by depending on the token's presence, not its exact
      value. Landscape's site-wide header is now hidden outright (not
      just shrunk) while actively speaking. See DECISIONS.md's third
      2026-08-24 entry.
      **Third corrective pass**: name-edit bug confirmed fixed;
      real-device testing found leaving and returning to the room left
      no way to re-enable camera/mic. Verified (not assumed) that
      seat-vacate-on-navigation is already the intended lifecycle —
      unchanged. The real bug was a missing UI trigger: Speaker View had
      no control that could ever call `activateMedia()` for a fresh
      connection instance that's still seated. Fixed with a new shared
      `SpeakerMediaActivationPrompt`, reusing the existing activation
      path verbatim. See DECISIONS.md's fourth 2026-08-24 entry.
      **Fourth corrective pass**: hardened `handleTapEmptySeat` with an
      `isSpeaker` guard at the source (couldn't conclusively reproduce
      the reported split-screen symptom from static analysis — every
      traced path was already inert or already server-guarded — reported
      honestly as defense-in-depth, not a confirmed root cause).
      Investigated and declined to auto-restore camera/mic on mount
      without a user gesture — Safari's gesture requirement resets per
      fresh page/hook instance regardless of prior permission, a
      previously-proven real-device failure mode; kept the existing
      button as the only path. See DECISIONS.md's fifth 2026-08-24 entry.
      **Fifth corrective pass**: a precise "top seat works, bottom seat
      doesn't" report investigated as a seat-index asymmetry, confirmed
      (not assumed) via an actually-executed probe test, not just
      re-reading the code — `SpeakerStage`/`EventRoom`/the role router
      are all symmetric for seat 1 vs. seat 2. No production code change
      made without evidence; instead added the full required
      local-seat-permutation test matrix (16 new tests, all passing) to
      close a real pre-existing coverage gap. Flagged a relevant finding
      to the user: `findOpenSeat` always prefers seat 1 regardless of
      which tile is tapped, so confirming which seat the "bottom" test
      actually landed in is the open question. See DECISIONS.md's sixth
      2026-08-24 entry.
      **Speaker View Phase 2**: the seat-index bug didn't reproduce on
      retest, so further investigation paused pending a better stress-
      testing setup. Restored Leave the stage (new `SpeakerControlBar`,
      reusing `leaveSpeakerSeat` verbatim), the compact composer
      (`ChatPanel`'s new `allowMicRequest` prop), and ambient comments to
      both portrait and landscape Speaker View — the real interface
      needed to stress-test join/leave cycles repeatedly. React/Vote/Gift
      stay inert. See DECISIONS.md's seventh 2026-08-24 entry.
      **Everything above approved on real-device stress testing** —
      top/bottom join, self-preview, Leave the stage, commenting/ambient
      comments, and landscape all confirmed working; the split-screen
      issue did not reproduce and further investigation is paused pending
      a clearer trigger. **Live mic/camera mute toggles shipped** (the
      original plan's remaining Phase 3 content) — `SpeakerControlBar`
      gained mic/camera buttons backed by `LocalTrack.mute()`/`.unmute()`
      on the already-published track, never `setMicrophoneEnabled`/
      `setCameraEnabled`. See DECISIONS.md's eighth 2026-08-24 entry.
      **#18 reconciled against the current code**: every requirement in
      the issue's own body is satisfied; no meaningful work remains;
      landscape done as an explicit deviation from the issue's original
      text, at the user's request; React/Vote/Gift, Discussion Expanded,
      a fuller landscape redesign, and desktop belong to #21 or a new
      issue, not #18. **UI cleanup pass before sign-off**: mic/camera
      toggles consolidated into the persistent bottom row
      (`WatchModeControls`' new `micCameraSlot`, replacing React/Vote for
      a speaker), `SpeakerControlBar` back to just "Leave the stage,"
      `AmbientComments` given Speaker-View-specific clearance
      (`bottom-32`), safe-area-aware bottom padding, and
      `SpeakerViewTopChrome` now reserves `SelfPreview`'s actual
      responsive footprint. Not yet merged or closed — gated on this
      pass's approval plus the integrated real-device sign-off. See
      DECISIONS.md's ninth 2026-08-24 entry.
      **Audience landscape rebuilt onto "05 — Social Stage"**, surfaced
      during the same #18 sign-off pass but genuinely #21 scope: rotating
      to landscape as an audience member still fell back to the legacy
      `RoomHeader`/"💬 Comments" toggle/`RoomChatPanel` interface, since
      only portrait Watch Mode had moved onto the "05" model.
      `MobileLandscapeRoom`'s audience branch now reuses the exact same
      `SpeakerViewTopChrome`/`AmbientComments`/`WatchModeControls`
      components portrait and Speaker View already use — only
      `SpeakerStage`'s own `orientation="landscape"` genuinely differs.
      `useCommentsMode` deleted outright, nothing referenced it after.
      React/Vote/Gift still inert; no Discussion Expanded/reactions/
      voting/gifting added. See DECISIONS.md's tenth 2026-08-24 entry.
      **Site header hidden for audience landscape too**: broadened the
      existing speaker-only header-hiding body class
      (`speaker-view-active`) into `mobile-landscape-live-active`,
      triggered whenever `MobileLandscapeRoom` (audience or speaker) is
      the actual composition rendering — one class/rule instead of two
      near-duplicates. Portrait, desktop, and landscape outside the room
      unaffected. See DECISIONS.md's eleventh 2026-08-24 entry.
      **Composer width capped in landscape**: `landscape:max-w-[40%]` on
      `ChatPanel`'s compact form — one change fixes the composer's
      unbalanced width in both Watch Mode and Speaker View landscape
      (they share this exact component); portrait unaffected. See
      DECISIONS.md's twelfth 2026-08-24 entry.
      **Merged into `feature/social-stage-shell` for #18 integration
      sign-off** (fast-forward, `a65c7f9..9348972`, zero conflicts). A
      real-device stress test on the merged preview then surfaced an
      intermittent Speaker/Audience role-consistency bug; fixed by
      consolidating "am I a speaker" to one authoritative computation
      (new `lib/participant-role.ts`) instead of `SpeakerStage`
      independently re-deriving its own copy — see DECISIONS.md's
      thirteenth 2026-08-24 entry. That stress test also surfaced a UX
      finding: the promotion countdown competed with the bottom
      composer/controls/ambient comments instead of reading as a
      significant transition. Redesigned as a center-stage takeover
      (new `CountdownOverlay`) — a presentation change to the existing
      `useAutomaticPromotion` state only, no new promotion system; can't
      coexist with Speaker View for the same structural reason
      Audience/Speaker already can't. See DECISIONS.md's fourteenth
      2026-08-24 entry. **Not checked off** — #18 stays open, pending
      the user's own real-device re-test of the merged, consolidated
      build.
- [ ] Refresh/reconnect media recovery + speaker reconnect grace period
      (2026-08-22, real-device follow-up) — a seated speaker who
      hard-refreshed and re-activated media published correctly but never
      saw their own self-preview return; `activateMedia()` now delegates
      to the existing `prepareLocalMedia()` (issue #22) instead of a
      second, incomplete acquisition path, fixing that and, as a side
      effect, a failed-attempt-permanently-hides-the-retry-button bug too.
      Separately, the LiveKit webhook's immediate (no-grace-period)
      eviction on `participant_left` was exposed as a real gap — new
      `useSpeakerReconnectGrace`/`checkAndEvictDisconnectedSpeaker` add a
      25s (tunable), server-re-validated grace period, reusing
      `useAutomaticPromotion`'s own grace-period shape rather than a
      second timer system; `SpeakerTile` shows "Speaker reconnecting…"
      during it. No new SQL. **Not checked off** — pending the user's own
      real-device confirmation (refresh, and a real temporary
      disconnect). See ARCHITECTURE.md and DECISIONS.md.
- [x] Desktop anti-squashing fix (2026-08-22, real-device follow-up) —
      right at the 1024px desktop threshold, a fixed 320px sidebar left
      the two video tiles pathologically narrow; one isolated responsive
      width class (`w-64 xl:w-80`) fixes the cramped zone without
      touching anything else about the desktop composition. A hard
      minimum width on the stage column itself would be more thorough —
      left to #18. See DECISIONS.md.
- [ ] Fresh next-speaker ranking rounds (issue #24) — ranking freshness
      bounded by the current pairing's `joined_at`, so stale reaction
      support from a previous pairing can't dominate a new one.
- [ ] Audience retention voting (issue #25) — decision-window model (not
      continuous polling): independent A/Both/B/New-speakers support
      tallies, recurring windows computed from `pairing_start_time` via
      modular arithmetic (no stored timer state), evaluation triggered by
      the two active speakers' clients plus opportunistic vote-casting
      (not audience-wide polling), reveal-after-vote percentages on the
      divider. Gated behind `format === 'main_stage'` (#19).

## Phase 3 — Audience power features

- [x] Speaker request queue + request-to-speak flow (issue #14)
      **(account-only** — this is the product's clearest "create an
      account to do this" moment; guests get the account-prompt copy
      from PRODUCT.md, inline on the same "Request the mic" button
      everyone sees, not a redirect). Deliberately **not** a
      `speaker_queue` table as originally scoped here — a mic request is
      a chat message with a flag on it (`event_chat_messages.is_speaker_request`),
      with lifecycle tracked separately in `speaker_requests`
      (pending/granted/withdrawn) — see ARCHITECTURE.md's Speaker
      request queue section and DECISIONS.md for the full reasoning.
      `claim_speaker_seat` (issue #13) got its first production caller
      via a self-service `claimOpenSeat` action, gated by rank (audience
      reactions on the request's message) among the top 3 eligible
      requests — an explicit MVP policy, not permanent, see
      `lib/speaker-queue.ts`.
- [ ] Continue voting — guest-eligible, rate-limited/deduped per
      ARCHITECTURE.md's guest identity + abuse-prevention design
- [ ] Replace speaker voting — guest-eligible, same as above
- [ ] Timer extension (tied to continue voting) — guest-eligible by
      inheritance from continue voting
- [ ] Live emoji reactions (Realtime broadcast, ephemeral — no `reactions`
      table needed unless we decide to persist them for analytics) —
      guest-eligible, rate-limited per identity (guest or account, same
      limit)
- [ ] Pinned/featured comments + general "top comments" ranking
      **(account-only** to post — per PRODUCT.md; guests may still *view*
      the comment feed). Partially unlocked by issue #14: request
      messages already carry a ranking signal (reaction count) and a
      rendering seam (`RoomChatPanel`'s `featuredSlot`) built for exactly
      this — what's still missing is generalizing beyond mic requests
      and building the actual pinned/expandable UI treatment.
- [ ] Report button — guest-eligible; someone shouldn't need an account to
      flag something alarming
- [ ] Basic moderator controls (mute/remove speaker, end event early)
      **(account-only**, moderator-flagged accounts specifically)

## Phase 4 — Reputation & reliability

Everything in this phase is **account-only by definition** — guests
structurally cannot have a `profiles` row, so there is nothing to attach a
score to (see ARCHITECTURE.md's Guest identity section).

- [ ] Reputation score updates driven by event outcomes (votes received
      while speaking, etc.) — implement as `security definer` functions, not
      client-side writes
- [ ] Reliability score updates (no-shows after queueing, removals for
      cause)
- [ ] Queue ordering that factors in reputation (Principle 4: priority, not
      control — reputation must never let someone skip the queue's
      first-come structure entirely, only move up within it)

## Explicitly not on this roadmap

Per PRODUCT.md's out-of-scope list: AI host, AI clipping, donations/
payments, premium accounts, user-created rooms, notifications, advertising,
complex recommendation algorithms. Do not add these without an explicit
instruction that overrides PRODUCT.md.

## Known gaps / blockers for future sessions

- **No LiveKit credentials/SDK exist yet** — Phase 2's video work is
  entirely unbuilt (see the tech stack table in ARCHITECTURE.md for why
  the dependency isn't even installed yet). A real Supabase project *is*
  connected and verified (Phase 0/1 — see SESSION_LOG.md).
- **No CI pipeline yet.** `npm run lint` / `npm run build` are run manually
  each session — see SESSION_LOG.md for the last known-good status.
- ~~The Supabase CLI still isn't set up~~ **Resolved** (issue #12): the CLI
  is installed, linked to the live project, and Phase 1's three migrations
  were reconciled via `migration repair` (verified against the live schema
  first — see DECISIONS.md). All future migrations go through
  `supabase db push --linked`, not the SQL Editor — see ARCHITECTURE.md's
  Migration workflow. Docker/local dev (`supabase start`, `db reset --local`)
  still isn't set up in this environment — a real, separate gap, not
  blocking normal migration work against the linked project.
- **Live reactions during the live room (Phase 3) must not reuse the
  pre-show lobby's message-reactions table pattern** — that table persists
  one row per reaction on purpose (needs per-person dedup, bounded
  volume); live reactions are the actually high-frequency case and should
  be ephemeral Realtime broadcast instead. See ARCHITECTURE.md's "Realtime
  traffic vs. durable writes."
