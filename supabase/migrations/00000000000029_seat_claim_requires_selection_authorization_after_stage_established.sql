-- Issue #21, third corrective pass: real-device testing found that after
-- a speaker was removed, tapping the newly-open seat let the tapper
-- become the next speaker directly -- bypassing Request-to-Speak
-- selection entirely. joinOpenSeat (room/actions.ts) was designed for
-- INITIAL stage formation (before the event's first two speakers are
-- both seated, anyone tapping an empty seat may join directly, same as
-- always) but nothing distinguished that from ONGOING replacement, where
-- an empty seat is controlled by the selection system, not first-tap.
--
-- Authoritative "has this stage ever been established" signal: reused,
-- not invented -- stage_rounds.round_number only ever reaches 1 (and
-- never goes back down) once ensure_stage_round has seen both seats
-- occupied *simultaneously* at least once (see migration
-- 00000000000027's placeholder-starts-at-0 fix). That is exactly "the
-- initial two-speaker pairing has been established," permanently, for
-- the rest of the event -- no new column needed.
--
-- claim_speaker_seat now rejects a direct claim once that's true, unless
-- the claiming identity is the event's currently authorized
-- Request-to-Speak candidate (speaker_requests.is_current_candidate, in
-- an active selection round) -- re-verified here, at the source of
-- truth, not merely trusted from whichever Server Action called in.
-- Every legitimate caller already satisfies this without any change on
-- its part: claimOpenSeat only ever calls this after resolveClaimDecision
-- has already confirmed the same fact (redundant, deliberate defense in
-- depth); simulateAdvanceSelection claims for a real frozen winner (same
-- reasoning); joinOpenSeat and a genuinely early claim during initial
-- formation aren't affected until round_number reaches 1.
--
-- One narrow, explicit bypass: the Session Simulator's own manual
-- re-seed action (`simulateSeedSpeaker`) is preview-only tooling whose
-- entire purpose is bootstrapping/resetting test state on demand, same
-- tier as this file's other isolated, documented adapters
-- (forceStageRoundDeadline, etc.) -- it never reaches a real user, and
-- migration 00000000000024's "seat already occupied" guard still applies
-- to it unconditionally regardless of this flag.
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

  -- Release the target seat's own occupant if it's only *logically*
  -- still active -- same grace-period predicate release_if_expired
  -- already applies above, just aimed at the seat instead of the caller.
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

  -- The fix from migration 24, unchanged: a seat that's still genuinely
  -- occupied is never silently replaced -- the caller must have lost a
  -- real race, and gets a real exception (every existing caller already
  -- treats this as "someone else got there first, not fatal").
  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id and seat_number = p_seat_number and left_at is null
  ) then
    raise exception 'seat % in event % is already occupied', p_seat_number, p_event_id;
  end if;

  -- The fix from this migration: once the stage has ever been
  -- established, an arbitrary direct claim is rejected -- only the
  -- currently authorized Request-to-Speak candidate (or a caller who
  -- explicitly bypasses, preview-only tooling) may claim the seat.
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
          and sr.status = 'pending'
          and ssr.status = 'active'
          and coalesce(sr.profile_id, sr.guest_id) = coalesce(p_profile_id, p_guest_id)
      ) into v_is_authorized_candidate;

      if not v_is_authorized_candidate then
        raise exception 'seat claims after initial stage formation require Request-to-Speak selection authorization';
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
