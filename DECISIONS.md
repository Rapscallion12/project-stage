# Decisions

Architecture Decision Record. Newest first. Format: Problem, Alternatives
considered, Decision, Reason, Tradeoffs.

## 2026-08-11 — The live room renders speakers from `event_speakers`, never from LiveKit's own state; `display_name` is denormalized to make that possible for guests

**Problem**: Issue #3's initial design proposal (before the user's
correction) derived the room's "who is speaking" display from LiveKit's
own participant/track state — a speaker's tile would show whoever
currently had a published, subscribed audio track. That's a reasonable
reading of "the room should show who's talking," but it makes `event_speakers`
*not* actually authoritative in the UI: a speaker who mutes, loses camera
permission, or has a transient connection hiccup would visually vanish
from the room, even though the database still correctly says they hold
the seat — the exact kind of drift PRODUCT.md's "the audience controls
the stage" principle (and every design decision since issue #1) has been
built to avoid.

**Alternatives considered**:
1. Derive current speakers from LiveKit's participant/track state
   directly (the original proposal).
2. Derive current speakers entirely from `event_speakers` (already
   fetched server-side, kept live via Realtime); use LiveKit's
   participant list *only* to decide whether a video frame is currently
   available to render for an already-known speaker.

**Decision**: Option 2, at the user's explicit direction.
`hooks/use-active-speakers.ts` subscribes to `event_speakers`'s Realtime
feed (migration `00000000000010` adds it to the `supabase_realtime`
publication) and is the *only* source `SpeakerStage`/`SpeakerTile` use to
decide whether a seat is occupied and by whom.
`hooks/use-live-room-connection.ts`'s LiveKit `Room` is consulted only to
look up a *matching, already-known* speaker's participant object for
media attachment — a `SpeakerTile` can have a `speaker` (DB) with no
`participant` (LiveKit) at all, and renders a named "camera off"
placeholder, not an empty seat. The reverse (a `participant` implying
occupancy) never happens; nothing in the room ever asks LiveKit "who's
speaking."

**Reason**: This is a direct extension of the same principle
`event_speakers` itself was designed around (issue #1) and that issue
#13's whole authorization model reinforces: the database is the single
source of truth for stage occupancy, and every other system (LiveKit
included) is downstream of it, never a peer source. A speaker's media
having trouble is a *presentation* concern, not an *occupancy* one.

**A real problem this decision surfaced**: `profiles` RLS grants `select`
to `authenticated` only (migration `00000000000001`) — guests can't read
it. Showing a speaker's name (sourced from `event_speakers.profile_id`)
to a guest viewer therefore needed *some* way to resolve a name without
a `profiles` join. Considered using LiveKit's own participant `.name`
metadata (already embedded in tokens by `mintLiveKitToken`, and readable
by any connected participant, guests included) — rejected, because that
re-couples the *name* to LiveKit connection state, exactly what this
whole decision exists to avoid: a speaker's name would disappear right
when their connection is the thing having trouble.

**Fix**: `display_name` (migration `00000000000010`) — a denormalized
snapshot of `profiles.display_name`, written by `claim_speaker_seat`
itself (a plain `select` at assignment time; the function already runs
`security definer` with full table access, so this needed no new grant),
never accepted as a caller-supplied parameter. Exactly the pattern
`event_chat_messages.author_display_name` already established for the
identical guest-visibility problem — not a new idea, a second application
of one. `profile_id` remains the durable identity reference for every
authorization check and future join; `display_name` is presentation-only
and never trusted for anything else.

**Tradeoffs**: A speaker's on-screen name is a snapshot, not live — if
they rename their account mid-show, the room keeps showing the name they
had when seated (same accepted tradeoff `event_chat_messages` already
made, for the same reason: consistency of what's currently displayed
matters more here than reflecting a rename that happens to land
mid-conversation). The table's zero rows in the live project at the time
of this migration meant no backfill was needed for the new `not null`
column — confirmed by query before writing the migration, not assumed.

---

## 2026-08-11 — Two testing-infrastructure gaps issue #3 surfaced (not product bugs)

**Problem**: Issue #3 was this project's first component-rendering test
(`speaker-tile.test.tsx`) and first hook that mirrors genuinely external
browser state via a subscription (`useOrientation`, matching
`window.matchMedia`). Both surfaced gaps in shared test/lint
infrastructure rather than in the feature code itself.

1. **React Testing Library's DOM wasn't being cleaned up between tests.**
   Multiple `render()` calls in `speaker-tile.test.tsx` left prior tests'
   DOM trees mounted, so `getByTestId`/`getByRole` started matching
   multiple elements once more than one test in the file called `render`.
   Testing Library's auto-cleanup relies on a global `afterEach` being
   available, which requires `test.globals: true` in `vitest.config.mts`
   — not set in this project (every test file explicitly imports
   `describe`/`it`/`expect` from `"vitest"` instead, a deliberate style
   choice worth keeping). **Fix**: `vitest.setup.ts` — already loaded for
   every test file — now explicitly calls `cleanup()` in its own
   `afterEach`, rather than turning on `globals: true` project-wide for
   one feature's sake. This benefits every future component test, not
   just this issue's.
2. **A first draft of `useOrientation` and part of `useLiveRoomConnection`
   set state synchronously inside `useEffect`**, which
   `react-hooks/set-state-in-effect` flags as an error — the same
   underlying issue `useNow`'s own comment already documents (see
   `hooks/use-now.ts`): setting state synchronously on every effect run
   is the wrong tool for mirroring genuinely external state.
   `useOrientation` was rewritten to use `useSyncExternalStore`, the same
   fix `useNow` already established as this project's pattern for exactly
   this case. `useLiveRoomConnection`'s violation was different in kind —
   an async connection-lifecycle effect, not a snapshot of synchronous
   external state — so `useSyncExternalStore` doesn't fit there; instead,
   the redundant `setStatus`/`setMediaError` calls that only restated
   what the `useState` initializer already knew were removed, leaving
   every `setState` call in that hook inside a genuine LiveKit event
   callback or promise resolution — which is what the lint rule is
   actually asking for.

**Reason recorded here**: both are exactly the kind of gap that's easy to
introduce once and then have silently affect every test/hook written
after, if not caught and fixed at the shared-infrastructure level. Same
reasoning as documenting issue #13's `PUBLIC`-execute-by-default finding
in ARCHITECTURE.md as a standing rule rather than just fixing the one
instance.

---

## 2026-08-11 — Three real bugs the issue #13 integration tests caught, fixed as forward migrations

**Problem**: Running issue #13's integration tests for real (once
`SUPABASE_SERVICE_ROLE_KEY` was configured) surfaced three genuine bugs
that unit-level reasoning about the migration's SQL hadn't caught. Each
is recorded here because each is a *pattern*, not a one-off typo — the
next migration that introduces a new `security definer` function or a new
`service_role` caller can hit the same thing.

1. **`service_role` had no table grants at all.** The service client's
   very first real call (`events.insert(...)` in a test fixture) failed
   with "permission denied for table events." `service_role` bypasses
   RLS, but RLS bypass and the underlying Postgres table `GRANT` are
   separate privilege layers — this project's tables were never granted
   to `service_role` (only `anon`/`authenticated`, deliberately, per
   table), and this project's setup turned out not to inherit the
   standard Supabase default-privilege bootstrap that normally makes that
   unnecessary. **Fix** (migration `00000000000007`): explicit
   `grant ... on all tables in schema public to service_role`, plus a
   matching `alter default privileges` so future tables inherit it
   automatically — the one place a blanket grant is correct instead of
   per-table, since `service_role` having full table access isn't an
   access-control decision the way `anon`/`authenticated` grants are, it's
   what the role is documented to mean.
2. **`claim_speaker_seat`/`end_speaker_seat` were callable by anyone,
   despite never being granted to `anon`/`authenticated`.** This is the
   one that mattered most: it's exactly the exposure the user's
   constraint on this issue was written to prevent, and it was happening
   silently. Cause: PostgreSQL grants `EXECUTE` on a new function to
   `PUBLIC` by default, unlike tables (which start with no privileges for
   anyone). Migration `00000000000006` added the *intended* explicit
   grants but never revoked the default `PUBLIC` one those were supposed
   to replace — confirmed via `select proacl from pg_proc where proname =
   'claim_speaker_seat'`, which showed an empty-role (`PUBLIC`) entry
   granting execute. The test written specifically to prove the exposure
   constraint held (signing in as an ordinary user and asserting `42501`
   on both functions) is what caught this — it failed with "expected null
   not to be null" instead, i.e. the call had simply succeeded. **Fix**
   (migration `00000000000008`): explicit `revoke execute ... from
   public` on all three functions. Documented in ARCHITECTURE.md's Data
   model section as a standing rule: a new `security definer` function
   must revoke `PUBLIC` execute in the same migration that creates it,
   never rely on omission the way a table grant works.
3. **`end_speaker_seat`'s no-op case returned a garbage object, not
   `NULL`.** When its `UPDATE ... RETURNING` matched zero rows (the
   intended safe no-op), the PL/pgSQL `v_row` variable was never assigned
   — but an unassigned composite variable is a row of all-NULL *fields*,
   not SQL `NULL` itself. `RETURN v_row` returned that, which PostgREST
   (calling a non-`SETOF` composite-returning function via `FROM
   fn(...)`, which always contributes exactly one row) serialized as
   `{"id": null, "event_id": null, ...}` — a real JSON object, not `null`.
   `endSpeakerSeat()`'s `data ?? null` check only catches genuine JSON
   `null`, so callers (the LiveKit webhook handler included) were getting
   a truthy garbage object where they expected — and the doc comment
   promised — `null`. **Fix**: migration `00000000000009` replaces the
   function body to check PL/pgSQL's `FOUND` variable (set by the
   preceding `UPDATE` to whether it matched a row) and `return null`
   explicitly when it didn't — the correct SQL-level fix. That alone
   wasn't sufficient, though: PostgREST's FROM-clause-call behavior means
   even a function that *genuinely* returns SQL `NULL` still serializes as
   one row of null fields once composite-typed. `endSpeakerSeat()` in
   `lib/repositories/event-speakers.ts` was also updated to check the
   row's `id` field rather than trusting `data` itself to be `null` —
   belt-and-suspenders, but the JS-side check is what's actually load-
   bearing given the PostgREST behavior.

Also worth recording: the first attempt at the race-safety integration
test asserted the wrong invariant (`exactly one of two concurrent claims
must reject`), and failed on a run where both fulfilled. That's not a
bug — `claim_speaker_seat`'s own semantics are "replace whoever's there,"
so if the two calls happen to land closely enough that the first fully
commits before the second's `UPDATE` step runs, the second legitimately
replaces the first's brand-new row, and *both* promises correctly
fulfill. A true concurrent collision (both transactions' `UPDATE` running
before either `INSERT` commits) is the other legitimate outcome, and
*that's* the one where the partial unique index causes a rejection. The
test now asserts the property that's actually invariant regardless of
interleaving — never more than one active row for the seat afterward, and
every non-active row for that seat properly closed out as `'replaced'` —
rather than asserting a specific fulfilled/rejected split that timing
doesn't guarantee either way.

**Reason this is recorded here rather than just fixed silently**: all
three are the kind of gotcha that reads as obvious in hindsight but isn't
something migration-writing or code review alone would have caught —
verifying against the real linked project, not just reasoning about the
SQL, is what surfaced each one. Consistent with why this project's
integration tests hit the real database instead of mocking it.

**Tradeoffs**: None beyond the three extra migrations
(`00000000000007`–`00000000000009`) needed to land on top of
`00000000000006` rather than editing it in place — consistent with this
project's "never edit an applied migration, write a new forward one"
rule, same as the `--linked` reset guidance in the Migration workflow
section.

---

## 2026-08-09 — Issue #13's write path: three functions with three different authorization models, and where `service_role` enters this project

**Problem**: `event_speakers` (issue #1) was read-only from the app's
perspective; issue #13 had to add the actual write path — atomic seat
assignment/replacement, voluntary leave, disconnect cleanup — without a
table-level grant that would let any authenticated client write directly.
Every write needs *some* PostgREST-facing authorization, and this
project's Postgres functions are `security definer` (they run with the
function owner's table access, elevated above the caller's own grants),
so the real question was: what authorizes the *call*, per operation?

**Alternatives considered, per operation**:
1. One generic `assign_speaker(event_id, profile_id, seat_number)`
   function, granted to `authenticated`, callable by anyone.
2. Self-service: a claiming user calls a function that ends whoever
   currently holds the seat and inserts themselves, authorized by
   `auth.uid()` alone (no special permission needed beyond being logged
   in) — the design this session initially proposed and the user
   approved, reasoning that "claiming" a contested resource doesn't need
   permission *over* its previous holder.
3. Split by who the operation acts on: functions that only ever act on
   the *caller's own* row are `auth.uid()`-gated and safe to expose
   broadly; functions that act on *someone else's* row require a
   different, trusted-server-only authorization tier.
4. For that trusted-server tier specifically: a hand-rolled shared-secret
   parameter checked inside the function (via a Postgres `current_setting`
   or similar), avoiding `service_role` entirely.

**Decision**: Option 3, with `service_role` (not option 4) as the
trusted-server tier's actual mechanism.

- `leave_speaker_seat(event_id)` — self-service, `auth.uid()`-gated,
  granted to `authenticated`. Ends only the caller's own row.
- `claim_speaker_seat(event_id, profile_id, seat_number)` and
  `end_speaker_seat(event_id, profile_id, reason)` — **not** granted to
  `anon`/`authenticated` at all. Callable only via the `service_role`
  client (`lib/supabase/service.ts`, introduced by this issue).

**Reason this isn't option 2, despite it being approved first**: revisiting
it, self-service claiming has a real flaw — without Phase 3's queue/voting
system built yet (and it deliberately isn't, this issue), granting
`claim_speaker_seat` to any authenticated user means *any* logged-in
account could seize the microphone from the current speaker at will,
repeatedly, adversarially. That's not an edge case to accept for a
prototype, it's the direct opposite of PRODUCT.md's "the audience controls
the stage" — the audience (collectively, via a mechanism that doesn't
exist yet) should decide, not any individual by calling an RPC. The user
caught this and set the constraint explicitly: ship the atomic,
race-safe *mechanism* in this issue, but it must not become a generally
exposed production action — Phase 3's queue/voting is what will own
deciding *who* is allowed to call it. `end_speaker_seat` has the same
shape of problem (ending *someone else's* occupancy) for the same reason.

**Reason this is `service_role` and not option 4**: every write reachable
through `service_role` here is already independently authorized before it
ever reaches Postgres — the LiveKit webhook route verifies LiveKit's
webhook signature before calling `end_speaker_seat`, and
`claim_speaker_seat` has no caller at all yet. A hand-rolled shared secret
stored in a Postgres GUC would add real complexity (a value that can't
simply live in a migration file, since migrations are committed to git —
it would need Postgres Vault or an out-of-band `ALTER DATABASE ... SET`
step) for no actual security improvement over a mechanism (`service_role`)
Supabase already provides and documents for exactly this scenario:
trusted, non-client-reachable backend code. This is a deliberate,
narrowly-scoped exception to this project's prior stance of never using
`service_role` — see ARCHITECTURE.md's Vendor portability section, which
that stance predates. It is not a general reversal: `service_role` is
used in exactly one file (`lib/supabase/service.ts`), imported by exactly
three call sites (the webhook route, `claimSpeakerSeat`, `endSpeakerSeat`),
each of which has its own independent gate before touching it.

**A second partial unique index** (`event_speakers_active_profile_uniq`
on `(event_id, profile_id) where left_at is null`) was added in the same
migration — a genuine gap in issue #1's schema surfaced while designing
`claim_speaker_seat`: nothing stopped the same profile from holding two
seats in one event at once. `claim_speaker_seat` relies on it as the real
race-safety backstop (an application-level existence check is only a
friendlier early error; concurrent callers are resolved by the unique
indexes, not by app logic), same pattern as the existing per-seat index.

**Tradeoffs**: `claim_speaker_seat` ships with no production caller and no
way to exercise it from the app UI — only tests call it, via the same
`service_role` access tier a real future caller (Phase 3) would need. This
is the same "ship the primitive, no UI trigger yet" shape issues #1 and #2
already established, just one level further (no Server Action stub
either, since creating one would itself be "generally exposing" it). The
integration tests that prove this all works (race safety, replacement
history, the authorization boundary itself) require
`SUPABASE_SERVICE_ROLE_KEY` in `.env.local` and real fixture rows (test
accounts created via the Auth admin API, not fake UUIDs, since these
functions write through real foreign keys) — they `describe.skipIf` when
that key is absent, same discipline as the existing anon-key integration
tests.

---

## 2026-08-09 — LiveKit token minting (issue #2) is split from seat-state writes (issue #13)

**Problem**: Issue #2 was originally scoped as "LiveKit SDK integration
and token endpoint," with its own body already anticipating that token
minting would need to check "occupying or entitled to occupy" a seat.
Working through the full authorization model before implementing (per
the user's request — audience joining, speaker promotion, replacement,
reconnects, race conditions, expiry, moderator actions, multi-room)
surfaced that "entitled to occupy" isn't just a read: it implies
*deciding* who occupies a seat, which needs an atomic DB write, a live
LiveKit permission push to already-connected participants, and
disconnect cleanup — none of which "mint a token" by itself requires.

**Alternatives considered**:
1. Implement all of it as one piece of work under issue #2.
2. Split: issue #2 mints tokens from *current* `event_speakers` state
   only (a read); a new issue owns changing that state (atomic
   assignment, live permission sync, disconnect cleanup).

**Decision**: Option 2, at the user's direction. New issue #13 covers the
write path; issue #2 stays a read-only token endpoint. Issue #13 was
positioned in the Project board's item order directly after #2 and
before #3/#4 (`updateProjectV2ItemPosition` via the GraphQL API — `gh
project` has no CLI flag for this), reflecting the real dependency: #3/#4
can be built and manually tested against hand-seeded `event_speakers`
rows (the same way `supabase/seed.sql` hand-seeds events) without #13,
but real dynamic speaker promotion needs it.

**Reason**: This mirrors the exact split already made for `event_speakers`
itself in issue #1 (ship the read path + RLS, defer the write
path/authorization logic to the issue that actually needs to design it) —
consistent, not novel. Bundling the write path into issue #2 would have
meant designing atomic-assignment race safety, a LiveKit webhook
receiver, and disconnect-grace-period handling as a side effect of "add
a token endpoint," which is a much larger and less independently
reviewable unit of work than the title suggested. Splitting keeps issue
#3 (room UI) unblocked as soon as #2 lands, without waiting on the
harder write-path problem.

**The authorization model itself** (what issue #2 actually implements):
the server is the sole source of truth for `canPublish` — the client
never receives the LiveKit API secret, only a scoped JWT whose grants
LiveKit's own SFU enforces server-side. `canPublish` is decided from
whether the requester currently holds an active `event_speakers` row
(`determineCanPublish()`, a pure function over an already-fetched
occupancy record, kept separate from the DB lookup specifically so it's
unit-testable without a live fixture — `event_speakers` has no write
grant, so a test can't seed an "active speaker" row through the app's
own client the way it seeded other fixtures). Token TTL is generous (4
hours) and deliberately *not* the revocation mechanism — see
ARCHITECTURE.md's LiveKit authorization model section for why relying on
expiry would visibly contradict "the audience controls the stage," and
why issue #13's live permission push is the real enforcement point.

**Tradeoffs**: Issue #2 ships a token endpoint that, in practice, always
returns `canPublish: false` today — nothing can create an active
`event_speakers` row yet, so there's no way to manually verify the
`true` branch end-to-end until #13 lands. Mitigated by unit-testing that
branch directly with a constructed (not DB-fetched) occupancy record,
same reasoning as issue #1's read-path tests not requiring a live
fixture either.

---

## 2026-08-09 — `event_speakers` models occupancy episodes, not a schedule or a pointer

**Problem**: Issue #1 needed a data model for "who's speaking in an
event." Three framings were plausible on the surface — a scheduled
speaker assignment, a single "current speaker" pointer per seat, or a
historical occupancy record — and the wrong choice would either
contradict the product's own principles or make Phase 3/4 (replace
voting, reputation, reliability) expensive to retrofit.

**Alternatives considered**:
1. A "scheduled speaker" table — pre-assign who will occupy each seat.
2. A single mutable pointer per seat (e.g. `events.current_speaker_1_id`),
   updated in place whenever a speaker changes.
3. Append-only occupancy episodes — one row per (seat, occupant) stretch
   of time, with `joined_at`/`left_at`, never overwritten; replacing a
   speaker ends one row and inserts another.

**Decision**: Option 3.

**Reason**: Option 1 doesn't match how this product actually works —
PRODUCT.md's Principle 1 ("the audience controls the stage") and
Principle 3 ("anyone can eventually earn the microphone," via a live
queue) both describe who's on stage as something the audience/queue
decide in the moment, not something scheduled in advance. Building a
"scheduled speaker" concept would invent a feature that contradicts those
principles rather than support them. Option 2 would destroy exactly the
history Phase 3's replace-speaker voting exists to create — the moment
someone gets replaced, there'd be no record they ever spoke, cutting off
Phase 4's reputation/reliability work ("votes received while speaking,"
"removals for cause") at the schema level, not just leaving it unbuilt.
Option 3 is simultaneously the simplest of the three to reason about,
matches how speakers actually change hands in this product (replacement,
not reassignment), and gives Phase 4 what it needs for free — no
retrofit required, since the full history already exists as a natural
consequence of the design rather than a feature added on top of it.

Also decided in the same pass, each following the same "match already-
established project conventions" logic:

- **`left_reason` is a `CHECK`-constrained `text` column, not a native
  Postgres enum** — easier to extend later (a migration adding a value to
  a `CHECK` is simpler than altering a Postgres enum type, which has real
  restrictions on removing/reordering values), and no other table in this
  project uses a native enum, so this doesn't introduce a second
  convention. The vocabulary (`voluntary`, `replaced`, `moderator_removed`,
  `event_ended`, `disconnected`) was deliberately kept to values that
  trace to already-scoped work (issues #2, #3, #6, and Phase 3's replace
  voting/moderator controls) rather than guessing at hypothetical future
  reasons.
- **Room-agnostic, matching `events`' own precedent exactly**: no `room_id`
  column, because no `event_rooms` table exists and Phase 2 has exactly
  one room per event. The migration comment documents the specific future
  change (nullable `room_id`, re-scoping the active-seat uniqueness from
  `(event_id, seat_number)` to `(room_id, seat_number)`) so it's an
  expected additive follow-up, not a surprise redesign.
- **No write grant in this migration.** `events` itself shipped
  SELECT-only in its first migration, before event creation was a
  feature; `event_speakers` follows the same pattern. The authorization
  logic for "who's allowed to occupy a seat" doesn't exist yet — it's
  already scoped into issue #2 (LiveKit token minting checks
  occupancy/entitlement, per that issue's own body) — so granting INSERT
  here would mean guessing at rules that haven't been designed, or
  worse, an open door. Verified this is actually enforced, not just
  documented, with a committed regression test
  (`event-speakers.test.ts`) that attempts a real insert against the
  linked project and asserts it's rejected with `42501`.

**Tradeoffs**: The table is inert from the app's perspective until issue
#2 adds a write path — by design, but it does mean this issue ships
schema and a read-only repository function with no UI yet consuming
either. `listActiveSpeakers()`'s only current caller will be issue #4's
audience-viewing work.

---

## 2026-08-09 — Adopt the Supabase CLI mid-project via `migration repair`, not a reset

**Problem**: Three migrations' worth of schema had already been applied by
hand through the SQL Editor, across three separate sessions, with real
data sitting on top of it (seeded events, chat history, a real account).
Adopting the CLI (issue #12) meant getting `supabase/migrations/` and the
live project's own bookkeeping of "what's been applied" into agreement,
without touching the schema or data that already matched.

**Alternatives considered**:
1. Run `supabase db push` naively and let it try to reapply all three
   migrations for real.
2. Wipe the project (`supabase db reset --linked` or manually dropping
   everything) and let the CLI rebuild it from a clean slate.
3. Verify the remote schema matches the local migration files exactly via
   read-only introspection, then use `supabase migration repair` to mark
   the three existing migrations as applied — bookkeeping only, no SQL
   executed.

**Decision**: Option 3.

**Reason**: Option 1 would have failed partway through each file —
`CREATE TABLE ... IF NOT EXISTS` might no-op, but `CREATE POLICY`,
`CREATE TRIGGER`, and `CREATE FUNCTION` are not idempotent in Postgres and
error on "already exists," risking a half-applied, confusing state. Option
2 is explicitly what the user's own requirements ruled out ("preserve all
existing data and avoid destructive operations") — real accounts and chat
history live on this database; there is no staging copy to test against.
`migration repair` exists specifically for "adopt the CLI on top of an
already-manually-managed database" — it only writes rows into
`supabase_migrations.schema_migrations`, the tracking table, and cannot
touch application tables, policies, grants, or data.

Verification came first, deliberately, before repairing anything — no
Docker is available in this environment, so `supabase db diff`'s
local-shadow-database comparison wasn't an option, but `supabase db query
--linked` (executes SQL directly against the linked project via the
Management API, no Docker required) was enough to directly compare, one
by one: table/column shapes (`information_schema.columns`), RLS enabled
per table (`pg_tables.rowsecurity`), every policy
(`pg_policies`), every meaningful grant
(`information_schema.role_table_grants`), the profile-provisioning trigger
(`pg_trigger`), and Realtime publication membership (`pg_publication_tables`).
All of it matched the three migration files exactly. Only then were the
three versions marked applied.

The forward workflow was proven end-to-end with a real (if low-risk)
migration — `00000000000004_table_comments.sql`, adding `COMMENT ON TABLE`
documentation — applied via `supabase db push --linked` and confirmed live,
rather than trusting the setup without exercising it.

`database.ts` was switched from hand-written to
`supabase gen types typescript --linked`-generated in the same pass — see
the superseded note on "Hand-write `src/types/database.ts`" above.

**Tradeoffs**: `migration repair` is a footgun if used carelessly — it
will happily mark a migration "applied" whether or not the remote schema
actually matches, since it never checks. The verification step above is
what makes this safe; skipping it would have converted "the CLI's
bookkeeping is wrong" into "the CLI's bookkeeping is wrong *and* nobody
checked," silently papering over any real drift instead of catching it.
Local dev (`supabase start`, `supabase db reset --local`) still isn't set
up — no Docker in this environment — so `db diff` and a true local
Postgres remain unavailable; documented as a gap in ARCHITECTURE.md's
Migration workflow section rather than worked around.

---

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

**Superseded 2026-08-09**: the Supabase CLI is now set up and linked (see
"Adopt the Supabase CLI mid-project" below) — `database.ts` is generated,
not hand-written. The manual-sync risk this entry accepted as a tradeoff
materialized exactly once (the missing `Relationships`/`Views`/`Functions`
bug), which is part of why generation was worth doing as soon as it became
possible rather than continuing to accept the risk indefinitely.

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
