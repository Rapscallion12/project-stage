-- Issue #21, fifth corrective pass: real-device testing found the stage
-- could get stuck showing "Selecting next speaker..." on BOTH seats for
-- far too long even though Expanded Comments showed two eligible,
-- already-voted-for Request-to-Speak candidates. Traced (not patched
-- with a delay) to the selection model being event-wide, not seat-aware:
-- `speaker_requests_current_candidate_uniq` allowed at most ONE current
-- candidate per round, period — with two seats open simultaneously, only
-- one candidate could ever be reserved at a time, and
-- `reset_speaker_candidate_pool` (Section E, unchanged product intent
-- for the single-seat case) unconditionally expired every OTHER pending
-- request the instant the first candidate's claim succeeded. That wiped
-- out the second seat's own legitimate, already-ranked candidate before
-- they ever got a chance to claim their seat, leaving it permanently
-- candidate-less until a fresh request arrived from scratch.
--
-- Fix: candidates are now reserved *per seat*, not per round. A round can
-- carry up to two simultaneously-current candidates (one per open seat),
-- distinct requests, never the same request for both. Withdrawal
-- advances only the affected seat's own reservation, never touching the
-- other seat's. The pool reset defers the full "everyone else expires"
-- wipe until no other seat still has a live reservation in flight.

-- ---------------------------------------------------------------------
-- reserved_seat_number: which seat (if any) a request is currently
-- reserved for. Only ever set alongside is_current_candidate = true.
-- ---------------------------------------------------------------------
alter table public.speaker_requests
  add column reserved_seat_number smallint check (reserved_seat_number in (1, 2));

-- Replaces speaker_requests_current_candidate_uniq (migration
-- 00000000000019): "at most one current candidate per round" becomes "at
-- most one current candidate per (round, seat)" — up to two
-- simultaneously, one per seat, never two for the same seat.
drop index public.speaker_requests_current_candidate_uniq;

create unique index speaker_requests_current_candidate_per_seat_uniq
  on public.speaker_requests (selection_round_id, reserved_seat_number)
  where is_current_candidate;

-- ---------------------------------------------------------------------
-- freeze_speaker_candidates: return type changes (adds
-- reserved_seat_number) -- CREATE OR REPLACE can't change a function's
-- return type, same drop-first pattern migration 00000000000020 already
-- established for this exact function. Ranking/freezing logic itself is
-- unchanged; only the returned column list is wider, so the TypeScript
-- layer can see which seat (if any) each already-reserved candidate
-- targets.
-- ---------------------------------------------------------------------
drop function public.freeze_speaker_candidates(uuid);

create function public.freeze_speaker_candidates(p_event_id uuid)
returns table (
  round_id uuid,
  request_id uuid,
  profile_id uuid,
  guest_id uuid,
  message_id uuid,
  rank smallint,
  vote_count integer,
  is_current boolean,
  reserved_seat_number smallint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_existing_round_id uuid;
begin
  select id into v_existing_round_id
  from public.speaker_selection_rounds
  where event_id = p_event_id and status = 'active';

  if v_existing_round_id is not null then
    return query
      select sr.selection_round_id, sr.id, sr.profile_id, sr.guest_id, sr.message_id,
             sr.frozen_rank, sr.frozen_vote_count, sr.is_current_candidate, sr.reserved_seat_number
      from public.speaker_requests sr
      where sr.selection_round_id = v_existing_round_id
      order by sr.frozen_rank;
    return;
  end if;

  if not exists (
    select 1 from public.speaker_requests where event_id = p_event_id and status = 'pending'
  ) then
    return;
  end if;

  begin
    insert into public.speaker_selection_rounds (event_id) values (p_event_id)
    returning id into v_round_id;
  exception when unique_violation then
    -- Lost a genuine concurrent race to create the round — fall back to
    -- whichever round the winner just created, same bounded/benign
    -- outcome this codebase already accepts elsewhere for this class of
    -- race (see claim_speaker_seat's own comment).
    select id into v_round_id
    from public.speaker_selection_rounds
    where event_id = p_event_id and status = 'active';

    return query
      select sr.selection_round_id, sr.id, sr.profile_id, sr.guest_id, sr.message_id,
             sr.frozen_rank, sr.frozen_vote_count, sr.is_current_candidate, sr.reserved_seat_number
      from public.speaker_requests sr
      where sr.selection_round_id = v_round_id
      order by sr.frozen_rank;
    return;
  end;

  with ranked as (
    select
      sreq.id as r_id,
      sreq.profile_id as r_profile_id,
      sreq.guest_id as r_guest_id,
      sreq.message_id as r_message_id,
      count(v.id) as r_vote_count,
      row_number() over (
        order by count(v.id) desc, sreq.created_at asc, sreq.id asc
      ) as r_rank
    from public.speaker_requests sreq
    left join public.speaker_request_votes v on v.request_id = sreq.id
    where sreq.event_id = p_event_id and sreq.status = 'pending'
    group by sreq.id
    order by r_rank
    limit 3
  )
  update public.speaker_requests sr
  set selection_round_id = v_round_id,
      frozen_rank = ranked.r_rank,
      frozen_vote_count = ranked.r_vote_count
  from ranked
  where sr.id = ranked.r_id;

  return query
    select v_round_id, sr.id, sr.profile_id, sr.guest_id, sr.message_id, sr.frozen_rank, sr.frozen_vote_count,
           sr.is_current_candidate, sr.reserved_seat_number
    from public.speaker_requests sr
    where sr.selection_round_id = v_round_id
    order by sr.frozen_rank;
end;
$$;

grant execute on function public.freeze_speaker_candidates(uuid) to service_role;
revoke execute on function public.freeze_speaker_candidates(uuid) from public;

-- ---------------------------------------------------------------------
-- set_current_speaker_candidate: now seat-aware -- clears any existing
-- current candidate for the *given seat only* (never the whole round,
-- which would clobber the other seat's own independent reservation),
-- then reserves the given request for that seat.
--
-- New trailing parameter -- per migration 00000000000030's own lesson,
-- CREATE OR REPLACE with a different parameter list creates a genuinely
-- new function overload rather than replacing in place; the stale
-- 2-argument overload is dropped explicitly below, in this same
-- migration, rather than as a separate follow-up.
-- ---------------------------------------------------------------------
create or replace function public.set_current_speaker_candidate(p_round_id uuid, p_request_id uuid, p_seat_number smallint)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.speaker_requests
  set is_current_candidate = false, reserved_seat_number = null
  where selection_round_id = p_round_id
    and reserved_seat_number = p_seat_number
    and is_current_candidate;

  update public.speaker_requests
  set is_current_candidate = true, reserved_seat_number = p_seat_number
  where id = p_request_id and selection_round_id = p_round_id and not selection_failed;
end;
$$;

drop function if exists public.set_current_speaker_candidate(uuid, uuid);

grant execute on function public.set_current_speaker_candidate(uuid, uuid, smallint) to service_role;
revoke execute on function public.set_current_speaker_candidate(uuid, uuid, smallint) from public;

-- ---------------------------------------------------------------------
-- withdraw_speaker_request / withdraw_speaker_request_as_guest: the
-- next-candidate advancement is now scoped to the withdrawing
-- candidate's own reserved seat only -- never picks a request that's
-- already reserved for the *other* seat (is_current_candidate already
-- true), and carries the same reserved_seat_number forward to whichever
-- request advances into it. The round is marked 'exhausted' only once
-- *no* seat has a live reservation left in it -- if the other seat's own
-- candidate is still actively reserved, the round must stay 'active' so
-- freeze_speaker_candidates keeps returning it (and that other
-- reservation) instead of spinning up a second, colliding round.
-- ---------------------------------------------------------------------
create or replace function public.withdraw_speaker_request(p_event_id uuid)
returns public.speaker_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.speaker_requests;
  v_next_id uuid;
begin
  if auth.uid() is null then
    raise exception 'withdraw_speaker_request requires an authenticated caller';
  end if;

  update public.speaker_requests
  set status = 'withdrawn', resolved_at = now()
  where event_id = p_event_id
    and profile_id = auth.uid()
    and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no pending request found for this caller in event %', p_event_id;
  end if;

  if v_row.is_current_candidate and v_row.selection_round_id is not null then
    update public.speaker_requests
    set is_current_candidate = false, selection_failed = true, reserved_seat_number = null
    where id = v_row.id;

    select id into v_next_id
    from public.speaker_requests
    where selection_round_id = v_row.selection_round_id
      and status = 'pending'
      and not selection_failed
      and not is_current_candidate
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
      update public.speaker_selection_rounds set status = 'exhausted', resolved_at = now()
      where id = v_row.selection_round_id and status = 'active';
    end if;
  end if;

  return v_row;
end;
$$;

grant execute on function public.withdraw_speaker_request(uuid) to authenticated;
revoke execute on function public.withdraw_speaker_request(uuid) from public;

create or replace function public.withdraw_speaker_request_as_guest(p_event_id uuid, p_guest_id uuid)
returns public.speaker_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.speaker_requests;
  v_next_id uuid;
begin
  update public.speaker_requests
  set status = 'withdrawn', resolved_at = now()
  where event_id = p_event_id
    and guest_id = p_guest_id
    and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no pending request found for this guest in event %', p_event_id;
  end if;

  if v_row.is_current_candidate and v_row.selection_round_id is not null then
    update public.speaker_requests
    set is_current_candidate = false, selection_failed = true, reserved_seat_number = null
    where id = v_row.id;

    select id into v_next_id
    from public.speaker_requests
    where selection_round_id = v_row.selection_round_id
      and status = 'pending'
      and not selection_failed
      and not is_current_candidate
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
      update public.speaker_selection_rounds set status = 'exhausted', resolved_at = now()
      where id = v_row.selection_round_id and status = 'active';
    end if;
  end if;

  return v_row;
end;
$$;

grant execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) to service_role;
revoke execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- reset_speaker_candidate_pool: the bulk "everyone else expires" wipe
-- (Section E, unchanged product intent for the ordinary single-seat-
-- opens case) now defers itself when another request is still actively
-- reserved (is_current_candidate, pending) for a *different* seat --
-- that's the exact two-seats-open-simultaneously case, and wiping it
-- here would destroy the second seat's own legitimate candidate before
-- they ever got to claim. The full reset (resolve the round, expire the
-- remaining pool, clear votes) runs once the *last* live reservation's
-- own claim completes and calls this again, finding no other
-- reservation left.
-- ---------------------------------------------------------------------
create or replace function public.reset_speaker_candidate_pool(p_event_id uuid, p_winning_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_other_reservation_exists boolean;
begin
  select exists (
    select 1 from public.speaker_requests
    where event_id = p_event_id
      and status = 'pending'
      and is_current_candidate
      and id != p_winning_request_id
  ) into v_other_reservation_exists;

  if v_other_reservation_exists then
    return;
  end if;

  update public.speaker_selection_rounds
  set status = 'resolved', resolved_at = now()
  where event_id = p_event_id and status = 'active';

  update public.speaker_requests
  set status = 'expired', resolved_at = now(), is_current_candidate = false, reserved_seat_number = null
  where event_id = p_event_id
    and status = 'pending'
    and id != p_winning_request_id;

  delete from public.speaker_request_votes where event_id = p_event_id;
end;
$$;

grant execute on function public.reset_speaker_candidate_pool(uuid, uuid) to service_role;
revoke execute on function public.reset_speaker_candidate_pool(uuid, uuid) from public;
