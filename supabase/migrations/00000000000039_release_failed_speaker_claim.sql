-- Issue #21, tenth corrective pass, Section 13: "if a selected candidate
-- is authorized but cannot claim their seat, release/reconcile them and
-- advance the next eligible candidate — without disturbing another
-- seat's own valid reservation." Reading the actual claim path
-- (claim_speaker_seat + room/actions.ts' claimOpenSeat) found no
-- existing mechanism for this at all: a claim that fails after
-- authorization (a genuine race — e.g. the target seat was taken by
-- something else in between the eligibility check and the claim itself)
-- simply returns an error to the caller and leaves that candidate's own
-- is_current_candidate/reserved_seat_number exactly as they were —
-- authoritatively "reserved" for a seat they will never occupy, with
-- nothing else ever re-evaluating that reservation. This is a real gap,
-- not an existing rule this migration is merely surfacing.
--
-- Mirrors withdraw_speaker_request(_as_guest)'s own "advance the next-
-- ranked candidate within this same round, for this same seat" branch
-- (migration 00000000000038) as closely as possible, for the same
-- reason that branch exists: the next candidate must be picked
-- atomically, server-side, under this row's own lock — a client-side
-- read-then-write (fetch the frozen pool in TypeScript, pick the next
-- one, call set_current_speaker_candidate) would reopen exactly the
-- concurrent-reservation race migration 00000000000036's own atomic
-- reservation RPC exists to close.
--
-- **Deliberately does NOT set selection_failed = true** on the failed
-- row, unlike the withdrawal path — a genuine design choice, not an
-- oversight, flagged in this pass's own handoff QUESTIONS section. A
-- claim failure is presumptively transient (a race with another seat-
-- filling event, not a deliberate "I don't want this seat" signal the
-- way withdrawal is), and selection_failed has no per-round scope in the
-- schema — it would follow this request's row into any later, entirely
-- independent fresh round (freeze_speaker_candidates does not reset it
-- when re-freezing an old still-pending row), permanently disqualifying
-- an otherwise-legitimate candidate over what might have been one bad
-- race. The "don't immediately re-pick the request that just failed"
-- exclusion this round still needs is scoped instead to this one call,
-- via "id != the failed request's own id" — sufficient to prevent an
-- infinite immediate-re-pick loop without a permanent, cross-round flag.
create function public.release_failed_speaker_claim(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.speaker_requests;
  v_next_id uuid;
begin
  select * into v_row from public.speaker_requests where id = p_request_id;

  -- Already changed underneath us (claimed elsewhere, withdrawn,
  -- released by a concurrent caller) — safe no-op, same idempotency
  -- discipline release_expired_inactive_speaker and every other
  -- "re-derive from current state, never assume the caller's snapshot
  -- is still valid" function in this schema already follows.
  if v_row.id is null or not v_row.is_current_candidate or v_row.selection_round_id is null then
    return;
  end if;

  update public.speaker_requests
  set is_current_candidate = false, reserved_seat_number = null
  where id = v_row.id;

  select id into v_next_id
  from public.speaker_requests
  where selection_round_id = v_row.selection_round_id
    and status = 'pending'
    and not selection_failed
    and not is_current_candidate
    and id != v_row.id
  order by frozen_rank
  limit 1;

  if v_next_id is not null then
    update public.speaker_requests
    set is_current_candidate = true, reserved_seat_number = v_row.reserved_seat_number
    where id = v_next_id;
  elsif not exists (
    select 1 from public.speaker_requests
    where selection_round_id = v_row.selection_round_id and is_current_candidate
  ) then
    -- No further candidate frozen into this round, and no other seat
    -- still has a live reservation in it either — same "genuinely
    -- nothing left this round can do" exhaustion check migration
    -- 00000000000038 added for withdrawal, so a later
    -- ensure_active_selection_round call re-freezes fresh from the
    -- current live pool instead of finding this stale round and
    -- reusing its already-exhausted candidate set.
    update public.speaker_selection_rounds set status = 'exhausted', resolved_at = now()
    where id = v_row.selection_round_id and status = 'active';
  end if;
end;
$$;

grant execute on function public.release_failed_speaker_claim(uuid) to service_role;
revoke execute on function public.release_failed_speaker_claim(uuid) from public;
