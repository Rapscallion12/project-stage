# Architecture

## Tech stack

| Layer | Choice | Notes |
| --- | --- | --- |
| Frontend framework | Next.js 16 (App Router) | See the Next.js 16 note below — Middleware was renamed to Proxy. |
| Language | TypeScript | Strict mode, as scaffolded by `create-next-app`. |
| Styling | Tailwind CSS v4 | Config-free (CSS-first) Tailwind v4; see `src/app/globals.css`. |
| Backend | Supabase (Postgres, Auth, Realtime) | One project covers DB, auth, and realtime — no separate backend service in the MVP. See [Vendor portability](#vendor-portability) for how this choice is kept reversible. |
| Realtime | Supabase Realtime | Implemented for the pre-show lobby: chat messages (Postgres Changes), reactions (Postgres Changes), attendee presence. Not yet used for the future live room's votes/live-reactions. |
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
                   logic lives here beyond composing components, resolving
                   identity, and calling lib/repositories/ functions. Never
                   imports lib/supabase/ directly except inside a
                   repository or an explicitly-documented Auth/Realtime
                   exception — see Vendor portability.
  components/
    ui/           Generic presentational primitives (Button, Input, Card).
                   No data fetching, no Supabase imports.
    landing/      Landing-page-specific composed components.
    auth/         Auth form components (client components; call server
                   actions, never call Supabase directly from the browser
                   for auth mutations).
    events/       Event list/detail presentational components.
    lobby/         Pre-show lobby presentational components (chat panel,
                   message item, guest name editor). Consume state from
                   useLobbyRealtime; don't touch Supabase themselves.
  hooks/
    use-lobby-realtime.ts  Owns the lobby's live state (messages,
                   reactions, presence). The one place a Client Component
                   calls Supabase Realtime directly — see Vendor
                   portability for why this isn't behind a repository.
    use-now.ts     Ticking clock via useSyncExternalStore, for countdowns.
  lib/
    supabase/
      client.ts   Browser Supabase client (Client Components).
      server.ts   Server Supabase client (Server Components/Actions/Route
                   Handlers) — reads/writes the session via cookies.
    repositories/  All durable-data reads/writes go through here — see
                   Vendor portability. events.ts, chat.ts, profiles.ts.
                   Each exports plain domain types (not aliased from
                   database.ts) and plain async functions; nothing outside
                   this folder (and lib/supabase/, and the documented Auth
                   exceptions) imports `createClient` from lib/supabase/.
    identity.ts    resolveIdentity() — "who is making this request,"
                   account or guest. Calls Supabase Auth directly (see
                   Vendor portability's Auth exception) and the profiles
                   repository.
    guest.ts       Guest cookie helpers + deterministic guest name
                   generation.
    events.ts      Pure functions: event phase/countdown/date formatting.
                   No Supabase, no I/O — fully portable, always was.
    config.ts      PROTOTYPE_CONFIG — the single toggle point for
                   loosening/tightening guest access later.
    utils.ts       Small framework-agnostic helpers (e.g. cn()).
  types/
    database.ts   Hand-written Supabase schema types. Only imported by
                   lib/supabase/ and lib/repositories/ — never by a page,
                   component, or action directly (see Vendor portability).
  proxy.ts        Refreshes the Supabase session cookie and mints the
                   guest session cookie on every request.
supabase/
  migrations/     Hand-authored, numbered SQL migrations — the source of
                   truth for the schema until the Supabase CLI is set up
                   and `supabase gen types` takes over `database.ts`.
  seed.sql        Dev/demo data (events), not a migration — re-runnable,
                   not schema-defining.
```

This mirrors a standard UI / business-logic / data-access separation:
`components/` is UI, `app/*/actions.ts` (added as features need mutations)
+ `lib/identity.ts`/`lib/events.ts` is business logic, `lib/repositories/`
is data access. See [Vendor portability](#vendor-portability) for why the
data-access layer is a real module boundary and not just a folder-naming
convention.

### `src/types/database.ts` is hand-maintained, not generated

A real Supabase project is now connected, but the Supabase CLI isn't set
up yet (see DECISIONS.md) — `supabase gen types typescript` needs it.
Until then, `database.ts` is hand-written to match `supabase/migrations/`
exactly. Any session that adds a migration must update this file in the
same commit. This file's shape has one hard requirement that isn't obvious
from reading it: every table needs a `Relationships: []` field, and the
schema needs `Views`/`Functions` keys (even empty) — `@supabase/postgrest-js`
silently returns `never` for every row type without them, with no type
error pointing at the cause. This bit us once already (see DECISIONS.md);
don't drop those fields when adding a table.

## Vendor portability

Supabase is this prototype's backend because it's the fastest path to a
working product today — Postgres, Auth, and Realtime in one project, no
infrastructure to stand up. It is **not** assumed to be the final
infrastructure if this product outgrows a prototype. This is a permanent
architectural stance, not a per-feature judgment call: the goal is to keep
a reasonable migration path open without paying for it today by
over-engineering around hypothetical scale.

**The rule**: `src/lib/repositories/` is the only place application code
calls `createClient(...).from(...)` for durable data (tables, not auth,
not realtime). Pages, Server Actions, and components call repository
functions (`listUpcomingEvents()`, `insertMessage(...)`, etc.), never
Supabase's query builder directly. If Supabase were ever replaced by
another Postgres provider, another ORM, or a different backend entirely,
the change is contained to `lib/repositories/` and `lib/supabase/` — every
page, component, and action that displays or submits data stays
untouched, because they only ever depended on plain TypeScript function
signatures and plain domain types.

Concretely, that means:

- Repository functions return **plain domain types** (e.g. `Event`,
  `ChatMessage` in `lib/repositories/events.ts` / `chat.ts`), not type
  aliases of `Database["public"]["Tables"][...]["Row"]`. The shapes match
  today, deliberately, but callers never import anything
  Supabase-generated — see `src/types/database.ts`'s note above for why
  that type is Supabase-flavored in a way callers shouldn't be exposed to.
- Repository functions are plain `async function`s returning plain data,
  not a class hierarchy, dependency-injection container, or generic
  "database interface." A prototype at this scale doesn't need that
  weight, and building it now would be exactly the "prematurely introduce
  distributed infrastructure for hypothetical scale" this principle warns
  against — the seam (a folder boundary + a naming convention) is enough
  until there's a real second backend to support.
- **PostgreSQL itself is treated as the durable source of truth.** The
  schema (`supabase/migrations/`) uses standard Postgres features —
  tables, `CHECK` constraints, indexes, RLS policies, triggers — nothing
  Supabase-proprietary. RLS is a Postgres feature Supabase happens to
  surface nicely in its dashboard, not a Supabase-only mechanism; the
  schema would `pg_dump`/restore into any Postgres instance unchanged.

### What's *not* abstracted, and why

Two subsystems are used directly, without a repository-style seam —
documented exceptions, not oversights:

- **Auth** (`lib/identity.ts`, `site-header.tsx`, `login`/`signup`/`auth`
  actions, `proxy.ts`) calls `supabase.auth.*` directly. Session
  management, cookie handling, and token refresh are deeply specific to
  whichever auth provider is in use — there's no generic "auth interface"
  that wouldn't just be Supabase Auth's API with extra steps, and building
  one speculatively (before there's a second auth provider to actually
  support) would itself violate the "don't prematurely introduce
  infrastructure" half of this same principle. If Supabase Auth is ever
  replaced, this is a real, acknowledged rewrite — not a folder-boundary
  change like the data layer.
- **Realtime** (`hooks/use-lobby-realtime.ts`) calls
  `createClient().channel(...)` directly for chat/reaction/presence
  subscriptions, for the same reason: every realtime provider's
  subscribe/broadcast/presence API shape differs enough that a generic
  wrapper would be Supabase's API renamed, not a real abstraction.

Both are called out explicitly here specifically so a future session
doesn't "fix" this by half-abstracting them — that would add complexity
without adding real portability.

### Realtime traffic vs. durable writes

Realtime (ephemeral, fans out to connected clients) and Postgres writes
(durable, source of truth) are two different concerns that happen to both
run through Supabase today, and they should stay conceptually separate
even where the current implementation uses one to drive the other:

- **Chat messages are durable by requirement** — they need to survive a
  refresh and show history to someone who joins late, so each one is a
  real `event_chat_messages` row. Supabase Realtime's Postgres Changes
  feature broadcasts the `INSERT` to subscribed clients as a side effect
  of that write — there's no separate "realtime write," so this doesn't
  cost more DB writes as the audience grows, only more *reads/broadcasts*
  (a Supabase infra concern, not something this app's write path
  controls).
- **Message reactions are also persisted individually** (one row per
  identity per message per emoji, deduplicated by a unique index) —
  deliberately, because deduplication (**one reaction per person per
  message**) requires knowing *who* reacted, which a plain aggregate
  counter can't express. This is a bounded volume (capped by message
  count × attendee count in one lobby), not the unbounded firehose the
  next bullet is about.
- **This is not the pattern for Phase 3's live emoji reactions on the live
  room.** Those are the actually high-frequency case PRODUCT.md Principle
  7 has in mind — audience members tapping a reaction repeatedly during a
  live conversation. That must be pure ephemeral Realtime *broadcast*
  (not Postgres Changes, no row per tap) with at most a periodically
  persisted aggregate count if analytics ever need one. Writing a
  database row per live reaction tap would be exactly the "excessive
  database writes as audience size grows" this principle warns against —
  whoever builds Phase 3 should not copy the message-reactions table
  pattern for it.

## Auth flow

Authentication is an optional upgrade, never an entry gate — see
[PRODUCT.md's progressive authentication model](./PRODUCT.md#progressive-authentication-model).
Concretely, that means:

- **No route requires an authenticated user to render.** There is no
  redirect-to-login anywhere in this codebase (`src/proxy.ts` only
  refreshes the session; it never inspects the result to gate a route), and
  there must not be one added for viewing the landing page, event list, or
  a live event as audience.
- **Gating happens at the action, not the route.** A feature that's
  account-only (requesting the mic, posting a comment) checks for an
  authenticated user *inside the server action*, and returns a specific
  "create an account to do this" response for the UI to show inline — it
  does not redirect the guest away from the page they were on. See
  PRODUCT.md for the required tone of that prompt (name the specific
  action, don't show a generic wall).
- Supabase Auth (email/password for the MVP; no OAuth providers configured
  yet) is the account mechanism. Guests are handled entirely outside
  Supabase Auth — see [Guest identity](#guest-identity) below.
- `src/lib/supabase/client.ts` — used in Client Components (e.g. the
  login/signup forms) for calls that need to run in the browser.
- `src/lib/supabase/server.ts` — used in Server Components/Actions to read
  the authenticated user (if any — always check for `null` rather than
  assuming a session exists) and perform authorized mutations.
- `src/proxy.ts` — runs on every request, refreshes the session token, and
  rewrites the auth cookies so Server Components always see a valid session
  without every route re-implementing refresh logic. It does not (and must
  not) redirect based on auth state.
- A Postgres trigger (`handle_new_user` in the first migration) creates a
  `profiles` row automatically when a `auth.users` row is created, so the
  app never has to orchestrate "create auth user, then create profile" as
  two client-visible steps. Guests never get an `auth.users` or `profiles`
  row — there is deliberately nowhere to store guest reputation/reliability,
  which makes "guests accrue nothing permanent" a structural fact rather
  than a convention someone could forget to enforce.

## Guest identity

Implemented (`src/proxy.ts`, `src/lib/guest.ts`, `src/lib/identity.ts`).
Guests need a stable-enough identity for the duration of an event to make
chat/reactions rate-limitable and duplicate-checkable, without ever
creating an account for them:

- On first visit, if no guest session cookie is present *and the visitor
  isn't authenticated*, `src/proxy.ts` mints a random opaque session id
  (`crypto.randomUUID()`) and sets it in an `httpOnly`, `Secure`,
  `SameSite=Lax` cookie (`vs_guest_id`, `src/lib/guest.ts`) with a 30-day
  expiry. It's a bare identifier, not a JWT — no claims, no elevated
  access — used purely to attribute and deduplicate a guest's actions.
- This is entirely separate from Supabase Auth. A guest session never
  becomes a `profiles` row implicitly; if a guest signs up, they get a
  normal new account via the existing signup flow (their guest activity is
  not retroactively linked — see PRODUCT.md).
- `resolveIdentity()` (`src/lib/identity.ts`) is the single place "who is
  making this request" gets resolved — an authenticated user's profile
  (name via `lib/repositories/profiles.ts`) if logged in, else their guest
  cookie (minting a fresh, non-persistent one as a last-resort fallback if
  the cookie is somehow missing, e.g. cookies disabled — degrades to "your
  identity won't survive a refresh," not a crash). Both the lobby page and
  its Server Actions call this the same way, so a guest and an account
  holder go through identical code paths that only branch on the result.
- Guests also get a lightweight generated identity, not just a UUID: a
  deterministic "Adjective Animal" display name (`generateGuestName()`,
  hashed from their guest id, so it's stable without persisting anything
  extra), overridable via a `vs_guest_name` cookie if they rename
  themselves in the lobby (`GuestNameEditor`). Already-sent messages keep
  their `author_display_name` snapshot — renaming never rewrites history.
- Guest-eligible Server Actions (`sendMessage`, `addReaction` in
  `src/app/events/[id]/lobby/actions.ts`) accept either identity and
  record whichever one acted. Account-only actions (not built yet — mic
  request, comments) would require an authenticated user and, if absent,
  return the specific account-prompt copy rather than silently failing.

## Rate limiting & abuse prevention for guests

Implemented for chat messages, per-message reactions only (not a generic
mechanism yet):

- **Duplicate prevention (reactions)**: a database-level unique index —
  `(message_id, emoji, COALESCE(reactor_profile_id, reactor_guest_id))` —
  one reaction per identity per message per emoji, account or guest.
  Enforced in Postgres (migration `00000000000003`), not just the UI.
- **Rate limiting (messages)**: `hasSentMessageRecently()`
  (`lib/repositories/chat.ts`) rejects a new message if the same identity
  sent one in the last 2 seconds — one extra read before the insert, no
  separate rate-limit table. Guests and account holders are limited
  identically.
- **No IP-based blocking, no CAPTCHA.** A session-cookie-based limit is
  enough to stop *obvious* duplicate abuse, which is what PRODUCT.md asks
  for. Someone deliberately clearing cookies to spam is an accepted MVP
  limitation (Principles 9/10) — not worth anti-fraud tooling before the
  core hypothesis is validated.
- **Reactions are insert-only — no delete policy for anyone**, guest or
  account holder. This isn't a rate-limiting decision, it's an RLS-gap
  decision: allowing a guest to delete their own reaction would need to
  verify *which* guest is asking, which an anon-key request can't prove,
  and opening delete to any anon request naming any reactor id is a
  trivial griefing vector (delete everyone's reactions on every message),
  not an "accepted limitation" the way guest vote-stuffing is. See the
  migration's comment on `event_chat_message_reactions` for the full
  reasoning. Not yet solved for Phase 3's votes — that needs its own
  design once real guest-aware RLS patterns exist (see Vendor portability
  above for the general shape of that problem: anon-key requests can't
  prove identity the way `auth.uid()` can).

## Data model

Implemented:

- **`profiles`** (migration `00000000000001`) — one row per *account*.
  Guests never get a row here — see Guest identity above.
  `reliability_score` and `reputation_score` (see PRODUCT.md for the
  distinction) default to neutral values and are read-only from the
  client's perspective beyond the owner updating their own `display_name`.
  Future migrations will move score mutation into `security definer`
  functions/triggers driven by event outcomes rather than direct client
  writes.
- **`events`** (migration `00000000000003`) — scheduled sessions:
  `title`, `description`, `scheduled_start`, `lobby_opens_at`. No status
  column — phase (`upcoming` / `lobby_open` / `ready`) is computed at read
  time from those two timestamps (`lib/events.ts`'s `getEventPhase()`),
  not stored, so nothing has to write to flip an event's state as time
  passes. Publicly readable (`select` granted to `anon, authenticated`);
  no insert/update/delete policy — event creation isn't a feature yet, no
  moderator/host UI exists. **Deliberately has no room/speaker/video
  columns** — see the migration's comment: a single event may later host
  multiple simultaneous conversation rooms, so room-specific state belongs
  in a future `event_rooms`-style table, keeping multi-room support a
  schema *addition*, not a redesign.
- **`event_chat_messages`** (migration `00000000000003`) — pre-show lobby
  chat, scoped to the event (not a room), so it stays shared if/when
  multi-room support lands. **Guest-eligible**: `author_profile_id` or
  `author_guest_id`, exactly one meaningfully set, enforced by RLS at
  insert time (not a strict DB `CHECK`, which would break the moment an
  account's profile row is deleted — see the migration's comment). Stores
  `author_display_name` as a send-time snapshot, not a live join, since
  guests have no profile to join to.
- **`event_chat_message_reactions`** (migration `00000000000003`) —
  message upvotes. **Guest-eligible**, same identity pattern as chat
  messages. Insert-only — see Rate limiting above for why there's no
  delete policy.

Not yet implemented (planned — see ROADMAP.md for sequencing). Guest
eligibility is called out explicitly per table since it's a schema-level
decision, not just a UI one:

- `event_speakers` — who is occupying which seat, join/leave timestamps.
  Account-only: a row here always references a `profiles.id`, never a guest.
- `speaker_queue` — ordered per-event queue of account holders requesting a
  seat, ordered by a function of wait time and reputation. Account-only —
  no `guest_session_id` column; the insert path itself requires auth.
- Live-room reactions (Phase 3) — **not the same table as
  `event_chat_message_reactions` above.** These are the actually
  high-frequency case (repeated taps during a live conversation) and
  should be ephemeral Realtime broadcast, not a table with a row per tap
  — see Vendor portability's "Realtime traffic vs. durable writes" for why.
- `comments` — audience comments/prompts/questions per event, with a
  ranking signal for "top comments." Account-only, per PRODUCT.md.
- `votes` — continue/replace/extend votes, scoped to event + vote round so
  results can't be double-counted. **Guest-eligible**, same
  `profile_id`-or-guest-session pattern as chat/reactions, plus a
  uniqueness constraint the same shape as `event_chat_message_reactions`'s.
- `reports` — moderation reports against a user/event. Guest-eligible in
  principle (a guest should be able to report something alarming without
  needing an account first), scoped the same way.

All tables have RLS enabled by default (see the `profiles` migration for
the pattern) — this is a hard rule, not a per-table decision. **Every
table also needs an explicit `GRANT`** — Supabase's SQL Editor does not
auto-apply the privileges the Table Editor UI would, which caused a real
bug in migration `00000000000002` (see DECISIONS.md); every migration
since has granted explicitly and should keep doing so.

## Realtime plan

Implemented for the pre-show lobby (`hooks/use-lobby-realtime.ts`):
Postgres Changes subscriptions on `event_chat_messages` and
`event_chat_message_reactions` INSERT (both added to the
`supabase_realtime` publication in migration `00000000000003` — easy to
forget, and forgetting it fails silently, "chat never updates live," not
with an error), plus a Presence channel per event for attendee count.
Presence includes guests, not just account holders — a guest in the room
is still part of "the audience should feel like a live crowd" (PRODUCT.md
Principle 7); the presence key is the guest session id, no auth required.

Not yet implemented: live reactions and vote tallies for the future live
room (Phase 2/3) — see Vendor portability's note that those should be pure
ephemeral broadcast, not Postgres Changes, unlike the lobby chat/reactions
above.

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

- **Shared logic, split presentation.** Server actions,
  `lib/repositories/` data access, and realtime subscriptions
  (`hooks/use-lobby-realtime.ts`) are shape-agnostic — the same hook/action
  serves both layouts. Where a screen's *structure* genuinely differs by
  breakpoint (e.g. a desktop multi-panel live room vs. a single-column
  mobile one), prefer two composed components sharing common children over
  one component full of breakpoint-conditional JSX — that's usually more
  readable than it sounds, and easier to reason about per-platform than a
  single component branching internally.
- **Where structure doesn't genuinely differ** (landing page, auth forms,
  the pre-show lobby — see Mobile orientation implementation below for why
  the lobby specifically stays a single responsive layout rather than
  branching), a single responsive layout using Tailwind's breakpoint
  utilities is the right call — don't build two components when one adapts
  cleanly. Judge this per-screen; don't default to either extreme.
- **Tap targets and hover.** Anything interactive must work without hover
  (no hover-only affordances) and must meet a comfortable touch target size
  on mobile; desktop can layer on hover states as enhancement, never as the
  only signal.
- **Viewport stability.** Avoid layout that jumps when mobile browser chrome
  (URL bar, keyboard) shows/hides. The root layout (`src/app/layout.tsx`)
  uses `h-dvh` (not `min-h-full`) for exactly this reason — the pre-show
  lobby's chat panel needs a properly bounded height chain to scroll
  internally instead of the whole page growing; every other page still
  scrolls normally via `overflow-y-auto` on `body`.
- **Graceful degradation is a correctness requirement, not a nice-to-have**
  — see PRODUCT.md. When building the live room (Phase 2) and realtime
  features (Phase 3), each must define its degraded-network behavior as
  part of the implementation, not bolt it on after.
- **Performance is part of "done."** Avoid unnecessary re-renders, keep
  component state localized, lazy-load what's off the critical path, throttle
  high-frequency events (emoji reactions are the obvious case in Phase 3),
  and clean up listeners/timers/media streams/subscriptions on unmount —
  this matters most on mobile, where it's also battery cost, not just CPU.

## Mobile orientation implementation

See [PRODUCT.md's mobile orientation behavior](./PRODUCT.md#mobile-orientation-behavior)
for the product rule: portrait and landscape are two intentional
presentation modes of the live room, and rotating between them must never
cost the user their video connection, chat state, votes, reactions, speaker
state, or timers. Not yet implemented — there's no live room yet (Phase
2+) — but the constraint this places on the implementation is decided now
so whoever builds it doesn't default to the naive approach:

- **The failure mode to design against**: conditionally rendering an
  entirely different component tree per orientation (`isPortrait ?
  <PortraitRoom /> : <LandscapeRoom />`) is the obvious way to build this,
  and it's wrong by default — if the LiveKit connection, chat subscription,
  vote/reaction state, or timers are owned *inside* either branch, React
  unmounts that branch's hooks (and their cleanup — dropping the call,
  closing the channel) the instant orientation flips, then mounts the other
  branch fresh. That's exactly the reload-equivalent PRODUCT.md forbids,
  just without an actual page reload.
- **The rule**: anything stateful and live — the LiveKit room/track
  subscriptions, the chat channel subscription, vote/reaction state, timer
  intervals — must be owned by a hook/context in a component that renders
  unconditionally (above the orientation branch), never inside
  `PortraitRoom`/`LandscapeRoom` themselves. Those two components should be
  close to pure presentation: given the same live state and the same
  callbacks, they just arrange it differently. This is the same "shared
  logic, split presentation" pattern already established above for
  breakpoints — orientation is a second axis of the same rule, not a new
  one, but it's called out explicitly here because getting it wrong doesn't
  just look bad (as a breakpoint mistake would), it drops the user's live
  connection.
- **Detecting orientation**: use `window.matchMedia('(orientation:
  portrait)')` with a change listener (wrapped in a small hook, e.g.
  `useOrientation()`), not viewport-width breakpoints — orientation and
  screen size are different axes (a tablet rotating doesn't necessarily
  cross a width breakpoint the way a phone does). Since this is
  client-only state, guard against a hydration mismatch with a sensible
  default for the initial server render rather than reading `matchMedia`
  during render.
- **Smoothness**: prefer CSS transitions for the layout change itself over
  JS-driven layout thrash; the goal is that rotating reads as "the same
  live session redecorated," not a navigation.

**The pre-show lobby (`components/lobby/`) does not branch by orientation
at all** — it's a concrete example of the "where structure doesn't
genuinely differ" case above, not an exception to this section. There's no
video yet competing for space, so there's no genuine structural difference
between portrait-phone and landscape-phone for the lobby; the real
difference is phone vs. desktop width, handled with ordinary Tailwind
breakpoints in `LobbyRoom`. This is also *why* the lobby was safe to build
without the orientation-state-ownership rule above ever coming into play —
`useLobbyRealtime` is called once, unconditionally, and nothing about it
changes based on orientation. Keep it that way until the live room actually
needs to reflow around video; don't add orientation branching to the lobby
speculatively.

## Testing & Definition of Done

A feature is not done — regardless of what the roadmap checkbox says —
until:

- It works with the shared business logic on both a phone-sized viewport
  and a desktop viewport, each using a layout intentionally designed for
  that size (not one stretched/compressed into the other).
- It's been checked in: narrow phone widths, common smartphone sizes,
  tablet, laptop, and desktop browser widths; both portrait and landscape
  where orientation applies.
- **For the live room specifically (Phase 2+)**: rotated live, mid-session,
  in both directions — not just checked once per orientation in isolation.
  No reload triggered, and live video connection, chat state, votes,
  reactions, speaker state, and timers all survive the rotation intact. See
  [Mobile orientation implementation](#mobile-orientation-implementation)
  for the architectural rule this is checking (state must not live inside
  the orientation-conditional branch).
- It's been checked under a throttled/slow network and under a simulated
  reconnect, and degrades per the graceful-degradation rule above rather
  than failing outright.
- For anything touching camera/microphone (Phase 2+): both permission
  granted and permission denied paths have been exercised.
- **Any new route or feature has been walked through as a guest (no
  session at all)** — confirming it renders and, where guest-eligible per
  PRODUCT.md, functions fully — before it's considered done. If a feature
  is account-only, confirm the guest gets the specific account-prompt copy
  (never a redirect to `/login`, never a generic wall) inline at the point
  of the action.
- For anything involving the on-screen keyboard (Phase 2+ comment/chat
  input): the layout has been checked with the keyboard open.
- **Any new durable-data read/write goes through `lib/repositories/`**,
  not a direct `createClient().from(...)` call in a page, component, or
  action — see [Vendor portability](#vendor-portability). Auth and
  Realtime are the only documented exceptions; don't add a third without
  updating that section's reasoning.
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
