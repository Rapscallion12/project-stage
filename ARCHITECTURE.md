# Architecture

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Frontend framework | Next.js 16 (App Router) | See the Next.js 16 note below — Middleware was renamed to Proxy. |
| Language | TypeScript | Strict mode, as scaffolded by `create-next-app`. |
| Styling | Tailwind CSS v4 | Config-free (CSS-first) Tailwind v4; see `src/app/globals.css`. |
| Backend | Supabase (Postgres, Auth, Realtime) | One project covers DB, auth, and realtime — no separate backend service in the MVP. |
| Realtime | Supabase Realtime | Used for reactions, comments, votes, presence/audience count. Not yet implemented. |
| Video | LiveKit | Used for the two-speaker live audio/video. Not yet integrated — no LiveKit dependency is installed until the live-room feature is built, to avoid unused/untested code in the tree. |
| Deployment | Vercel | Not yet deployed. Local dev only so far. |

### Next.js 16: read this before writing app code

Next.js 16 is newer than most models' training data and has real breaking
changes. Before writing routing, caching, or data-fetching code, check
`node_modules/next/dist/docs/01-app/` (the version installed in *this* repo)
rather than relying on memory. Two changes that already bit us once:

- **Middleware is now called Proxy.** The convention is `src/proxy.ts`
  (co-located with `src/app`), exporting a function named `proxy` (or a
  default export). See `src/proxy.ts` for the session-refresh implementation.
- **`PageProps<'/route'>` / `LayoutProps<'/route'>`** are globally available
  generated helper types for page/layout props (including `params` as a
  `Promise`) — prefer them over hand-rolling prop types.

## Folder structure and layering

```
src/
  app/            Routes only: layout.tsx, page.tsx, route.ts. No business
                   logic lives here beyond composing components and calling
                   lib/ functions. Keeps routes readable and lets business
                   logic be unit-tested independent of Next.js.
  components/
    ui/           Generic presentational primitives (Button, Input, Card).
                   No data fetching, no Supabase imports.
    landing/      Landing-page-specific composed components.
    auth/         Auth form components (client components; call server
                   actions, never call Supabase directly from the browser
                   for auth mutations).
  lib/
    supabase/
      client.ts   Browser Supabase client (Client Components).
      server.ts   Server Supabase client (Server Components/Actions/Route
                   Handlers) — reads/writes the session via cookies.
    utils.ts      Small framework-agnostic helpers (e.g. cn()).
  types/
    database.ts   Hand-written Supabase schema types (see note below).
  proxy.ts        Refreshes the Supabase session cookie on every request.
supabase/
  migrations/     Hand-authored, numbered SQL migrations — the source of
                   truth for the schema until a live Supabase project
                   exists and `supabase gen types` takes over `database.ts`.
```

This mirrors a standard UI / business-logic / data-access separation:
`components/` is UI, `app/*/actions.ts` (added as features need mutations)
is business logic, `lib/supabase/` is data access.

### `src/types/database.ts` is hand-maintained, not generated

There is no live Supabase project yet (no project URL/keys have been
provided to this environment). Normally you'd run
`supabase gen types typescript` against a real project; instead,
`database.ts` is hand-written to match `supabase/migrations/` exactly. Any
session that adds a migration must update this file in the same commit.
Once a real Supabase project exists, replace this workflow with generated
types (see the comment at the top of `database.ts`).

## Auth flow

- Supabase Auth (email/password for the MVP; no OAuth providers configured
  yet).
- `src/lib/supabase/client.ts` — used in Client Components (e.g. the
  login/signup forms) for calls that need to run in the browser.
- `src/lib/supabase/server.ts` — used in Server Components/Actions to read
  the authenticated user and perform authorized mutations.
- `src/proxy.ts` — runs on every request, refreshes the session token, and
  rewrites the auth cookies so Server Components always see a valid session
  without every route re-implementing refresh logic.
- A Postgres trigger (`handle_new_user` in the first migration) creates a
  `profiles` row automatically when a `auth.users` row is created, so the
  app never has to orchestrate "create auth user, then create profile" as
  two client-visible steps.

## Data model

Implemented so far (`supabase/migrations/00000000000001_profiles.sql`):

- **`profiles`** — one row per user. `reliability_score` and
  `reputation_score` (see PRODUCT.md for the distinction) default to neutral
  values and are read-only from the client's perspective beyond the owner
  updating their own `display_name`. Future migrations will move score
  mutation into `security definer` functions/triggers driven by event
  outcomes rather than direct client writes.

Not yet implemented (planned — see ROADMAP.md for sequencing):

- `events` — scheduled sessions (start time, status, two speaker seat refs).
- `event_speakers` — who is occupying which seat, join/leave timestamps.
- `speaker_queue` — ordered per-event queue of audience members requesting a
  seat, ordered by a function of wait time and reputation.
- `reactions` — ephemeral emoji reactions per event (short retention).
- `comments` — audience comments per event, with a ranking signal for "top
  comments."
- `votes` — continue/replace/extend votes, scoped to event + vote round so
  results can't be double-counted.
- `reports` — moderation reports against a user/event.

All tables will have RLS enabled by default (see the `profiles` migration
for the pattern) — this is a hard rule, not a per-table decision.

## Realtime plan

Supabase Realtime (Postgres changes + broadcast) will drive: audience count,
live reactions, live comment feed, and vote tallies. Not yet implemented —
the MVP currently has no live event UI at all (see ROADMAP.md).

## Video plan

LiveKit will host the two-speaker audio/video room. Deferred until the
event/waiting-room data model exists, since the room needs an `events` row
and speaker-seat assignment to know who gets a token. No LiveKit SDK is
installed yet — see the tech stack table above for why.

## Responsive implementation notes

See [PRODUCT.md's responsive design principle](./PRODUCT.md#responsive-design-principle)
for the product-level rule: desktop and smartphone are both first-class,
built intentionally rather than one stretched/compressed into the other.
This section is the engineering implementation of that rule.

- **Shared logic, split presentation.** Server actions, `lib/supabase/`
  data access, and (once built) realtime subscriptions are shape-agnostic —
  the same hook/action serves both layouts. Where a screen's *structure*
  genuinely differs by breakpoint (e.g. a desktop multi-panel live room vs.
  a single-column mobile one), prefer two composed components sharing
  common children over one component full of breakpoint-conditional JSX —
  that's usually more readable than it sounds, and easier to reason about
  per-platform than a single component branching internally.
- **Where structure doesn't genuinely differ** (landing page, auth forms,
  most of the MVP so far), a single responsive layout using Tailwind's
  breakpoint utilities is the right call — don't build two components when
  one adapts cleanly. Judge this per-screen; don't default to either extreme.
- **Tap targets and hover.** Anything interactive must work without hover
  (no hover-only affordances) and must meet a comfortable touch target size
  on mobile; desktop can layer on hover states as enhancement, never as the
  only signal.
- **Viewport stability.** Avoid layout that jumps when mobile browser chrome
  (URL bar, keyboard) shows/hides. Prefer `dvh`-aware sizing over raw `vh`
  for anything that must fill the screen (relevant once the live room and
  waiting room exist; not yet applicable to the current static pages).
- **Graceful degradation is a correctness requirement, not a nice-to-have**
  — see PRODUCT.md. When building the live room (Phase 2) and realtime
  features (Phase 3), each must define its degraded-network behavior as
  part of the implementation, not bolt it on after.
- **Performance is part of "done."** Avoid unnecessary re-renders, keep
  component state localized, lazy-load what's off the critical path, throttle
  high-frequency events (emoji reactions are the obvious case in Phase 3),
  and clean up listeners/timers/media streams/subscriptions on unmount —
  this matters most on mobile, where it's also battery cost, not just CPU.

## Testing & Definition of Done

A feature is not done — regardless of what the roadmap checkbox says —
until:

- It works with the shared business logic on both a phone-sized viewport
  and a desktop viewport, each using a layout intentionally designed for
  that size (not one stretched/compressed into the other).
- It's been checked in: narrow phone widths, common smartphone sizes,
  tablet, laptop, and desktop browser widths; both portrait and landscape
  where orientation applies.
- It's been checked under a throttled/slow network and under a simulated
  reconnect, and degrades per the graceful-degradation rule above rather
  than failing outright.
- For anything touching camera/microphone (Phase 2+): both permission
  granted and permission denied paths have been exercised.
- For anything involving the on-screen keyboard (Phase 2+ comment/chat
  input): the layout has been checked with the keyboard open.
- `npm run lint`, `npm run build` (which type-checks), and any relevant
  tests pass.
- Relevant docs (this file, PRODUCT.md, ROADMAP.md, CHANGELOG.md,
  SESSION_LOG.md) are updated in the same commit/session.

This checklist grows as new interaction types (video, realtime) land —
extend it rather than relying on tribal knowledge.

## Deployment

Vercel is the intended target. Not yet configured — no `vercel.json` /
project link exists in this repo. Do not deploy from an agent session
without explicit user instruction (per the project's DO NOT list).
