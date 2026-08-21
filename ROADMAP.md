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

### Video-first participation redesign (issues #19–#25)

Design work following the two-device AV checkpoint (`prototype-live-av-stable`,
Session 21) — reduces participation friction (direct-join, composer-integrated
mic requests, automatic promotion) and replaces the room's stacked-block
layout with a video-first, overlay/scrim-based one, ahead of #18's visual
polish. Sequenced by dependency, not left as one large "build the live room
UX" issue — see DECISIONS.md for the full design reasoning (scrim vs. video
opacity, dead-zone gesture mechanism, voting-evaluation scaling, the
room-format seam). #18 is now the final step in this sequence, not a
separate one.

- [ ] Room format seam (issue #19) — additive `events.format` column,
      defaulted/constrained to `'main_stage'` today, so Main Stage's
      two-seat/voting/ranking assumptions don't become inseparable from
      "what a room is" once Roulette/Spotlight/Group Stage exist. Those
      three formats are documented, not built.
- [ ] Video-first room shell (issue #20) — video-dominant base layer that
      stays geometrically stable across focus changes, a scrim/overlay
      compositing primitive (opacity/transform only, never resizing the
      video element itself), a fixed self-preview slot, a structural
      (inert) speaker divider, and removal of issue #15's diagnostics
      panel from normal UI (kept dev-only).
- [ ] Chat/voting focus interactions (issue #21) — dead-zone-gated
      drag-handle gestures (bottom-sheet pattern) for reaching chat-focus
      and voting-focus, tap always available independent of the gesture,
      and `ChatPanel` made a single continuously-mounted component so
      draft text/scroll position/mic-request-mode survive focus changes.
- [ ] Composer mic-request + candidate readiness/self-preview (issue
      #22) — mic-mode toggle built into the chat composer (no separate
      "Request the mic" control), local media acquired once via
      `createLocalTracks()` at request time, a persistent spatially-stable
      self-preview that morphs (not remounts) from candidate to active
      speaker, and promotion via `publishTrack()` on the already-held
      tracks — no second `getUserMedia()` call.
- [ ] Direct empty-seat join + automatic ranked promotion (issue #23) —
      an empty seat with no real queue can be joined directly; a queued
      seat auto-promotes the highest-ranked eligible *ready* candidate
      server-side, no manual `claimOpenSeat` race, unready candidates
      yield via a bounded grace period.
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
