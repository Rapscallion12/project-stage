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

### Fixed

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

### Known limitations

- LiveKit is not yet integrated (deferred to Roadmap Phase 2 — see
  DECISIONS.md).
- Events, event details, joining as a guest, watching, and reactions
  (Phases 1–3) are not yet implemented — there is currently nothing to
  audit or test for those beyond confirming they're documented as
  guest-eligible in PRODUCT.md/ROADMAP.md for when they're built.
