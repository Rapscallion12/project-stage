-- Corrective: migration 00000000000036's `reserve_speaker_candidates_for_seats`
-- has a RETURNS TABLE column named `reserved_seat_number`, which
-- PL/pgSQL implicitly exposes as an OUT-parameter-like variable in
-- scope for the whole function body -- every unqualified reference to
-- `reserved_seat_number` inside the function (the `exists(...)` check
-- and the final `update ... set reserved_seat_number = v_seat_number`)
-- became ambiguous against that variable, caught immediately by the
-- real-database test suite ("column reference is ambiguous"). Fully
-- qualifies every such reference to `public.speaker_requests` explicitly.
create or replace function public.reserve_speaker_candidates_for_seats(p_event_id uuid, p_seat_numbers smallint[])
returns table (
  round_id uuid,
  request_id uuid,
  profile_id uuid,
  guest_id uuid,
  message_id uuid,
  rank smallint,
  vote_count integer,
  reserved_seat_number smallint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
  v_seat_number smallint;
  v_winner_id uuid;
begin
  select id into v_round_id
  from public.speaker_selection_rounds
  where event_id = p_event_id and status = 'active';

  if v_round_id is null then
    return;
  end if;

  perform 1 from public.speaker_requests where selection_round_id = v_round_id for update;

  foreach v_seat_number in array p_seat_numbers loop
    if exists (
      select 1 from public.speaker_requests sr
      where sr.selection_round_id = v_round_id and sr.reserved_seat_number = v_seat_number and sr.is_current_candidate
    ) then
      continue;
    end if;

    select sr.id into v_winner_id
    from public.speaker_requests sr
    where sr.selection_round_id = v_round_id
      and sr.status = 'pending'
      and not sr.selection_failed
      and not sr.is_current_candidate
    order by sr.frozen_rank
    limit 1;

    if v_winner_id is not null then
      update public.speaker_requests
      set is_current_candidate = true, reserved_seat_number = v_seat_number
      where public.speaker_requests.id = v_winner_id;
    end if;
  end loop;

  return query
    select sr.selection_round_id, sr.id, sr.profile_id, sr.guest_id, sr.message_id, sr.frozen_rank, sr.frozen_vote_count, sr.reserved_seat_number
    from public.speaker_requests sr
    where sr.selection_round_id = v_round_id
    order by sr.frozen_rank;
end;
$$;

grant execute on function public.reserve_speaker_candidates_for_seats(uuid, smallint[]) to service_role;
revoke execute on function public.reserve_speaker_candidates_for_seats(uuid, smallint[]) from public;
