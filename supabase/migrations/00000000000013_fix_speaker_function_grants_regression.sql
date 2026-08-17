-- Fixes a real, live security regression introduced by migration
-- 00000000000012, caught by the existing "not callable by an ordinary
-- authenticated user" test suite immediately after deploying — not
-- caught before deploying, which is exactly why this is a forward fix,
-- not an edit to that migration (never edit an applied migration).
--
-- This is the SAME mistake DECISIONS.md's issue #13 entry already
-- documents happening once before (migration 00000000000006 → fixed by
-- 00000000000008): PostgreSQL grants EXECUTE on a newly created function
-- to PUBLIC by default. Migration 00000000000012 recreated
-- claim_speaker_seat and end_speaker_seat via `drop function` + `create
-- function` (required, since their parameter list changed) — which
-- resets that default, silently undoing migration 00000000000008's
-- original fix for these exact two functions. Every *other* new function
-- in migration 00000000000012 correctly included its own `revoke ...
-- from public` — only these two, extended in place rather than newly
-- authored from scratch, were missed.
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text) from public;
revoke execute on function public.end_speaker_seat(uuid, text, uuid, uuid) from public;
