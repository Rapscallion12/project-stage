-- Issue #21, fifth corrective pass, corrective follow-up within the same
-- pass: migration 00000000000033's fallback condition required BOTH
-- seats to be empty (`v_occupied_count = 0`) at the moment of every
-- claim -- but Section 14's own explicit requirement is that once the
-- fallback has legitimately opened and one seat has been claimed
-- through it, the fallback must continue to cover the *second* seat too
-- (as long as it's still empty and nobody has submitted a real request
-- yet) -- "do not kick them back out... for the remaining seat, prefer
-- Request-to-Speak once real demand exists." A real-database test
-- (two-seat-selection-fallback.test.ts, Section 18 item E) caught this
-- directly: a second fallback claim for the still-empty seat was
-- incorrectly rejected once the first seat's fallback claim raised
-- occupancy from 0 to 1.
--
-- The fix distinguishes the two cases that both present as "one seat
-- occupied, one empty, zero requests":
-- - An ordinary established-stage steady state (Section 9 Case A) --
--   one seat has a *legitimately paired* occupant and the other simply
--   hasn't been refilled yet. Fallback must NOT apply here.
-- - The second half of an in-progress small-room recovery (Section 18
--   item E) -- both seats went empty together, the recovery opened, and
--   one seat has since been filled (via fallback or an organic
--   Request-to-Speak claim -- either way, the *episode* isn't over).
--   Fallback SHOULD still apply to the remaining seat.
--
-- These are told apart using the exact signal already being tracked for
-- a different reason: `stage_rounds.fallback_excluded_*` is only ever
-- non-empty while a both-empty recovery episode is unresolved -- stamped
-- the moment occupancy hits zero, cleared only once a fresh two-speaker
-- pairing is actually established (migration 00000000000033's
-- `ensure_stage_round` extension). A Case A steady state never triggered
-- that stamp (occupancy never dropped to zero for the current pairing),
-- so its exclusion arrays stay empty -- correctly keeping fallback closed
-- there, while the in-progress recovery case has non-empty arrays and
-- correctly stays open for its second seat.
create or replace function public.claim_speaker_seat(
  p_event_id uuid,
  p_seat_number smallint,
  p_profile_id uuid default null,
  p_guest_id uuid default null,
  p_guest_display_name text default null,
  p_bypass_selection_authorization boolean default false
)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
  v_display_name text;
  v_stage_established boolean;
  v_is_authorized_candidate boolean;
  v_occupied_count integer;
  v_requests_exist boolean;
  v_excluded_profile_ids uuid[];
  v_excluded_guest_ids uuid[];
  v_recovery_in_progress boolean;
begin
  if (p_profile_id is not null) = (p_guest_id is not null) then
    raise exception 'claim_speaker_seat requires exactly one of p_profile_id/p_guest_id';
  end if;

  perform public.release_if_expired(p_event_id, p_profile_id, p_guest_id);

  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id
      and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
      and left_at is null
  ) then
    raise exception 'identity % already holds an active seat in event %', coalesce(p_profile_id, p_guest_id), p_event_id;
  end if;

  update public.event_speakers
  set left_at = now(),
      left_reason = case
        when disconnected_at is not null and disconnected_at <= now() - interval '11 seconds' then 'disconnected'
        else 'inactive'
      end
  where event_id = p_event_id
    and seat_number = p_seat_number
    and left_at is null
    and not public.is_speaker_seat_active(left_at, disconnected_at, media_inactive_since);

  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id and seat_number = p_seat_number and left_at is null
  ) then
    raise exception 'seat % in event % is already occupied', p_seat_number, p_event_id;
  end if;

  if not p_bypass_selection_authorization then
    select exists(
      select 1 from public.stage_rounds where event_id = p_event_id and round_number >= 1
    ) into v_stage_established;

    if v_stage_established then
      select exists(
        select 1
        from public.speaker_requests sr
        join public.speaker_selection_rounds ssr on ssr.id = sr.selection_round_id
        where sr.event_id = p_event_id
          and sr.is_current_candidate
          and sr.reserved_seat_number = p_seat_number
          and sr.status = 'pending'
          and ssr.status = 'active'
          and coalesce(sr.profile_id, sr.guest_id) = coalesce(p_profile_id, p_guest_id)
      ) into v_is_authorized_candidate;

      if not v_is_authorized_candidate then
        select count(*) into v_occupied_count
        from public.event_speakers
        where event_id = p_event_id and left_at is null;

        select exists(
          select 1 from public.speaker_requests where event_id = p_event_id and status = 'pending'
        ) into v_requests_exist;

        select fallback_excluded_profile_ids, fallback_excluded_guest_ids
        into v_excluded_profile_ids, v_excluded_guest_ids
        from public.stage_rounds
        where event_id = p_event_id;

        -- See this migration's own doc comment: an in-progress recovery
        -- episode (both seats went empty together and a fresh pairing
        -- hasn't been established since) keeps the fallback open for
        -- whichever seat is still empty, even after the first has been
        -- filled -- an ordinary Case A steady state (exclusion arrays
        -- empty, since occupancy never hit zero for the current pairing)
        -- does not.
        v_recovery_in_progress := cardinality(coalesce(v_excluded_profile_ids, '{}')) > 0
          or cardinality(coalesce(v_excluded_guest_ids, '{}')) > 0;

        if v_occupied_count < 2 and not v_requests_exist and (v_occupied_count = 0 or v_recovery_in_progress) then
          if (p_profile_id is not null and p_profile_id = any(coalesce(v_excluded_profile_ids, '{}')))
            or (p_guest_id is not null and p_guest_id = any(coalesce(v_excluded_guest_ids, '{}')))
          then
            raise exception 'recently removed speakers cannot immediately reclaim a fallback-open seat';
          end if;
          -- Fallback permitted -- fall through to the claim below.
        else
          raise exception 'seat claims after initial stage formation require Request-to-Speak selection authorization';
        end if;
      end if;
    end if;
  end if;

  if p_profile_id is not null then
    select display_name into v_display_name from public.profiles where id = p_profile_id;
    if v_display_name is null then
      raise exception 'profile % does not exist', p_profile_id;
    end if;
  else
    if p_guest_display_name is null or length(btrim(p_guest_display_name)) = 0 then
      raise exception 'claim_speaker_seat requires p_guest_display_name for a guest identity';
    end if;
    v_display_name := p_guest_display_name;
  end if;

  insert into public.event_speakers (event_id, profile_id, guest_id, seat_number, display_name)
  values (p_event_id, p_profile_id, p_guest_id, p_seat_number, v_display_name)
  returning * into v_row;

  perform public.ensure_stage_round(p_event_id);

  return v_row;
end;
$$;

grant execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) to service_role;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from public;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from anon;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from authenticated;
