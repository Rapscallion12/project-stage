# Product

## The question this prototype answers

**Will people voluntarily watch strangers interact, and become invested
enough to keep the conversation going?**

This is not a startup-in-progress. It is a prototype built to test one
behavioral hypothesis. Every scope decision should be judged against whether
it helps answer that question faster and more cheaply — not against whether
it would help the "real" product later.

## What it is

A live social platform: two strangers hold a conversation while an audience
watches, reacts, and votes on what happens to the conversation next
(continue it, extend it, replace a speaker). Anyone in the audience can work
their way onto stage via a request queue.

## Product principles

These override feature requests whenever the two conflict.

1. **The audience controls the stage.** Continue/replace/extend decisions are
   audience votes, not host or algorithm decisions.
2. **Great conversations earn more time.** Timer extension is a direct
   reward for audience engagement, not a fixed slot.
3. **Anyone can eventually earn the microphone.** The speaker queue is the
   only path to stage — no invite-only or celebrity fast lane in the MVP.
   Requesting the mic is normally the product's clearest account-only
   action (see Principle 12) — **except during the current prototype-
   testing phase**, where it's deliberately opened to guests too, so the
   core social experiment can be validated without account-creation
   friction. See "Prototype-testing exception: guest speaking" below;
   this is an explicit, reversible testing-phase policy, not a reversal
   of the underlying principle.
4. **Reputation earns opportunities, not control.** A high-reputation user
   gets queue priority; they do not get extra votes or moderation power.
5. **Maximize interesting interactions over agreement.** Do not optimize for
   pleasant consensus; optimize for engagement and productive friction.
6. **The conversation is the product.** Everything else (chat, reactions,
   queue) is in service of the conversation, not a competing feature.
7. **The audience should feel like a live crowd**, not a passive viewer
   count — reactions, comments, and audience count should read as "alive."
8. **Simplicity over feature bloat.**
9. **The MVP exists only to validate the core behavior** — not to be a
   complete product.
10. **Never add unnecessary complexity.**
11. **Neither platform is secondary.** Desktop and smartphone are both
    first-class targets — see [Responsive design principle](#responsive-design-principle).
12. **Guests can fully experience the show; accounts unlock contribution.**
    Nobody should have to sign up to watch, react, or vote — see
    [Progressive authentication model](#progressive-authentication-model).
13. **Portrait and landscape are two intentional modes, not one layout
    rotated.** Rotating the device must never cost the user their video
    connection, chat state, votes, reactions, or place in the session — see
    [Mobile orientation behavior](#mobile-orientation-behavior).

## Responsive design principle

This is a permanent product decision, not a per-feature judgment call: it
applies to every screen built from here forward.

The app is used two ways that feel nothing alike — someone half-watching on
a phone while doing something else, and someone leaning into a desktop
browser as the primary activity. Both are core to the "will people stay
invested" question this prototype exists to answer; a platform that only
works well on one doesn't get a real answer.

- **Do not build for desktop and compress it for phones.** Do not build for
  phones and stretch it for desktop.
- **Build responsive layouts and interaction patterns intentionally
  designed for each screen size, sharing the same underlying business
  logic.** The data layer, server actions, and realtime subscriptions are
  shared; the layout, information density, and interaction pattern (e.g.
  tap targets vs. hover states, single-column vs. multi-panel) are not.
- **Desktop** should use the extra space deliberately (multi-panel layouts
  where useful, keyboard shortcuts, natural mouse interaction) rather than
  just centering a phone layout in a wide viewport.
- **Smartphone** is not a secondary experience to tolerate — portrait-first,
  thumb-friendly controls, stable viewport behavior (no layout jumps from
  mobile browser chrome appearing/disappearing), and reliable camera/
  microphone/reconnect handling once the live room exists.
- **Every feature should degrade gracefully under poor network conditions
  instead of failing completely.** E.g.: dropped video quality lowers
  resolution rather than disconnecting; delayed reactions don't stall the
  conversation; slow comments don't freeze the UI; a late audience-count
  update doesn't block the room from functioning.

See [ARCHITECTURE.md](./ARCHITECTURE.md#responsive-implementation-notes)
for the engineering implementation of this principle, and its testing
checklist for what "done" requires per feature.

## Mobile orientation behavior

On the smartphone live-room experience (Phase 2+), portrait and landscape
are **two intentional presentation modes of the same session — not the
same layout rotated 90°.** This is a permanent product decision, scoped
specifically to the live room (speakers, chat, reactions, prompts, voting,
request-to-speak), where orientation genuinely changes what the audience is
there to do.

**Portrait prioritizes participation and community context:**

- Speakers remain clearly visible.
- Chat, reactions, prompts, voting, and request-to-speak controls are easy
  to reach.
- Vertical space is used efficiently so the audience can follow the live
  conversation and the surrounding audience activity at the same time.
- Live chat is more prominent than it is in landscape.
- Controls stay thumb-friendly and never cover important video content.
- No layout should require horizontal scrolling.

**Landscape prioritizes the live conversation itself:**

- Speakers get substantially more screen space.
- The two speaker feeds display side by side when practical.
- Live chat is reduced, collapsed, or hidden by default.
- Reactions and essential controls may remain visible as lightweight
  overlays or compact controls.
- There's always an easy way to reopen chat without leaving the live view.
- The result should feel closer to a focused live-show viewing mode than a
  chat app with video attached.

**Rotating between them must never cost the user anything.** No reload, and
nothing resets: live video stays connected, chat state is preserved, votes
and reactions in progress aren't lost, speaker state and timers keep
running, and the user doesn't lose their place in the session. See
[ARCHITECTURE.md](./ARCHITECTURE.md#mobile-orientation-implementation) for
how this constrains the implementation (state must not live inside
whichever layout variant is currently rendered).

## Progressive authentication model

This is a permanent product decision, adopted as a correction after the
first session initially treated login as the front door. It is not a
per-feature judgment call.

**Authentication must never be a mandatory entry gate.** Nobody should have
to create an account to open the app, see what's on, or join a live event
as a member of the audience. An account is an *upgrade you're invited into
once you have a reason to want it* — not a toll booth before the product
will let you in.

### Guests may (no account required)

- Open the landing page.
- View upcoming events.
- Join a live event as an audience member.
- Watch the current speakers.
- Use basic emoji reactions.
- Participate in continue/replace voting.
- View the audience chat.
- Leave at any time.

### Account holders may additionally

- Request the microphone (**temporarily also available to guests during
  the current prototype-testing phase** — see below).
- Submit prompts, comments, and questions.
- Build entertainment reputation.
- Build reliability and trust history.
- Receive future speaking opportunities.
- Save clips or session history (later feature).
- Host sessions, if eligible (later feature).
- Use a persistent display name and preferences.

### The funnel

```
Landing page
  → Join event as guest
  → Watch and interact
  → Encounter a meaningful account-only action
  → Sign up or log in
```

Guests should never be interrupted with an account prompt speculatively —
only when they take an action that genuinely requires one (requesting the
mic, posting a comment). At that moment, explain the benefit in the same
breath as the ask. Examples of the tone to use:

- "Create an account to request the mic."
- "Sign in to build reputation and earn more stage opportunities."
- "Create an account to save your history and future privileges."

Never phrase an account prompt as a generic wall ("Sign up to continue") —
it should always name the specific thing the guest just tried to do.

### Guest identity and its limits

A guest is represented by a temporary, anonymous session — not a `profiles`
row. See [ARCHITECTURE.md](./ARCHITECTURE.md#guest-identity) for the
implementation (a signed session cookie). Guest votes and reactions are
rate-limited and checked for obvious duplicate abuse (see ARCHITECTURE.md),
but guests do not accumulate anything that outlives the session:

- No reputation.
- No reliability/trust history.
- No hosting privileges.
- No payouts (payouts aren't in scope for anyone — see MVP scope below —
  but the rule holds regardless).

A guest who creates an account starts that history at account creation,
not retroactively from their guest activity, unless a future session
explicitly decides to build identity-linking (not planned for the MVP).

### Prototype-testing exception: guest speaking (issue #16)

During the current prototype-testing phase, guests can request the mic
and become a seated speaker — an **explicit, reversible testing-phase
exception** to Principle 3/12's account-only rule above, not a permanent
product direction. The goal being validated right now is the core social
experiment itself (do strangers join, watch, chat, request the mic,
speak, and stay engaged?), and requiring an account to reach the actual
thing being tested would contaminate that test the same way a login wall
on the landing page would (see "The question this prototype answers").

This is controlled by a single flag
(`PROTOTYPE_CONFIG.guestParticipationEnabled` in `lib/config.ts`), so it
can be tightened back to account-only later — once reputation,
reliability, persistent identity, moderation history, or prizes actually
require an account to mean something — without redesigning the
authorization system. The server-authoritative model itself is
unchanged: a guest's identity is still resolved server-side from an
unforgeable session cookie, seat assignment and LiveKit publish rights
are still decided entirely server-side, and no client of any kind can
grant itself a seat or publish rights. See ARCHITECTURE.md's LiveKit
authorization model and DECISIONS.md for the full design.

While this exception is active:

- A guest's seat occupancy and mic request still accrue nothing that
  outlives the session (no reputation, no reliability, no history) — the
  "guests do not accumulate anything permanent" rule above is unaffected.
- A guest's identity is still just a cookie, not a verified account —
  clearing cookies or switching devices mid-conversation loses the
  seat's identity thread. Accepted as a prototype limitation for now; no
  seat-recovery mechanism is built for it.

## MVP scope (v1)

In scope:

- Landing page
- Progressive authentication (guest access by default; optional accounts
  that unlock contribution — see
  [Progressive authentication model](#progressive-authentication-model))
- Scheduled events
- Waiting room
- Two live speakers
- Audience viewing
- Speaker request queue
- Reputation system
- Reliability system
- Continue voting
- Replace speaker voting
- Timer extension
- Live emoji reactions
- Top audience comments
- Audience count
- Report button
- Emergency leave
- Basic moderator controls

Explicitly out of scope, unless a future session is explicitly instructed
otherwise:

- AI host
- AI clipping
- Donations / payments
- Premium accounts
- User-created rooms
- Notifications
- Advertising
- Complex recommendation algorithms

If a feature request isn't on the in-scope list, the default answer is no —
raise it as a roadmap candidate in [ROADMAP.md](./ROADMAP.md) rather than
building it directly.

## Core entities (product-level, not schema)

- **Guest** — an anonymous visitor identified only by a temporary session,
  not an account. Can watch, react, vote (continue/replace), and view
  audience chat. Accrues nothing that outlives the session — see
  [Progressive authentication model](#progressive-authentication-model).
- **Account holder** — a guest who created an account. Has a reputation
  score and a reliability score (see below) and can additionally comment,
  request the mic, and (later) host.
- **Event** — a scheduled live session with a start time and two speaker
  seats. Viewable and joinable by guests and account holders alike.
- **Speaker** — an account holder currently occupying one of the two
  seats. Normally account-only, requiring an account first — **except
  during the current prototype-testing phase**, where a guest can occupy
  a seat too (see "Prototype-testing exception: guest speaking" above).
- **Audience member** — anyone watching an event, guest or account holder.
  Both can react, vote, and view chat; commenting and joining the speaker
  request queue are normally account-only, with the same testing-phase
  exception extended to guests.
- **Speaker request queue** — ordered list of requesters waiting for a
  seat; reputation affects position, not eligibility. Normally
  account-only (Principle 3) — temporarily open to guests too, per the
  testing-phase exception above.

### Reputation vs. reliability

These are deliberately separate:

- **Reputation** reflects how good someone's contributions have been
  (audience/vote-driven). It affects queue priority.
- **Reliability** reflects whether someone shows up and behaves as expected
  (e.g. doesn't no-show after joining the queue, doesn't get emergency-left
  or reported for cause). It affects standing, not creative license.

Neither score grants moderation power or extra votes — see Principle 4.
