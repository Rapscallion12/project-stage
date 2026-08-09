# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Dates are session dates, not deploy dates — nothing has been deployed yet.

## [Unreleased]

### Added

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
- The Supabase CLI still isn't set up; every migration so far has been
  applied by hand via the SQL Editor.
