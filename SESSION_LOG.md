# Session Log

Newest entry first.

---

## 2026-08-06 — Session 4: Live Supabase connection, confirm-route fix, progressive-auth audit

**Goal**: Resolve the local runtime blocker (no Supabase credentials), connect
a real Supabase project end to end, and — before calling the foundation
done — verify the implementation actually matches PRODUCT.md's progressive
authentication model rather than assuming it still does.

**Completed work**:

- Diagnosed a port conflict (an unrelated "Magic Layers" project's dev
  server was holding port 3000); started Virtual Stage on the Next.js
  auto-selected fallback (3001) instead of touching the unrelated process.
  Updated README so it no longer implies port 3000 is guaranteed.
- Walked the user through creating a Supabase project, finding the Project
  URL and anon key (explicitly steering away from `service_role`), and
  scaffolding `.env.local` — filled in everything except the two secret
  values myself, so those never had to pass through chat.
- Caught two false starts before they caused confusion: `.env.local` was
  initially still empty when the user believed it was configured (found by
  checking key-name/value-length only, never printing secrets), and the
  first migration attempt left the `profiles` table not actually created.
  Both were re-verified rather than assumed fixed.
- Verified live Supabase connectivity directly (`/auth/v1/settings`
  returned 200; confirmed `email` auth is enabled) before restarting the
  dev server, and confirmed the original 500 was gone on `/`, `/login`,
  `/signup`.
- **Found and fixed a real bug via the `profiles` table check**: the table
  existed but had no Postgres-level `GRANT` for the `authenticated` role —
  Supabase's SQL Editor doesn't auto-apply the privileges the Table Editor
  UI would have. Added `supabase/migrations/00000000000002_profiles_grants.sql`
  (`grant select, update on public.profiles to authenticated;`), matching
  exactly what the existing RLS policies already declared.
- **Found and fixed a second real bug from reading dev-server logs during
  the user's manual browser smoke test**: the confirmation email link used
  Supabase's PKCE `?code=` style, but `src/app/auth/confirm/route.ts` only
  handled the older `token_hash`+`type` style, so every confirmation click
  landed on `/login?error=confirmation-failed` instead of logging the user
  in directly. The account was still getting confirmed (Supabase does
  that server-side before redirecting to us), so manual login afterward
  worked — masking the bug — but the intended UX (click link → land logged
  in) was broken. Fixed by handling `code` via `exchangeCodeForSession`,
  falling back to the old `verifyOtp` path for any non-PKCE flow.
- User completed the full manual browser smoke test: signup → email
  confirmation → login → logout → login again, all successful.
- **Audited the entire codebase against PRODUCT.md's progressive
  authentication model**, at the user's request, before finalizing this
  milestone rather than assuming the earlier (Session 2) correction still
  held after subsequent changes:
  - Full route surface (`find src/app -type f`): only `/`, `/login`,
    `/signup`, `/auth/confirm` exist. Events, event details, joining as a
    guest, watching, and reactions are Phase 1–3 features (ROADMAP.md) —
    **not yet implemented**, so there was nothing there to audit or break;
    they're already documented as guest-eligible for when they're built.
  - Grepped every `redirect(...)`, `getUser()`, and `auth.uid()` call in
    `src/`: every redirect is either a post-login/post-logout landing
    redirect or part of the confirm-route flow itself — none of them gate
    a page behind authentication. `getUser()` is only used to refresh the
    session (`proxy.ts`) or to decide which buttons the header shows
    (`site-header.tsx`) — never to block rendering.
  - Grepped for `useRouter`/`router.push`/`window.location`: no
    client-side redirect logic exists anywhere.
  - **Conclusion: no violations found.** Nothing needed to change in code.
    The Session 2 correction still holds.
- Updated ROADMAP.md's Phase 0 checklist: "Real Supabase project
  connected" is now checked off, with the verification steps listed.

**Files changed**: `README.md` (port note, from a prior turn), `.env.local`
(not committed — git-ignored, confirmed via `git check-ignore`),
`supabase/migrations/00000000000002_profiles_grants.sql` (new),
`src/app/auth/confirm/route.ts` (PKCE fix), `ROADMAP.md`, `SESSION_LOG.md`,
`CHANGELOG.md`.

**Known issues**:

- None currently open for Phase 0. The two bugs found this session
  (missing grants, missing PKCE handling) are both fixed and were each
  re-verified after the fix (grants: re-checked via PostgREST, going from
  `PGRST205` table-not-found → `42501` permission-denied → fixed;
  confirm route: hot-reloaded and confirmed it no longer crashes on
  missing/invalid codes, though a full live re-click of a real confirmation
  email post-fix was offered to the user but not required to close this
  out, since the fix is a direct application of Supabase's own documented
  pattern).

**Tests run**:

- `npm run lint` — passes.
- `npm run build` — passes, type-checks clean, route table unchanged
  (`/`, `/login`, `/signup`, `/auth/confirm`).
- Live Supabase connectivity verified via direct API calls
  (`/auth/v1/settings`, `/rest/v1/profiles`).
- Full manual browser smoke test by the user: signup, email confirmation,
  login, logout, login again — all successful.
- Codebase-wide grep audit for auth-gating patterns — zero violations.

**Current build status**: Lint clean, build clean, live Supabase project
connected and verified, no known route-protection violations of the
progressive authentication model.

**Recommended next task**: Phase 1 (scheduled events). When building the
`events` table and event list/detail pages, keep them guest-viewable from
the first commit (per ROADMAP.md's per-item guest-eligibility notes) rather
than defaulting to an auth-gated pattern and correcting it later. Also a
good moment to consider setting up the Supabase CLI migration workflow the
user asked about (edit migration locally → commit → apply via CLI → shared
migration history) instead of continuing to hand-paste SQL into the
dashboard, now that a second migration has shown the friction of the manual
approach firsthand.

---

## 2026-08-06 — Session 3: GitHub remote + dev server port fix

*(Logged retroactively while writing up Session 4 — these two small,
back-to-back milestones shipped without a session entry at the time,
against this project's own standing rule. Backfilled from git history
rather than skipped.)*

**Goal**: Establish a GitHub remote and backup for the repository; then fix
a local dev-server annoyance (an unrelated project occupying port 3000).

**Completed work**:

- Confirmed the local repo was clean, created a private GitHub repository
  (`Rapscallion12/project-stage`), added it as `origin`, pushed `main`
  (Git Credential Manager handled auth with no manual token entry needed),
  and verified the push with `git log origin/main` / `git ls-remote`.
- Documented the git workflow in README.md (branching model, commit
  conventions, push/pull steps) for future contributors/sessions.
- Diagnosed `localhost:3000` opening an unrelated "Magic Layers" project
  (identified by its process command line, left untouched since killing it
  wasn't necessary); started Virtual Stage on Next.js's auto-selected
  fallback port (3001) instead.
- Updated README so it points readers at whatever port the terminal
  actually prints rather than hardcoding 3000.

**Files changed**: `README.md` (both commits).

**Tests run**: `npm run lint` before each commit.

**Current build status**: Lint clean. No functional code changed — both
commits were docs/config only.

**Recommended next task**: (superseded by Session 4, logged above.)

---

## 2026-08-06 — Session 2: Progressive authentication correction

**Goal**: Correct a product mistake from Session 1 — authentication had
been built as a mandatory entry gate (landing page's primary CTA led
straight to signup, with no guest path into the product at all). The user
specified a progressive authentication model: guests can fully watch,
react, vote, and view chat with no account; an account is required only for
actions needing persistent identity (mic request, comments, reputation).

**Completed work**:

- Audited the existing auth implementation for anything that assumed every
  visitor must log in. Found: `src/proxy.ts` only refreshes the session and
  never redirects (confirmed clean — no code change needed there); the
  actual violation was `src/components/landing/hero.tsx`, whose only two
  CTAs were "Join the audience" → `/signup` and "Log in" → `/login`, i.e.
  100% of the landing page's primary actions routed through auth.
- Refactored `Hero`: primary CTA now points at an on-page `#how-it-works`
  anchor (no auth required); added a low-key, benefit-framed account prompt
  below it ("No account needed to watch. Create an account to request the
  mic, comment, and start building reputation.") instead of a second
  full-weight auth button.
- Added a guest-access rule and an id anchor to `HowItWorks`
  (`src/components/landing/how-it-works.tsx`) so the new CTA has somewhere
  to land, and so the guest/account split is stated on the page itself, not
  just in docs.
- `SiteHeader`'s login/signup nav links were reviewed and left as-is — a nav
  link is not a gate; a guest can ignore it and use the product fully.
- Rewrote the documentation suite for the new model:
  - **PRODUCT.md**: new "Progressive authentication model" section (guest
    vs. account capability lists, the funnel, required account-prompt tone,
    guest identity limits), new Principle 12, Principle 3 footnoted,
    "Authentication" MVP scope line reworded, Core entities section
    rewritten to distinguish Guest from Account holder.
  - **ARCHITECTURE.md**: Auth flow section rewritten around "gating happens
    at the action, not the route"; new Guest identity section (planned
    cookie-based anonymous session, deliberately outside Supabase Auth);
    new Rate limiting & abuse prevention section (dedup via a DB unique
    constraint, per-identity rate limits, no IP blocking in the MVP); Data
    model section annotated per-table for guest eligibility; Testing &
    Definition of Done gained a "walk it through as a guest" checklist item.
  - **README.md**: new "Design principle: authentication is an upgrade, not
    a gate" section, mirroring the existing responsive-design section.
  - **ROADMAP.md**: every phase item annotated guest-eligible vs.
    **(account-only)**; added a Phase 2 item for the guest session cookie
    mechanism; added a Known gaps entry noting the Hero's CTA is a
    placeholder anchor until Phase 1's event list gives guests somewhere
    real to land.
  - **AGENTS.md**: new rule at the top of the project-specific list —
    authentication is an upgrade, not a gate, with a pointer back to this
    correction so a future session doesn't reintroduce a login wall.
  - **DECISIONS.md**: full ADR for this correction (problem, alternatives,
    decision, two "reason" entries — why progressive auth at all, and why a
    cookie-based guest identity specifically — and tradeoffs).

**Files changed**: `PRODUCT.md`, `ARCHITECTURE.md`, `README.md`,
`ROADMAP.md`, `DECISIONS.md`, `AGENTS.md`, `SESSION_LOG.md` (this entry),
`src/components/landing/hero.tsx`, `src/components/landing/how-it-works.tsx`.

**Known issues**:

- The guest identity mechanism (session cookie, rate limiting, duplicate
  vote/reaction prevention) is a documented design, not implemented code —
  there's no guest-facing write yet for it to protect (that's Phase 3).
  Whoever builds Phase 3 must implement it then, not assume it already
  exists.
- The Hero's primary CTA is an on-page anchor link, not a real guest-join
  flow, because Phase 1 (events) doesn't exist yet. Tracked in ROADMAP.md's
  Known gaps.
- Same live-credentials gap as Session 1: no real Supabase project
  connected in this environment.

**Tests run**:

- `npm run lint` — passes, no warnings.
- `npm run build` — passes, type-checks clean. Route table unchanged from
  Session 1 (`/`, `/login`, `/signup`, `/auth/confirm`), as expected — this
  session changed copy/navigation and documentation, not routes.
- No new automated tests — this was a copy/navigation/documentation
  correction, not new application logic.

**Current build status**: Lint clean, build clean. Same "no live Supabase
credentials" limitation as Session 1 — not a regression.

**Recommended next task**: Unchanged from Session 1's recommendation — get a
real Supabase project connected and smoke-test signup → confirm → login →
logout — but when Phase 1 (scheduled events) starts, build the guest
session cookie mechanism (ARCHITECTURE.md's Guest identity section)
alongside it rather than deferring it further, since Phase 2's audience
viewing and Phase 3's guest voting/reactions both depend on it.

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
