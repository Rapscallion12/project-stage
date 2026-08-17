# Changelog

Format loosely follows [Keep a Changelog](https://keepachangelog.com/).
Dates are session dates, not deploy dates — every push to `main` deploys
automatically (see README.md's Deployment section), so there's no
separate release cadence to track here.

## [Unreleased]

### Added

- **One event URL** (issue #17) — `/events/[id]` is now the entire event
  experience: tapping an event from the list lands directly in it, no
  "Enter Lobby"/"Enter the room" clicks. The same mounted component
  (`EventRoom`, renamed from `LiveRoom`) shows a lightweight countdown
  before the lobby opens, then the full room layout (chat, seat
  placeholders, request-mic control, event status) from `lobby_open`
  onward — the same layout that already existed for the live room, just
  reachable earlier, not a new "waiting room" surface. LiveKit connects
  in place once the event goes live, using the token already fetched at
  page load — no remount, no redirect, no dropped Realtime subscription.
  `/events/[id]/lobby` and `/events/[id]/room` redirect to the unified
  URL for backward compatibility. Claiming a seat (not requesting)
  stays server-enforced to the event's actual start time, since the
  request/claim controls are now reachable before the show technically
  begins. See DECISIONS.md.
- **Guest speaker participation** (issue #16) — an explicit, reversible
  prototype-testing exception (`PROTOTYPE_CONFIG.guestParticipationEnabled`,
  `lib/config.ts`) letting guests request the mic, get promoted, and
  publish camera/mic through the same server-authoritative path an
  account holder already used — no client of any kind can grant itself a
  seat or publish rights. `event_speakers`/`speaker_requests` gained a
  nullable `guest_id` column each, XOR-constrained against `profile_id`
  (migration `00000000000012`). `claim_speaker_seat`/`end_speaker_seat`
  widened in place (still `service_role`-only); `request_to_speak`/
  `withdraw_speaker_request` kept their existing self-service path and
  gained separately-named guest siblings instead. Caught and fixed a
  real, live regression the same session: recreating
  `claim_speaker_seat`/`end_speaker_seat` (required, since their
  parameter list changed) silently reset them to PostgreSQL's
  PUBLIC-execute-by-default, the exact mistake issue #13 already hit
  once — fixed within minutes via a forward migration
  (`00000000000013`), caught by the existing integration test suite
  against the real linked database. See DECISIONS.md.
- **First deployment — Vercel Hobby, live at
  [project-stage-weld.vercel.app](https://project-stage-weld.vercel.app)**.
  GitHub-integrated (every push to `main` auto-deploys, confirmed with a
  real push). `NEXT_PUBLIC_SITE_URL` set explicitly to the stable domain
  rather than left to the code's `VERCEL_URL` fallback, which turned out
  to resolve to a per-deployment hash that changes on every build — would
  have silently shifted auth email links on every push. Supabase Auth's
  Redirect URLs allowlist updated additively (existing localhost entry
  untouched) to accept the new domain. LiveKit wired in for the first
  time against a real public HTTPS URL: credentials added as Vercel env
  vars, and — only possible now that a public URL exists —
  `/api/livekit/webhook` configured in the LiveKit Cloud dashboard, then
  confirmed live (a bogus signature and a missing one both correctly
  return 401 from the deployed URL). `/dev` confirmed 404ing in
  production both immediately after deploy and after a later
  auto-triggered rebuild. See DECISIONS.md for the full reasoning,
  including a real limit worth knowing: Vercel's "Sensitive" env var type
  can't be read back once set, by anyone, which changes how a credential
  like this can be verified (through the deployed app's behavior, never
  by fetching the value back out).
- **`/dev` browser-based usability-testing UI** — create a live demo
  event, open its room, and seat your logged-in account in seat 1 or 2
  without any CLI commands. Complements (doesn't replace) the CLI dev
  harness — the CLI is still how you create a synthetic second speaker's
  account. `notFound()`-gated on `NODE_ENV !== "production"` (reliable
  since Next.js force-sets that for every build/start), with every
  Server Action independently re-checking the same guard, since an
  action's endpoint is reachable regardless of whether its trigger page
  ever rendered. Verified both ways directly: a production
  build/start on a spare port confirms `/dev` 404s while real routes
  stay healthy, and a unit test confirms each action rejects under a
  stubbed `NODE_ENV=production`. No new schema/RLS/RPC/authorization
  path — reuses `claimSpeakerSeat` (issue #13) directly, bypassing issue
  #14's production request-queue gate on purpose, the same bypass the
  CLI harness's `seat` command already established as acceptable for
  testing. The CLI's tagging convention moved to a shared
  `lib/dev-demo.ts` module so the CLI and the UI clean up each other's
  data. Found and fixed a real (reproducible) test-infrastructure bug
  along the way: two independent integration test files sharing that
  tag both ran their own "delete everything tagged" reset, and Vitest's
  default parallel file execution let one delete the other's in-progress
  fixtures — fixed with `fileParallelism: false` in `vitest.config.mts`.
  See DECISIONS.md.
- **Speaker request queue** (issue #14) — the first issue to give
  `claim_speaker_seat` (issue #13) a real production caller, closing the
  loop from request to live seat. Deliberately not a generic waiting-list
  table: a mic request is a chat message
  (`event_chat_messages.is_speaker_request`, a permanent marker) with its
  lifecycle (`pending`/`granted`/`withdrawn`) tracked separately in a new
  `speaker_requests` table that never duplicates the message content —
  this is what lets a future pinned/featured comment surface render the
  same rows through `RoomChatPanel`'s existing `featuredSlot` (issue #3)
  without a schema change. Three new `security definer` functions
  (migration `00000000000011`): `request_to_speak` (self-service,
  **atomic** — the chat message and the request row are created in one
  function call, so a losing concurrent request can never leave an
  orphaned message or an orphaned request row, proven by a live race
  test), `withdraw_speaker_request` (self-service, same shape as issue
  #13's `leave_speaker_seat`), and `rank_pending_speaker_requests`
  (trusted-server-only, ranks by reaction count on the request's message,
  then `profiles.reputation_score` as a tiebreak — currently always `0`
  for everyone, harmless no-op, not a blocker — then recency). Every new
  function explicitly revokes `PUBLIC` execute in its own migration this
  time (the lesson from issue #13's bug), verified directly against
  `pg_proc.proacl`, not just asserted. `claimOpenSeat` (the room's Server
  Action) gates self-service seat-claiming on a pure, unit-tested
  decision (`lib/speaker-queue.ts`'s `decideClaimEligibility`): caller
  has a pending request, a seat is open, and the caller ranks within the
  top 3 eligible requests — an **explicit MVP selection policy, not a
  permanent product rule** (documented at length in `lib/speaker-queue.ts`
  and DECISIONS.md: it solves the "absent top requester blocks the seat
  forever" failure mode without new background-job infrastructure, using
  `claim_speaker_seat`'s existing race-safety as the tiebreak). A
  successful claim pushes `canPublish: true` live
  (`syncPublishPermission`), so publishing starts immediately with no
  reconnect — the first time issues #2, #13, #3, and #14 connect into one
  real end-to-end flow. `RoomControls` gained request/withdraw/claim
  states; guests see the same "Request the mic" button as everyone else,
  with PRODUCT.md's scripted account prompt appearing inline on click,
  never a proactive banner. No dedicated queue screen — a request is just
  a badged message in the existing chat feed.
- **Development test harness** (`scripts/dev-harness.mts`,
  `npm run dev:harness --`) — create/seat/list/reset live test events
  from the command line, without hand-writing SQL or waiting on a
  scheduled start time. Standalone: outside `src/`, never imported by
  application code, no new route/schema/RLS/grant, confirmed absent from
  `npm run build`'s route table. Authenticates with the existing
  `SUPABASE_SERVICE_ROLE_KEY` and drives the same trusted
  `claim_speaker_seat`/`leave_speaker_seat`/`end_speaker_seat`
  primitives issue #13 already built and authorized — not a new
  capability, one more legitimate caller of an existing one. Every
  resource it creates is tagged (`[dev-harness] ` title prefix for
  events, the reserved `@dev-harness.invalid` domain for auto-created
  throwaway accounts) so `reset` can only ever delete what the harness
  itself made; seating your own real account is safe by construction,
  since `seat` refuses to auto-create an account for any email that
  isn't already a real profile and isn't harness-tagged. Requires Node
  22.6+ (native `--env-file`/`--experimental-strip-types`, no new
  dependency) — documented in README.md along with full usage.
  `tsconfig.json` gained `allowImportingTsExtensions: true` (safe given
  `noEmit: true` was already set) so the harness's own test file can
  import it. See DECISIONS.md for the full design and the end-to-end
  safety-boundary test (`scripts/dev-harness.test.ts`) that proves
  `reset` leaves untagged events/accounts completely untouched.
- **Two-speaker live room UI** (issue #3) — `livekit-client` installed,
  `src/app/events/[id]/room/page.tsx` + `components/room/` (`live-room.tsx`,
  `portrait-room.tsx`/`landscape-room.tsx`, `speaker-stage.tsx`/
  `speaker-tile.tsx`, `room-header.tsx`, `room-controls.tsx`,
  `room-chat-panel.tsx`). Current speakers render entirely from
  `event_speakers` (via a new `hooks/use-active-speakers.ts`, Realtime-
  subscribed — migration `00000000000010` adds the table to the
  `supabase_realtime` publication), never from LiveKit's own
  participant/track state — an explicit correction made mid-design; see
  DECISIONS.md. `event_speakers` also gained a `display_name` column
  (same migration), a denormalized snapshot of `profiles.display_name`
  written by `claim_speaker_seat` itself, so guests (who can't read
  `profiles` under RLS) can still see who's speaking. An occupied seat
  with no available video renders a named "camera off" placeholder; an
  empty seat renders an intentional "Seat open" placeholder — never
  blank either way. Explicit room status ("Waiting for speakers" /
  "Selecting next speaker" / "Live", `lib/room-status.ts`) derived purely
  from active-speaker count. `hooks/use-live-room-connection.ts` owns the
  LiveKit `Room` connection and auto-publishes camera/mic whenever the
  server-issued token's `canPublish` is true — on connect, and again live
  on every permission change pushed by issue #13's `syncPublishPermission`
  — so a participant with `canPublish: false` never has a code path that
  attempts to publish, and a participant who loses `canPublish` while
  connected stops immediately. `hooks/use-orientation.ts` (portrait/
  landscape via `matchMedia`, `useSyncExternalStore`) selects between the
  two layouts in a component that renders unconditionally above them, so
  rotation never remounts the LiveKit connection, chat subscription, or
  speaker roster. The lobby's "ready" phase banner now links into the
  room instead of showing a "not open yet" placeholder. `RoomChatPanel`
  reserves a `featuredSlot` prop (always `undefined` today) so a future
  pinned/expandable Featured Comments section is an addition, not a
  layout restructure. `RoomControls` ships exactly one control — "Leave
  the stage," issue #13's `leaveSpeakerSeat` action getting its first
  caller; manual mic/camera mute toggles were deliberately left out of
  scope.
- Building this surfaced and fixed two shared test-infrastructure gaps,
  not product bugs: React Testing Library's DOM wasn't being cleaned up
  between tests (`vitest.setup.ts` now calls `cleanup()` in `afterEach`
  — this project's first component-rendering tests are what surfaced
  it), and a first draft of `useOrientation` set state synchronously
  inside `useEffect` (rewritten to `useSyncExternalStore`, the same
  pattern `useNow` already established). See DECISIONS.md.
- **GitHub Issues + a Project (Kanban) board** as the visible planning
  layer: Backlog → Ready → In Progress → Testing / Review → Done. 12
  initial issues covering Phase 2 (the live room, broken into a
  dependency-ordered chain) and outstanding backlog items. Documented in
  AGENTS.md and a new "Project management" section in README.md.
- **Supabase CLI migration workflow**, replacing hand-pasting SQL into the
  dashboard: installed as a project-local dev dependency, linked to the
  live project. `src/types/database.ts` is now generated
  (`supabase gen types typescript --linked`) instead of hand-maintained.
  New migration (`00000000000004_table_comments.sql`, schema-level
  documentation) applied end-to-end via `supabase db push --linked` as
  proof the forward workflow works. Full setup and day-to-day commands
  documented in README.md and ARCHITECTURE.md's new Migration workflow
  section.
- **`event_speakers` table** (issue #1, migration `00000000000005`) —
  append-only occupancy episodes (who occupied which seat, when, and why
  they left), not a scheduled-speaker table or a mutable "current
  speaker" pointer — see DECISIONS.md for why both alternatives were
  rejected. Account-only, room-agnostic (matching `events`' own
  precedent), publicly readable, no write grant yet (deferred to issue
  #13's write-path issue by design — see below). `left_reason` is a
  `CHECK`-constrained vocabulary, not free text. `lib/repositories/event-speakers.ts`
  ships the read path (`listActiveSpeakers`); a committed regression test
  verifies both that reads work and that writes are actually rejected by
  RLS (`42501`), against the real linked project.
- First integration-style tests against the live Supabase project
  (`event-speakers.test.ts`) — skip gracefully if `.env.local` isn't
  configured rather than hard-failing. Vitest now loads `.env.local` for
  tests that need real credentials.
- **LiveKit token minting** (issue #2, `lib/livekit/token.ts` +
  `getLiveKitToken` Server Action) — server-authoritative, read-only:
  mints a scoped JWT from *current* `event_speakers` occupancy, never
  from anything the client sends. Guests always come back
  `canPublish: false` (structurally — `event_speakers` is account-only).
  Namespaced participant identities (`guest:<id>` / `profile:<id>`),
  room naming (`event:<event_id>:main`, multi-room-ready), and a
  generous token TTL (expiry is deliberately not the revocation
  mechanism — see ARCHITECTURE.md's LiveKit authorization model for what
  is). The atomic seat-assignment write path, live permission sync, and
  disconnect cleanup are split into a new issue (#13) rather than bundled
  here — see DECISIONS.md for why.
- **Speaker seat state transitions** (issue #13, migration
  `00000000000006`) — the write path `event_speakers` didn't have until
  now, as three `security definer` Postgres functions with three
  different authorization models rather than one generic "update a seat":
  `leave_speaker_seat` (self-service voluntary leave, `auth.uid()`-gated,
  granted to `authenticated`), and `claim_speaker_seat`/`end_speaker_seat`
  (atomic assignment/replacement and reason-coded ending of someone else's
  occupancy — deliberately **not** granted to `anon`/`authenticated`,
  callable only via a new `service_role` client, `lib/supabase/service.ts`
  — the first use of `service_role` in this project; see DECISIONS.md for
  why granting these broadly would let any authenticated user seize the
  microphone at will, and why `service_role` was judged the right
  trusted-server mechanism over a hand-rolled alternative). A second
  partial unique index (`event_speakers_active_profile_uniq`) now stops
  one profile from holding two seats in the same event at once — a real
  gap issue #1's schema had. `lib/livekit/permissions.ts`'s
  `syncPublishPermission()` pushes `canPublish` changes live to an
  already-connected participant via `RoomServiceClient.updateParticipant()`
  (best-effort — `mintLiveKitToken` is the eventual-consistency fallback
  if it fails). A new LiveKit webhook route
  (`src/app/api/livekit/webhook/route.ts`) verifies LiveKit's webhook
  signature and ends a disconnected participant's occupancy
  (`left_reason: 'disconnected'`), fixing the "stuck seat" problem — no
  live permission push follows since there's no connected participant
  left to push to. `claim_speaker_seat` has no production caller yet by
  design (Phase 3's queue/voting is what will decide who's allowed to call
  it); integration tests exercise it directly, and skip gracefully
  (`describe.skipIf`) without `SUPABASE_SERVICE_ROLE_KEY` configured.
  Running those tests for real caught three genuine bugs, each fixed as
  its own forward migration rather than editing `00000000000006` in
  place: `service_role` had no table grants at all in this project
  (`00000000000007`); `claim_speaker_seat`/`end_speaker_seat` were
  actually callable by anyone, because PostgreSQL grants `EXECUTE` to
  `PUBLIC` by default and migration `00000000000006` never revoked it
  (`00000000000008` — the exact exposure the user's constraint on this
  issue set out to prevent, caught by the test written to prove that
  constraint held); and `end_speaker_seat`'s no-op case returned a
  garbage all-null object instead of `NULL` (`00000000000009`, plus a
  matching fix in `endSpeakerSeat()` for how PostgREST serializes a
  composite-returning function's `NULL`). See DECISIONS.md for the full
  writeup of all three.
- `livekit-server-sdk` installed (server-side only; `livekit-client`
  deferred to issue #3, the first thing that actually connects to a
  room). New Vitest environment-override pattern documented
  (`// @vitest-environment node`) for tests needing real Node WebCrypto,
  which jsdom's shimmed crypto breaks for JWT signing.

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
- **Scheduled events and the pre-show lobby** (Phase 1): `events`,
  `event_chat_messages`, `event_chat_message_reactions` tables (RLS +
  explicit grants + Realtime publication); event list and detail pages
  with a computed (not stored) countdown/phase; a pre-show lobby with live
  text chat, native emoji + quick-emoji buttons, insert-only upvote
  reactions, and live attendee count via Realtime Presence — all
  guest-accessible, no account required. Guest identity is now
  implemented for real (a `vs_guest_id` cookie minted in `src/proxy.ts`,
  `resolveIdentity()` in `lib/identity.ts`, a deterministic "Adjective
  Animal" guest name, renameable). GIF support and image uploads in chat
  are deliberately deferred as documented fast-follows (ROADMAP.md) — both
  were conditional in the original request and would have added meaningful
  new-dependency scope (an external GIF API, a Storage bucket + moderation
  review) beyond what that milestone's Definition of Done required.
- First test in the project: Vitest + React Testing Library + jsdom
  (`npm test`), added specifically to regression-test the update-depth
  bug described below.

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
- **Durable data access is now centralized behind `lib/repositories/`**,
  not scattered `createClient().from(...)` calls in pages/actions —
  Supabase is today's backend, not a permanent commitment (see
  ARCHITECTURE.md's new "Vendor portability" section). Auth and Realtime
  remain direct, documented exceptions. Refactored the events/lobby
  feature into this shape before it was ever committed.

### Fixed

- **Camera and microphone never activated for a seated speaker on real
  iPhone Safari** (issue #15) — found via hands-on testing of the deployed
  app. Root cause: `useLiveRoomConnection` called
  `setMicrophoneEnabled`/`setCameraEnabled` from LiveKit's async
  `RoomEvent.Connected`/`ParticipantPermissionsChanged` callbacks, never
  from a real user tap; Safari silently refuses to even show the
  permission prompt for a `getUserMedia` call outside a gesture's call
  stack. A second bug compounded it: the hook already computed a
  `mediaError` value that nothing in the UI ever read. Fixed by requiring
  an explicit "Enable camera & mic" tap (`RoomControls`, calling the
  hook's new `activateMedia()` directly from `onClick`) for the *first*
  activation only — subsequent server-driven `canPublish` changes still
  resync automatically, since browser media permission persists for the
  rest of the tab's session once granted — and by classifying/surfacing
  `getUserMedia` failures via their `DOMException.name` (permission
  denied / no device / device unavailable / init failed) instead of a
  generic silent placeholder. See DECISIONS.md.
- **Project board Status field left stale after closing an issue.**
  Closing a GitHub issue via `closes #N` in a commit message closes the
  *issue*; it never touched the Project board's custom Status
  single-select field, a separate piece of state. Issues #13 and #3 had
  both been merged and closed for a while but still showed
  `Status: Backlog` on the board. Found while reviewing the board before
  starting issue #14 (the user asked whether #4/#5 were already
  satisfied by #3 — checking that surfaced this too). Fixed retroactively
  for #13, #3, and the newly-closed #4/#5; treating the board Status
  update as its own explicit step going forward, not something
  `closes #N` handles. See DECISIONS.md.
- **"Maximum update depth exceeded" crash entering an event lobby.**
  `src/hooks/use-now.ts`'s `useSyncExternalStore` call returned
  `Date.now()` directly from `getSnapshot()`, which changes on nearly
  every call — violating the hook's contract that `getSnapshot()` must be
  stable between calls unless the store actually changed, which made React
  perceive a change on almost every internal consistency check and loop
  re-rendering. Fixed by caching the clock value and only updating it when
  the subscribed interval actually fires. Reproduced deterministically
  with a new regression test before fixing (`src/hooks/use-now.test.tsx`)
  — see DECISIONS.md and SESSION_LOG.md for the full investigation.
- `src/types/database.ts` was missing `Relationships: []` per table and
  top-level `Views`/`Functions` keys, silently typing every Supabase query
  result as `never` with no error explaining why — a latent bug since the
  first migration, only exercised once this session's repositories added
  the first real `.from(...).select()` calls.
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
- Guest-path RLS for the lobby verified directly against the live project:
  guest inserts succeed, impersonating an authenticated author is
  rejected, duplicate reactions are rejected, reaction deletes are
  rejected for everyone. Realtime broadcast delivery confirmed via a
  throwaway script against the real Supabase Realtime service. Full guest
  and authenticated browser verification of the lobby (entry, sending
  messages, reacting, history persisting across refresh, repeated
  navigation) completed after the update-depth fix, with no crash.

### Known limitations

- LiveKit is not yet integrated (deferred to Roadmap Phase 2 — see
  DECISIONS.md). Live speakers, the speaker queue, continue/replace
  voting, and reputation-affecting actions (Phases 2–4) remain unbuilt.
- GIF support and image uploads in the pre-show lobby are deliberately
  deferred fast-follows (see ROADMAP.md), as is un-reacting to a message.
- The `/events` list page hides events more than 2 hours past their
  `scheduled_start`, even though their lobby remains enterable directly by
  URL indefinitely (no "ended" state exists yet) — a minor UX rough edge,
  not a bug in the lobby itself.
- No Docker in this environment, so `supabase start` / local Postgres /
  `db reset --local` remain unavailable — all CLI operations go against
  the linked (live) project directly, which works for migrations/queries
  but means there's no local sandbox to test destructive changes against.
