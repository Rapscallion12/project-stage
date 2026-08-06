# Roadmap

Phased by dependency order — each phase's features generally require the
data model or infrastructure from the previous phase. Within a phase, order
is a suggestion, not a requirement.

Check off items as they're completed and update this file in the same
commit as the feature. See SESSION_LOG.md for session-by-session detail.

Every item below is subject to the [responsive design principle](./PRODUCT.md#responsive-design-principle)
and its [testing checklist](./ARCHITECTURE.md#testing--definition-of-done) —
not repeated per line item to avoid clutter, but not optional either.

Every item is also subject to the
[progressive authentication model](./PRODUCT.md#progressive-authentication-model):
unless explicitly marked **(account-only)** below, a feature must work for a
guest with no session at all. When in doubt about a specific line item's
guest eligibility, PRODUCT.md's guest/account capability lists are the
source of truth, not this file.

## Phase 0 — Foundation

- [x] Repository, Next.js/TS/Tailwind scaffold, documentation suite
- [x] Supabase client setup (browser + server) and session-refresh proxy
- [x] `profiles` table + auto-provisioning trigger
- [x] Landing page (guest-first — no signup/login funneling as the primary
      call to action; see DECISIONS.md for the correction that drove this)
- [x] Authentication, as an **optional account upgrade** (sign up, log in,
      log out) — not an entry gate. No route redirects an unauthenticated
      visitor away.
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
- [ ] Event list / event detail pages — guest-viewable, no account required
- [ ] Waiting room (pre-event lobby, countdown to start) — guest-viewable
- [ ] Basic moderator flag on `profiles` **(account-only, by definition —
      moderators are accounts)** (needed before moderator controls in
      Phase 3, cheap to add alongside events)

## Phase 2 — Live room (two speakers + audience)

- [ ] Guest session mechanism: anonymous session cookie (see
      [ARCHITECTURE.md's guest identity design](./ARCHITECTURE.md#guest-identity)),
      minted on first visit, used for presence/audience count and as the
      prerequisite for Phase 3's guest votes/reactions.
- [ ] LiveKit integration (install SDK, token endpoint, room component)
- [ ] `event_speakers` table **(account-only** — speakers must have an
      account; see PRODUCT.md)
- [ ] Two-speaker live audio/video room, with adaptive video quality and
      reconnect handling on flaky networks, and explicit handling of both
      camera/microphone permission granted and denied
- [ ] Audience viewing (join a live room as a non-speaker) — guest-viewable,
      no account required
- [ ] Audience count (Supabase Realtime presence) — counts guests and
      account holders alike
- [ ] Emergency leave — available to guests and account holders alike

## Phase 3 — Audience power features

- [ ] `speaker_queue` table + request-to-speak flow **(account-only** — this
      is the product's clearest "create an account to do this" moment; use
      the account-prompt copy from PRODUCT.md, inline, not a redirect)
- [ ] Continue voting — guest-eligible, rate-limited/deduped per
      ARCHITECTURE.md's guest identity + abuse-prevention design
- [ ] Replace speaker voting — guest-eligible, same as above
- [ ] Timer extension (tied to continue voting) — guest-eligible by
      inheritance from continue voting
- [ ] Live emoji reactions (Realtime broadcast, ephemeral — no `reactions`
      table needed unless we decide to persist them for analytics) —
      guest-eligible, rate-limited per identity (guest or account, same
      limit)
- [ ] Comments + "top comments" ranking **(account-only** — per PRODUCT.md;
      guests may still *view* the comment feed)
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

- **No live Supabase or LiveKit credentials exist in this environment.**
  Phase 0's auth and Phase 2's video work are built against the SDKs but are
  untested against real infrastructure. The first session with real
  credentials should smoke-test signup/login end-to-end before building
  further.
- **No CI pipeline yet.** `npm run lint` / `npm run build` are run manually
  each session — see SESSION_LOG.md for the last known-good status.
- **The landing page's primary CTA is a placeholder anchor link**
  (`#how-it-works`), not a real guest-join flow — there's nowhere to send a
  guest yet since Phase 1's event list doesn't exist. Once Phase 1 ships,
  repoint `src/components/landing/hero.tsx`'s CTA to the events list (or
  straight into a live event if one's running) so the guest funnel in
  PRODUCT.md is actually reachable end to end.
