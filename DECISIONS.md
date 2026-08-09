# Decisions

Architecture Decision Record. Newest first. Format: Problem, Alternatives
considered, Decision, Reason, Tradeoffs.

## 2026-08-08 — Data access goes through a repository layer, not scattered Supabase calls

**Problem**: The scheduled-events + pre-show-lobby milestone was the first
feature with real, substantial data access — events, chat messages,
reactions, presence — and it was built with pages, Server Actions, and
`lib/identity.ts` all calling `createClient().from(...)` directly. The
user flagged this before it became a bigger habit: Supabase is the
prototype's backend because it's fast to build on today, not necessarily
the platform this product would stay on at large scale, and "scattered
direct Supabase queries throughout UI components" is exactly what makes a
later migration expensive.

**Alternatives considered**:
1. Leave it as built — direct Supabase calls in pages/actions/hooks — and
   deal with portability later if it ever actually matters.
2. A full abstraction: a generic repository *interface* + a Supabase
   implementation behind it, ready to swap in a second backend.
3. A lightweight repository layer — plain functions in
   `lib/repositories/`, returning plain domain types not aliased from the
   Supabase-generated schema type — as the only place durable-data queries
   happen, with Auth and Realtime left as explicit, documented exceptions
   rather than force-abstracted too.

**Decision**: Option 3. Refactored the just-built events/lobby code
(`lib/repositories/events.ts`, `chat.ts`, `profiles.ts`) the same session
it was written, rather than letting the anti-pattern spread to more
features first. Documented in ARCHITECTURE.md's new "Vendor portability"
section (the repository rule, the Auth/Realtime exceptions and why they
aren't abstracted too, and the realtime-vs-durable-writes distinction for
reactions specifically), AGENTS.md (standing rule + a new Testing &
Definition of Done checklist item), and this entry.

**Reason**: A folder-boundary convention (repositories return plain types,
callers never import Supabase-generated types) gets most of the
portability benefit — contain a future backend swap to `lib/repositories/`
and `lib/supabase/` — for close to zero cost today, since the functions
are just `async function`s, not a class hierarchy or DI container. Option
2 was rejected specifically because the user's own instruction paired
"design for portability" with "do not prematurely introduce distributed
infrastructure solely for hypothetical scale" — a generic interface with
exactly one implementation is complexity paid for today against a benefit
that only materializes if this product actually reaches a scale where
Supabase stops fitting, which is explicitly not assumed. Auth and Realtime
were deliberately left un-abstracted for the same reason in the other
direction: both have provider-specific API shapes deep enough that a
generic wrapper would just rename Supabase's API, not add real
portability — abstracting them now would be the same over-engineering
mistake in a different spot.

**Reason for also documenting the realtime/durable-writes distinction**:
the user's instruction specifically called out not persisting every
high-frequency reaction individually if aggregation suffices. The lobby's
message-reactions table does persist individually — a deliberate, correct
choice (dedup requires knowing *who* reacted; volume is bounded by message
count, not by tap frequency) — but it reads, out of context, like exactly
the pattern the instruction warns against. Documented explicitly in
ARCHITECTURE.md so Phase 3's live emoji reactions (the actually
high-frequency case the instruction has in mind) don't copy this table's
pattern by precedent.

**Tradeoffs**: Every new table needs a repository file (or an addition to
an existing one) before any page can use it — one extra hop compared to
querying inline, paid on every future feature that touches data. Accepted
as the cost of keeping the migration path real rather than aspirational.
Auth and Realtime remain genuine, acknowledged rewrite risk if either
provider is ever replaced — not mitigated by this decision, by design.

---

## 2026-08-06 — Portrait and landscape are two intentional live-room modes

**Problem**: The live room (Phase 2+) is the one screen in this app where
mobile orientation isn't just a layout question — portrait and landscape
audiences want genuinely different things (following the crowd vs.
focusing on the conversation). Left undecided, the default engineering
approach would be a single responsive layout that just reflows on rotation
— or worse, two component trees swapped by orientation that each own their
own LiveKit connection and chat subscription, silently dropping the call
and resetting state every time the phone rotates.

**Alternatives considered**:
1. Treat orientation as just another responsive breakpoint — one layout,
   CSS reflow only, no orientation-specific behavior differences.
2. Two distinct presentation modes (portrait: participation/community
   context; landscape: focused live-show view), architecturally required to
   share the same live state so rotating never drops the connection or
   resets anything.

**Decision**: Option 2, specified in detail by the user: portrait
prioritizes speakers-visible + easy-to-reach chat/reactions/prompts/voting/
request-to-speak + prominent chat + no horizontal scroll; landscape
prioritizes the conversation itself — speakers get substantially more
space, side-by-side feeds when practical, chat collapsed by default with
an easy reopen, reactions/controls as lightweight overlays. Rotating
between them must preserve live video, chat state, votes, reactions,
speaker state, and timers, with no reload. Documented in PRODUCT.md (new
Mobile orientation behavior section + Principle 13), ARCHITECTURE.md (new
Mobile orientation implementation section — the architectural rule that
live state must be owned above the orientation-conditional branch, not
inside it — plus a new Testing & Definition of Done checklist item),
AGENTS.md (standing rule against the naive per-orientation-component-tree
approach), and ROADMAP.md (cross-referenced from Phase 2).

**Reason**: This is a corollary of the existing responsive design
principle (PRODUCT.md Principle 11) applied to the one place in the MVP
where orientation carries real product meaning, not just layout
convenience — the live room is simultaneously a video call and a crowd
experience, and which one dominates should follow how the phone is held.
Calling it out as its own principle (rather than leaving it implicit under
"responsive design") exists because the failure mode is worse than a
typical responsive bug: getting breakpoints wrong looks bad, but getting
orientation wrong on this screen actually drops the user's live connection
— severe enough to warrant an explicit, named rule future sessions can't
miss.

**Tradeoffs**: Requires more deliberate component architecture up front
(shared state lifted above two presentation-only orientation branches)
than the naive approach would. Accepted, since retrofitting this after
building it the naive way would mean rearchitecting state ownership in a
component that also has to manage a live WebRTC connection — considerably
more expensive later than deciding it now, before Phase 2 exists at all.
Currently a design commitment for a future session to implement against,
not working code — there's no live room yet.

---

## 2026-08-06 — Authentication is a progressive upgrade, not an entry gate

**Problem**: Session 1 built the landing page and header with signup/login
as the primary, unavoidable calls to action — "Join the audience" led to
`/signup`, and there was no path into the product that didn't route through
account creation first. The user corrected this: nobody should have to
create an account to open the app, view an event, or participate as
audience.

**Alternatives considered**:
1. Keep authentication as the front door — simplest to build, matches a lot
   of default SaaS templates, but means every visitor's first experience of
   the product is a signup form, not the conversation itself.
2. Progressive authentication — guests can fully watch/react/vote; an
   account is required only for actions that need persistent identity
   (requesting the mic, commenting, reputation).

**Decision**: Option 2, specified in detail by the user: guest capabilities
(view landing, view events, join as audience, watch, emoji react,
continue/replace vote, view chat, leave anytime) vs. account-only
capabilities (request mic, comment/prompt/question, build reputation and
reliability, future speaking opportunities, saved history, hosting,
persistent display name). Guest identity is a temporary anonymous session
(cookie-based), not a `profiles` row; guest votes/reactions are rate-limited
and duplicate-checked but never accrue reputation, reliability, hosting
privileges, or payouts. Documented across PRODUCT.md (new Progressive
authentication model section + Principle 12), ARCHITECTURE.md (Auth flow
rewritten, new Guest identity and Rate limiting sections, Data model updated
per-table for guest eligibility), README.md, AGENTS.md, and ROADMAP.md
(every phase item annotated for guest eligibility).

**Reason**: The prototype exists to test whether people voluntarily watch
and stay invested in strangers' conversations (see PRODUCT.md's core
question). A login wall in front of that test contaminates the result —
you'd be measuring "who is willing to sign up for an unproven product,"
not "who is willing to watch." Gating only the actions that genuinely need
persistent identity (requesting the mic, building reputation) keeps the
account meaningful — see PRODUCT.md Principle 4, reputation earns
opportunity, not control — without making it a toll.

**Reason for the specific mechanism (cookie-based guest identity, not, say,
letting guests vote with no identity check at all)**: PRODUCT.md explicitly
requires guest actions to be "rate-limited and protected against obvious
duplicate abuse," which needs *some* stable-enough identity per guest per
session. A signed session cookie is the minimal mechanism that satisfies
that requirement without creating an account, an email address, or any
`auth.users`/`profiles` row for the guest — see ARCHITECTURE.md's Guest
identity section.

**Tradeoffs**: Every account-only server action must check for an
authenticated user itself and degrade to an inline "create an account to do
this" prompt, rather than relying on a route-level gate to keep unauthorized
users out — more discipline required per-action, but this is also just
correct: a route-level gate would violate the "guests are never redirected
away from where they are" requirement by construction. The guest identity
mechanism (cookie, rate-limiting, dedup) is unbuilt as of this decision — no
guest-facing write exists yet (that's Phase 3) — so this is currently a
design commitment for future sessions to implement against, not working
code. The existing landing page was refactored this session (Hero's primary
CTA no longer points at `/signup`); see ROADMAP.md's Known gaps for the
placeholder anchor link that needs to become a real guest-join flow once
Phase 1's events exist.

---

## 2026-08-06 — Responsive design is a permanent, first-class product principle

**Problem**: Whether mobile support could be treated as a later adaptation
pass on a desktop-first build (or vice versa), given the MVP's time
pressure to validate the core behavioral hypothesis quickly.

**Alternatives considered**:
1. Build desktop-first, adapt/compress for mobile once the core loop is
   validated.
2. Build mobile-first, stretch for desktop later.
3. Treat both as first-class from the start: shared business logic, layouts
   and interaction patterns intentionally designed per screen size.

**Decision**: Option 3, adopted explicitly by the user mid-session as a
permanent architectural/product principle — not a per-feature judgment
call. Documented in PRODUCT.md (product rule), ARCHITECTURE.md
(implementation notes + testing/Definition-of-Done checklist), README.md,
AGENTS.md, and ROADMAP.md (checklist reference on every phase).

**Reason**: The prototype's entire purpose is testing whether people stay
invested in watching strangers talk — a huge share of realistic usage (half-
attentive viewing) happens on phones, and a platform that only works well
on one form factor doesn't actually test the hypothesis for the audience
that matters. Graceful degradation under poor network conditions was
called out specifically because a live-conversation product that hard-fails
on a network hiccup breaks the exact behavior (staying invested) being
measured.

**Tradeoffs**: More engineering effort per screen than a single desktop (or
mobile) layout — accepted explicitly by the user as worth it. Landing page
and auth pages built earlier in this same session (before the principle was
formalized) use responsive Tailwind utilities throughout but have not yet
been walked through the full testing checklist (real device widths,
throttled network) — flagged in ROADMAP.md Phase 0 as a follow-up rather
than blocking this session on manual device testing that isn't available in
this environment.

---

## 2026-08-06 — Defer LiveKit SDK installation

**Problem**: The tech stack specifies LiveKit for video, but the MVP
feature being built this session (landing page + auth) doesn't use it.

**Alternatives considered**:
1. Install `livekit-client`/`livekit-server-sdk` now so the dependency is
   "ready" for later.
2. Defer installation until the live-room feature (Roadmap Phase 2) is
   actually being built.

**Decision**: Defer (option 2).

**Reason**: Principle 10 ("never add unnecessary complexity") and the
project's own testing rule — untested, unused dependencies and code paths
are a liability, not readiness. LiveKit also needs an `events`/speaker-seat
data model to be useful, which doesn't exist yet.

**Tradeoffs**: A future session has one more `npm install` step before
Phase 2 work. Judged cheap.

---

## 2026-08-06 — Hand-write `src/types/database.ts` instead of generating it

**Problem**: Supabase's recommended workflow generates database types from
a live project (`supabase gen types typescript --project-id ...`), but this
environment has no Supabase project or credentials.

**Alternatives considered**:
1. Skip typed Supabase clients entirely (use `any`/untyped queries) until a
   real project exists.
2. Hand-write types that mirror `supabase/migrations/` exactly, and
   document that they must be kept in sync by hand until generation is
   possible.

**Decision**: Hand-write (option 2).

**Reason**: Untyped Supabase queries would defeat the purpose of using
TypeScript for the one layer (data access) most prone to silent bugs.
Keeping migrations as the schema source of truth, with types mirroring
them, is the same discipline the project will use once generation is
available — it's a placeholder for the mechanism, not a different design.

**Tradeoffs**: Manual sync risk — a migration and `database.ts` can drift.
Mitigated by calling this out explicitly in ARCHITECTURE.md and requiring
both to change in the same commit.

---

## 2026-08-06 — RLS enabled on every table from the first migration

**Problem**: Whether to enable Postgres Row Level Security per-table as a
judgment call, or as a hard default.

**Alternatives considered**:
1. Add RLS later, once there's more than one table and a clearer sense of
   access patterns.
2. Enable RLS on every table from the start, including the first
   (`profiles`).

**Decision**: Hard default from the start (option 2).

**Reason**: Retrofitting RLS onto a table that's already accumulated
policies-by-omission (i.e., an open table the client happened to only query
safely) is a common source of real-world data leaks. Cheaper to establish
the pattern once, correctly, than to audit for it later.

**Tradeoffs**: Slightly more ceremony per migration (must write policies
alongside the table). Judged worth it for a social product with
user-generated data.

---

## 2026-08-06 — Package name required a workaround for `create-next-app`

**Problem**: `create-next-app` refuses to scaffold into a directory whose
name isn't a valid npm package name; the project folder is `Virtual Stage`
(capital letters, a space).

**Alternatives considered**:
1. Rename the working directory.
2. Scaffold into a temporary valid-named subdirectory (`virtual-stage/`),
   then move its contents up to the repo root and remove the subdirectory.

**Decision**: Scaffold into `virtual-stage/` then move up (option 2).

**Reason**: The working directory name is outside this project's control
(user's filesystem); renaming it wasn't requested and risks confusing the
user about where their project lives. The npm package name (`package.json`
`name` field) only needs to be a valid identifier — it doesn't need to
match the folder name — so `virtual-stage` was kept as the package name
after the move.

**Tradeoffs**: None of consequence — purely a scaffolding-time workaround.
