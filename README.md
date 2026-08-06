# Virtual Stage

A prototype of a live social platform where strangers hold conversations in
front of a live audience. See [PRODUCT.md](./PRODUCT.md) for what this
project is and why it exists.

This repository is designed to be picked up by any engineer or AI model with
no prior context. Start with the docs below, in order.

## Documentation map

| File | Purpose |
| --- | --- |
| [PRODUCT.md](./PRODUCT.md) | Product goal, principles, MVP scope, non-goals |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Tech stack, folder structure, data model, system design |
| [ROADMAP.md](./ROADMAP.md) | What's built, what's next, phased by feature |
| [DECISIONS.md](./DECISIONS.md) | Architectural/product decisions and their rationale |
| [CHANGELOG.md](./CHANGELOG.md) | Chronological record of shipped changes |
| [SESSION_LOG.md](./SESSION_LOG.md) | Per-session log: goal, work done, status, next task |

Read `SESSION_LOG.md` last-entry-first — it tells you exactly where the
previous session left off and what to do next.

## Design principle: desktop and mobile are both first-class

Every screen in this app must be built responsively — an intentional layout
per screen size sharing the same business logic, not one platform's layout
stretched or compressed for the other. This is a permanent, non-negotiable
product decision. See
[PRODUCT.md's responsive design principle](./PRODUCT.md#responsive-design-principle)
for the product rule and
[ARCHITECTURE.md's testing checklist](./ARCHITECTURE.md#testing--definition-of-done)
for what "done" requires before a feature is considered complete.

## Design principle: authentication is an upgrade, not a gate

Nobody should have to create an account to open the app, see what's on, or
watch and interact with a live event as audience. An account unlocks
contribution (requesting the mic, commenting, building reputation) — it is
never required just to walk in the door. This is a permanent, non-negotiable
product decision, corrected into the project after the first session
initially wired login as the front door. See
[PRODUCT.md's progressive authentication model](./PRODUCT.md#progressive-authentication-model)
for the full guest/account capability split and
[ARCHITECTURE.md's guest identity design](./ARCHITECTURE.md#guest-identity)
for the implementation. **No route may redirect an unauthenticated visitor
away** — gating happens at the specific action, not the page.

## Tech stack

- **Frontend**: Next.js 16 (App Router), TypeScript, Tailwind CSS v4
- **Backend / auth / database**: Supabase (Postgres + Auth)
- **Realtime**: Supabase Realtime
- **Video**: LiveKit (not yet integrated — see ROADMAP.md)
- **Deployment**: Vercel (not yet deployed — local development only so far)

> **Note on Next.js version**: this project uses Next.js 16, which renamed
> Middleware to **Proxy** (`src/proxy.ts`, `export function proxy(...)`) and
> introduced other changes. If something in your training data or memory
> says "middleware.ts", check `node_modules/next/dist/docs/` first — it may
> be stale for this version.

## Getting started

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template and fill in real values from your Supabase
   project (Project Settings → API):

   ```bash
   cp .env.local.example .env.local
   ```

3. Apply the database schema in `supabase/migrations/` to your Supabase
   project (via the SQL editor or the Supabase CLI once installed).

4. Run the dev server:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Scripts

- `npm run dev` — start the local dev server
- `npm run build` — production build (also type-checks)
- `npm run start` — run a production build locally
- `npm run lint` — ESLint

## Project structure

```
src/
  app/            Routes (pages, layouts). Thin — composition only.
  components/
    ui/           Generic, reusable UI primitives
    landing/      Landing-page-specific components
    auth/         Auth form components
  lib/
    supabase/     Supabase client factories (browser + server)
    utils.ts      Small shared helpers (e.g. cn())
  types/          Hand-written types, incl. database.ts (Supabase schema)
  proxy.ts        Session-refresh proxy (Next.js 16's renamed Middleware)
supabase/
  migrations/     Hand-authored SQL migrations (schema source of truth)
```

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the reasoning behind this
structure and the full data model.
