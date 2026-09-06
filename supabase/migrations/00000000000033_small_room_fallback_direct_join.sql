-- Issue #21, fifth corrective pass, Sections 8-15: the small-room
-- fallback. Once a stage is established, an empty seat is normally
-- controlled entirely by Request-to-Speak selection (migration
-- 00000000000029) -- but if BOTH seats are empty AND there are zero
-- eligible pending requests, the conversation would otherwise die
-- permanently with nobody able to get back on stage. This adds one
-- narrow, authoritative exception: a direct claim is permitted again in
-- that specific state, for anyone except the speaker(s) who were just
-- removed (closing the "lose a vote, instantly tap back on" loophole).
--
-- Authoritative exclusion lifecycle, not a timer: `ensure_stage_round`
-- already observes every occupancy transition. The moment it sees BOTH
-- seats go from occupied-or-partially-occupied to genuinely empty, it
-- stamps the identities of whoever was just seated (read from
-- event_speakers' own left_at history -- no caller needs to tell it who
-- left) into two new stage_rounds columns. The moment it sees a fresh
-- two-seat pairing become active again (fallback or ordinary selection,
-- either way), it clears them. No multi-minute timer, no separate ban
-- table -- the lifecycle event itself is the boundary, per explicit
-- instruction.

alter table public.stage_rounds
  add column fallback_excluded_profile_ids uuid[] not null default '{}',
  add column fallback_excluded_guest_ids uuid[] not null default '{}';

-- ---------------------------------------------------------------------
-- ensure_stage_round: unchanged signature/return type (CREATE OR
-- REPLACE is safe here, no new-overload risk), extended with the
-- fallback-exclusion stamp/clear. Stamping only happens the *first* time
-- occupancy is observed at zero since the last clear (guarded by the
-- columns still being empty) -- never re-stamped on every subsequent
-- idle poll while the room stays empty, and never stamps on the
-- brand-new-event cold start (occupied_count = 0 with no prior occupant
-- history at all just yields empty arrays, which is harmless: nobody to
-- exclude, and isStageEstablished is false anyway so the fallback check
-- never even applies to a stage that's never been established).
-- ---------------------------------------------------------------------
create or replace function public.ensure_stage_round(p_event_id uuid)
returns public.stage_rounds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_occupied_count integer;
  v_closing_count integer;
  v_round public.stage_rounds;
  v_now timestamptz := now();
  v_excluded_profile_ids uuid[];
  v_excluded_guest_ids uuid[];
begin
  select * into v_round from public.stage_rounds where event_id = p_event_id for update;

  if v_round.id is null then
    insert into public.stage_rounds (event_id, round_number, started_at, ends_at, phase)
    values (p_event_id, 0, v_now, v_now, 'awaiting_pairing')
    on conflict (event_id) do nothing
    returning * into v_round;

    if v_round.id is null then
      -- Lost the race to create the placeholder -- the winner's row now
      -- exists (and, per the reasoning above, its transaction has since
      -- committed, since the INSERT above only unblocks once that
      -- happens). Re-read it under lock.
      select * into v_round from public.stage_rounds where event_id = p_event_id for update;
    end if;
  end if;

  select count(*), count(*) filter (where round_phase = 'closing')
  into v_occupied_count, v_closing_count
  from public.event_speakers
  where event_id = p_event_id and left_at is null;

  if v_occupied_count = 2 and v_closing_count = 0 then
    if v_round.phase = 'awaiting_pairing' or v_round.ends_at <= v_now then
      update public.stage_rounds
      set round_number = v_round.round_number + 1,
          started_at = v_now,
          ends_at = v_now + interval '60 seconds',
          phase = 'active',
          updated_at = v_now,
          -- A fresh two-speaker pairing is now established -- whether it
          -- got here via the fallback or ordinary selection, the
          -- recovery cycle that opened it is over. Clear the exclusion
          -- for whatever the *next* both-empty episode turns out to be.
          fallback_excluded_profile_ids = '{}',
          fallback_excluded_guest_ids = '{}'
      where id = v_round.id
      returning * into v_round;
    end if;

    update public.event_speakers
    set round_number = v_round.round_number,
        round_started_at = v_round.started_at,
        round_ends_at = v_round.ends_at
    where event_id = p_event_id and left_at is null and round_phase = 'active';
  else
    if v_round.phase = 'active' then
      update public.stage_rounds
      set phase = 'awaiting_pairing', updated_at = v_now
      where id = v_round.id
      returning * into v_round;
    end if;

    if v_occupied_count = 0
      and cardinality(v_round.fallback_excluded_profile_ids) = 0
      and cardinality(v_round.fallback_excluded_guest_ids) = 0
    then
      select
        coalesce(array_agg(profile_id) filter (where profile_id is not null), '{}'),
        coalesce(array_agg(guest_id) filter (where guest_id is not null), '{}')
      into v_excluded_profile_ids, v_excluded_guest_ids
      from (
        select profile_id, guest_id
        from public.event_speakers
        where event_id = p_event_id and left_at is not null
        order by left_at desc
        limit 2
      ) recently_left;

      update public.stage_rounds
      set fallback_excluded_profile_ids = v_excluded_profile_ids,
          fallback_excluded_guest_ids = v_excluded_guest_ids
      where id = v_round.id
      returning * into v_round;
    end if;
  end if;

  return v_round;
end;
$$;

grant execute on function public.ensure_stage_round(uuid) to service_role;
revoke execute on function public.ensure_stage_round(uuid) from public;

-- ---------------------------------------------------------------------
-- claim_speaker_seat: seat-aware authorization check (a candidate's own
-- reservation is now scoped to a specific seat -- see migration
-- 00000000000032 -- so this must match that same seat, not just "any
-- current candidate for this event"), plus the fallback branch below it.
-- Unchanged signature -- CREATE OR REPLACE is safe, no new-overload risk.
-- ---------------------------------------------------------------------
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
        -- Issue #21, fifth corrective pass, Sections 8-15: the
        -- small-room fallback. Only reachable when there is genuinely
        -- nothing to select from -- the moment even one eligible
        -- request exists, this branch is skipped entirely and the
        -- exception below is raised exactly as before, so
        -- Request-to-Speak always regains priority the instant there's
        -- real demand (Section 14).
        select count(*) into v_occupied_count
        from public.event_speakers
        where event_id = p_event_id and left_at is null;

        select exists(
          select 1 from public.speaker_requests where event_id = p_event_id and status = 'pending'
        ) into v_requests_exist;

        if v_occupied_count = 0 and not v_requests_exist then
          select fallback_excluded_profile_ids, fallback_excluded_guest_ids
          into v_excluded_profile_ids, v_excluded_guest_ids
          from public.stage_rounds
          where event_id = p_event_id;

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
