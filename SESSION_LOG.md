# Session Log

Newest entry first.

---

## 2026-08-09 — Session 11: Issue #13 — speaker seat state transitions

**Goal**: Ship the write path `event_speakers` didn't have — atomic seat
assignment/replacement, self-service voluntary leave, live LiveKit
permission sync, and disconnect-webhook cleanup — starting from an
architecture review and explicit assumptions before implementing, per the
user's now-standing practice.

**Completed work**:

- **Design review before implementation**, surfacing a real authorization
  question rather than picking an approach unilaterally: every write to
  `event_speakers` needs *some* PostgREST-facing authorization, and this
  app has no role between `anon`/`authenticated` and `service_role`.
  Proposed self-service claiming (`auth.uid()` alone authorizes claiming
  *any* contested seat) as the initial design; the user approved it but
  added an explicit constraint after further review: the seat-claim
  function must not become a generally exposed production action any
  authenticated user can invoke — Phase 3's queue/voting (not built) is
  what should gate who's allowed to claim a seat. Revised the design
  accordingly before writing any code — see DECISIONS.md for the full
  three-function authorization split this produced.
- **Migration `00000000000006`**: a second partial unique index
  (`event_speakers_active_profile_uniq`) closing a real gap in issue #1's
  schema (nothing stopped one profile holding two seats in the same event
  at once), plus three `security definer` functions —
  `leave_speaker_seat` (self-service, `auth.uid()`-gated, granted to
  `authenticated`), `claim_speaker_seat` and `end_speaker_seat` (atomic
  assignment/replacement and reason-coded ending of someone else's
  occupancy — deliberately **not** granted to `anon`/`authenticated`,
  service-client-only). Applied via `supabase db push --linked` and
  verified with `supabase migration list` (local/remote match); types
  regenerated.
- **`lib/supabase/service.ts`**: this project's first use of the
  `service_role` key — a deliberate, narrowly-scoped exception to the
  prior "never use it" stance (see DECISIONS.md for why), imported by
  exactly three call sites, each independently gated before touching it.
- **`lib/livekit/permissions.ts`**: `syncPublishPermission()`, pushing
  `canPublish` live to an already-connected participant via
  `RoomServiceClient.updateParticipant()`. Best-effort by design — logs
  and swallows failures rather than throwing or retrying, since
  `mintLiveKitToken` (issue #2) is the eventual-consistency fallback and
  building a retry queue would be exactly the "prematurely introduce
  distributed infrastructure" ARCHITECTURE.md's Vendor portability section
  warns against for a prototype.
- **`lib/repositories/event-speakers.ts`** gained `leaveSpeakerSeat`,
  `claimSpeakerSeat`, `endSpeakerSeat` — thin wrappers over the three RPC
  functions, each using the client tier its underlying function's grant
  actually requires (session-bound client for `leaveSpeakerSeat`, service
  client for the other two). `src/app/events/[id]/room/actions.ts` gained
  a `leaveSpeakerSeat` Server Action composing the repository write with a
  live permission push — no UI calls it yet (issue #3/#6), a tested
  primitive like issue #1/#2's unwired functions before it.
  `claimSpeakerSeat` deliberately has **no** Server Action wrapper at all
  — creating one would itself be "generally exposing" it, contradicting
  the user's constraint; only tests call it, via the same service-client
  tier a real future caller would need.
- **LiveKit webhook route** (`src/app/api/livekit/webhook/route.ts`):
  verifies LiveKit's webhook signature (`WebhookReceiver`, the `Authorize`
  header — confirmed by reading the installed SDK's source rather than
  assuming the header name), parses `participant_left` events back into
  `event_id`/`profile_id` via new inverse functions
  (`parseParticipantIdentity`/`parseRoomName` in `lib/livekit/token.ts`,
  returning `null` rather than throwing on malformed input — a webhook
  payload is untrusted even after signature verification), and calls
  `end_speaker_seat` with `reason: 'disconnected'`. No live permission
  push follows the disconnect — the participant's already gone, so
  there's nothing connected left to push to.
- Tests: `event-speakers-transitions.test.ts` (real fixture rows — test
  accounts created via the Auth admin API, not fake UUIDs, since these
  functions write through real foreign keys) covering atomic
  assignment, replacement history preservation, the second-seat rejection,
  race safety (two concurrent claims for one open seat — exactly one
  wins), disconnect/no-op safety, and — directly proving the user's
  exposure constraint holds, not just documenting it — that
  `claim_speaker_seat`/`end_speaker_seat` return `42501` for an ordinary
  authenticated user while `leave_speaker_seat` succeeds for one's own
  seat. `route.test.ts` signs real webhook payloads with `jose` (mirroring
  `livekit-server-sdk`'s own `WebhookReceiver`/`TokenVerifier` scheme,
  read from its source) to exercise the actual signature-verification
  path, not a bypassed one. `permissions.test.ts` proves the best-effort
  contract holds under every failure mode reproducible without a live
  connected participant. All of the above `describe.skipIf` gracefully
  without `SUPABASE_SERVICE_ROLE_KEY` configured. `token.test.ts` gained
  round-trip/malformed-input cases for the new parse functions.
- Documented in ARCHITECTURE.md (Data model, folder structure, Video plan,
  a new "Who may transition a seat, and how" subsection under LiveKit
  authorization model, Testing & Definition of Done), DECISIONS.md (a full
  ADR on the authorization-model split and the `service_role` exception),
  ROADMAP.md, README.md (service_role setup, webhook configuration note),
  `.env.local.example`, CHANGELOG.md.

- **`SUPABASE_SERVICE_ROLE_KEY` was added to `.env.local` partway through
  this session** (the user added it themselves, per this project's
  standing rule that credential-entering steps are never done through an
  agent), which unblocked running the integration tests for real instead
  of relying on their skip path. Doing so caught **three genuine bugs**
  that reasoning about migration `00000000000006`'s SQL alone hadn't —
  each fixed as its own forward migration rather than editing an already-
  applied one, per this project's migration discipline:
  - `service_role` had no table grants at all (this project's setup
    doesn't inherit Supabase's usual default-privilege bootstrap for it) —
    `service.from("events").insert(...)` failed with "permission denied
    for table events." Fixed in `00000000000007` with an explicit grant
    plus a matching `alter default privileges` for future tables.
  - **`claim_speaker_seat`/`end_speaker_seat` were actually callable by
    any authenticated (or anon) request**, despite never being granted to
    `anon`/`authenticated` — PostgreSQL grants `EXECUTE` on a new function
    to `PUBLIC` by default, and migration `00000000000006` added the
    intended explicit grants but never revoked that default. This is
    exactly the exposure the user's constraint on this issue was written
    to prevent, happening silently — caught by the test written
    specifically to prove that constraint held (it expected `42501` and
    got a successful call instead). Fixed in `00000000000008`.
  - `end_speaker_seat`'s no-op case (no active seat to end) returned a
    JSON object with every field `null`, not `null` itself — a PL/pgSQL
    unassigned-composite-variable subtlety compounded by how PostgREST
    serializes a non-`SETOF` composite function's result. Fixed in
    `00000000000009` (PL/pgSQL `FOUND` check) plus a matching guard in
    `endSpeakerSeat()` (checking the row's `id` field, since even a
    function that genuinely returns SQL `NULL` still arrives over
    PostgREST as one row of null fields).
  - Also caught and fixed: the race-safety test's own first draft asserted
    the wrong invariant (that exactly one of two concurrent claims must be
    rejected) — not a product bug, a test bug. `claim_speaker_seat`'s
    "replace whoever's there" semantics mean both calls can legitimately
    fulfill if they land closely enough together (the second cleanly
    replaces the first's brand-new row); a true collision is the other
    valid outcome, where the unique index rejects the loser. Rewrote the
    assertion to check what's actually invariant regardless of
    interleaving — never more than one active row for the seat, and every
    non-active row cleanly closed out as `'replaced'`.
  - Full writeup of all three (plus the test-assertion fix) in
    DECISIONS.md; the `PUBLIC`-execute-by-default gotcha is now a standing
    warning in ARCHITECTURE.md's Data model section for any future
    `security definer` function.
  - Also fixed along the way: the transitions test file's own first draft
    called `listActiveSpeakers()` (the Next-request-bound repository
    function) directly from a plain Vitest process, which fails on
    `cookies()` outside a request scope — same limitation
    `event-speakers.test.ts`'s existing comment already documented, just
    missed when writing the new file. Replaced with a direct service-
    client read. And the webhook route test originally required *real*
    LiveKit project credentials to run at all, even though signature
    signing/verification is a local HMAC/JWT check with no LiveKit API
    call involved — switched to `vi.stubEnv`-ed fake credentials (same
    pattern `token.test.ts` already uses for token minting), so it runs in
    any environment, not just one with a live LiveKit project configured.

**Files changed**: `supabase/migrations/00000000000006_speaker_seat_transitions.sql`
through `00000000000009_fix_end_speaker_seat_null_return.sql` (four
migrations total for this issue), `src/types/database.ts`,
`src/lib/supabase/service.ts`, `src/lib/livekit/permissions.ts`,
`src/lib/livekit/permissions.test.ts`, `src/lib/livekit/token.ts`,
`src/lib/livekit/token.test.ts`, `src/lib/repositories/event-speakers.ts`,
`src/lib/repositories/event-speakers-transitions.test.ts`,
`src/app/events/[id]/room/actions.ts`,
`src/app/api/livekit/webhook/route.ts`,
`src/app/api/livekit/webhook/route.test.ts`, `ARCHITECTURE.md`,
`DECISIONS.md`, `ROADMAP.md`, `README.md`, `.env.local.example`,
`CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: `claim_speaker_seat` has no production caller — by
design, not an oversight (see above) — so, same shape of limitation issue
#2 accepted for its `canPublish: true` branch, it's only exercised by
tests, not walked through the real app end-to-end. The webhook route
isn't reachable from local dev without a public tunnel (no LiveKit project
can call `localhost`); verified instead by constructing real signed
payloads (with fake-but-consistent credentials — see above).

**Tests run**: `npm run lint` (clean), `npx tsc --noEmit` (clean),
`npm run build` (clean — `/api/livekit/webhook` appears correctly in the
route table), `npx vitest run` — **28/28 passing, zero skipped**, once
`SUPABASE_SERVICE_ROLE_KEY` was configured and the three bugs above were
fixed (was 16/28 passing with 12 skipped before the key was added).

**Current build status**: Lint clean, typecheck clean, build clean, full
test suite passing (28/28, no skips).

**Recommended next task**: Issue #3 (room UI, `livekit-client`) — the
first thing with an actual page to build against `getLiveKitToken` and,
once a queue/authorization gate exists, `claimSpeakerSeat`. Phase 3's
queue/voting design is the remaining prerequisite for `claim_speaker_seat`
ever getting a real caller.

---

## 2026-08-09 — Session 10: Issue #2 — LiveKit token endpoint (split from #13)

**Goal**: Design and ship the LiveKit token endpoint — the enforcement
point for who may publish audio/video — starting from a full
authorization-model review before implementing, per the user's request.

**Completed work**:

- **Design review before implementation**, covering all nine points the
  user asked about: how audience members join as viewers, how current
  speakers get publish rights, how a newly-selected speaker transitions
  from audience to speaker, how a replaced speaker loses publish rights,
  reconnect handling, race conditions between near-simultaneous seat
  claims, token expiration/renewal, future moderator actions, and
  multi-room readiness. Core design: `canPublish` decided server-side
  from *current* `event_speakers` occupancy; token expiry deliberately
  not the revocation mechanism; live `updateParticipantPermissions()`
  pushes are what actually revoke/grant rights on already-connected
  participants.
- **Found a genuine scope gap while working through the design, and
  stopped to explain it rather than expanding scope unilaterally**:
  issue #2's own body already assumed a "become a speaker" write path,
  but designing that write path properly (atomic assignment, race
  safety, live permission sync, hard-disconnect cleanup via LiveKit
  webhooks) turned out to be substantially more surface area than "SDK
  install + token endpoint." Proposed splitting it out; user approved.
- Created **issue #13** for the write path, with the 8 scope points the
  user specified, and positioned it in the Project board's item order
  directly after #2 and before #3/#4 (`updateProjectV2ItemPosition` via
  raw GraphQL — `gh project` has no CLI flag for item ordering; verified
  the resulting order by re-listing items: #1 → #2 → #13 → #3 → #4).
- Implemented **issue #2 narrowly**, per the user's explicit scope list:
  - Installed `livekit-server-sdk` only (not `livekit-client` — deferred
    to issue #3, the first thing that actually connects to a room),
    continuing the project's existing discipline against installing
    dependencies before something uses them.
  - `lib/livekit/token.ts`: `getRoomName()` (`event:<id>:main`,
    multi-room-ready), `getParticipantIdentity()` (namespaced
    `guest:`/`profile:` identities), `determineCanPublish()` (a pure
    function over an already-fetched occupancy record, deliberately
    separated from the DB lookup so it's unit-testable without a live
    fixture — `event_speakers` has no write grant, so nothing can seed
    an "active speaker" row through the app's own client), and
    `mintLiveKitToken()` (4-hour TTL, `canPublishData: false` since chat
    already goes through Supabase Realtime).
  - `src/lib/repositories/event-speakers.ts` gained
    `getActiveSeatForProfile()` — a targeted read, not a filter over
    `listActiveSpeakers()`.
  - `src/app/events/[id]/room/actions.ts`'s `getLiveKitToken` Server
    Action — thin glue: resolve identity, look up occupancy (guests skip
    the DB call entirely, since they can never have one), mint token.
    No `room/page.tsx` exists yet (issue #3); the action file doesn't
    need a page to exist to be valid Next.js.
- **Real bug caught and fixed while writing tests**: minting a token
  under the project's default `jsdom` Vitest environment failed with an
  opaque "payload must be an instance of Uint8Array" error — `jose`
  (which `livekit-server-sdk` uses for signing) needs real Node
  WebCrypto, which jsdom shims incompatibly. Fixed with a per-file
  `// @vitest-environment node` override; documented in ARCHITECTURE.md
  so the next test that signs/verifies anything doesn't hit this fresh.
- Tests (`token.test.ts`, 7 cases) cover the pure logic
  (`determineCanPublish`, naming functions) and the actual JWT output
  (decoded and asserted, for both a guest/no-seat case and an
  active-speaker case using a constructed — not DB-fetched — occupancy
  record) — all without needing the user's real LiveKit credentials,
  since minting signs a JWT locally and never calls LiveKit's API.
- Documented the model in ARCHITECTURE.md (new "LiveKit authorization
  model" section, LiveKit added as a third documented Vendor-portability
  exception alongside Auth/Realtime), a DECISIONS.md ADR (the #2/#13
  split and why), README.md (optional LiveKit credential setup, since
  nothing in the app connects to a room yet), AGENTS.md (server-decides-
  publish-rights standing rule, plus generalizing the
  "walk the design through before implementing" practice into a standing
  rule of its own — it's caught real gaps twice now), and ROADMAP.md.

**Files changed**: `src/lib/livekit/token.ts`,
`src/lib/livekit/token.test.ts`, `src/app/events/[id]/room/actions.ts`,
`src/lib/repositories/event-speakers.ts`, `package.json`,
`package-lock.json`, `ARCHITECTURE.md`, `DECISIONS.md`, `README.md`,
`AGENTS.md`, `ROADMAP.md`, `CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: None for issue #2's own scope. The token endpoint's
`canPublish: true` branch can't be exercised end-to-end through the real
app yet (nothing can create an active `event_speakers` row until #13
lands) — covered by the unit test using a constructed occupancy record
instead, same reasoning as issue #1's read-path tests not needing a live
fixture either. The user's real LiveKit project credentials aren't
configured in this environment — not required for anything issue #2
ships (token minting signs locally), only for issue #3 onward.

**Tests run**: `npm run lint`, `npx tsc --noEmit`, `npm run build`,
`npx vitest run` (10 tests across 3 files, including the 7 new LiveKit
ones) — all clean.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing (10/10).

**Recommended next task**: Either issue #13 (speaker state transitions —
unblocks real dynamic speaker promotion) or issue #3 (room UI, which can
proceed against hand-seeded `event_speakers` rows without #13, per the
dependency analysis above). #12 and #1 are already Done.

---

## 2026-08-09 — Session 9: Issue #1 — `event_speakers` table

**Goal**: Design and ship the `event_speakers` schema — the Phase 2
foundation everything else (LiveKit integration, the live room, audience
viewing) depends on — starting from a product-philosophy review rather
than jumping straight to columns.

**Completed work**:

- Moved issue #1 to **In Progress**, branched `feature/event-speakers-table`.
- **Design review before writing any schema**, per the user's request:
  walked through what an event speaker represents (an append-only
  occupancy episode, not a scheduled assignment or a mutable "current
  speaker" pointer), how it relates to Events/Profiles/future Live Rooms
  (account-only, deliberately room-agnostic like `events` itself), how
  replacement preserves history (end one row, insert another, never
  overwrite), how it supports reputation/reliability/moderation/analytics
  (the `[joined_at, left_at)` interval and a constrained `left_reason`
  give Phase 4 what it needs without extra columns), and which fields are
  derived vs. persisted (active/duration/current-speakers are all query-
  time computations, matching `events`' own computed-phase discipline).
  Presented for approval before implementing — see DECISIONS.md for the
  full reasoning, including why the other two framings were rejected.
- **Checked for a genuine prerequisite before treating it as one**: the
  obvious next question — "who's allowed to write to this table, and does
  that logic exist yet?" — turned out to already be scoped into issue #2
  (its own body already says the token-minting flow checks
  occupancy/entitlement). Confirmed this by re-reading the existing issue
  rather than assuming, so no new issue was needed and scope wasn't
  expanded.
- User approved the design with one change: `left_reason` as a
  constrained vocabulary, not free text.
- Migration `00000000000005_event_speakers.sql`: append-only occupancy
  episodes, `CHECK`-constrained `left_reason` (`voluntary` / `replaced` /
  `moderator_removed` / `event_ended` / `disconnected` — each traceable to
  already-scoped work, not guessed), a partial unique index enforcing one
  active occupant per seat per event (historical rows unrestricted), RLS
  with a public `SELECT` policy and **no write grant** (matching `events`'
  own first-migration precedent), applied via `supabase db push --linked`
  and verified (RLS/policies/grants all confirmed via `db query --linked`).
- `src/types/database.ts` regenerated. `lib/repositories/event-speakers.ts`
  ships `listActiveSpeakers()` only — no write functions, since there's no
  RLS policy or design to support them yet (that's issue #2).
- **New test infrastructure**: Vitest now loads `.env.local` (via Vite's
  `loadEnv`) so tests can use real credentials. `event-speakers.test.ts`
  is the project's first integration-style test — hits the real linked
  Supabase project (not a mock), confirms reads work and, more
  importantly, that a raw insert attempt is actually rejected with
  `42501` — proving the "read-only for now" design decision is enforced,
  not just documented. Skips gracefully if credentials aren't configured.
- Documented the design in ARCHITECTURE.md's Data model section and a new
  DECISIONS.md ADR; checked off the item in ROADMAP.md's Phase 2.

**Files changed**: `supabase/migrations/00000000000005_event_speakers.sql`,
`src/types/database.ts`, `src/lib/repositories/event-speakers.ts`,
`src/lib/repositories/event-speakers.test.ts`, `vitest.config.mts`,
`ARCHITECTURE.md`, `DECISIONS.md`, `ROADMAP.md`, `CHANGELOG.md`,
`SESSION_LOG.md` (this entry).

**Known issues**: None. The table is intentionally inert from the app's
perspective until issue #2 adds a write path — `listActiveSpeakers()`'s
only caller so far will be issue #4's audience viewing.

**Tests run**: `npm run lint`, `npx tsc --noEmit`, `npm run build`,
`npx vitest run` (3 tests: the existing update-depth regression test plus
two new `event_speakers` RLS tests, all against the real linked project) —
all clean.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing (3/3). Migration applied and verified live.

**Recommended next task**: Issue #2 (LiveKit SDK integration and token
endpoint) — the first consumer of `event_speakers`, and where its write
path (who's allowed to occupy a seat) actually gets designed.

---

## 2026-08-09 — Session 8: Issue #12 — Supabase CLI migration workflow

**Goal**: Replace the manual SQL-Editor-copy-paste workflow with a proper
Supabase CLI migration workflow, so the repository becomes the actual
source of truth for schema changes — without touching or risking the live
project's existing schema and data.

**Completed work**:

- Moved issue #12 to **In Progress**, branched
  `feature/supabase-cli-migration-workflow` from `main`.
- Installed the Supabase CLI as a project-local dev dependency
  (`npm install -D supabase` — global installs are blocked by the CLI
  itself) and ran `supabase init` (scaffolds `supabase/config.toml`;
  confirmed it didn't touch the existing `migrations/`/`seed.sql`).
- User ran `supabase login` and `supabase link --project-ref
  xuzlgcfuwlcpejhctofv` themselves, interactively, in their own terminal —
  deliberately not attempted through a non-interactive tool call, so the
  database password/CLI auth token never passed through anything that gets
  logged.
- **Verified before changing anything irreversible**: no Docker in this
  environment, so `supabase db diff`'s local-shadow-database comparison
  wasn't available, but `supabase db query --linked` (direct SQL via the
  Management API, no Docker needed) was enough to compare the live schema
  against the three existing migration files directly — table/column
  shapes, RLS-enabled flags, every policy, every meaningful grant, the
  profile-provisioning trigger, and Realtime publication membership. All
  matched exactly.
- Only after that verification: `supabase migration repair --status
  applied 00000000000001 00000000000002 00000000000003` — bookkeeping
  only (writes to `supabase_migrations.schema_migrations`), no SQL
  executed, confirmed via `supabase migration list` showing `local`/
  `remote` in sync, and confirmed no data moved (`events`/messages/
  `profiles` row counts unchanged before and after).
- **Proved the forward workflow end-to-end** with a real (low-risk)
  migration: `00000000000004_table_comments.sql` (adds `COMMENT ON TABLE`
  documentation to all four tables, mirroring ARCHITECTURE.md), applied
  via `supabase db push --linked`, confirmed live via `db query --linked`.
- **Switched `src/types/database.ts` from hand-written to generated**
  (`supabase gen types typescript --linked`) — removes the exact bug class
  hit earlier (missing `Relationships`/`Views`/`Functions` fields) instead
  of relying on remembering the shape by hand. Verified against real
  Postgres foreign keys, which are more accurate than the hand-written
  version's placeholder `Relationships: []` ever was.
- Documented the full workflow — one-time setup, creating/applying
  migrations, regenerating types, verifying status, seeding, and the
  local-vs-linked distinction for `db reset` (with an explicit warning
  never to run `--linked` against the shared project, which has no staging
  copy) — in ARCHITECTURE.md (new Migration workflow section), README.md
  (new Database migrations section + updated Getting Started), and
  AGENTS.md (standing rules). DECISIONS.md records the reconciliation
  strategy and why it was safe.

**Files changed**: `supabase/config.toml`, `supabase/.gitignore`,
`supabase/migrations/00000000000004_table_comments.sql`,
`src/types/database.ts` (generated, not hand-edited going forward),
`package.json`, `package-lock.json`, `ARCHITECTURE.md`, `README.md`,
`AGENTS.md`, `DECISIONS.md`, `ROADMAP.md`, `CHANGELOG.md`,
`SESSION_LOG.md` (this entry).

**Known issues**: Docker isn't installed in this environment, so local dev
(`supabase start`, `supabase db reset --local`, `supabase db diff`'s
shadow-database comparison) remains unavailable — all CLI operations
target the linked project directly. Not blocking normal migration work,
but means there's no local sandbox to rehearse a risky migration against
before it hits the real database. Flagged in ARCHITECTURE.md and
ROADMAP.md, not silently worked around.

**Tests run**: `npm run lint`, `npx tsc --noEmit`, `npm run build`,
`npx vitest run` — all clean after switching to generated types. Migration
workflow itself verified end-to-end against the live project (see above),
not just documented.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing. Live schema, migration tracking, and `database.ts` all
confirmed in sync.

**Recommended next task**: Pick up issue #1 (`event_speakers` table) —
it's the first migration to go through the newly-verified CLI workflow for
real feature work, not just a documentation-only proof.

---

## 2026-08-09 — Session 7: GitHub Projects + Issues workflow

**Goal**: Add GitHub Issues + a Project (Kanban) board as the visible
planning/task-management layer for the repo, before starting Phase 2.

**Completed work**:

- Installed and authenticated the GitHub CLI (`gh`), including the
  `project` scope (not part of `gh`'s default auth scopes — needed
  `--scopes "repo,project"`, done interactively by the user since it's a
  browser-based login).
- Created a private GitHub Project ("Virtual Stage",
  [github.com/users/Rapscallion12/projects/1](https://github.com/users/Rapscallion12/projects/1))
  and linked it to the repo.
- Replaced the board's default Status options (Todo/In Progress/Done —
  not deletable as a field, since it's a built-in one, but its options are
  editable via the GraphQL API) with the requested five: Backlog, Ready,
  In Progress, Testing / Review, Done.
- Created 12 issues and added all of them to the board:
  - **Phase 2 (the live room), broken into a dependency-ordered chain**:
    #1 `event_speakers` table, #2 LiveKit SDK + token endpoint, #3
    two-speaker live room UI, #4 audience viewing, #5 audience count, #6
    emergency leave. Each issue states its dependencies and links back to
    the relevant ARCHITECTURE.md/PRODUCT.md sections rather than
    restating them.
  - **Outstanding backlog items**: #7 moderator flag, #8 GIF support, #9
    image uploads, #10 un-reacting, #11 the `/events` list's 2-hour
    cutoff hiding still-open lobbies (bug), #12 Supabase CLI setup.
  - #1 and #12 set to **Ready** (unblocked, next up); the rest to
    **Backlog**.
- Documented the full workflow (issue → board → branch → commits →
  checks → review → merge → close) in AGENTS.md and README.md's new
  "Project management" section, plus a light cross-reference from
  ROADMAP.md tying its phase-level items to the corresponding issue
  numbers.
- **Adopted `feature/` as the branch-naming prefix going forward**
  (previously `feat/`), per the user's explicit new convention — existing
  `feat/*` branches aren't being renamed retroactively.

**Files changed**: `AGENTS.md`, `README.md`, `ROADMAP.md`,
`SESSION_LOG.md` (this entry). No application code changed this session.

**Known issues**: None. The board and issues are net-new and haven't yet
been exercised by a real feature branch under the new workflow — the
first real test of it is whichever issue gets picked up next (#1 or #12).

**Tests run**: `npm run lint` (docs-only session; no build/typecheck/test
changes expected or needed).

**Current build status**: Unchanged from Session 6 — lint clean, build
clean, test suite passing.

**Recommended next task**: Pick up issue #1 (`event_speakers` table) or
#12 (Supabase CLI setup) from the board — both are in **Ready**. Move the
chosen one to **In Progress**, branch as `feature/<description>`, and
follow the documented flow through to **Done**.

---

## 2026-08-09 — Session 6: Scheduled events + pre-show lobby, repository refactor, update-depth bug fix

**Goal**: Deliver the "Public Scheduled Events + Pre-Show Lobby Foundation"
milestone — the full guest-accessible entry path (landing → browse events
→ event detail → countdown/status → pre-show lobby with live chat) —
explicitly *not* the live conversation system (no LiveKit, no speakers, no
voting). Mid-session, apply a new standing vendor-portability principle to
the just-built data layer, then find and fix a real runtime bug surfaced
during verification.

### Part 1 — Events + pre-show lobby feature

**Data model** (`supabase/migrations/00000000000003_events_and_lobby.sql`):
`events` (no room/speaker columns — a single event may later host multiple
simultaneous rooms, kept as a schema *addition* not a redesign),
`event_chat_messages`, `event_chat_message_reactions`. Guest-eligible via
the `author_profile_id` XOR `author_guest_id` pattern already documented
in ARCHITECTURE.md, enforced by RLS at insert time (a relaxed `not both`
`CHECK` rather than a strict "exactly one," to survive a future account
deletion cascading `author_profile_id` to null without violating the
constraint). Reactions are insert-only for everyone — a guest-safe delete
policy would need to verify *which* guest is asking, which an anon-key
request can't prove, and opening delete to any anon request naming any
reactor id is a real griefing vector, not an accepted limitation. Every
table got an explicit `GRANT` and was added to the `supabase_realtime`
publication (both lessons from earlier migrations' bugs, applied
proactively this time instead of discovered the hard way again).

**Guest identity, implemented for real** (previously just designed in
ARCHITECTURE.md): `src/proxy.ts` mints a `vs_guest_id` cookie for
unauthenticated visitors; `resolveIdentity()` (`lib/identity.ts`) is the
one place "who is making this request" gets resolved, account or guest;
guests get a deterministic "Adjective Animal" display name, renameable via
a `vs_guest_name` cookie, without affecting already-sent messages
(display-name snapshots).

**Pre-show lobby**: live text chat (Server Action + Supabase Realtime
Postgres Changes), native emoji input + a quick-emoji row, insert-only
upvote reactions (deduplicated via a `COALESCE(profile_id, guest_id)`
unique index), live attendee count via Realtime Presence, a phase banner
("lobby hasn't started" / "starting now"), computed — not stored — event
phase (`upcoming` / `lobby_open` / `ready`) from two timestamps. Root
layout switched to `h-dvh` + `overflow-y-auto` on `body` so the lobby's
chat panel scrolls internally instead of growing the whole page.

**Deferred, at the user's explicit agreement**: GIF support and image
uploads (both phrased conditionally in the original request; neither
required by its Definition of Done; both would add meaningful scope —
a new external API key for GIFs, a Storage bucket + RLS + moderation
review for uploads). Documented as fast-follows in ROADMAP.md, not
abandoned. Also deferred: un-reacting (removing your own reaction) — same
guest-can't-prove-identity problem as reaction deletes generally.

**Landing page**: repointed the Hero's primary CTA from the `#how-it-works`
anchor placeholder to `/events`, closing a gap flagged in Session 2's
ROADMAP notes.

### Part 2 — Vendor portability refactor

The user introduced a new standing principle mid-session: Supabase is
today's backend, not a permanent commitment, and durable-data access
should be centralized behind repository/service abstractions rather than
scattered `createClient().from(...)` calls in pages/actions. Refactored
the just-built feature (before it was ever committed) into
`lib/repositories/{events,chat,profiles}.ts`, returning plain domain types
never aliased from the Supabase-generated schema type. Auth and Realtime
were deliberately left un-abstracted and documented as such — both have
provider-specific API shapes deep enough that a generic wrapper would just
rename Supabase's API, and building one now (before there's a second
provider to actually support) would be the same over-engineering mistake
the "don't prematurely introduce distributed infrastructure" half of the
same instruction warns against. Documented at length in ARCHITECTURE.md's
new "Vendor portability" section, including the realtime-vs-durable-writes
distinction (message reactions persist individually on purpose — dedup
needs identity; the *future* live-room reactions must not copy that
pattern, they're the actually high-frequency case).

**Found and fixed along the way**: `src/types/database.ts` was missing
`Relationships: []` per table and top-level `Views`/`Functions` keys —
`@supabase/postgrest-js` requires this exact shape and silently types
every query result as `never` without it, with no error pointing at the
cause. This was a latent bug since the very first migration; nothing had
ever exercised a typed `.from(...).select()` call until this session's
repositories did.

### Part 3 — "Maximum update depth exceeded" in the lobby

**Bug report**: entering an event lobby crashed with "Maximum update depth
exceeded," reported stack pointing at `page.tsx` → `<LobbyRoom />`, with
`initialMessages={messages.slice().reverse()}` flagged as a suspect
(a new array reference every render).

**Investigation**: read `use-lobby-realtime.ts`'s subscription effect
(deps `[eventId]` only), `LobbyRoom`, `ChatPanel`'s two effects (deps
`[pending, state]` and `[messages.length]`), and `MessageItem` — none of
them use `initialMessages`, `identity`, or `event` as an effect dependency,
and `useState(initialMessages)` only consumes its argument on mount, so a
new array reference per parent render doesn't retrigger anything. The
component-stack pointing at `page.tsx` turned out to just be where
`<LobbyRoom>` is instantiated in JSX, not where the loop originated —
`page.tsx` is an async Server Component and doesn't "re-render" in the
client sense at all.

**Root cause**: `grep`ping every `useEffect` in the codebase found only
three, none matching the hypothesis — but `use-now.ts`'s `useSyncExternalStore`
call was the real site: `getSnapshot()` returned `Date.now()` directly.
`useSyncExternalStore`'s contract requires `getSnapshot()` to return a
value stable between calls unless the external store actually changed —
React calls it both before and after every commit to check for "tearing,"
and a value that changes on nearly every call (time always advances) makes
React perceive a change on almost every check, forcing an immediate
re-render, which checks again, sees another new value, and so on. `useNow()`
is consumed by `LobbyRoom`, `EventCountdown`, and `EventEntryStatus` — the
lobby's larger render tree just reliably gives enough time between the two
snapshot checks for the millisecond to tick over, which is why it
reproduced there specifically rather than on the simpler event list/detail
pages (though the same latent bug existed there too, just less reliably
triggered).

**Confirmed, not assumed**: a first regression-test attempt (plain
`renderHook(() => useNow())`) passed even against the buggy code — a
synchronous test render is too fast for `Date.now()` to actually differ
between the two internal checks, so the race didn't reproduce reliably.
Rewrote the test to force `Date.now()` to increment on every single call
(`vi.spyOn(Date, "now")`), which reproduced the exact reported error
deterministically, with React's own diagnostic confirming the cause
verbatim: *"The result of getSnapshot should be cached to avoid an
infinite loop."*

**Fix**: `src/hooks/use-now.ts` now caches the clock value at module scope,
only updating it inside the `subscribe` interval's callback — `getSnapshot`
reads the cached value instead of calling `Date.now()` itself, so it's
stable between calls except when the interval actually fires. No
`eslint-disable`, no dependency removal, no added guards/timeouts — the
actual contract violation was fixed.

**Regression test infrastructure**: this was the first test in the
project, so it needed a runner. Added Vitest + React Testing Library +
jsdom (`vitest.config.mts`, `vitest.setup.ts`, `npm test`) — chosen over
Jest for lower App-Router/ESM friction. `src/hooks/use-now.test.tsx`
reproduces the bug against the old code and passes against the fix.

**Browser verification** (by the user, since no browser automation is
available in this environment): using the existing seeded "Strangers,
Unscripted" event (its lobby has no expiry — the lobby route only blocks
entry *before* `lobby_opens_at`, never after `scheduled_start` — so it
remained enterable directly by URL even after falling off the `/events`
list page's 2-hour display cutoff; no new test data was created). Guest
lobby entry, authenticated lobby entry, sending messages, reactions,
history persisting across refresh, and repeated navigation into/out of the
lobby — all confirmed working, no crash.

**Files changed**: migration `00000000000003`, `supabase/seed.sql`,
`src/types/database.ts`, `src/proxy.ts`, `src/lib/{config,events,guest,identity}.ts`,
`src/lib/repositories/{events,chat,profiles}.ts`, `src/app/events/**`,
`src/app/not-found.tsx`, `src/components/{events,lobby}/**`,
`src/components/site-header.tsx`, `src/components/landing/hero.tsx`,
`src/app/layout.tsx`, `src/hooks/{use-lobby-realtime,use-now}.ts`,
`src/hooks/use-now.test.tsx`, `vitest.config.mts`, `vitest.setup.ts`,
`package.json`, `ARCHITECTURE.md`, `AGENTS.md`, `DECISIONS.md`,
`ROADMAP.md`, `CHANGELOG.md`, `SESSION_LOG.md` (this entry).

**Known issues**: None open. The `/events` list page's 2-hour post-start
display cutoff is a minor rough edge (an event whose lobby is still
enterable can silently disappear from the browsable list) — not a bug in
this milestone's scope, flagged for whenever an "ended" event state is
designed.

**Tests run**: `npx vitest run` (1/1 passing, including the update-depth
regression test), `npm run lint`, `npx tsc --noEmit`, `npm run build` — all
clean. Guest-path RLS verified directly against the live Supabase project
(insert succeeds; impersonating an authenticated author is rejected;
duplicate reactions are rejected; reaction deletes are rejected — all via
raw PostgREST calls with the anon key). Realtime broadcast delivery
confirmed via a throwaway Node script using the real `@supabase/supabase-js`
client (deleted after use, never committed). Full guest + authenticated
browser verification completed by the user against the running dev server.

**Current build status**: Lint clean, typecheck clean, build clean, test
suite passing (1 test). Lobby confirmed stable in a real browser, guest
and authenticated.

**Recommended next task**: Phase 2 — LiveKit integration and the live
room. Apply the vendor-portability pattern from the start this time
(repository functions from the first commit, not refactored in after the
fact) and the mobile-orientation architecture decided in Session 5 (live
state owned above the orientation branch). Also worth: fixing the
`/events` list cutoff rough edge noted above, and setting up the Supabase
CLI before Phase 2 adds more migrations (friction noted in Session 3/4,
still unresolved).

---

## 2026-08-06 — Session 5: Mobile orientation behavior principle

**Goal**: Document a new permanent product/architecture principle from the
user, specific to the live room's smartphone experience: portrait and
landscape must be two intentional presentation modes of the same session,
not the same layout rotated — and rotating between them must never drop
the live video connection or reset chat/vote/timer state.

**Completed work**: Pure documentation — no application code exists yet for
this to apply to (the live room is Phase 2+, not yet built).

- **PRODUCT.md**: new Principle 13 and a new top-level "Mobile orientation
  behavior" section (portrait vs. landscape priorities, the no-reload/
  no-state-loss requirement), matching the weight given to the two prior
  standing principles (responsive design, progressive authentication).
- **ARCHITECTURE.md**: new "Mobile orientation implementation" section
  naming the specific failure mode to design against (a naive
  `isPortrait ? <A/> : <B/>` split that owns live state — LiveKit
  connection, chat subscription, vote/reaction state, timers — inside
  either branch, which React unmounts on rotation) and the rule that
  prevents it (that state must be owned by a hook/context in a component
  that renders unconditionally, above the orientation branch). Also added
  a dedicated Testing & Definition of Done checklist item requiring the
  live room be rotated mid-session in both directions, not just checked
  once per orientation in isolation.
- **AGENTS.md**: standing rule warning against the naive per-orientation
  component-tree approach, before whoever builds Phase 2 writes that code.
- **ROADMAP.md**: cross-referenced from the Phase 2 section, matching how
  the other two standing principles are already threaded through the
  roadmap.
- **DECISIONS.md**: full ADR — added for consistency with how the other
  two standing principles were recorded, though not explicitly requested
  this time.

Caught and fixed one mistake while editing: an early edit to
ARCHITECTURE.md accidentally deleted the "## Testing & Definition of Done"
heading text (old_string/new_string boundary error) — noticed immediately
via `grep -n "^## "` and restored before it could ship.

**Files changed**: `PRODUCT.md`, `ARCHITECTURE.md`, `AGENTS.md`,
`ROADMAP.md`, `DECISIONS.md`, `SESSION_LOG.md` (this entry).

**Known issues**: None — this is a design commitment for Phase 2, not
working code. There is nothing to test yet; the checklist item added to
ARCHITECTURE.md will apply once the live room exists.

**Tests run**: `npm run lint` and `npm run build` — both pass (docs-only
change; route table unchanged).

**Current build status**: Lint clean, build clean.

**Recommended next task**: Unchanged — Phase 1 (scheduled events) is next.
When Phase 2 (live room) eventually starts, the orientation architecture
decided here should shape the very first component structure, not be
retrofitted after a naive version ships.

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
