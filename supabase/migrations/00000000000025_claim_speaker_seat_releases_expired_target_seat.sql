-- Issue #21 corrective pass, follow-up: migration 00000000000024 made
-- claim_speaker_seat refuse to steal an already-occupied seat (fixing the
-- real seat-stealing race), but its new guard checked raw `left_at is
-- null` on the *target seat*, not `is_speaker_seat_active` (migration
-- 00000000000018) -- unlike release_if_expired, which already makes this
-- exact distinction for the *caller's own* identity. The gap: a seat
-- whose occupant disconnected past the 11s grace period, but hasn't been
-- physically released yet by any other trigger
-- (release_expired_inactive_speaker only runs when some connected
-- client's own timer asks the server to check), would now block every
-- other claimant forever -- a real regression migration 24's own test
-- suite caught (event-speakers-expiration.test.ts's "expired seat is
-- treated as available to another claimant" -- previously true only as
-- a side effect of the unconditional "replace whoever's there" migration
-- 24 deliberately removed).
--
-- Fix: release the *target seat's* current occupant first, using the
-- exact same is_speaker_seat_active/expiration-reason logic
-- release_if_expired already applies to the caller's own identity --
-- then the "already occupied" guard only ever blocks a genuinely active
-- occupant, never a logically-expired one nobody has cleaned up yet.
create or replace function public.claim_speaker_seat(
  p_event_id uuid,
  p_seat_number smallint,
  p_profile_id uuid default null,
  p_guest_id uuid default null,
  p_guest_display_name text default null
)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
  v_display_name text;
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
