-- Durable test-fixture guarantee. Real-device testing has repeatedly hit
-- "no room available" on the deployed Browse Events page — a dev-harness
-- event's scheduled_start aged past the list's 2-hour visibility cutoff
-- (lib/events.ts's getEventsListCutoffIso), or dev-harness reset (or the
-- /dev page's own reset button) deleted it between sessions. See
-- DECISIONS.md/SESSION_LOG.md for the incidents this fixes.
--
-- One flagged row, enforced to be at most one via a partial unique index
-- — a real database-level invariant, not just a naming convention. The
-- events-list query (lib/repositories/events.ts) exempts this row from
-- the time-based cutoff entirely, and both reset paths
-- (scripts/dev-harness.mts, lib/repositories/dev-demo.ts) explicitly
-- exclude it, so normal test-data cleanup can never delete it.
alter table public.events
  add column is_permanent_test boolean not null default false;

create unique index events_one_permanent_test_idx
  on public.events (is_permanent_test)
  where is_permanent_test;

-- A fixed, well-known id — not gen_random_uuid() — so this insert is
-- idempotent: applying this migration against a database that already
-- has the row (or re-running it) is a safe no-op, never a duplicate row
-- or a constraint violation. scheduled_start/lobby_opens_at are pinned
-- to the moment this migration runs and never need to change again —
-- getEventPhase (lib/events.ts) computes "ready" for any event whose
-- scheduled_start is in the past, so this row stays permanently live
-- with zero special-casing of phase/countdown logic anywhere else in the
-- app.
insert into public.events (id, title, description, scheduled_start, lobby_opens_at, is_permanent_test)
values (
  '00000000-0000-0000-0000-000000000001',
  '[DEV] Always-On Test Room',
  'Permanent development fixture for real-device/manual testing during the prototype phase. Always live, always discoverable from Browse Events, never deleted by dev-harness reset. Chat/speaker state can be cleared without deleting this room — see README.md''s Development test harness section.',
  now(),
  now(),
  true
)
on conflict (id) do nothing;
