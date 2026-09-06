-- Issue #21, fifth corrective pass, second corrective follow-up within
-- the same pass: real-database testing (two-seat-selection-fallback.test.ts,
-- Section 18 item G) caught a lingering-recovery-flag bug. Once a
-- small-room recovery episode opens (both seats empty, exclusion
-- stamped), the exclusion arrays only get cleared by `ensure_stage_round`
-- when occupancy reaches 2 -- but if the *single* fallback-recovered
-- occupant later leaves again without the pairing ever completing, and
-- someone else is then seated through an entirely unrelated path (a
-- fresh direct-formation/simulator bypass claim, not a continuation of
-- that same recovery), the stale exclusion arrays incorrectly kept
-- treating the *new*, unrelated occupancy as still "recovery in
-- progress" -- reopening the fallback for the second seat in what should
-- be an ordinary Case A steady state (Section 9: "one seat occupied +
-- zero requests -> do NOT reopen the fallback").
--
-- Fix: a bypass claim (`p_bypass_selection_authorization = true`) is, by
-- definition, never itself part of an unresolved small-room recovery --
-- it's the initial-stage-formation / simulator-seeding path, which
-- represents "this occupancy is authoritatively established," not "one
-- half of an in-progress fallback recovery." A successful bypass claim
-- now clears the fallback-exclusion arrays the same way a completed
-- pairing does, so any *subsequent* empty-seat claim is judged against a
-- clean slate rather than a stale episode that has nothing to do with
-- it. This does not change who a bypass claim itself is available to
-- (still preview-only tooling / initial formation, migration
-- 00000000000029's guard on that flag is unchanged) -- it only clears
-- bookkeeping for the fallback's own unrelated exclusion tracking.
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

  if p_bypass_selection_authorization then
    -- See this migration's own doc comment: a bypass claim is never
    -- itself part of an unresolved fallback recovery.
    update public.stage_rounds
    set fallback_excluded_profile_ids = '{}', fallback_excluded_guest_ids = '{}'
    where event_id = p_event_id;
  end if;

  perform public.ensure_stage_round(p_event_id);

  return v_row;
end;
$$;

grant execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) to service_role;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from public;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from anon;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from authenticated;
