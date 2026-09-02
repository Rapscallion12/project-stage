-- Issue #21, nineteenth corrective pass: a real-device/real-simulator
-- finding traced to a genuine, production-reachable stale-reservation
-- bug (not a simulator-only artifact — reproduced against the real
-- linked database using only real RPCs, no bypass, no simulator
-- helpers; see stage-round-invariant.test.ts's own new "reservation
-- lifecycle" coverage and DECISIONS.md for the full investigation).
--
-- Root cause: `is_current_candidate = true` is meant, by every reader in
-- this schema, to mean "this reservation is still live and blocking" --
-- `reserve_speaker_candidates_for_seats`'s own "already has a live
-- reservation for this seat, never re-decided" check (migration
-- 00000000000036/37) trusts it unconditionally, with no cross-check
-- against the request's own `status`. But a winning candidate's row
-- could keep `is_current_candidate = true` indefinitely: the primary
-- fix (this same pass, `speaker-requests.ts`'s `markSpeakerRequestGranted`)
-- now clears it the instant a claim is granted -- this migration is the
-- paired defense-in-depth guard, not a second, independent fix for a
-- second bug. Even if some future write path ever again leaves
-- `is_current_candidate` stale on a non-pending row (granted, withdrawn,
-- or expired), this check must not be fooled by it -- a reservation that
-- isn't `status = 'pending'` can never be "the live claim responsible
-- for" anything, definitionally, regardless of what its own
-- `is_current_candidate` flag happens to say.
--
-- Verified safe to add unconditionally: every place `is_current_candidate`
-- is ever set `true` (`reserve_speaker_candidates_for_seats` itself,
-- `set_current_speaker_candidate`, the withdrawal/release-failed-claim
-- advancement branches) only ever does so on a request whose `status`
-- is still `'pending'` at that exact moment -- `status` only ever
-- changes to `granted`/`withdrawn`/`expired` via a separate, later,
-- explicit transition. So a genuinely live reservation always has
-- `status = 'pending'` for the entire time it's live; this guard can
-- never reject one.
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
      where sr.selection_round_id = v_round_id
        and sr.reserved_seat_number = v_seat_number
        and sr.is_current_candidate
        and sr.status = 'pending'
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
