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

## MVP scope (v1)

In scope:

- Landing page
- Authentication
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

- **User** — has a reputation score and a reliability score (see below).
- **Event** — a scheduled live session with a start time and two speaker
  seats.
- **Speaker** — a user currently occupying one of the two seats.
- **Audience member** — a user watching an event; can react, comment, vote,
  and join the speaker request queue.
- **Speaker request queue** — ordered list of audience members waiting for a
  seat; reputation affects position, not eligibility.

### Reputation vs. reliability

These are deliberately separate:

- **Reputation** reflects how good someone's contributions have been
  (audience/vote-driven). It affects queue priority.
- **Reliability** reflects whether someone shows up and behaves as expected
  (e.g. doesn't no-show after joining the queue, doesn't get emergency-left
  or reported for cause). It affects standing, not creative license.

Neither score grants moderation power or extra votes — see Principle 4.
