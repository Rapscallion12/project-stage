-- Issue #21, fifth corrective pass, Section 4: "candidate reservation
-- must be authoritative... use an atomic/transactional/locking approach
-- appropriate to the existing database architecture... do not solve
-- this only through client state." `ensureActiveSelectionRound`
-- (room/actions.ts) decides, in TypeScript, which unreserved candidate
-- goes to which open seat, then makes one `set_current_speaker_candidate`
-- RPC call per seat -- each call is its own transaction. Two genuinely
-- concurrent callers (e.g. two different connected clients' own
-- reconciliation polls landing at the same moment) could both read the
-- *same* "candidates" snapshot before either had committed a
-- reservation, and independently decide the same top-ranked candidate
-- for two different seats -- the per-(round, seat) unique index
-- (migration 00000000000032) stops two candidates colliding on the
-- *same* seat, but nothing stopped the *same* candidate being reserved
-- for seat 1 by one caller and seat 2 by another, moments apart, each
-- overwriting the other's `reserved_seat_number`.
--
-- Fix: the whole "for every open seat, reserve the highest-ranked still-
-- unreserved candidate" decision now happens inside one function call,
-- one transaction, with the frozen round's own candidate rows locked
-- (`for update`) for its duration. A second concurrent call blocks on
-- that lock until the first commits, then re-reads the now-current
-- reservation state under its own lock and correctly skips whatever the
-- first call already reserved -- there is no window where two
-- concurrent callers can each decide from a stale snapshot.
create function public.reserve_speaker_candidates_for_seats(p_event_id uuid, p_seat_numbers smallint[])
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

  -- Locks every row in this round for the duration of this transaction —
  -- the actual race-safety mechanism this migration exists for. A
  -- second concurrent call to this function for the same round blocks
  -- here until the first commits.
  perform 1 from public.speaker_requests where selection_round_id = v_round_id for update;

  foreach v_seat_number in array p_seat_numbers loop
    -- Already has a live reservation (from an earlier call, or an
    -- earlier iteration of this same array) — never re-decided.
    if exists (
      select 1 from public.speaker_requests
      where selection_round_id = v_round_id and reserved_seat_number = v_seat_number and is_current_candidate
    ) then
      continue;
    end if;

    select id into v_winner_id
    from public.speaker_requests
    where selection_round_id = v_round_id
      and status = 'pending'
      and not selection_failed
      and not is_current_candidate
    order by frozen_rank
    limit 1;

    if v_winner_id is not null then
      update public.speaker_requests
      set is_current_candidate = true, reserved_seat_number = v_seat_number
      where id = v_winner_id;
    end if;
  end loop;

  return query
    select v_round_id, sr.id, sr.profile_id, sr.guest_id, sr.message_id, sr.frozen_rank, sr.frozen_vote_count, sr.reserved_seat_number
    from public.speaker_requests sr
    where sr.selection_round_id = v_round_id
    order by sr.frozen_rank;
end;
$$;

grant execute on function public.reserve_speaker_candidates_for_seats(uuid, smallint[]) to service_role;
revoke execute on function public.reserve_speaker_candidates_for_seats(uuid, smallint[]) from public;
