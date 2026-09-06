-- Corrective: migration 00000000000029 added a new trailing parameter to
-- claim_speaker_seat, which (per migration 00000000000030's own finding)
-- created a genuinely new function object in Postgres's catalog rather
-- than replacing the old one in place -- and a brand-new function object
-- does not inherit whatever revoked-from-public state the old one had.
-- The real-database test suite caught the resulting gap directly: an
-- ordinary authenticated user's (and even an anonymous) direct RPC call
-- was no longer cleanly rejected with a permission error the way it was
-- before this pass. Restated explicitly here, matching the trusted-
-- server-only tier this function has always been meant to sit at (the
-- original 5-argument version only ever granted execute to
-- service_role, migration 00000000000012).
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from public;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from anon;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from authenticated;
grant execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) to service_role;
