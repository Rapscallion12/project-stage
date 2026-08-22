<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Virtual Stage — project agent rules

Read [README.md](./README.md) first; it maps the rest of the docs
(PRODUCT.md, ARCHITECTURE.md, ROADMAP.md, DECISIONS.md, CHANGELOG.md,
SESSION_LOG.md). Everything you need to continue this project without prior
conversation context lives in those files — read `SESSION_LOG.md`
last-entry-first before starting work.

A few rules that are easy to violate by defaulting to generic habits:

- **Authentication is an upgrade, never an entry gate.** No route may
  redirect an unauthenticated visitor away — not the landing page, not an
  event, not the live room as audience. Guests can watch, react, vote
  (continue/replace), and view chat with zero session. Gate account-only
  actions (mic request, comments, reputation) *inside the server action*,
  and respond with a specific, benefit-framed prompt ("Create an account to
  request the mic") — never a generic wall, never a redirect to `/login`.
  See PRODUCT.md's progressive authentication model and ARCHITECTURE.md's
  Guest identity section before touching auth, routing, or any
  audience-facing feature. This was a correction the user had to make once
  already (see DECISIONS.md) — don't reintroduce a login wall by default
  when building Phase 1+ features.
- **Every screen is responsive by requirement, not by convenience.**
  Desktop and smartphone are both first-class targets, built with layouts
  intentionally designed per screen size sharing the same business logic —
  never one platform's layout stretched or squeezed for the other. See
  PRODUCT.md's responsive design principle and ARCHITECTURE.md's testing
  checklist before marking any UI work done.
- **On the live room (Phase 2+), portrait and landscape are two
  intentional modes, not one layout rotated 90°.** The obvious
  implementation — a component tree picked by `isPortrait ? <A/> : <B/>` —
  is wrong by default if the LiveKit connection, chat subscription, vote/
  reaction state, or timers live inside either branch: React unmounts that
  branch's hooks on rotation, dropping the call and resetting state, which
  is the reload-equivalent PRODUCT.md explicitly forbids. That live state
  must be owned by a hook/context in a component that renders
  unconditionally, above the orientation branch — the portrait/landscape
  components stay presentation-only. See PRODUCT.md's mobile orientation
  behavior and ARCHITECTURE.md's mobile orientation implementation section
  before writing the live room's layout code.
- **Never claim an interaction is verified using a weaker test than the
  interaction itself requires.** This project has repeatedly shipped
  changes that passed every automated check while still failing the
  actual user journey on a real phone (issue #20's first pass; the
  Browse Events dead end hit in Sessions 20 and 21) — automated checks
  and real UX are different questions, and reporting one as if it
  answered the other is the recurring root cause, not any single bug.
  Distinguish three tiers explicitly, every time, and never round one up
  to the next:
  1. **Automated** — `npm run lint`, `npx tsc --noEmit`, `npm test`,
     `npm run build`. Verifies implementation health (it compiles, types
     check, existing behavior isn't broken). Says nothing about whether
     the UX works.
  2. **Production interaction** — things you *actually exercised*
     against the real deployed app (fetching pages, following real
     redirects, confirming rendered output) — not local dev, not a
     database query, not a direct `/events/[id]` URL standing in for
     navigation, not "the element exists in the DOM." If a feature's
     point is discoverability or navigation (a new entry point, a new
     link, a redirect), the test must *start from the normal public
     entry point* (e.g. the landing page) — bypassing it with a direct
     internal URL doesn't test the thing the feature actually changed.
     Fetching rendered HTML can confirm a control is *present*; it
     cannot confirm tapping it *works* — don't conflate the two in how
     you report it.
  3. **Real-device** — anything requiring an actual touchscreen tap,
     camera/microphone permission and hardware, mobile Safari
     specifically, device rotation, or a subjective feel/UX judgment.
     Nothing in this environment can exercise these. Report them
     explicitly as **"UNVERIFIED — requires real-device testing,"** with
     a short concrete checklist of what to check — never as "verified,"
     "confirmed working," or similar, even when the code clearly should
     work. "Camera/mic work on mobile Safari" is only ever true once
     someone has actually exercised a real camera/mic on real mobile
     Safari, not because `getUserMedia` is called correctly.

  Structure every handoff after a UI/UX-affecting change around these
  three categories explicitly (label them), so the user can tell at a
  glance what's actually been established versus what still needs their
  own device. Keep an issue in **Testing / Review**, not **Done**, until
  they confirm tier 3 themselves — see DECISIONS.md's entries on issues
  #19–#20 for the corrections that established this.
- **Never build a feature that isn't in PRODUCT.md's MVP scope** (or a
  future session's explicit instruction) — check the out-of-scope list
  before adding anything that smells like a "nice to have."
- **Supabase is today's backend, not a permanent commitment — don't call
  it directly outside `lib/repositories/`.** Any new durable-data read or
  write (a new table, a new query) gets a function in
  `lib/repositories/`, returning a plain domain type, never a type aliased
  from `database.ts`. Pages/components/actions call that function, never
  `createClient().from(...)` themselves. Auth (`lib/identity.ts`,
  auth actions, `proxy.ts`), Realtime (`hooks/use-lobby-realtime.ts`), and
  LiveKit (`lib/livekit/token.ts`) are the only documented exceptions —
  see ARCHITECTURE.md's Vendor portability section before adding a
  fourth. Don't build a generic database-interface/DI abstraction on top
  of this either — that's over-engineering a prototype for hypothetical
  scale, which the same section explicitly warns against. The seam is a
  folder boundary, not a framework.
- **The client is never trusted to decide who may publish audio/video.**
  LiveKit tokens are minted server-side (`lib/livekit/token.ts`) from
  *current* `event_speakers` occupancy — never from anything the client
  sends. Token expiry is deliberately not the revocation mechanism (it's
  set generously); a speaker losing their seat needs their publish
  rights revoked *immediately*, which is a live
  `updateParticipantPermissions()` push to an already-connected
  participant (issue #13), not something to wait on. See
  ARCHITECTURE.md's LiveKit authorization model before touching token
  minting or seat assignment.
- **Before implementing an issue that touches data model, auth, or
  cross-system state, walk the design through out loud first** — what
  does this actually represent, how does it relate to existing entities,
  what happens under replacement/failure/concurrency — rather than
  jumping straight to schema or code. This caught real scope gaps twice
  already (issue #1's write-path deferral, issue #2's authorization
  model revealing a split into #2/#13) without expanding scope
  unilaterally in either case — both times, the fix was to name the gap
  clearly and either confirm it was already covered elsewhere or ask
  before creating new issues/touching code. Do this whether or not a
  session explicitly asks for it.
- **High-frequency, truly ephemeral events (live reactions during the
  future live room) must not get a database row per event** — broadcast
  via Realtime, persist an aggregate at most. This is different from the
  pre-show lobby's message reactions, which persist individually on
  purpose (they need per-person dedup and are volume-bounded) — see
  ARCHITECTURE.md's "Realtime traffic vs. durable writes" before deciding
  which pattern a new feature needs.
- **RLS is enabled on every table, from its first migration, with an
  explicit `GRANT`** — no exceptions, no "add it later," and don't assume
  the SQL Editor grants privileges the way the Table Editor UI does (it
  doesn't — see DECISIONS.md for the bug this caused once already).
- **Schema changes go through the Supabase CLI, never the dashboard SQL
  Editor.** `npx supabase migration new <name>` to create, `npx supabase
  db push --linked` to apply, `npx supabase gen types typescript --linked
  > src/types/database.ts` to regenerate types — same commit as the
  migration. `database.ts` is generated, not hand-edited. See
  ARCHITECTURE.md's Migration workflow section for the full sequence
  (including the one-time `login`/`link` setup, which must be run
  interactively by a human — never attempt it through a non-interactive
  tool call, and never ask for the database password to be pasted into
  chat).
- **Never run `supabase db reset --linked`.** It wipes the actual shared
  project — every table dropped, all data destroyed, no staging copy
  exists for this prototype. `--local` (against a Docker-based local
  Postgres) is the safe one, and isn't set up yet in this environment
  (no Docker) — see ARCHITECTURE.md.
- **Never work on `main` directly** — branch, commit, and keep
  ROADMAP.md/CHANGELOG.md/SESSION_LOG.md in sync with what actually shipped.
- **All work is tracked through GitHub Issues + the Project board, not
  just branches.** Board:
  [github.com/users/Rapscallion12/projects/1](https://github.com/users/Rapscallion12/projects/1)
  (private). Columns: **Backlog → Ready → In Progress → Testing / Review →
  Done**. For each meaningful feature, bug fix, or independently
  reviewable component:
  1. Find or create a GitHub Issue describing the work (`gh issue create`
     or `gh issue list --repo Rapscallion12/project-stage`).
  2. Confirm it's on the board (`gh project item-add 1 --owner
     Rapscallion12 --url <issue-url>` if it isn't yet).
  3. Move it to **In Progress** when you actually start implementing —
     not before, and not left there after you stop.
  4. Create a feature branch (see naming below) — never implement new
     feature work directly on `main`.
  5. Small, descriptive commits on that branch.
  6. Run the required checks before considering it done: `npm run lint`,
     `npx tsc --noEmit`, `npm run build`, `npm test`, plus
     ARCHITECTURE.md's Testing & Definition of Done checklist.
  7. Move the issue to **Testing / Review** once implementation is
     finished but before merging.
  8. Merge only after it passes the Definition of Done, then push the
     verified `main`.
  9. Close the issue and move its card to **Done** — a merged PR linked
     via "Closes #N" does this automatically; otherwise do it explicitly
     (`gh issue close`, `gh project item-edit`).
  - **Branch naming**: `feature/<short-description>` or
    `fix/<short-description>` (e.g. `feature/event-state-machine`,
    `fix/lobby-reconnect`) — matches this repo's existing `feat/`/`fix/`
    convention (see the git log). Don't create a branch for a trivial edit
    that's naturally part of an already-open feature branch.
  - **Before starting a large milestone**, break it into smaller issues
    where doing so improves clarity, testing, parallel work, or review —
    see the Phase 2 issues (#1, #2, #13, #3-#6 — #13 added mid-stream
    when implementing #2 revealed it needed splitting, see DECISIONS.md)
    for the granularity to aim for: each one is independently reviewable
    and has an explicit dependency chain noted in its body, rather than
    one giant "build the live room" issue. A new issue discovered mid-work
    gets positioned in the board's item order at its actual dependency
    point (`gh api graphql` with `updateProjectV2ItemPosition` — `gh
    project` has no CLI flag for this), not just appended to the end.
  - **Keep the board honest.** A stale board (cards left in the wrong
    column, issues closed without a card, work started without an issue)
    is worse than no board — update it as part of doing the work, not as
    an afterthought.
