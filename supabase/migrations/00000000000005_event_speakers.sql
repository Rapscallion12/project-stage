-- Append-only occupancy episodes: "this account holder occupied this seat,
-- from this time, until this time (or still occupying it, if left_at is
-- null)". Deliberately not a "scheduled speaker" table (nothing in this
-- product pre-books a seat — the queue/audience decide live) and not a
-- single mutable "current speaker" pointer (that would destroy history the
-- instant someone gets replaced, which is exactly the case Phase 3's
-- replace-speaker voting exists to trigger). Replacing a speaker means
-- ending this row (left_at/left_reason) and inserting a new one for the
-- next occupant — never overwriting who was there. See DECISIONS.md for
-- the full design reasoning.
--
-- Deliberately room-agnostic, same as `events` itself: Phase 2 has exactly
-- one room per event. When multi-room support lands, the additive change
-- is a nullable `room_id` column plus RE-SCOPING the uniqueness below from
-- (event_id, seat_number) to (room_id, seat_number) — flagged here so it's
-- an expected follow-up, not a surprise.
create table public.event_speakers (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  -- Account-only, not nullable, no guest column — speakers must have an
  -- account (PRODUCT.md's progressive authentication model); there is no
  -- XOR-with-guest pattern here the way chat authorship has one.
  profile_id uuid not null references public.profiles (id) on delete cascade,
  -- Hardcoded to the MVP's two-speaker format (PRODUCT.md is explicit and
  -- consistent about this). Loosening this later, if the product ever
  -- supports more seats, is a trivial additive constraint change — not a
  -- redesign.
  seat_number smallint not null check (seat_number in (1, 2)),
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  -- Constrained vocabulary, not free text — each value traces to an
  -- already-scoped feature rather than a guess at future ones:
  --   voluntary          — speaker left on their own (issue #3/#6)
  --   replaced           — audience voted them out (Phase 3 replace voting)
  --   moderator_removed  — moderator action (Phase 3 moderator controls)
  --   event_ended        — event/room concluded while they were seated
  --   disconnected       — connection lost (issue #3's reconnect handling)
  left_reason text check (
    left_reason in ('voluntary', 'replaced', 'moderator_removed', 'event_ended', 'disconnected')
  ),
  constraint left_at_after_joined check (left_at is null or left_at >= joined_at),
  -- No ambiguous "ended but we don't know why" rows — a real correctness
  -- property for future reliability scoring, not just tidiness.
  constraint left_reason_required_when_left check (
    (left_at is null and left_reason is null) or
    (left_at is not null and left_reason is not null)
  )
);

-- Exactly one ACTIVE occupant per seat per event at a time. Historical
-- (left_at is not null) rows are unrestricted — many past occupants can
-- have held the same seat over an event's lifetime.
create unique index event_speakers_active_seat_uniq
  on public.event_speakers (event_id, seat_number)
  where left_at is null;

create index event_speakers_event_id_idx on public.event_speakers (event_id);

alter table public.event_speakers enable row level security;

-- Public, like `events` — guests watching need to see who's currently
-- speaking without an account (PRODUCT.md's progressive authentication
-- model: audience viewing is guest-eligible).
create policy "Event speakers are publicly viewable"
  on public.event_speakers for select
  to anon, authenticated
  using (true);

-- Read-only from the app's perspective, deliberately, matching `events`'
-- own first migration: no insert/update/delete policy or grant here. The
-- authorization logic for "who's allowed to occupy a seat" doesn't exist
-- yet — it's already scoped into issue #2 (LiveKit token minting checks
-- occupancy/entitlement), which is where the write path belongs. Adding
-- a write policy here, before that logic is designed, would either be a
-- guess or an open door.
grant select on public.event_speakers to anon, authenticated;
