-- Session Simulator Reset Session follow-up (issue #21): the simulator's
-- Reset Session action hard-deletes rows from event_chat_messages,
-- event_chat_message_reactions, speaker_requests, and event_speakers —
-- something the ordinary product flow never does (a message is
-- permanent; a request transitions status via UPDATE; a seat departure
-- sets left_at via UPDATE). Every realtime hook reading these tables
-- (useLobbyRealtime, useActiveSpeakerRequests, useActiveSpeakers) was
-- built only to react to INSERT/UPDATE as a result, leaving deleted rows
-- visually stale in the live comment feed, Top Speaker Requests, and the
-- speaker stage until a full page reload.
--
-- Fixing that client-side requires each DELETE payload to carry enough
-- of the old row to (a) know which client-side aggregate to update —
-- reactions are keyed by message_id, speakers by seat_number, neither
-- of which is the row's own primary key — and (b) let Supabase
-- Realtime's server-side `event_id=eq.<id>` filter (already used by the
-- existing INSERT/UPDATE subscriptions on three of these four tables)
-- evaluate correctly on DELETE at all, since a filtered column must be
-- present in the row data Postgres includes in its replication stream
-- for a delete.
--
-- Postgres's default REPLICA IDENTITY (primary key only) means a
-- DELETE's logical-replication old-row data contains just `id` — not
-- enough for either purpose. REPLICA IDENTITY FULL makes Postgres log
-- the complete old row for these four tables specifically, so DELETE
-- events carry the same shape INSERT/UPDATE already do. This changes
-- nothing about RLS, grants, or the schema itself — it's purely a
-- replication-stream detail scoped to exactly the tables that need it.
alter table public.event_chat_messages replica identity full;
alter table public.event_chat_message_reactions replica identity full;
alter table public.speaker_requests replica identity full;
alter table public.event_speakers replica identity full;
