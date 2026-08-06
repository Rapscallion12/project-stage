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

### Known limitations

- No live Supabase project is connected in this environment — auth is
  implemented against the SDK but has not been exercised against a real
  backend. Runtime without `.env.local` fails with a clear Supabase error
  (verified manually this session), not a silent failure.
- LiveKit is not yet integrated (deferred to Roadmap Phase 2 — see
  DECISIONS.md).
