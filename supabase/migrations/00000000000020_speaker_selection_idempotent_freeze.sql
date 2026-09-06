-- Issue #21, Phase 1 follow-up: freeze_speaker_candidates needs to be
-- safe to call on *every* eligibility poll (the same "every evaluation
-- independently recomputes and re-verifies" idempotent, safe-no-op
-- discipline #13's disconnect cleanup and #23's promotion already rely
-- on), not just once per seat-opening. As originally written, a second
-- call while a round is already active would violate
-- speaker_selection_rounds_active_uniq and throw. Now: if an active
-- round already exists for the event, return its existing candidates
-- (with whatever's already been selected, via a new `is_current`
-- output column) instead of erroring — and if a genuine race loses the
-- INSERT despite that check (two near-simultaneous first calls), catch
-- the unique-violation and fall back to reading the round the other
-- caller just created, rather than surfacing an error to the poll that
-- lost the race.
-- The return column list is changing (new `is_current` column) —
-- CREATE OR REPLACE can't change a function's return type, same
-- drop-first pattern migration 00000000000012 established for
-- claim_speaker_seat/rank_pending_speaker_requests.
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
  is_current boolean
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
             sr.frozen_rank, sr.frozen_vote_count, sr.is_current_candidate
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
             sr.frozen_rank, sr.frozen_vote_count, sr.is_current_candidate
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
           sr.is_current_candidate
    from public.speaker_requests sr
    where sr.selection_round_id = v_round_id
    order by sr.frozen_rank;
end;
$$;

grant execute on function public.freeze_speaker_candidates(uuid) to service_role;
revoke execute on function public.freeze_speaker_candidates(uuid) from public;
