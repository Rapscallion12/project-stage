-- Issue #21, eighteenth corrective pass: `event_speakers_active` (the
-- one and only view in this schema — confirmed by grepping every
-- migration for `create view`/`create or replace view`, so this is a
-- narrow, one-off fix, not a symptom of a wider pattern) was created in
-- migration 00000000000018 as `select * from event_speakers where
-- is_speaker_seat_active(...)`. PostgreSQL expands a view's `select *`
-- into the specific column list that existed on the underlying table at
-- `CREATE VIEW` time, and does not retroactively pick up columns added
-- to that table afterward. `event_speakers` gained five more columns in
-- migration 00000000000021 (`round_number`, `round_started_at`,
-- `round_ends_at`, `round_phase`, `closing_ends_at`) — three migrations
-- after the view's own creation — so every one of those five has been
-- silently absent from every `event_speakers_active` read ever since,
-- despite the `EventSpeaker` TypeScript type (a hand-written domain
-- type, not derived from the generated view type) claiming all five are
-- always present.
--
-- Proved directly against the live linked database's own generated
-- types (`src/types/database.ts`, introspected from the real schema,
-- not from these migration files) before writing this migration:
-- `event_speakers_active`'s `Row` type has exactly 11 columns (id,
-- event_id, profile_id, seat_number, joined_at, left_at, left_reason,
-- display_name, guest_id, disconnected_at, media_inactive_since) —
-- precisely the column set `event_speakers` had immediately before
-- migration 00000000000021 ran. `event_speakers`'s own `Row` type has
-- 16. The five-column difference is exactly migration 21's additions —
-- confirming this affects more than the two columns (`round_phase`,
-- `closing_ends_at`) the seventeenth pass's live-browser test happened
-- to surface; `round_number`/`round_started_at`/`round_ends_at` were
-- equally absent, silently breaking `speaker-vote-panel.tsx`'s own
-- round-key/deadline derivation too (see that component's `roundKey`
-- and `nearestDeadlineMs`).
--
-- Consequence, traced precisely (not just "the view is stale"):
-- Supabase Realtime's `postgres_changes` subscriptions replicate off
-- the *base table's* WAL directly, never through a view — so
-- `useActiveSpeakers`'s own incremental INSERT/UPDATE deltas (the
-- `postgres_changes` handlers subscribed on `event_speakers` itself)
-- already correctly carried all 16 columns the whole time. It was only
-- every *reconcile* — the full authoritative resync this same hook
-- deliberately performs on SUBSCRIBED, on visibility/focus restoration,
-- on its own 20s backstop, and on every bootstrap/invariant-triggered
-- `refetch()` (all reading `event_speakers_active` via `.select("*")`)
-- — that clobbered a just-delivered, correct `round_phase: "closing"`
-- back to `undefined` moments later. This explains the seventeenth
-- pass's own reproduction precisely: a narrow-loss UPDATE briefly set
-- the client's local state correctly, but the very next reconcile (the
-- bounded 20s backstop, if nothing else) overwrote it, silently
-- canceling `useStageRoundResolution`'s just-scheduled Final-30 timer
-- — not "the client never learns," but "the client learns correctly,
-- then has it taken away again," which is consistent with the seat
-- staying stuck in `closing` indefinitely once caught in that cycle.
--
-- Fix: `create or replace view`, not a drop+recreate — Postgres allows
-- `CREATE OR REPLACE VIEW` to *add* new output columns at the end
-- without disturbing dependents, as long as every existing column's
-- name/position/type is unchanged; it does not allow reordering or
-- removing existing columns. The explicit column list below reproduces
-- the original 11 in their original `select *`-implied order (verified
-- against `event_speakers`'s own column history: initial migration
-- 00000000000005, then `display_name` in migration 00000000000010,
-- `guest_id` in migration 00000000000012, `disconnected_at` in
-- migration 00000000000016, `media_inactive_since` in migration
-- 00000000000017 — all in that order, all before this view's own
-- creation), then appends the five migration-21 columns at the end, in
-- their own declaration order. No SQL-level dependents exist to check
-- (confirmed by grep: no other view, function, or FK constraint
-- references `event_speakers_active` — the "referencedRelation:
-- event_speakers_active" entries the generated types show for
-- `speaker_round_votes_event_speakers_id_fkey` are the *same* real
-- constraint, which genuinely targets the base table; the generator
-- lists it twice because it also infers a PostgREST embedding path
-- through the view — Postgres does not allow a view to be an actual FK
-- target at all), so this is a safe, in-place `create or replace`.
--
-- An explicit column list, not another `select *` — deliberately, so
-- this exact class of drift can't recur silently: any future column
-- added to `event_speakers` now requires a conscious decision (and a
-- migration) to expose it here, rather than an automatic, invisible
-- omission. Every one of the five newly-exposed columns is already the
-- same public visibility tier as the rest of the row (round-lifecycle
-- bookkeeping — a number, two timestamps, a two-value phase string, a
-- nullable deadline — no auth secrets, no moderator-only data, nothing
-- the base table doesn't already expose to the same anon/authenticated/
-- service_role grant), so nothing new or sensitive is being surfaced.
-- Filtering semantics (`is_speaker_seat_active`), `security_invoker`,
-- and the existing grant are all preserved unchanged.
create or replace view public.event_speakers_active
with (security_invoker = true)
as
  select
    id,
    event_id,
    profile_id,
    seat_number,
    joined_at,
    left_at,
    left_reason,
    display_name,
    guest_id,
    disconnected_at,
    media_inactive_since,
    round_number,
    round_started_at,
    round_ends_at,
    round_phase,
    closing_ends_at
  from public.event_speakers
  where public.is_speaker_seat_active(left_at, disconnected_at, media_inactive_since);

-- CREATE OR REPLACE VIEW preserves the view's OID and, in practice,
-- existing grants — re-issued explicitly anyway so this migration is
-- correct even if that assumption is ever wrong on some future
-- Postgres version, at zero cost (a repeat grant is a no-op).
grant select on public.event_speakers_active to anon, authenticated, service_role;
