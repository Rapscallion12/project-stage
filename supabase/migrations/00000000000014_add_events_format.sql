-- Room format seam (issue #19) — the smallest possible boundary between
-- "what a room is" and "Main Stage's specific rules" (two seats, retention
-- voting, ranked mic-request promotion). Not a plugin/rules-engine
-- framework: one additive column, defaulted and constrained to the only
-- format that exists today, same extensible-CHECK-constraint pattern
-- event_speakers.left_reason already uses. Future formats (Roulette,
-- Spotlight, Group Stage — none built yet, see ROADMAP.md/DECISIONS.md)
-- would each add an allowed value here plus their own branch at the
-- relevant entry points, never touch Main Stage's code.
--
-- No RLS/GRANT changes needed: this adds a column to the existing `events`
-- table, whose row-level policies already govern who can read/write a row
-- regardless of which columns are selected — see events_and_lobby.sql.
alter table public.events
  add column format text not null default 'main_stage' check (format in ('main_stage'));
