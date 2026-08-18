# Decisions

Architecture Decision Record. Newest first. Format: Problem, Alternatives
considered, Decision, Reason, Tradeoffs.

## 2026-08-18 — First user-confirmed stable checkpoint tagged (`prototype-mobile-single-device-stable`)

**Problem**: After several rounds of real-device fixes (issues #15/#16/#17),
the user personally verified the deployed app end to end on their iPhone
for the first time and confirmed it as "the first state of the project
I consider a stable, usable mobile prototype." They asked for this exact
state to be preserved as a known-good recovery point, separate from and
prior to any further feature work, so a future regression has something
concrete to compare against or restore to.

**Decision**: An annotated Git tag, `prototype-mobile-single-device-stable`,
on commit `1e72311e20efb195e5d63d6e7e8f6b6d7ca06d65` — confirmed (not
assumed) to be exactly what's live in production via two independent
checks: `vercel inspect` on the current production deployment
(`dpl_3ncVAw1JEPQHRamaaxMXVNw1gdZA`) and GitHub's own deployments API
for that commit SHA, which recorded the identical Vercel deployment ID.
Pushed to `origin`, plus a GitHub Release created from the tag and
explicitly marked as a **prerelease** — deliberately not a normal
"Latest Release," since this is a prototype checkpoint, not a production
version number. No code changed to create this checkpoint; the working
tree and `main` were already clean and in sync with `origin/main` before
tagging.

**What was actually verified, exactly as the user reported it** (real
iPhone, against the live deployment): landing page, Browse Events,
discovering the test event through that page (not a direct link),
one-tap entry into the unified room with no lobby/room navigation step,
chat, reactions, the request-the-mic control, the full guest-speaker
request→claim flow, and camera/microphone both activating successfully.
The click count/navigation feel was explicitly confirmed acceptable.

**What remains explicitly unverified — recorded so it isn't quietly
assumed later**: a genuine two-device live-media test. Specifically:
a second device receiving the first speaker's video; a second device
receiving the first speaker's audio; the first speaker receiving a
second speaker's video/audio; a simultaneous two-speaker conversation;
and rotation/orientation surviving an active two-device call. Camera/mic
*activating* on one device was confirmed — tracks actually reaching
another participant was not, and is a materially different claim.

**Reason issues #15/#16/#17 stay open despite this checkpoint**: the
user was explicit that this milestone doesn't constitute their
acceptance criteria for those issues — it's a recovery point for what's
been built so far, not a closing confirmation. Each issue's actual
closing bar (stated in their own threads/DECISIONS.md entries above)
still requires the two-device verification listed above.

**Tradeoffs**: None — this is a pure bookkeeping/safety action, no
implementation changed.

---

## 2026-08-18 — Two more real-device #17 findings: stale test fixtures, and the request-mic control buried below the fold

**Problem**: The user's real-device retest of #17 found two blockers:
(1) the test event handed off couldn't be found through the actual
"Landing page → Browse events" journey at all, and (2) the direct room
link worked, but no "Request the mic" control was visibly reachable —
exactly the flow #16 exists to let a guest exercise.

**Finding 1 — not a code bug, a stale-fixture bug of my own making.**
Reproduced directly: `listUpcomingEvents` filters `scheduled_start >
(now - 2h)` (`getEventsListCutoffIso`, intentional — hides events that
"started" more than two hours ago, documented in its own comment). The
test events handed off earlier had been created under a stale
assumption about the current date — real wall-clock time had moved
forward roughly two days since — so their `scheduled_start` had aged
`~48h` past that cutoff and was correctly excluded from "Browse events."
`getEventById` (used by the direct room link) has no such time filter,
so the direct link kept working the whole time and masked the problem —
which is exactly why the user's instruction not to substitute a direct
link for the real journey mattered: the direct link's success was
hiding a real gap in how discoverable the test event actually was.
Confirmed by reproducing the exact query against the anon key locally
(returned zero rows for the stale event, non-zero for a freshly created
one) rather than assumed. **Fix**: none needed to the list/query logic
itself — it's working as designed. Created fresh test data and
reconfirmed it appears in the deployed "Browse events" page before
handing anything off again.

**Finding 2 — the request-mic control's logic was correct; its position
wasn't.** Traced the full render-condition chain the user asked for —
event phase (`ready`), `PROTOTYPE_CONFIG.guestParticipationEnabled`
(`true`, default), identity type (`guest`), pending-request state
(`false`, fresh guest), active-speaker state (`false`) — every condition
correctly resolves to `RoomControls` rendering its default "Request the
mic" branch, confirmed present in the actual deployed HTML. The gap
wasn't the logic, it was position: `RoomControls` sat *after*
`RoomChatPanel` (a variable-, potentially-tall-height flex-1 element) in
`PortraitRoom`, with the temporary `RoomDiagnostics` panel stacked below
*that* — meaning on a real phone, reaching the request-mic control
depended on scrolling past however much chat content and diagnostic
text came before it. This is the same shape of bug the tile-placement
fix already found once for camera/mic activation: a control that's
logically present and even present in the server-rendered HTML, but not
reliably discoverable to a real user under real viewport constraints.

**Decision**: Two changes, without trying to fully prove the exact
viewport-unit mechanics on a device I can't access directly:
1. Reordered `PortraitRoom` so `RoomControls` sits directly below the
   speaker stage, *before* `RoomChatPanel` — its reachability no longer
   depends on chat content height at all; only the chat feed itself
   (already internally scrollable via its own `overflow-y-auto`)
   absorbs remaining space. Landscape wasn't changed — its chat is a
   fixed-width side panel, not vertically stacked, so this specific
   failure mode doesn't apply there.
2. `RoomDiagnostics` collapsed to a single-line toggle by default,
   expandable on demand — it was itself a real, measurable contributor
   to pushing real controls further down the page, on top of being
   something the user had already flagged as "not a product feature."
   Still fully available for the next round of debugging, just not
   permanently consuming vertical space it doesn't need most of the
   time.

**Reason recorded together with finding 1**: both are the same root
lesson in different clothes — verifying "the code is correct" (a passing
query, a rendered button) is not the same claim as "a real user can
actually reach this," and this project's own standing discipline (real
devices, real linked databases, not mocks or assumptions) is what caught
both. Worth a checklist reflex for future sessions: when handing off a
test link, reproduce that it's reachable through the *actual* discovery
path, not just that the direct link responds.

**Tradeoffs**: None of consequence for either fix — the reorder is
presentation-only (no state/logic moved), and the diagnostics collapse
is reversible/still fully available on tap.

---

## 2026-08-16 — One event URL: collapsing event/lobby/room into a single persistent experience (issue #17)

**Problem**: Real-device testing repeatedly confirmed the three-route
event→lobby→room split (each a full navigation, each mounting its own
top-level state-owning component) as an active usability failure, not
polish — roughly three taps before reaching anything interactive, and a
screenshot showing the room's empty-seat/"Waiting for speakers" state
with the chat/request-mic flow the user expected not actually present
(because they'd reached it via the narrower, chat-only `LobbyRoom`
before "Enter the room," not the full room layout). The user's own
framing: tapping an event should mean immediately being in the room,
whatever state it's currently in.

**Alternatives considered**:
1. Keep three routes; make the "Enter Lobby"/"Enter the room" transition
   automatic (a client-side redirect once the phase flips) instead of a
   manual click. Rejected explicitly by the user up front — an automatic
   redirect between routes still unmounts and remounts every
   top-level component, tearing down and rebuilding the chat/presence
   Realtime subscription and (once live) the LiveKit connection. That's
   the reload-equivalent PRODUCT.md's mobile-orientation principle
   already forbids for rotation; the same reasoning applies to a phase
   transition.
2. One URL (`/events/[id]`), one persistent client component owning
   every live hook unconditionally, with phase becoming a render branch
   *above* the existing orientation branch — the exact same shape
   already proven for orientation (see the mobile-orientation entries
   below): hooks that never unmount, only the presentation chosen
   underneath them changes.

**Decision**: Option 2. `LiveRoom` was renamed `EventRoom` (it now owns
the whole lifecycle, not just the "live" part) and gained a fourth
unconditional piece of state — `phase`, computed the same
`useNow()`-driven way `EventCountdown`/the old `LobbyRoom` already did —
sitting above `useLobbyRealtime`/`useActiveSpeakers`/`useOrientation`.
`useLiveRoomConnection` already handled a `null → real params`
transition by design (its own doc comment states this explicitly); the
LiveKit connection simply starts using the token already fetched at
initial page load the moment `phase` becomes `"ready"`, without any
remount or new fetch. The room's *existing* layout
(`RoomHeader`/`SpeakerStage`/`RoomChatPanel`/`RoomControls`) needed no
restructuring — it already showed seat placeholders, chat, and (as of
issue #16) the request-mic control together; the actual bug was that
this layout was gated behind an extra click and only reachable once
`phase === "ready"`, not that the layout itself was missing anything.
It's now reachable from `lobby_open` onward, with only a lightweight
countdown-only view before that (matching what the old event-detail page
showed pre-lobby).

**Server-side data fetching also unified**: `/events/[id]`'s page now
fetches speakers, messages/reactions, a LiveKit token, and pending-request
status unconditionally, regardless of phase, replacing the old
per-route, phase-gated fetches. Minting a token before "ready" is
harmless — signing a JWT never contacts LiveKit's servers, and
`canPublish` is still derived purely from real `event_speakers`
occupancy either way (see the LiveKit authorization model section).
`initialPhase` is computed server-side (no `now` parameter, so it
reflects the actual request-time truth) and used until the client's
`useNow()` clock ticks past hydration — this is what makes opening an
already-live shared link land directly in the live state on first
paint, not a placeholder that flips a moment later.

**A real, deliberate gap this surfaced, not silently absorbed**: making
`RoomControls` reachable before `phase === "ready"` means requesting the
mic (a real product requirement — "waiting together is part of the
experience") also makes *claiming* a seat reachable from the same
screen, before the scheduled start. Left unguarded, that would let the
live conversation start early, defeating the purpose of a scheduled
start time. Fixed by adding a server-enforced check to `claimOpenSeat`
itself — fetches the event, rejects with a clear message unless
`getEventPhase(event) === "ready"` — not just a hidden button, consistent
with this project's "the server decides, the client never does" rule.
Requesting the mic and withdrawing a request remain available from
`lobby_open` onward, unchanged.

**Route fate**: `/events/[id]/lobby` and `/events/[id]/room` become
plain `redirect()` stubs — kept, not deleted, for any link already
shared before this change, per the user's explicit allowance. The old
`LobbyRoom` and `EventEntryStatus` components became genuinely dead code
once nothing rendered them and were deleted rather than left unused;
`GuestNameEditor` (previously only in `LobbyRoom`'s sidebar) moved into
the unified room's layout, shown for guests in both the pre-lobby
countdown view and the main room view.

**Reason this is recorded as a first-class architectural decision, not
just a routing tweak**: it's the second time in this project a
navigation/redirect pattern was rejected specifically because it would
tear down live state (the first being the mobile-orientation principle
itself) — worth naming explicitly so a future session recognizes the
pattern (hooks-above-the-branch) as the general answer to "how do I add
a new mode to a live experience," not something to rediscover per
feature.

**Tradeoffs**: `EventRoom` is now a larger component, owning one more
piece of branching logic (phase) on top of orientation and role — still
manageable, but issue #18's role-based UI split will add a third
dimension on top of this same base, worth watching for complexity as
that lands. The pre-lobby countdown view duplicates a small amount of
"upcoming" rendering logic that used to live in the now-deleted
`EventEntryStatus` — judged acceptable since it's a handful of lines,
not worth extracting into a shared component for one caller.

---

## 2026-08-16 — Guest speaker participation (issue #16): design, and a real grant-revocation regression caught by the existing test suite

**Problem**: A third real-device test of issue #15 (after the LiveKit
credential fix and the tile-visibility fix) showed every layer working —
connection, token, browser permission — except `canPublish`, because the
user's own session correctly resolved as a guest, and guests couldn't
become speakers at all. The user reframed the priority: validating "the
live room works" the way they actually intend to test it (no login
required during this prototype phase) requires guest speaking first.
#16 was promoted from "next in sequence" to "prerequisite for #15's own
final validation." See SESSION_LOG.md for the full re-evaluation this
session did (which issue owns which piece of the journey, the exact
end-to-end acceptance test, why #17/#18's order didn't need to change).

**Design — preserving the security boundary while widening who can
reach it**: the question wasn't "should guests speak" (the user decided
that, as an explicit, reversible testing-phase exception — see
PRODUCT.md) but "how, without letting an anonymous client tell Postgres
*which* guest it is." Guest identity is a server-resolved, httpOnly-
cookie-derived id — trustworthy as *the caller in a Server Action*
(already true for guest chat authorship), but with no `auth.uid()`
equivalent Postgres/RLS can check the way it can for accounts. So:

- `claim_speaker_seat`/`end_speaker_seat` (already `service_role`-only,
  already took an explicit target identity rather than `auth.uid()`) —
  smallest possible change: widen the identity to optionally be a guest,
  in the *same* function, XOR-validated exactly like the table's own new
  constraint. Not a second overload — Postgres resolves overloads by
  parameter type, and a guest-only version would have the identical
  `(uuid, uuid, smallint)` signature, which isn't a valid overload at
  all. `p_profile_id`/`p_guest_id`/`p_guest_display_name` all default to
  null so an existing partial-parameter caller (including the "not
  callable by an ordinary user" grant tests) still resolves to this one
  function.
- `request_to_speak`/`withdraw_speaker_request` (self-service,
  `auth.uid()`-gated, granted to `authenticated`) — left **completely
  unchanged**. A guest gets a separately-named, `service_role`-only
  sibling (`request_to_speak_as_guest`/`withdraw_speaker_request_as_guest`)
  instead of a widened single function, because the authorization
  *mechanism* genuinely differs (a caller can't spoof `auth.uid()`; there
  is no equivalent trust anchor for a guest) — unifying them would mean
  one function serving two different trust models awkwardly, which is
  the opposite of "clearest API," the standard the user asked this
  decision be judged against. The atomic message+request insert logic is
  shared via an internal `request_to_speak_internal` function that's
  never granted to anyone — only reachable from the two public wrappers.
- `event_speakers`/`speaker_requests`: `profile_id` becomes nullable,
  `guest_id` added, `check ((profile_id is not null) <> (guest_id is not
  null))` — the exact XOR pattern `event_chat_messages`/
  `event_chat_message_reactions` already established for guest-vs-account
  authorship (migration `00000000000003`), applied here for the first
  time to the *speaking* tables. The active-occupancy/active-request
  partial unique indexes became `coalesce(profile_id, guest_id)`-keyed,
  same shape as the existing reaction-dedup index.
- Everywhere else (LiveKit token minting, `syncPublishPermission`, the
  disconnect webhook, `SpeakerStage`'s participant-identity lookup,
  `decideClaimEligibility`) was already either identity-generic
  (`mintLiveKitToken`/`determineCanPublish` needed zero changes) or had a
  single hardcoded `{type: "profile", ...}` assumption to generalize —
  no new authorization logic, just correctly propagating whichever
  identity a seat/request actually belongs to.
- `PROTOTYPE_CONFIG.guestParticipationEnabled` (`lib/config.ts`) — already
  existed, unused, from a much earlier session, apparently set up in
  advance for exactly this decision — is now the single gate every new
  guest-facing branch in `room/actions.ts`/`RoomControls` checks, so this
  can be tightened back to account-only later without touching the
  authorization system.

**A real, live security regression this caught, not just risked**:
after applying the migration, the *existing* "claim_speaker_seat/
end_speaker_seat are not callable by an ordinary authenticated user"
integration tests failed — for real, against the live linked project,
not a mock. Cause: both functions had to be recreated via `drop
function` + `create function` (Postgres doesn't allow `create or
replace` to change a parameter list), and a fresh `create function`
resets to PostgreSQL's PUBLIC-execute-by-default — **the exact same
mistake this project's own issue #13 entry below already documents
happening once before** (migration `00000000000006` → fixed by
`00000000000008`). Every other new function in this migration correctly
included its own `revoke ... from public`; only these two, extended in
place rather than authored from scratch, were missed. Fixed immediately
with a forward migration (`00000000000013`, applied within minutes of
the failing test run, before any other work continued) rather than
editing the applied migration, per this project's standing rule.
Verified directly against `pg_proc.proacl` afterward, not just by the
test passing, the same way the original issue #13 finding was verified.

**Reason this is worth a second, explicit callout despite already being
a documented pattern**: it demonstrates exactly why this project's
integration tests hit the real linked database instead of mocking it —
this class of bug is invisible to `tsc`, to `eslint`, and to a test
suite that mocks Postgres's grant system, and was only caught because
the existing tests already asserted the security boundary directly
against a real database and were run before considering the migration
done. Worth encoding as a checklist reflex for the next session that
touches a `security definer` function's signature: **recreating a
function via drop+create is not the same as altering it in place —
always re-verify its grants afterward, never assume they survived.**

**Tradeoffs**: Two forward migrations (`00000000000012`/`00000000000013`)
instead of one, for the same reason every prior grant-fix in this project
has been a forward migration, not an edit. A guest's seat/request rows
carry no FK to any table (unlike a profile, which FKs through
`auth.users`) — nothing to clean up if a guest's cookie is later cleared;
this is an accepted consequence of guest identity being a bare id, not a
new gap introduced here.

---

## 2026-08-16 — The activation control existed and worked; the user couldn't find it (issue #15, second real-device retest)

**Problem**: After the user fixed the actual LiveKit credentials on
Vercel (see the entry below), a second real iPhone test confirmed every
layer up through browser permission was genuinely working — production
diagnostics read `LiveKit connection status: connected`, `Server grants
canPublish: true`, `Needs media-activation tap: true`, `Media error:
none`, and the tile's own direct `getUserMedia` test reported `SUCCESS`.
Despite all of that, the user still reported "I still only see my
initials / camera off" and couldn't find a working activation control.

**Diagnosis**: Confirmed by re-reading the render tree, not guessed —
`RoomDiagnostics` and `RoomControls` both read the exact same
`needsMediaActivation`/`isSpeaker` values from one shared source
(`LiveRoom`'s `layoutProps`), so there was no possible state mismatch
between what the diagnostics panel reported and what `RoomControls`
received. The actual "Enable camera & mic" button (added by the first
#15 fix) rendered correctly — but only inside `RoomControls`, a small
control strip at the very bottom of the room, competing for space with
"Leave the stage," chat, and (this session) the diagnostics panel itself.
`SpeakerTile` — the thing actually showing "camera off," which is what
the user is looking at — had no awareness of `needsMediaActivation` at
all and offered no interactive element whatsoever. This was a
discoverability/placement bug, not a logic bug: the fix from the first
#15 entry was real and worked, it just lived somewhere the user's
attention never went.

**Alternatives considered**:
1. Make the existing `RoomControls` button more visually prominent
   (larger, different color, moved higher in the strip) — doesn't
   address the root issue, which is that the control lives in the wrong
   *place* on the page, not that it's insufficiently styled.
2. Put the primary activation control directly on the local
   participant's own `SpeakerTile` — exactly where the "camera off"
   placeholder the user is looking at already is.

**Decision**: Option 2, keeping `RoomControls`' button too (redundant,
still useful, doesn't hurt). `SpeakerTile` now takes optional
`needsMediaActivation`/`activateMedia`/`mediaError` props; when
`isLocal && needsMediaActivation`, the tile's placeholder becomes a real
`<button>` ("Tap to enable camera & mic") instead of static text, calling
`activateMedia()` directly from its own `onClick` — still a genuine user
gesture, satisfying Safari's requirement the same way `RoomControls`'
button already did. `SpeakerStage` threads these three props to every
tile (they only ever act on the tile matching `myIdentity`), and
`PortraitRoom`/`LandscapeRoom` pass them through unchanged from
`layoutProps`, same wiring pattern as everything else in the room.
`mediaError`, when present on the local tile with no activation pending,
now shows a compact reason ("Permission denied", "No camera found") in
place of the generic "Camera off" too — the tile itself, not just
`RoomControls`, now explains what's happening.

**Reason this matters beyond just "add a button"**: this is the second
distinct #15 finding where a value was computed correctly and even
verified correct by a diagnostics panel, yet the actual product surface
failed to make it actionable for a real user under real conditions — the
first was a silently-discarded `mediaError` (never rendered anywhere),
this is a correctly-rendered control the user's attention never reached.
Both are the same underlying lesson: computing the right state isn't the
same as a real person being able to act on it, and only real-device
testing — not unit tests, not code review, not even a passing diagnostics
readout — caught either one.

**Tradeoffs**: None of consequence — purely additive props with safe
defaults, existing `SpeakerTile`/`SpeakerStage` callers/tests needed no
changes beyond the two room-layout call sites that now pass the three new
props through.

---

## 2026-08-16 — Issue #15's gesture fix never got exercised in production: LiveKit itself isn't reachable there (issue #15, real-device retest)

**Problem**: The gesture-gating fix (below) shipped, passed full automated
verification, and deployed — but a second real iPhone test against the
same deployed build still showed no camera/mic activation at all.
Re-closing the issue on the first fix's merge, before this retest, was
premature; reopened per the user's explicit correction. Rather than
assume the original gesture diagnosis was incomplete and layer on another
speculative fix, this session traced the actual deployed path end to end.

**Investigation, in order**:
1. Downloaded every JS chunk the deployed room page's HTML actually
   references and grepped all of them for a literal LiveKit `wss://`
   hostname — `NEXT_PUBLIC_LIVEKIT_URL` is a build-time-inlined
   `NEXT_PUBLIC_` var, so a genuinely-configured value must appear as a
   literal string somewhere in the client bundle. Found none, anywhere.
2. Added a temporary, safe diagnostics panel to the room UI
   (`components/room/room-diagnostics.tsx` — booleans/enums only, never
   token contents) surfacing identity type, seated-speaker recognition,
   whether the server issued a token, whether the client LiveKit URL is
   configured, live connection status, `canPublish`,
   `needsMediaActivation`, and `mediaError`, plus a button that calls
   `getUserMedia` directly, bypassing LiveKit entirely, to isolate raw
   browser/OS permission failures from every other layer.
3. Deployed the diagnostics-only change and read the *server-rendered*
   values directly off the live production page (no phone needed for
   this part) — confirmed, not inferred:
   - `LiveKit client URL configured: false`
   - `Server issued a token: false` (`mintLiveKitToken` is throwing —
     `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` aren't usable at runtime
     either, not just the client URL)
   - `LiveKit connection status: unavailable` (the room never even
     attempts to connect — `useLiveRoomConnection` is called with `null`
     params from the very first render)
4. Cross-checked against `vercel env ls`: all three vars
   (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `NEXT_PUBLIC_LIVEKIT_URL`)
   are listed as configured for Production — but, per the Session 16
   finding, Vercel's "Sensitive" var type can't be read back by CLI, so
   "the key exists" and "the value is correct and non-empty" are
   different claims, and step 3's runtime evidence says the second one
   is false for at least these three. My own local `.env.local` has the
   same var present as a key with a confirmed 0-length value — the same
   class of gap, not a coincidence.

**Root cause**: LiveKit is not actually reachable from the deployed app
at all — client URL and server API key/secret alike — which is why the
room never gets far enough to even show issue #15's "Enable camera &
mic" button. The gesture-gating fix is real, correct, and still needed
once this is resolved; it simply was never exercised, because everything
upstream of it was already broken. This is a deployment *configuration*
gap (empty or invalid env var values on Vercel), not a defect in #15's
code.

**Decision**: Not a code fix. `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
and `NEXT_PUBLIC_LIVEKIT_URL` need their actual values re-verified/
re-entered on Vercel (Production environment) — something only the
project owner can do, consistent with this project's standing rule
against ever having a secret value pasted into an agent session (see
Session 16's Migration workflow note on the database password, same
principle). The temporary diagnostics panel stays deployed specifically
so this can be re-confirmed the moment the values are fixed, without
needing another full phone round trip for the parts that don't actually
require a phone.

**Reason this is recorded as its own entry, not folded into the fix
below**: this is a second, independent example of the exact risk
Session 16's "Sensitive env var" finding already named — a credential
that *looks* configured (present as a key, scoped correctly) but cannot
actually be verified as *correct* without exercising the deployed app's
real behavior. Worth a second entry because it's now happened twice, to
two different LiveKit-related variable sets, which makes it a pattern
this project's deployment checklist should watch for by default, not
just a one-off.

**Tradeoffs**: None of consequence — the diagnostics panel is
temporary and explicitly marked for removal once the real root cause is
confirmed fixed by a real-device test, not left as permanent surface
area.

---

## 2026-08-13 — Camera/mic never activated on real iPhone Safari: gesture-gated activation, not automatic (issue #15)

**Problem**: Hands-on testing of the deployed app on a real iPhone
(Session 17) found that a seated speaker's camera and microphone never
activated — Safari never even showed the permission prompt, and
`SpeakerTile` silently rendered the generic "camera off" placeholder with
no indication anything had failed.

**Root cause, traced through the actual connection code, not guessed**:
`useLiveRoomConnection` called `setMicrophoneEnabled`/`setCameraEnabled`
(the calls that trigger `getUserMedia`) from `syncPublishing()`, itself
invoked from the async `RoomEvent.Connected` and
`RoomEvent.ParticipantPermissionsChanged` callbacks — LiveKit's own
WebSocket event emitter, never a user tap. iOS/macOS Safari requires
`getUserMedia` to execute synchronously within the call stack of a real
user-gesture event handler; called from an async event callback, it
silently declines to even show the prompt. A second, independent bug
compounded this: the hook already computed a `mediaError` value in its
catch blocks, but nothing in the component tree ever read it —
`RoomLayoutProps` had no field for it — so even a *legitimate* failure
(permission actually denied, no camera present) produced no visible
error either.

**Alternatives considered**:
1. Try to keep auto-publishing on connect, and look for a workaround that
   preserves "user activation" across the async gap to `RoomEvent.Connected`
   (e.g. pre-warming a `getUserMedia` call speculatively earlier in a click
   handler that led to this page). Rejected — fragile, browser-version
   dependent, and exactly the "fighting the browser" approach ruled out
   up front; Safari's user-activation window doesn't reliably survive a
   WebSocket round trip no matter how it's massaged.
2. Require an explicit, separate tap to first-activate camera/mic, and
   treat every *subsequent* `canPublish` change (server promotion,
   live revocation, re-promotion) as automatic, since browser-granted
   media permission persists for the rest of the tab's session once
   the first prompt is resolved.

**Decision**: Option 2. `useLiveRoomConnection` now exposes
`canPublish` (the server's grant, tracked live as before),
`needsMediaActivation` (true once `canPublish` but before this tab has
activated media), and `activateMedia()` — a function that must be called
directly from a real click handler. `RoomControls` renders an explicit
"Enable camera & mic" button for a seated speaker whenever
`needsMediaActivation` is true, and calls `activateMedia()` synchronously
from its `onClick`. Disabling (`canPublish` becoming `false`) never needed
a gesture and still happens automatically in every case, same as before.

**Media errors are now classified and surfaced, not swallowed**:
`classifyMediaError` maps `getUserMedia`'s own `DOMException.name`
(`NotAllowedError`/`SecurityError` → permission denied,
`NotFoundError`/`OverconstrainedError` → no device,
`NotReadableError`/`AbortError` → device unavailable, anything else →
init failed) into a `MediaError` value threaded through
`RoomLayoutProps` down to `RoomControls`, which shows source-specific
copy ("Camera permission was denied…", "No microphone found on this
device.") instead of a generic failure. A "Setting up your mic access…"
message covers the brief connected-but-not-yet-granted window
specifically (distinguished from still-connecting/reconnecting, which
`RoomHeader` already covers, to avoid showing both at once).

**Reason this is scoped as its own issue, not folded into the later
role-based UI work**: this is a correctness bug affecting today's
account-only speakers already, independent of guest participation or the
lifecycle/UI redesign work queued behind it — fixing it first means every
later issue in the sequence (guest speaking, the unified lifecycle,
role-based views) gets tested against a room where media actually works,
rather than compounding on top of a known-broken foundation.

**Tradeoffs**: A seated speaker now sees an explicit button rather than
media silently starting on its own — a small extra step, but the
alternative (silent, and on Safari, *non-functional* auto-publish) isn't
actually simpler, it's just broken. The activation button and error copy
live in the existing `RoomControls` strip for now, not a
speaker-specific layout — issue #18 (role-based Audience/Candidate/Speaker
views) is where this gets a more prominent, purpose-built treatment; this
issue deliberately doesn't redesign the room's layout to stay narrowly
scoped to the activation bug itself.

---

## 2026-08-13 — First deployment (Vercel Hobby), and two real findings from wiring LiveKit into it

**Problem**: usability testing needed a public HTTPS URL — nothing to
decide here (the user asked for exactly this), but several details of
*how* to configure it correctly weren't obvious from the code alone and
only surfaced by actually doing it.

**Decision**: Vercel Hobby tier, project imported from GitHub
(`Rapscallion12/project-stage`, private — Vercel's GitHub App was granted
access during import), no custom domain. Production URL:
`https://project-stage-weld.vercel.app` (Vercel appended `-weld` since
the bare `project-stage` subdomain was already taken globally). Deployed
via the dashboard's "Import Git Repository" flow rather than a bare
`vercel deploy` from local source specifically because the user wanted
future pushes to `main` to auto-deploy — that requires the Git
integration, which the dashboard import sets up as a side effect and a
CLI-only deploy would not.

**Finding 1 — `NEXT_PUBLIC_SITE_URL` must be set explicitly, not left to
the existing `VERCEL_URL` fallback in `getSiteURL()`**: `VERCEL_URL` is
Vercel's *per-deployment* URL — a hash that changes on every single
build, not the stable production domain. `getSiteURL()`'s fallback
predates any real deployment (written speculatively early in the
project) and was never exercised against Vercel's actual runtime
behavior until now. Left as-is, every push to `main` would have silently
changed where auth confirmation emails point. Fixed by setting
`NEXT_PUBLIC_SITE_URL` explicitly in Production env vars to the stable
`project-stage-weld.vercel.app` domain — an env var change, not a code
change (the existing fallback order already checks this var first).
Vercel does expose a *stable* per-project variable
(`VERCEL_PROJECT_PRODUCTION_URL`) that `getSiteURL()` could fall back to
instead of `VERCEL_URL` — not adopted here, since an explicit,
dashboard-visible env var is more inspectable than a second layer of
runtime auto-detection for a single-domain prototype with no preview
workflow that depends on it.

**Finding 2 — Vercel's "Sensitive" env var type cannot be read back by
anyone, including the project owner, once set**: attempted to verify the
LiveKit credentials by pulling them locally (`vercel env pull`) and
replaying the app's own token-minting/webhook-signing logic against the
real LiveKit project as a server-side check. Every var came back as the
literal string `[SENSITIVE]` — not a bug, a deliberate Vercel security
property of that variable type (all vars in this project default to
Sensitive when added through the dashboard/CLI). **Consequence**:
verifying a Sensitive credential's correctness can only be done by
observing the *deployed app's* actual behavior — never by fetching the
value out for a local side-by-side test, not even by the person who set
it. Adjusted the verification approach accordingly: checked the live
room page's SSR output for the absence of `getLiveKitToken`'s
"Couldn't connect" fallback text (proves the vars are present and
non-empty, and that local JWT signing succeeds — token minting itself
never calls LiveKit's API), and separately confirmed the deployed
webhook route genuinely validates signatures (a bogus signature and a
missing one both correctly return 401 from the live public URL). What
this *doesn't* prove — a validly-signed webhook payload being accepted,
and the actual client-side WebRTC connection succeeding — can't be
proven without either the real secret (which nobody but the person who
set it should paste anywhere, including here) or a real browser
(camera/mic permission prompts, actual video negotiation), which this
environment doesn't have. Documented as an explicit, honest limit of
what an agent session can verify for this feature, not glossed over.

**Reason both are recorded here**: neither was a design *choice* so much
as a real gap between how the code was written (before any deployment
existed) and how Vercel's platform actually behaves — exactly the kind
of thing worth writing down so the next session that touches deployment
config doesn't rediscover either the hard way.

**Tradeoffs**: none of consequence — both fixes were env-var-only, no
code changes, no new infrastructure.

---

## 2026-08-12 — A dev-only `/dev` route for browser-based usability testing, and why it has to be gated differently than the CLI harness

**Problem**: the CLI harness (`scripts/dev-harness.mts`) solved "create
and seat test events" but still required running terminal commands —
usability testing needs a way to launch and use the product without CLI
commands, i.e. something reachable by clicking through a browser.

**Alternatives considered**:
1. Extend the CLI harness's ergonomics (shorter commands, a watch mode,
   etc.) — doesn't solve "no CLI commands," just makes the CLI nicer.
2. A dev-only Next.js route (`/dev`), gated at runtime.

**Decision**: Option 2 — `src/app/dev/`, at the user's direction.

**Reason this needs a genuinely different safety model than the CLI**:
the CLI harness achieved zero production footprint by living entirely
outside `src/` — never imported by application code, never bundled, not
HTTP-reachable *at all*. A UI-reachable tool cannot make that same claim
by construction: it has to be a Next.js route, which means it exists in
the production server bundle regardless of gating. So "keep production
behavior unchanged" has to mean something more precise here — the route
must be behaviorally inert in a real deployment, verified, not just
gated and hoped. Concretely: `isDevToolsAvailable()`
(`lib/dev-demo.ts`) checks `process.env.NODE_ENV !== "production"` —
reliable specifically because Next.js itself force-sets
`NODE_ENV=production` for every `next build`/`next start`, regardless of
shell environment, so it isn't a flag that can be accidentally left
unset. The page calls `notFound()` on this check; **every Server Action
in `src/app/dev/actions.ts` independently re-checks the same guard as
its first statement**, since an action has its own callable endpoint,
reachable whether or not the page that renders its trigger button ever
rendered — hiding the page alone would not have been sufficient.
Verified both ways directly: `npm run build && npm run start` on a spare
port, confirmed `/dev` 404s while a real route stays healthy, and a unit
test (`src/app/dev/actions.test.ts`) stubbing `NODE_ENV=production`
proving each action rejects synchronously, before ever touching
`resolveIdentity()`/cookies() or the database.

**No new backend capability, on purpose**: every write goes through
primitives issue #13/#14 already built and authorized — `claimSpeakerSeat`
(seating the *currently logged-in* account directly, bypassing the
production request-queue/ranking gate from issue #14, the same bypass
the CLI's `seat` command already established as acceptable for testing)
and a plain `events` insert via the existing service client. `/dev` is
orchestration over existing, already-reviewed capability, not a new one.

**One shared source of truth for tagging, not two**: extracted the
harness's `[dev-harness] ` prefix, `.invalid` test-email domain, and
phase-timing helper into `lib/dev-demo.ts` (pure, no Supabase/IO) and
refactored `scripts/dev-harness.mts` to import from it instead of
keeping its own copies. Effect: the CLI's `reset` and `/dev`'s "Reset all
demo events" clean up *each other's* data — one convention, two entry
points.

**A genuine testing-infrastructure bug this surfaced, not a flaky
network blip**: once `src/lib/repositories/dev-demo.test.ts` existed
alongside `scripts/dev-harness.test.ts` — two *independent* integration
test files both creating `[dev-harness] `-tagged fixtures and both
running their own "delete everything tagged" reset — Vitest's default
parallel file execution let one file's reset delete the other file's
still-in-use fixtures mid-run, producing a real (reproducible, not
timing-flaky) test failure (`eventsDeleted` was `0` when it should have
found the file's own fixture). Every other integration test in this
project was safe under parallel execution because each one scopes its
fixtures to unique, randomly generated ids/emails that could never
collide across files — this was the first case where two files
deliberately *share* a broad tag, which is exactly what made them able
to step on each other's test runs too. **Fix**: `fileParallelism: false`
in `vitest.config.mts`, with a comment explaining why — this removes the
whole class of cross-file shared-state interference (present and any
future case), not just these two files, at the cost of a few extra
seconds of total suite runtime. Considered scoping each test's
assertions to "my own fixture specifically" instead (more surgical,
preserves parallelism) but judged less robust: it would require
correctly auditing every assertion in every current *and future*
integration test file for hidden global-state assumptions, an easy thing
to get subtly wrong once and not notice until the next flaky failure.

**Tradeoffs**: none of consequence for the gating design — the "route
necessarily ships in the bundle" tradeoff was unavoidable given the
requirement (UI-reachable), not a choice. For the test-parallelism fix,
the total suite runtime increased (roughly summed rather than
overlapped for the integration-heavy files) — accepted as clearly worth
it for a prototype's test suite, where correctness matters far more than
shaving several seconds off `npm test`.

---

## 2026-08-12 — The speaker request queue is comment-driven, not a generic waiting list; request creation is atomic by construction

**Problem**: PRODUCT.md's own literal text describes "Speaker request
queue" as "an ordered list of account holders waiting for a seat" — a
generic FIFO/priority-queue shape. Building it that way would create a
second, parallel content system (queue entries) sitting next to chat
(comments), when the product's actual direction — confirmed by the user
before implementation — is that these converge: "request the mic" and
"submit a comment" (two separately-listed account-holder capabilities in
PRODUCT.md) are meant to be one action, and a future pinned/featured
comment surface needs to highlight exactly the same content a request
produces.

**Alternatives considered**:
1. A dedicated `speaker_queue` table (position, joined-at, status),
   independent of chat, as PRODUCT.md's literal wording suggests.
2. A mic request is a chat message with a flag on it. `speaker_requests`
   stores lifecycle only (pending/granted/withdrawn) and references the
   message that carries the actual content — never duplicating it.

**Decision**: Option 2, at the user's explicit direction, with two
refinements added during design review:

- **Request creation must be atomic** — the chat message and the
  `speaker_requests` row are never two independent application-level
  writes that could partially succeed. Implemented as a single
  `security definer` Postgres function (`request_to_speak`, migration
  `00000000000011`): one function call is one implicit transaction, so a
  losing concurrent call (the partial unique index rejecting a second
  pending request from the same profile) rolls back its message insert
  too. Proven with a real race test in `speaker-requests.test.ts` —
  two concurrent `request_to_speak` calls from the same profile, then
  asserting the count of "is_speaker_request" messages exactly equals
  the count of `speaker_requests` rows for that profile (no orphan
  either direction) — not just asserted from reading the SQL.
- **Promotion eligibility is `TOP_ELIGIBLE_COUNT = 3` pending requests,
  not strictly rank 1**, and this is recorded here explicitly as an
  **MVP selection policy, not a permanent product rule**. A strict
  "only rank 1 may claim" design has a real failure mode this prototype
  has no infrastructure to solve: an absent top-ranked requester would
  block the seat forever, with no background-job/cron mechanism in this
  serverless setup to expire or skip them. Widening eligibility to the
  top few — with `claim_speaker_seat`'s own existing race-safety (issue
  #13) as the tiebreak if more than one eligible requester claims at
  once — solves the stuck-seat problem without new infrastructure. The
  durable concepts this stands in for, which should survive even if this
  specific policy is replaced later: audience support determines which
  requests rise (reaction-count-driven ranking), only sufficiently
  elevated requests become eligible (this constant), and the mechanism
  that finally promotes one of the eligible requests may evolve into
  something more deliberately audience-driven than "first successful
  claim wins." Documented at length in `lib/speaker-queue.ts` itself, not
  just here, so it's visible at the point anyone would change it.

**Reason**: Same principle issue #3 already established for speaker
occupancy (the database is authoritative, the realtime channel is
presentation) applied to requests: `event_chat_messages.is_speaker_request`
is a permanent marker (set once, never flipped back — "was this
submitted as a request," not "is it still pending"), so a future
pinned/featured surface is a read (`pending speaker_requests`, ranked)
rendered through `RoomChatPanel`'s existing `featuredSlot` (issue #3),
never a schema change. Ranking itself is trusted-server-only
(`rank_pending_speaker_requests`, `service_role`-gated — it reads
`profiles.reputation_score`, which `anon`/`authenticated` can't select
directly) and is never exposed to the client as a public leaderboard in
this issue; `claimOpenSeat` (the Server Action) only ever returns
pass/fail.

**A genuine, if minor, forward-compatibility check performed, not just
assumed**: the user asked to keep future one-level comment replies in
mind without building them. Confirmed nothing in this migration blocks
adding a nullable, self-referencing `parent_message_id` to
`event_chat_messages` later — a plain additive column, same shape as
every other "left room for it" decision in this schema.

**Tradeoffs**: `reputation_score` is always `0` for every profile today
(nothing mutates it yet — same accepted gap issue #13 left for
`display_name`'s tiebreak-adjacent reasoning), so ranking currently
reduces to reaction-count-then-recency; harmless, not a blocker, but
worth remembering when reputation mutation eventually lands elsewhere.
`claimOpenSeat`'s pure decision (`decideClaimEligibility`, in
`lib/speaker-queue.ts`) had to be extracted from the Server Action
specifically because the action itself can't be unit-tested directly —
it depends on `resolveIdentity()` → `next/headers`' `cookies()`, valid
only inside a real Next.js request. Same limitation this project has
hit for every other Server Action; the fix (test the decision, not the
wrapper) is the same one already used for
`determineCanPublish`/`shouldPublish`/`applySpeakerChange`.

---

## 2026-08-12 — Closing a GitHub issue does not update the Project board's Status field; treat them as two separate updates

**Problem**: Reviewing the board before starting this issue (per the
user's request to check whether issues #4/#5 were already satisfied by
#3) surfaced that issues #13 and #3 — both already merged and closed via
"closes #N" in their commit messages — still showed **Status: Backlog**
on the Project board, not Done. The "closes #N" convention this project
has used since issue #1 closes the GitHub *issue*; it does not touch the
board's custom Status field, which is a separate piece of state entirely.
Every prior session assumed closing the issue was sufficient and never
verified the board reflected it.

**Decision**: Fixed the four stale cards (#13, #3, and the newly-closed
#4/#5) to Status: Done via `gh project item-edit`, and are treating the
board Status update as its own explicit step from here forward — moved
issue #14 through In Progress → Testing / Review → (Done, once merged)
deliberately, rather than only relying on the commit message's
"closes #N".

**Reason**: AGENTS.md's own standing rule — "a stale board... is worse
than no board" — already named this risk category; this is the first
session with working `gh` access to actually verify state against it,
and the verification found exactly the drift that rule warns about.
Worth fixing retroactively rather than leaving stale cards next to
newly-accurate ones.

**Tradeoffs**: None — this is a correctness fix with no design
alternative to weigh; it was simply an unchecked assumption until now.

---

## 2026-08-11 — A standalone dev-harness script, not an application route, for manual test-session tooling

**Problem**: there was no efficient way to manually test the live room.
Creating an event required hand-writing SQL against the live project (the
same one `supabase/seed.sql` populates — there's no separate dev/staging
database for this prototype); becoming a speaker was, by design,
impossible through the app at all (`claim_speaker_seat` deliberately has
no `anon`/`authenticated` grant and no Server Action wrapper — issue
#13's explicit constraint, reaffirmed for issue #3). Every verification
of the two-speaker room so far had been a service-role test script, never
an actual person clicking into a browser tab.

**Alternatives considered**:
1. A dev-only page/Server Actions inside the Next.js app (e.g.
   `/dev/test-events`), guarded by a runtime `NODE_ENV`/similar check
   that 404s in production.
2. A standalone CLI script, outside `src/`, never imported by
   application code, using the same `service_role` credential and the
   same already-authorized `claim_speaker_seat`/`leave_speaker_seat`/
   `end_speaker_seat` RPCs issue #13 built — i.e., becoming one more
   trusted server-side caller of primitives that already exist, not a
   new capability.

**Decision**: Option 2, at the user's direction —
`scripts/dev-harness.mts`, run via `node --experimental-strip-types
--env-file=.env.local scripts/dev-harness.mts <command>` (wrapped as
`npm run dev:harness --`). Four commands: `create [--phase=...]`, `seat
<email-or-label> <seat>`, `list`, `reset`.

**Reason**: A runtime-guarded route (option 1) is still application code
— it ships in the bundle, it's still a route the server has to handle,
and "guarded by an env check" is a weaker guarantee than "does not exist
in the deployed surface at all," which is what the user's "do not expose
the harness through the production application" constraint actually
calls for. A standalone script under `scripts/` (not `src/`) is
structurally never reachable via HTTP and never bundled — confirmed by
`npm run build`'s route table having no entry for it, not just asserted.
It also needed zero new backend capability: `claim_speaker_seat`'s
service-role-only tier already exists specifically for "a trusted
server-side caller decides who's seated," and this script is exactly
that, the same way the LiveKit webhook route already is.

**Safety design — how `reset` can never touch real content**: every
resource the harness creates is tagged, and `reset` only ever acts on
tagged resources:
- Events: title prefixed `[dev-harness] `.
- Auto-created test accounts: email on the reserved, non-routable
  `@dev-harness.invalid` domain (RFC 2606) — real signups can never
  collide with it.

Critically, `seat` **refuses to auto-create an account for an email that
isn't already a real profile and isn't a harness-tagged address** —
rather than silently creating an untagged throwaway account `reset`
could never find and clean up (a leak `reset`'s own tag-based logic can't
detect by construction). This is also what makes seating your own real
dev account safe: pass your real email, and since it already exists, the
harness reuses it and never creates or deletes it — verified directly
(`scripts/dev-harness.test.ts`'s end-to-end suite creates an untagged
"real" event and account alongside harness-tagged ones, runs the actual
`resetHarness`, and asserts the untagged fixtures survive byte-for-byte
while the tagged ones are gone — not just asserting the tag-matching
predicates in isolation).

**A real, if minor, finding while implementing**: `tsc --noEmit` rejects
an explicit `.ts`/`.mts` extension in an import specifier by default
(`TS5097`) — required here because `scripts/dev-harness.test.ts` imports
value exports (not just types) from `scripts/dev-harness.mts`, and
Node's own ESM resolution (used when the script runs directly) requires
that same explicit extension. Fixed by adding
`allowImportingTsExtensions: true` to the project's single `tsconfig.json`
— safe project-wide because it requires (and this project already has)
`noEmit: true`; the flag only changes what the type-checker accepts in
import specifiers, never what gets emitted, and Next.js's own bundling
doesn't go through `tsc` at all.

**Tradeoffs**: requires Node 22.6+ (native `--env-file` and
`--experimental-strip-types`) — a real constraint, documented in
README.md rather than worked around with a new dependency
(ts-node/tsx) that would add ongoing maintenance for a tool used
occasionally. Testing an actual two-person conversation still requires
two browser sessions (one per seated speaker) — the harness prepares the
data, it doesn't automate the browser; that's out of scope for "smallest
tooling."

---

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
