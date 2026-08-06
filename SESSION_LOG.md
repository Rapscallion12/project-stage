# Session Log

Newest entry first.

---

## 2026-08-06 — Session 1: Bootstrap, landing page, authentication

**Goal**: Stand up the repository from an empty directory and deliver the
first vertical slice of the MVP (landing page + authentication), per the
project's standing instructions.

**Completed work**:

- Initialized git repo (`main` as default branch).
- Scaffolded Next.js 16 + TypeScript + Tailwind CSS v4 via `create-next-app`
  (worked around the tool's npm-name restriction — see DECISIONS.md — since
  the working directory is `Virtual Stage`, not a valid package name).
- Read Next.js 16's bundled docs (`node_modules/next/dist/docs/`) before
  writing routing/auth code, since the version is newer than training data.
  Found and adopted the Middleware → Proxy rename (`src/proxy.ts`) before it
  could cause a silent bug.
- Installed `@supabase/supabase-js`, `@supabase/ssr`, `zod`, `clsx`,
  `tailwind-merge`. Deliberately did not install LiveKit yet (see
  DECISIONS.md).
- Built the `src/lib/supabase/{client,server}.ts` factories, `src/proxy.ts`
  session refresh, and `src/types/database.ts` (hand-written, mirrors the
  migration until a real Supabase project exists to generate from).
- Wrote `supabase/migrations/00000000000001_profiles.sql`: `profiles`
  table, RLS policies, and an auth-trigger that provisions a profile row on
  signup.
- Built UI primitives (`Button`/`ButtonLink`, `Input`/`Label`), the landing
  page (hero + how-it-works), and full auth flow (signup with email
  confirmation, login, logout, session-aware header) as Server Actions.
- **Mid-session, the user gave a permanent architecture/product
  instruction**: responsive design (desktop and mobile both first-class,
  intentionally designed per screen size, graceful degradation on poor
  networks) is a standing principle, not a per-feature judgment call. Wrote
  it into PRODUCT.md, ARCHITECTURE.md (with a testing/Definition-of-Done
  checklist), README.md, AGENTS.md, and ROADMAP.md; retrofitted the
  already-built landing/auth UI (mobile CTA stacking, 16px inputs to avoid
  iOS auto-zoom-on-focus, 44px minimum touch targets on buttons).
- Wrote the full documentation suite: README, PRODUCT, ARCHITECTURE,
  ROADMAP, DECISIONS, CHANGELOG (this entry's companion).

**Files changed**: this is the initial commit — see `git log` /
`git show --stat` rather than enumerating here, since the whole tree is new.

**Known issues**:

- No live Supabase project — `.env.local` does not exist in this
  environment (no credentials were available). Verified manually: running
  `npm run dev` without it produces a clear, correct error ("Your project's
  URL and Key are required to create a Supabase client!") from
  `src/proxy.ts`, not a silent failure or a crash elsewhere — so the
  failure mode is at least legible for the next session. Auth has **not**
  been exercised end-to-end against a real backend.
- The responsive design principle was adopted partway through this session.
  Landing/auth pages use responsive Tailwind utilities throughout and were
  retrofitted for the specific mobile issues caught on review (see above),
  but have not been walked through the full manual device/network testing
  checklist in ARCHITECTURE.md — no real devices or network throttling
  available in this environment. Flagged in ROADMAP.md Phase 0.

**Tests run**:

- `npm run lint` — passes, no warnings.
- `npm run build` — passes (Next.js 16 + Turbopack), type-checks clean.
- Manual smoke test: started `npm run dev`, confirmed `/` returns HTTP 500
  with the expected "URL and Key are required" Supabase error (proving the
  proxy's error path is reachable and correctly attributed) since no real
  Supabase credentials exist yet; confirmed the build's static/dynamic
  route table looks correct (`/`, `/login`, `/signup`, `/auth/confirm` all
  present, all dynamic due to per-request auth state in the header).
  Stopped the dev server afterward. No automated tests exist yet — none
  were warranted for this UI/plumbing-heavy slice; the first logic worth
  unit-testing (e.g. queue ordering) arrives in Phase 3.

**Current build status**: Lint clean, build clean, app not runnable
end-to-end yet for lack of real Supabase credentials (expected, tracked
above — not a regression to fix next session, just a prerequisite).

**Recommended next task**: Get a real Supabase project connected
(`.env.local` from `.env.local.example`), apply
`supabase/migrations/00000000000001_profiles.sql`, and smoke-test
signup → email confirmation → login → logout end to end before starting
Phase 1 (scheduled events). Then walk the landing/auth pages through the
responsive testing checklist in ARCHITECTURE.md now that real
devices/network throttling are presumably available outside this sandboxed
environment.
