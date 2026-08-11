-- Real bug caught by issue #13's own integration tests: PostgreSQL grants
-- EXECUTE on a new function to PUBLIC by default, unless explicitly
-- revoked. Migration 00000000000006 added explicit grants for the access
-- each function was *meant* to have (authenticated for
-- leave_speaker_seat; service_role only for claim_speaker_seat and
-- end_speaker_seat) but never revoked the default PUBLIC grant those
-- explicit grants were supposed to replace — confirmed via
-- `select proacl from pg_proc where proname = 'claim_speaker_seat'`
-- showing `{=X/postgres, ...}`, where the empty role name is PUBLIC. In
-- practice this meant claim_speaker_seat/end_speaker_seat — the two
-- functions this project's whole design explicitly keeps
-- trusted-server-only, see DECISIONS.md — were actually callable by any
-- authenticated (or even anon) request all along, exactly the exposure
-- the user's constraint on this issue was written to prevent.
--
-- Tables don't have this default-PUBLIC-access behavior (new tables start
-- with no privileges for anyone but the owner), which is why this pattern
-- was never hit before — every other grant in this project's migrations
-- so far has been on a table, not a function.
revoke execute on function public.claim_speaker_seat(uuid, uuid, smallint) from public;
revoke execute on function public.end_speaker_seat(uuid, uuid, text) from public;
revoke execute on function public.leave_speaker_seat(uuid) from public;

-- leave_speaker_seat's intended access (authenticated only, already
-- granted in migration 00000000000006) is unaffected by the revoke above
-- — re-stated here only for anyone reading this migration in isolation,
-- not because the earlier grant needs re-issuing.
