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

- [ ] LiveKit integration (install SDK, token endpoint, room component) —
      including the write path for `event_speakers` (who's allowed to
      occupy a seat), deferred here by design; see issue #1/DECISIONS.md.
- [x] `event_speakers` table (issue #1) **(account-only** — speakers must
      have an account; see PRODUCT.md). Append-only occupancy episodes,
      room-agnostic, read-only from the app until this issue's write path
      lands. See ARCHITECTURE.md's Data model section and DECISIONS.md.
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
