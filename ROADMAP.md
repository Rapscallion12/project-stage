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
- [x] Role-based Audience/Candidate/Speaker UI (issue #18) — a speaker
      gets a purpose-built layout (other speaker prioritized, own preview
      small, controls immediately reachable), not the audience UI with
      their own video added. Preserves the `featuredSlot`/reply-thread
      seams without implementing them. Full design/implementation/
      real-device investigation chain in the "Social Stage (05)
      interaction shell (issue #21)" entry below and DECISIONS.md.
      **Closed 2026-08-26**: confirmed via real-device testing with no
      complaints, merged to `main`, and deployed to production
      (public-beta-v1, tag `public-beta-v1-stable`). This closes #18's
      own scope only — issue #21 remains open for the rest of Social
      Stage (voting, gifting, full comment/reaction system).
      **Reopened 2026-08-28**: the split-layout report reproduced again
      after being confirmed clean — a second manual Join tap fixed it,
      revealing the reconciliation mechanism worked but nothing
      automatic triggered it. Seat-role reconciliation made self-healing
      (successful-claim triggers, a `canPublish`-vs-`isSpeaker`
      contradiction watchdog, visibility/focus resync). Not checked off
      — pending real-device confirmation that this survives repeated
      testing.

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
      2026-08-24 entry. That pass found three more issues: a brief
      pre-countdown candidate-UI flash, Cancel not reliably canceling,
      and Speaker View's self-preview intermittently missing. Fixed the
      first two at their traced root cause (a real race between
      `useAutomaticPromotion`'s claim-success reset and the independent
      Realtime `isSpeaker` push — `isSpeaker` is now the single signal
      that ends the countdown state, reusing the existing
      `useRoleTransitionReset` hook rather than a second mechanism), and
      added a defensive, dev-logged reconciliation for the third (adopts
      an already-live camera publication into `localVideoTrack` state
      without ever re-acquiring media) since no reproducible root cause
      could be confirmed. See DECISIONS.md's fifteenth 2026-08-24 entry.
      A real-device screenshot from that re-check found the compact
      "Request sent · Cancel" pill overlapping the composer/ambient
      request comment — removed it entirely; the composer's own mic
      button now carries a distinct pending state and cancels the
      request when tapped again, wired to the same existing
      `onCancelPromotion` action. See DECISIONS.md's sixteenth
      2026-08-24 entry. Two final changes before sign-off: Speaker
      View's activation prompt now reads "Tap to reconnect" (copy only —
      confirmed this state can only ever mean an already-seated speaker's
      tab coming back fresh); and the speaker disconnect grace period
      became genuinely server-authoritative (see the roadmap item below
      and DECISIONS.md's seventeenth 2026-08-24 entry). That re-test
      found two more issues: an intermittent Speaker View failure on
      first/fresh load (traced to `useOrientation`/`useIsDesktopViewport`
      guessing a mobile default during hydration, letting `EventRoom`
      briefly commit to `DesktopRoom` — no role router at all — before
      correcting; fixed with `useHasMountedOnClient()` gating the
      composition choice entirely, showing a brief neutral state
      instead of ever rendering a wrong one), and the reconnect prompt
      needed a real countdown (now derived from the viewer's own
      `disconnected_at` plus the existing 11-second grace period, never
      a fresh client timer). See DECISIONS.md's eighteenth 2026-08-24
      entry. Three further real-device retest rounds followed: a
      reconnect-countdown precedence bug (an independently re-derived
      display flag could disagree with the seat's own authoritative
      field — fixed by deriving from one field only), a genuine
      expiration-enforcement gap (a stale, past-deadline seat could
      still be reconnected into, since ownership reads never checked
      logical expiration — fixed with `event_speakers_active` and
      `release_if_expired`, migration 00000000000018), and finally the
      actual "split-layout" root cause: `useActiveSpeakers` had no
      reconciliation mechanism for a missed Realtime delta, so a
      client's own seat-ownership state could silently diverge from the
      server's — fixed with a full resync on every Realtime
      (re)subscription. Unified inactive-speaker model shipped alongside
      (LiveKit disconnect and connected-but-both-media-off both use the
      same 11-second grace period). See DECISIONS.md's 2026-08-25
      through 2026-08-27 entries for the full investigation chain.
      Confirmed clean on a real-device retest and closed — then
      **reopened 2026-08-28** when the split-layout report reproduced
      again. Decisive new evidence broke the case: a second manual Join
      tap immediately fixed it, proving `useActiveSpeakers`' own
      `refetch()` reconciliation was already correct — nothing automatic
      ever triggered it. Fixed with `useSeatReconciliation` (a
      `canPublish`-vs-`isSpeaker` contradiction watchdog, plus
      visibility/focus resync) and explicit refetch triggers on both
      seat-claim success paths — reusing the existing canonical
      `mySeatNumber`-derived role chain throughout, no new role flag.
      See DECISIONS.md's 2026-08-28 entry. **Confirmed via real-device
      testing 2026-08-26** with no complaints — this specific #18 fix is
      done and shipped in public-beta-v1. The outer checkbox above stays
      unchecked because it belongs to #21's still-open mega-entry, not to
      this sub-item.
      **Discussion Expanded built (issue #21, 2026-08-26, on
      `feature/expanded-comments` — post-public-beta, not yet merged to
      `main`)**: a tap-opened bottom sheet (`ExpandedComments`) for
      intentionally browsing the live comment stream, without turning
      the default room into a conventional chat screen. Opened only from
      an ambient comment bubble's tap — the `data-message-id` seam
      `AmbientComments` carried since Phase 3 specifically for this;
      an earlier version tried opening from the composer's own
      focus/tap instead and that broke the already-approved "tap,
      type, send" flow, so it was reverted. **Its original live-follow/
      jump-to-latest scroll design was replaced outright the same day**
      — see the refinement entry immediately below; this paragraph's
      "jump to latest" description is superseded, kept only for history.
      Reuses the same `messages`/`ChatPanel` compact composer every
      collapsed composition already has — no new backend, no duplicated
      send path. `commentsOpen` is local `useState` in each of the four
      room compositions (portrait/landscape × audience/speaker), never
      lifted to `EventRoom` — no causal path to role/seat/media state at
      all. Schema checked for one-level replies first, per instruction:
      `event_chat_messages` has no self-referencing column anywhere in
      the migrations or `database.ts` — real migration work, not a small
      additive change — so replies are deliberately deferred; the
      comment list is structured (flat, keyed by `message.id`) so a
      future `repliesByParentId` grouping can slot in without a
      rewrite. Desktop untouched (existing persistent sidebar, out of
      scope per instruction). See DECISIONS.md.
      **Refinement pass (issue #21, 2026-08-26, same branch)**, after
      real-device confirmation of the foundation above: `AmbientComments`
      rebuilt from a self-expiring 3-bubble stack into a small
      always-scrollable live-stream feed (no more hard 7s removal — it
      conflicted with being able to scroll back through older ambient
      comments). `ExpandedComments` rebuilt around a frozen
      newest→oldest snapshot (captured on open/refresh only, never
      mutated by background arrivals) with a "↻ N new comments" refresh
      control, replacing the live-follow/jump-to-latest design entirely.
      New "Top Speaker Requests" section (up to 3, FIFO-ordered at the
      time — later superseded by real vote-based ranking the same day,
      see immediately below — kept live rather than frozen, a
      deliberate, reported choice). Double-tap-to-like on comment rows,
      reusing the fully-existing `event_chat_message_reactions`
      schema/RLS/`addReaction` action verbatim — investigated first, no
      schema or backend expansion needed. Grabber-handle swipe-to-close,
      scoped to the handle only so list scrolling can never trigger a
      dismiss. See DECISIONS.md's matching entry for the full reasoning.
      **Request voting + ranked Top 3 + weighted selection (issue #21,
      Phase 1 of the audience voting loop, 2026-08-26, same branch)**:
      first functional piece of "the audience decides who speaks next."
      Request-to-Speak 👍 is now a real vote — one active vote per
      viewer per event, transferable, toggle-off on re-tap (new
      `speaker_request_votes` table, deliberately not a reuse of
      ordinary comment likes — different exclusivity semantics). Top
      Speaker Requests now ranks by real live vote count, not FIFO. When
      a seat opens, the current pool freezes and one candidate is picked
      by weighted-random selection among the vote-ranked Top 3 (fixed
      rank weights `[3,2,1]` — the leader never exceeds 50% odds
      regardless of vote-count magnitude), authoritatively server-side,
      committed via the *existing* Going Live countdown (no second
      winner/join system). A failed pick (withdrawal, this pass's only
      practical failure signal) advances to the next unfailed candidate
      in the same frozen pool; exhausting it returns the seat to normal
      open/request state. A successful join resets the *entire*
      candidate pool (bulk-expire every other pending request, clear
      every vote) — runners-up don't stay queued, the former speaker can
      request again immediately, no cooldown. Two new migrations
      (00000000000019/20), 11 real-database integration tests + 13
      weighted-selection boundary unit tests. **Not built this pass**:
      60-second Continue/Replace protected blocks and the Vote control's
      emphasis UI (Sections F–H) — explicitly phased out per the user's
      own suggested split; see DECISIONS.md's matching entry, including
      the flagged per-speaker-vs-per-pairing conflict resolution Phase 2
      will need.
      **Continue/Replace rounds + preview-only Session Simulator (issue
      #21, Phase 2, 2026-08-26, same branch)**: the Vote control is now
      real. Each occupied seat runs an independent 60-second round
      (`event_speakers.round_number`/`round_started_at`/`round_ends_at`/
      `round_phase`/`closing_ends_at`, migrations 00000000000021/22),
      resolved authoritatively server-side (`resolve_speaker_round` RPC)
      on the same deadline-in-the-row pattern as #18's reconnect grace —
      never by a client's own elapsed-time count. Outcome thresholds
      (0 votes/≤50%/>50%–<66%/≥66%) are centralized in
      `lib/speaker-round.ts` and mirrored in SQL via integer
      cross-multiplication to avoid rounding ambiguity exactly at the
      boundaries. A narrow Replace loss gets a 30-second closing period
      (no further voting) before replacement; a decisive Replace (≥66%)
      replaces at the round boundary with no closing period; replacement
      reuses the *existing* Phase 1 freeze/rank/weighted-selection/Going
      Live path — no second candidate-selection system. Round countdown
      is hidden in production until the final 10 seconds
      (`ROUND_TIMER_REVEAL_SECONDS`) but shown for the round's full
      duration on preview/dev builds, an explicit test-only behavior
      split. New preview-only **Session Simulator** panel
      (`SessionSimulatorPanel`, gated by a new `isPreviewOrDevBuild()`
      check on Vercel's own `VERCEL_ENV` signal — the existing
      `NODE_ENV`-based dev-tools gate would never appear on a deployed
      preview URL, since Next.js force-sets `NODE_ENV=production` for
      every build) drives a generated ~20-person simulated audience
      through the real comment, like, Request-to-Speak, request-vote, and
      round-vote pathways (`insertMessage`, `insertReaction`,
      `requestToSpeakAsGuest`, `castSpeakerRequestVoteAsGuest`,
      `castSpeakerRoundVoteAsGuest`, `claimSpeakerSeat`, `endSpeakerSeat`
      — same functions a real guest session calls), plus deterministic
      buttons to force each round outcome and open a seat. The one
      simulation-specific adapter, `forceRoundDeadline`, backdates a
      round's deadline via the service client and then calls the real
      resolution action, so only the clock is faked — the decision logic
      never is. Real-time (not accelerated) round/closing/Going-Live
      timing is used by default per instruction. 10 real-database
      integration tests for the round state machine plus unit/component
      tests for the decision logic, resolution hook, countdown display,
      vote panel, and simulator gating/actions/panel. See DECISIONS.md's
      matching entry.
      **Simulator UI real-device follow-up (2026-08-27, same branch)**:
      the panel was too large on a phone, covering most of the app.
      Added a minimize control (collapses to a small "SIM" pill without
      stopping the simulation running behind it), shrank the expanded
      panel to a `dvh`-based max-height with internal scroll and
      safe-area-aware positioning, and made it draggable by its header
      (Pointer Events, touch and mouse alike) clamped so it can never go
      fully offscreen and re-clamped on resize/orientation/collapse.
      Presentation-only — no change to simulation behavior, voting,
      round logic, or any production code path. See DECISIONS.md.
      **Round-testing presentation follow-up (2026-08-27, same branch)**:
      the panel still didn't let the user clearly test the round system
      itself. Round-timer badge now reads "Round N · Ns"/"Final Ns" on
      the stage; a seeded simulated speaker's tile shows an unambiguous
      "Simulated speaker" placeholder instead of the generic "Camera
      off" one (cosmetic only, via a `simulatedGuestIds` set threaded
      the same way as `isPreviewBuild`); the round-outcome force
      controls are now per-seat (never one ambiguous global control),
      each with live vote tallies and a projected-outcome line;
      `forceRoundDeadline` now returns the real resolver's outcome so
      forced-outcome feedback always matches what was actually decided;
      "Seed 2 Speakers" reuses the same two stable identities for the
      whole run. Presentation/test-control only. See DECISIONS.md.
      **Reset Session (2026-08-27, same branch)**: Stop only ever halted
      future activity, leaving old test data piled up. New destructive
      "Reset Session" control (inline confirm, not a native dialog)
      deletes every row the current run created — comments, likes,
      requests/votes, seats, round votes — by an exact tracked guest-id
      list, investigated first and chosen over a new `simulation_run_id`
      schema column since the exact-id-list approach is already safe and
      precise without a migration or touching four production RPCs.
      `speaker_selection_rounds` deliberately left untouched (no owner
      column, shared production writer — see DECISIONS.md). 5 new
      real-database integration tests proving real activity survives a
      reset even when paired with same-shape simulated data. See
      DECISIONS.md.
      **Visible-feed follow-up (2026-08-27, same branch)**: the DB
      deletion was correct but old comments stayed visible without a
      manual reload. Root cause: `useLobbyRealtime`/
      `useActiveSpeakerRequests`/`useActiveSpeakers` had never needed
      Postgres `DELETE` handling before (ordinary usage only ever
      UPDATEs these rows) — migration 00000000000023 enables `REPLICA
      IDENTITY FULL` on the four affected tables and each hook gained a
      pure, tested DELETE handler. Fixes every tab watching a room, not
      just the simulator's own. See DECISIONS.md.
      **One-tap full session + replacement loop (2026-08-27, same
      branch)**: Start now auto-seeds both speakers itself (no separate
      Seed 2 Speakers press). Root finding: production's automatic
      promotion resolves "who" from the calling tab's own session — a
      simulated identity has none, so no real pathway could ever promote
      one. New `simulateAdvanceSelection` adapter reuses the identity-
      agnostic freeze/weighted-pick (`ensureActiveSelectionRound`,
      exported) unmodified and only adapts the claim step, gated by one
      safety property verified via a real-DB test built to try to break
      it: it never claims on behalf of a real user's winning request,
      even alone in the pool. Round voting rolls an independent
      continue-bias per round instead of one fixed constant, so outcomes
      vary naturally over a long session. See DECISIONS.md.
      **Corrective pass (2026-08-28, same branch)**: real-device testing
      found the simulator's background promotion loop could race and
      steal a real join, leaving a stuck self-preview with no Leave
      Stage, and confirmed the per-speaker independent round timers were
      the wrong product behavior. `claim_speaker_seat` now raises rather
      than silently replacing an occupied seat (migration 24, closing
      the race for every caller); two immediate follow-up migrations
      fixed a stale-seat regression the guard introduced (25) and a
      round-number-starts-at-2 cosmetic bug (26/27), both caught by the
      real-database test suite before merge consideration. Round model
      rebuilt around one shared `stage_rounds` clock per pairing —
      Continue/Replace still resolved per speaker at that shared
      boundary — while `event_speakers`' own round columns stay
      unchanged in shape, so the existing vote-casting RPCs needed no
      changes. New `useReleaseStuckLocalMedia` hook and a
      `realJoinInProgress` guard on the simulator's own polling loop
      close the two real-device findings generally, not with a
      simulator-specific patch. Simulator panel rebuilt: one shared
      round badge, per-seat force buttons now configure a vote split
      rather than resolving immediately, new "Resolve Round Now"
      control. Full suite 899/899, lint/tsc/build clean. See
      DECISIONS.md and SESSION_LOG.md's Session 42.
      **Second corrective pass (2026-08-28, same branch)**: traced the
      simulator's intermittent incomplete-seeding bug to a real database
      race — `ensure_stage_round`'s cold-start INSERT had no conflict
      handling, so two seats claimed within the same instant (concurrent
      simulator seeding, or two real people) could roll back one seat's
      claim entirely via an uncaught unique-constraint violation, exactly
      matching the "Stop/Start fixes it" symptom. Fixed in the database
      (migration 28: `ON CONFLICT DO NOTHING` plus reading occupancy
      after the round row locks), verified with a real-`Promise.all`
      concurrency test; simulator seeding also made sequential with
      per-step progress logging. Round timer moved from the stage's top
      edge (overlapping the room header's own top-of-screen chrome) to
      dead center — the seam between the two equal-width/height tiles in
      both orientations. Investigated a "wrong candidate replaced the
      speaker" report by re-reading the weighted-selection algorithm end
      to end — found no bug (a rank-1 candidate losing the draw ~33-50%
      of the time is the agreed design) — delivered observability instead
      of touching it: the simulator now shows the frozen Top 3 with real
      weighted odds, the selected candidate, and joining/promoted status.
      Reset Session now deletes the shared `stage_rounds` row when it
      leaves the stage empty (clean "Round 1" next time) or resyncs
      (never deletes) it when a real speaker remains seated. Audience
      Vote panel gained live Continue/Replace percentages (polled only
      while open), a "No votes yet" zero-participation state, a locked
      "Replacement decided" presentation during Final 30s, and a
      "Vote · Ns" final-10s emphasis label. Full suite 919/919,
      lint/tsc/build clean. See DECISIONS.md and SESSION_LOG.md's
      Session 43.
      **Third corrective pass (2026-08-29, same branch)**: removed the
      weighted-random selection draw entirely — highest votes now wins
      deterministically, tie broken by earliest active request, reusing
      `freeze_speaker_candidates`' already-correct ranking rather than
      adding new tiebreak logic. The significant fix: seat claims now
      require Request-to-Speak selection authorization once the stage's
      initial two-speaker pairing has ever been established (reusing
      `stage_rounds.round_number >= 1` as the authoritative, permanent
      signal) — enforced inside `claim_speaker_seat` itself (migration
      29), not just a UI hide, proven with a real-database test where an
      unauthorized claim submitted concurrently with the authorized
      candidate's own claim always loses. Caught (and fixed, migrations
      30/31) a real Postgres gotcha along the way: `CREATE OR REPLACE`
      with a new trailing parameter created a stale, ungoverned function
      overload rather than replacing in place. New shared
      `ParticipantAvatar` component replaces four duplicated inline
      initials circles in `SpeakerTile` and adds avatars to Expanded
      Comments/ambient comments, previously bare text. Vote panel now
      dismisses on outside-tap/Escape without erasing the viewer's
      selection. Full suite 935/935, lint/tsc/build clean. See
      DECISIONS.md and SESSION_LOG.md's Session 44.
      **Fourth corrective pass (2026-08-29, same branch)**: real-device
      testing caught a genuine invariant violation — both seats showing
      "Selecting next speaker…" while a shared round kept counting down.
      `startSimulation` used to flip `running` (and schedule every
      natural-activity loop) before seeding had actually finished or even
      succeeded; rebuilt around an explicit bounded startup state machine
      (`establishInitialPairing`/`establishSeat`, new preview-only
      `startupState`) that only reaches "running" after both seats are
      confirmed occupied *and* the shared round is confirmed active — a
      failure at any step reports why and never half-starts. Startup now
      also respects the same seat-authorization model the third pass
      introduced: seeding a genuinely new stage still uses the direct
      initial-formation join (Case A), but re-seeding an *already-
      established* stage — including the standalone "Seed 2 Speakers"
      button — now goes through the real Request-to-Speak → selection →
      authorized-claim pipeline (Case B), never a bypass, closing a
      simulator-only authorization loophole the same principle the third
      pass established for production. New client-side reactive backstop
      (`reconcileStageRoundAction`/`useStageRoundReconciliation`) calls
      the already-idempotent `ensure_stage_round` whenever any connected
      client's own view of seat occupancy changes, independent of
      whichever server path changed it. New compact "Startup" panel
      section (Simulation/Audience/Seat 1-2/Pairing/Shared round) visible
      only during startup or on failure. Also fixed: toggling Request-to-
      Speak while typing a comment was dismissing the keyboard
      (`onMouseDown` `preventDefault()` on the mic button — stops the
      browser's own default focus-shift before it happens, no
      compensating refocus); ambient comments now fade at the top edge
      via a container-level CSS mask instead of a hard clip (Expanded
      Comments deliberately unaffected — it's a reading surface, not the
      livestream feed). Vote UI left untouched per explicit instruction.
      3 new real-database integration tests
      (`stage-round-invariant.test.ts`) prove the invariant directly:
      zero/one occupied seats never show an active round, exactly one new
      round begins once both are authoritatively occupied, both via fresh
      seeding and via the speaker-loss/replacement path. See DECISIONS.md
      and SESSION_LOG.md's Session 45.
      **Fifth corrective pass (2026-08-29, same branch)**: real-device
      testing found replacement selection getting stuck for far too
      long despite eligible, already-voted-for Request-to-Speak
      candidates existing — traced to selection being event-wide, not
      seat-aware: with two seats open at once, only one candidate could
      ever be reserved (a leftover unique index from the single-seat
      model), and claiming that one seat wiped every other pending
      request — including the second seat's own legitimate candidate —
      via the existing bulk pool reset. Fixed by making reservation
      seat-scoped (`speaker_requests.reserved_seat_number`, migration
      32) — up to two simultaneous reservations per round, one per open
      seat, the pool reset now deferred until no seat has a live
      reservation left. A real-database concurrency test then caught a
      *second*, subtler race the fix's first cut still had: two
      genuinely concurrent selectors could still reserve the same
      candidate for two different seats from a stale snapshot before
      either committed. Closed by moving the whole per-seat reservation
      decision into one atomic, row-locked SQL function
      (`reserve_speaker_candidates_for_seats`, migrations 36/37 — 37 a
      same-pass fix for an ambiguous-column bug 36's first version had,
      caught immediately by the test suite) rather than a TypeScript
      loop making one RPC call per seat. New small-room direct-join
      fallback: once a stage is established, a direct claim is illegal
      everywhere except one narrow case — both seats empty and zero
      eligible requests — with the two just-removed speakers excluded
      from immediately reclaiming it (an authoritative exclusion stamped
      from `event_speakers`' own departure history, cleared once a
      fresh pairing is established — no timer, no ban table). Two
      same-pass corrective migrations (34, 35) fixed real gaps the test
      suite caught in the fallback's own lifecycle: the fallback
      needed to keep covering a second still-empty seat once the first
      filled through it, and a lingering exclusion flag needed clearing
      on an unrelated later occupancy. New reactive selection-
      reconciliation backstop
      (`reconcileSpeakerSelectionAction`/`useSpeakerSelectionReconciliation`),
      same shape as the fourth pass's round-invariant backstop. Ambient
      comments redesigned (avatar, name on its own line, wrapped
      two-line comment text below, replacing the old single-line
      hard-truncated pill) with a new Hide/Show control (a
      `localStorage`-persisted client preference, hides only the
      floating feed — composer/Request-to-Speak/Expanded Comments
      untouched). Vote UI left untouched per explicit instruction. New
      real-database integration test file
      (`two-seat-selection-fallback.test.ts`) covers two-seat
      reservation, all seven fallback cases, and an explicit true-
      concurrency race test proving the atomic RPC. See DECISIONS.md and
      SESSION_LOG.md's Session 46.

      **Sixth corrective pass (2026-08-30, same branch)**: real-device
      testing still found next-speaker promotion "taking far too long" —
      up to two eligible, already-voted-for candidates visible while
      both seats stayed on "Selecting next speaker…". A diagnostic-first
      pass (no fix attempted before tracing) found the *server-side*
      reservation from the fifth pass was never the problem — a new
      real-database timing test measured a representative reservation +
      both seats' authorization at 440ms/432ms/448ms, and
      `useSpeakerSelectionReconciliation` already re-triggers selection
      reactively from any connected client's own occupancy/pending-pool
      changes, not a timer. The actual bottleneck was entirely
      client-side: `useAutomaticPromotion`'s own eligibility check — the
      thing that starts a *candidate's* 3-second Going Live countdown —
      was a blind 4-second `setInterval` poll, completely disconnected
      from the `pendingRequests` Realtime state `EventRoom` already held
      live. Fixed by deriving `isCurrentlyReservedCandidate` from that
      already-live state and checking it first, before falling back to
      the unchanged 4s poll as a bounded backstop for a missed Realtime
      delta — the poll's own claim-time server revalidation is untouched,
      so this closes no existing race-safety guarantee. A companion fix:
      "Selecting next speaker…" was staying visible through a candidate's
      *entire* Going Live countdown even after they'd been reserved —
      `SpeakerStage`/`SpeakerTile` gained a "Joining…" state, checked
      before "Selecting…", so the label only ever means "still executing
      selection." New preview-only SIM diagnostic timeline
      (`useSeatPromotionTiming`) shows real, observed per-seat timestamps
      (vacant → candidates found → reserved → occupied) with a specific
      `WAITING AT: <reason>` line instead of a generic status whenever a
      seat is blocked — never an estimated number. See DECISIONS.md and
      SESSION_LOG.md's Session 47.

      **Seventh corrective pass (2026-08-30, same branch)**: four UX/
      simulator issues found testing the sixth pass's preview, none
      touching speaker selection. `SpeakerStage`'s two-tile arrangement
      now responds to a real CSS container query on the stage's own
      geometry (`@container stage (aspect-ratio < 1.5)`) rather than
      always being side-by-side — the initial threshold (`< 2`) was
      wrong and only caught by loading the app in a real browser at real
      window sizes (jsdom can't execute container queries), since a
      fixed-width sidebar keeps the stage's own aspect ratio roughly
      constant across ordinary desktop windows. The site-wide header now
      hides unconditionally for the whole time a room is mounted
      (previously only in one narrow short-landscape case), recovering
      that space for the stage; a new `RoomInfoOverlay`, rendered once
      by `EventRoom` as a sibling of the composition branch, provides
      the navigation/room-info/account content that lived there, opened
      via the existing status pill (no new floating control) or a new
      small button in desktop's `RoomHeader`. Session Simulator's Reset
      had a real bug, traced before fixing: `useStageRound`'s Realtime
      handler silently discarded every `DELETE` event, so the shared
      round row Reset deletes stayed stuck on screen indefinitely — the
      one production path that ever deletes that row, so likely never
      exercised before. Fixed via a directly-tested pure reducer. Reset
      is now one tap (the confirmation step is gone), and a new shared
      `SimButton` gives every simulator control real pointer-tracked
      press feedback and an automatic executing/disabled state for async
      actions only — what actually prevents a duplicate concurrent
      Reset now, not a second confirmation. See DECISIONS.md and
      SESSION_LOG.md's Session 48.

      **Eighth corrective pass (2026-08-30, same branch)**: a real
      iPhone still showed "Selecting next speaker…" for an extended
      period with a visibly eligible candidate — the sixth pass's
      reactive fix only helps a *real* candidate's own browser tab.
      Diagnostic-first again, this time finding and fixing four
      independent, real bugs rather than one: (1) `useStageRound`/
      `useActiveSpeakerRequests` were missing the visibility/focus
      resync `useSeatReconciliation` already had for seat occupancy —
      live-reproduced as a tab stuck showing a round from before the
      stage was even established, long after the real round had
      advanced; (2) simulated candidates had no reactive promotion path
      at all (only production's own poll), fixed with a sequential
      drain after two earlier attempts were each proven wrong live
      (both left a second simultaneously-open seat's own reservation
      permanently unclaimed), plus a `try/finally` closing a related bug
      where an unhandled rejection silently disabled the whole mechanism
      for the rest of a run; (3) the simulator's own startup retry
      budget (750ms total) was measured too tight for this environment's
      real reconciliation round-trip time, live-reproduced to fail
      startup outright and silently disable every subsequent promotion
      mechanism — widened to a 6s ceiling; (4) a genuine server-side bug,
      not simulator-specific — `withdraw_speaker_request(_as_guest)`'s
      "mark this round exhausted" check only ran when the withdrawing
      request was itself the round's reserved candidate, so a
      frozen-but-never-reserved straggler withdrawing could leave a
      round stuck `active` forever, making every later-arriving request
      permanently invisible to selection (migration 00000000000038 —
      applied to the linked project). A related, deeper finding
      (`reset_speaker_candidate_pool`'s own reservation check being
      event-wide rather than round-scoped) was surfaced rather than
      fixed, as a genuine design decision rather than an obvious bug.
      See DECISIONS.md and SESSION_LOG.md's Session 49.

      **Ninth corrective pass (2026-08-30, same branch)**: a focused
      re-investigation, discarding a prior branch entirely, found the
      round boundary itself never triggered selection — the two
      authoritative functions that resolve a round/closing-period
      boundary and create a vacancy (`resolveStageRoundAction`,
      `resolveSeatClosingAction`) never called `ensureActiveSelectionRound`
      directly; selection depended entirely on a separate chain (DB
      write → Realtime delivery → a client's own reconciliation effect
      → a second Server Action call). Fixed by calling the same
      idempotent, row-locked selection function directly from both
      boundary actions, immediately after the vacancy is created —
      collapsing that chain into the call that already resolves the
      boundary, not a second competing selection path. A real-database
      test proved 10 consecutive replacement cycles in one
      continuously-running event, no reset between, with real measured
      boundary→reservation latency of 719-824ms (avg 747ms); corroborated
      live in a real browser (548-559ms observed). Session Simulator
      gained a collapsible "Selection Forensics" panel distinguishing
      the ranking frozen at the boundary from the live current ranking.
      Deliberately not extended to `checkAndEvictInactiveSpeaker`/
      `leaveSpeakerSeat` (same gap exists there, left for a future pass —
      this pass's own instructions scoped it to the round boundary
      specifically). See DECISIONS.md and SESSION_LOG.md's Session 50.

      **Tenth corrective pass (2026-08-30, same branch)**: the deferred
      extension happened this pass, plus more — a full trigger-matrix
      audit found the identical gap in `leaveSpeakerSeat`,
      `checkAndEvictInactiveSpeaker`, `requestToSpeak`,
      `withdrawSpeakerRequest`, and `claimOpenSeat`'s failed-claim path;
      all five now call the same reconciliation mechanism via a new
      failure-swallowing `bestEffortReconcileSelection` helper. A
      genuinely new mechanism (migration 00000000000039,
      `release_failed_speaker_claim`) releases and advances past a
      candidate whose authorized claim itself failed — previously left
      stuck forever — deliberately without permanently disqualifying
      them (a real design decision, flagged and proven with a real-
      database test showing the same candidate winning a later
      independent round). Dual-replacement/fallback chains (two seats,
      three ranked candidates; a winner cancelling advances the fallback
      without disturbing the other seat's valid reservation) proved with
      real-database tests, not just asserted unchanged. Separately: a
      real-device report of active-session diagnostics showing no sense
      of "who's next" turned out to be a genuine diagnostics-clarity gap,
      not a selection bug (`ensureActiveSelectionRound` already correctly
      refuses to reserve early) — fixed by adding a "Live Replacement
      Queue"/"Established mode"/"Selected-Reserved" summary to Selection
      Forensics. A real Reset Session bug was traced to an actual
      ordering race (a scheduled background write landing in the
      database *after* Reset's own DELETE already ran, not a wrong
      guest-id list or stale client rendering) and fixed with a delayed
      follow-up sweep. New preview-only "Copy Debug Snapshot" tool for
      pasting real-device state directly into a future session —
      deliberately scoped down from the full requested spec (no
      persisted rolling event-history subsystem this pass; flagged as
      deferred). See DECISIONS.md and SESSION_LOG.md's Session 51.
- [ ] Refresh/reconnect media recovery + speaker reconnect grace period
      (2026-08-22, real-device follow-up) — a seated speaker who
      hard-refreshed and re-activated media published correctly but never
      saw their own self-preview return; `activateMedia()` now delegates
      to the existing `prepareLocalMedia()` (issue #22) instead of a
      second, incomplete acquisition path, fixing that and, as a side
      effect, a failed-attempt-permanently-hides-the-retry-button bug too.
      Separately, the LiveKit webhook's immediate (no-grace-period)
      eviction on `participant_left` was exposed as a real gap — original
      fix added `useSpeakerReconnectGrace`/`checkAndEvictDisconnectedSpeaker`
      with a 25s client-side-triggered, server-re-validated grace period.
      **Made genuinely server-authoritative (issue #18 UX finding,
      2026-08-24)**: the "grace period" was still a client-side
      illusion — the webhook released the seat immediately, no grace at
      all server-side. New migration `00000000000016` adds
      `event_speakers.disconnected_at` plus
      `mark_speaker_disconnected`/`mark_speaker_reconnected`/
      `release_expired_disconnected_speaker` (race-safe via a single
      atomic `UPDATE ... WHERE`, applied to the real linked project);
      the webhook now starts/clears the clock on
      `participant_left`/`participant_joined` instead of evicting
      immediately, and the actual 11-second boundary (down from the
      cosmetic 25s) is enforced by Postgres, not a client timer. See
      DECISIONS.md's seventeenth 2026-08-24 entry — includes real-database
      -verified coverage (not mocks) for every race scenario. **Not
      checked off** — pending the user's own real-device confirmation
      (refresh, and a real temporary disconnect/reconnect cycle). See
      ARCHITECTURE.md and DECISIONS.md.
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
