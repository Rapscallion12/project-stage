# Roadmap

Phased by dependency order — each phase's features generally require the
data model or infrastructure from the previous phase. Within a phase, order
is a suggestion, not a requirement.

Check off items as they're completed and update this file in the same
commit as the feature. See SESSION_LOG.md for session-by-session detail.

Every item below is subject to the [responsive design principle](./PRODUCT.md#responsive-design-principle)
and its [testing checklist](./ARCHITECTURE.md#testing--definition-of-done) —
not repeated per line item to avoid clutter, but not optional either.

## Phase 0 — Foundation

- [x] Repository, Next.js/TS/Tailwind scaffold, documentation suite
- [x] Supabase client setup (browser + server) and session-refresh proxy
- [x] `profiles` table + auto-provisioning trigger
- [x] Landing page
- [x] Authentication (sign up, log in, log out)
- [ ] Real Supabase project connected (currently no live credentials in this
      environment — `.env.local` must be created by a human or a session
      with access to a Supabase account)
- [ ] Manual responsive/device verification of landing + auth pages against
      the testing checklist. The responsive design principle was adopted
      partway through the session that built these pages; layouts use
      responsive Tailwind utilities throughout, but the full checklist
      (real phone widths, throttled network, etc.) has not been walked yet
      in a real browser — see SESSION_LOG.md.

## Phase 1 — Scheduled events & waiting room

- [ ] `events` table + migration
- [ ] Event list / event detail pages
- [ ] Waiting room (pre-event lobby, countdown to start)
- [ ] Basic moderator flag on `profiles` (needed before moderator controls
      in Phase 3, cheap to add alongside events)

## Phase 2 — Live room (two speakers + audience)

- [ ] LiveKit integration (install SDK, token endpoint, room component)
- [ ] `event_speakers` table
- [ ] Two-speaker live audio/video room, with adaptive video quality and
      reconnect handling on flaky networks, and explicit handling of both
      camera/microphone permission granted and denied
- [ ] Audience viewing (join a live room as a non-speaker)
- [ ] Audience count (Supabase Realtime presence)
- [ ] Emergency leave

## Phase 3 — Audience power features

- [ ] `speaker_queue` table + request-to-speak flow
- [ ] Continue voting
- [ ] Replace speaker voting
- [ ] Timer extension (tied to continue voting)
- [ ] Live emoji reactions (Realtime broadcast, ephemeral — no `reactions`
      table needed unless we decide to persist them for analytics)
- [ ] Comments + "top comments" ranking
- [ ] Report button
- [ ] Basic moderator controls (mute/remove speaker, end event early)

## Phase 4 — Reputation & reliability

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

- **No live Supabase or LiveKit credentials exist in this environment.**
  Phase 0's auth and Phase 2's video work are built against the SDKs but are
  untested against real infrastructure. The first session with real
  credentials should smoke-test signup/login end-to-end before building
  further.
- **No CI pipeline yet.** `npm run lint` / `npm run build` are run manually
  each session — see SESSION_LOG.md for the last known-good status.
