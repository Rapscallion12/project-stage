-- Issue #21, twelfth corrective pass: a clean real-device capture (two
-- occupied seats, one voluntarily vacated, two fresh eligible RTS
-- candidates, simulator still running, a 591ms authoritative read
-- agreeing with the client that no reservation existed) traced to a
-- genuine, previously-undiagnosed root cause — found by reading the
-- real linked database directly, not guessed:
--
-- The permanent test room (00000000-0000-0000-0000-000000000001) had a
-- `speaker_selection_rounds` row frozen on 2026-08-29, still
-- `status = 'active'` two days later, with zero `speaker_requests` rows
-- still referencing it (every candidate that was ever part of it had
-- long since been claimed, withdrawn, or expired by completely
-- unrelated later activity). `freeze_speaker_candidates`'s own
-- idempotency check — "if an active round already exists for this
-- event, reuse it, never create a second one" (migration 00000000000020,
-- deliberately built so a rapid double-call from two concurrent clients
-- can't spin up colliding rounds) — has no corresponding check for
-- whether that existing round is actually still *alive*. It reused this
-- two-day-old, completely dead round indefinitely, on every single call,
-- silently preventing this event from ever freezing a fresh round from
-- its own current live pending pool — regardless of how many new
-- Request-to-Speak submissions arrived, how many votes they got, or how
-- many seats opened up. Every vacancy path in this codebase already
-- funnels through this one function (directly, via
-- `ensureActiveSelectionRound`, or via `simulateAdvanceSelection`), so
-- this single gap could silently defeat selection reconciliation
-- regardless of *which* vacancy-creating action ran — a deeper,
-- more general version of the bug than any one specific trigger path
-- (round boundary, voluntary leave, simulator Open Seat, etc.) could
-- explain on its own.
--
-- Why this round was never resolved by any existing mechanism: the two
-- functions that ever transition a round out of 'active'
-- (`reset_speaker_candidate_pool`, called only after a normal
-- claim → grant flow completes; and the exhaustion check inside
-- `withdraw_speaker_request(_as_guest)`/`release_failed_speaker_claim`,
-- migrations 00000000000038/00000000000039, which only fire when a
-- *specific* request tied to that round is withdrawn or fails its
-- claim) both depend on some later, specific event happening to that
-- exact round. A room whose *next* activity happens to use the
-- bypass-authorization seed path (`claim_speaker_seat` with
-- `p_bypass_selection_authorization = true` — the Session Simulator's
-- own initial-pairing/re-seed mechanism, which never calls
-- `reset_speaker_candidate_pool` at all) can go arbitrarily long,
-- across arbitrarily many completely unrelated future sessions, without
-- either mechanism ever running — exactly what happened here.
--
-- Fix: `freeze_speaker_candidates` now verifies liveness before
-- deciding to reuse an existing "active" round — does it have a live
-- reservation (`is_current_candidate`), or at least one remaining
-- viable (`status = 'pending' and not selection_failed`) candidate of
-- its own? If neither, it is genuinely dead regardless of its own
-- `status` column — mark it `exhausted` right here, and fall through to
-- the existing "create a fresh round from the current live pool" logic
-- below, rather than returning early with nothing. Race-safe: two
-- concurrent callers both finding the same dead round and both marking
-- it exhausted is a harmless double no-op (`where status = 'active'`
-- matches at most once); the fresh-round creation path immediately
-- below this already has its own `unique_violation` handling for two
-- callers racing to create the *replacement* round. This is a pure
-- `create or replace` — the function's return signature is unchanged
-- from migration 00000000000032, so no drop-first is needed this time.
create or replace function public.freeze_speaker_candidates(p_event_id uuid)
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
  v_existing_round_alive boolean;
begin
  select id into v_existing_round_id
  from public.speaker_selection_rounds
  where event_id = p_event_id and status = 'active';

  if v_existing_round_id is not null then
    select
      exists (
        select 1 from public.speaker_requests
        where selection_round_id = v_existing_round_id and is_current_candidate
      )
      or exists (
        select 1 from public.speaker_requests
        where selection_round_id = v_existing_round_id and status = 'pending' and not selection_failed
      )
    into v_existing_round_alive;

    if v_existing_round_alive then
      return query
        select sr.selection_round_id, sr.id, sr.profile_id, sr.guest_id, sr.message_id,
               sr.frozen_rank, sr.frozen_vote_count, sr.is_current_candidate, sr.reserved_seat_number
        from public.speaker_requests sr
        where sr.selection_round_id = v_existing_round_id
        order by sr.frozen_rank;
      return;
    end if;

    update public.speaker_selection_rounds set status = 'exhausted', resolved_at = now()
    where id = v_existing_round_id and status = 'active';
    -- Falls through below to create a genuinely fresh round from the
    -- event's current live pending pool.
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
