-- Issue #21, seventeenth corrective pass: a real-device snapshot proved
-- an authoritative, genuinely-invalid transition — the shared round
-- (`stage_rounds.phase`) demoted from 'active' to 'awaiting_pairing'
-- while BOTH seats remained authoritatively occupied by the same two
-- speakers the whole time (canonical client state and authoritative
-- database state agreed perfectly; this was never a client-sync bug).
--
-- Root cause, traced to the actual writer, not assumed: `stage_rounds.phase`
-- is written in exactly one place, `ensure_stage_round`. Since its very
-- first version (migration 00000000000024), the function has required
-- BOTH `v_occupied_count = 2` AND `v_closing_count = 0` before treating
-- the round as active — that second condition (nobody currently in
-- their own individual Final-30 "closing" window) was a deliberate,
-- documented design choice from the shared-round architecture's own
-- introduction ("only when both seats are occupied and neither is in
-- its own closing window... otherwise marks (or leaves) the stage
-- 'awaiting_pairing'"). `resolve_stage_round` (the shared deadline's own
-- resolver) sets a narrow-loss seat's `round_phase` to 'closing' —
-- WITHOUT vacating it (`left_at` stays null, the seat stays fully
-- occupied) — then, in the very same call, invokes `ensure_stage_round`
-- to decide the round's next state. With the other seat having
-- genuinely "continued" (round_phase still 'active', not vacated
-- either), occupied_count is still 2 — but closing_count is now 1, so
-- the ORIGINAL logic fell into its own "else" branch and demoted the
-- entire shared round, hiding the shared timer for BOTH seats even
-- though the pairing itself never broke.
--
-- This directly contradicts this project's own stated shared-round
-- invariant (the very hook a real-device Final-30 finding introduced,
-- resolve_seat_closing's own doc comment: "the other speaker should not
-- be forced into that final-30 state") and the explicit clarification
-- this pass's own investigation confirmed: closing is not "the pairing
-- being incomplete" — the seat is still occupied, still part of the
-- pairing, and simply excluded from the shared round's own *next*
-- Continue/Replace cycle (already correctly handled below, by the
-- `round_phase = 'active'` filter on the event_speakers sync UPDATE,
-- unchanged by this migration) while it separately counts down its own
-- independent 30s window.
--
-- Fix: whether the round should be considered active now depends only
-- on `v_occupied_count = 2` — a seat being 'closing' no longer demotes
-- the shared round, and (since the renewal condition below is
-- unconditional on closing_count too) a shared-round boundary that
-- elapses while one seat is closing still correctly renews the round
-- for the *other*, still-actively-continuing seat, exactly as a normal
-- Continue outcome would. Proven not to be a stale-read/stale-write
-- race (Section 3 of this pass's own investigation): `ensure_stage_round`
-- always re-derives `v_occupied_count`/`v_closing_count` from a fresh,
-- currently-locked read at the top of its own execution (`for update`
-- on the round row serializes concurrent callers) — no caller can ever
-- poison it with a stale precomputed value. This was a pure logic bug,
-- not a race.
--
-- Also adds lightweight, preview/debug-only transition observability
-- (Section 6): a single new nullable column, `last_transition_reason`,
-- written by `ensure_stage_round` itself only on an actual phase/
-- round-number change, encoding the initiating caller, the old/new
-- phase, the round number before/after, and the occupancy/closing
-- counts observed at that exact moment — everything Section 6 asked
-- for (previous phase, next phase, round number, seat occupancy
-- observed, initiating source) in one compact field, reusing the
-- already-existing `updated_at` column for the mutation timestamp
-- rather than adding a second new column. Every caller of
-- `ensure_stage_round` now passes its own literal source tag via a new
-- `p_source` parameter (defaulted to `'unknown'` so this is backward
-- compatible with any caller this migration doesn't touch).
alter table public.stage_rounds
  add column last_transition_reason text;

create or replace function public.ensure_stage_round(p_event_id uuid, p_source text default 'unknown')
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
  v_old_phase text;
  v_old_round_number integer;
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

  v_old_phase := v_round.phase;
  v_old_round_number := v_round.round_number;

  -- Issue #21, seventeenth corrective pass: `v_closing_count` no longer
  -- gates whether the round is treated as active -- see this migration's
  -- own doc comment above for the full trace. Both seats occupied is the
  -- whole of the "is the pairing established" question; a seat being
  -- 'closing' only affects which seats the sync UPDATE below applies to
  -- (unchanged: still `round_phase = 'active'` only).
  if v_occupied_count = 2 then
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
          fallback_excluded_guest_ids = '{}',
          last_transition_reason = format(
            '%s: %s->active (round %s->%s, occupied=%s closing=%s)',
            p_source, coalesce(v_old_phase, 'none'), v_old_round_number, v_old_round_number + 1, v_occupied_count, v_closing_count
          )
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
      set phase = 'awaiting_pairing',
          updated_at = v_now,
          last_transition_reason = format(
            '%s: active->awaiting_pairing (round %s, occupied=%s closing=%s)',
            p_source, v_old_round_number, v_occupied_count, v_closing_count
          )
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

grant execute on function public.ensure_stage_round(uuid, text) to service_role;
revoke execute on function public.ensure_stage_round(uuid, text) from public;

-- The old single-argument signature is gone (CREATE OR REPLACE cannot
-- change a function's parameter list in place) -- drop it explicitly so
-- there isn't a stale, uncallable-from-anywhere overload left behind.
drop function if exists public.ensure_stage_round(uuid);

-- ---------------------------------------------------------------------
-- Every SQL caller now passes its own literal source tag. Bodies are
-- otherwise byte-for-byte identical to each function's own latest
-- prior definition -- only the one `perform public.ensure_stage_round(...)`
-- line changes in each.
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
    -- See migration 00000000000035's own doc comment: a bypass claim is
    -- never itself part of an unresolved fallback recovery.
    update public.stage_rounds
    set fallback_excluded_profile_ids = '{}', fallback_excluded_guest_ids = '{}'
    where event_id = p_event_id;
  end if;

  perform public.ensure_stage_round(p_event_id, 'claim_speaker_seat');

  return v_row;
end;
$$;

grant execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) to service_role;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from public;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from anon;
revoke execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text, boolean) from authenticated;

create or replace function public.end_speaker_seat(
  p_event_id uuid,
  p_reason text,
  p_profile_id uuid default null,
  p_guest_id uuid default null
)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
begin
  if (p_profile_id is not null) = (p_guest_id is not null) then
    raise exception 'end_speaker_seat requires exactly one of p_profile_id/p_guest_id';
  end if;

  if p_reason not in ('moderator_removed', 'event_ended', 'disconnected') then
    raise exception 'end_speaker_seat does not accept left_reason %; voluntary and replaced have their own dedicated functions', p_reason;
  end if;

  update public.event_speakers
  set left_at = now(), left_reason = p_reason
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
  returning * into v_row;

  if v_row.id is not null then
    perform public.ensure_stage_round(p_event_id, 'end_speaker_seat');
  end if;

  return v_row;
end;
$$;

grant execute on function public.end_speaker_seat(uuid, text, uuid, uuid) to service_role;

create or replace function public.leave_speaker_seat(p_event_id uuid)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
begin
  if auth.uid() is null then
    raise exception 'leave_speaker_seat requires an authenticated caller';
  end if;

  update public.event_speakers
  set left_at = now(), left_reason = 'voluntary'
  where event_id = p_event_id
    and profile_id = auth.uid()
    and left_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no active seat found for this caller in this event';
  end if;

  perform public.ensure_stage_round(p_event_id, 'leave_speaker_seat');

  return v_row;
end;
$$;

create or replace function public.leave_speaker_seat_as_guest(p_event_id uuid, p_guest_id uuid)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
begin
  update public.event_speakers
  set left_at = now(), left_reason = 'voluntary'
  where event_id = p_event_id
    and guest_id = p_guest_id
    and left_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no active seat found for this guest in this event';
  end if;

  perform public.ensure_stage_round(p_event_id, 'leave_speaker_seat_as_guest');

  return v_row;
end;
$$;

create or replace function public.resolve_stage_round(p_event_id uuid)
returns table (
  out_event_speakers_id uuid,
  out_outcome text,
  out_profile_id uuid,
  out_guest_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round public.stage_rounds;
  v_seat public.event_speakers;
  v_continue_count integer;
  v_replace_count integer;
  v_total integer;
begin
  select * into v_round from public.stage_rounds where event_id = p_event_id for update;
  if v_round.id is null or v_round.phase != 'active' or now() < v_round.ends_at then
    return;
  end if;

  for v_seat in
    select * from public.event_speakers
    where event_id = p_event_id and left_at is null and round_phase = 'active'
    order by seat_number
  loop
    select count(*) filter (where choice = 'continue'), count(*) filter (where choice = 'replace')
    into v_continue_count, v_replace_count
    from public.speaker_round_votes
    where event_speakers_id = v_seat.id;

    v_total := v_continue_count + v_replace_count;

    if v_total = 0 or v_replace_count * 100 <= 50 * v_total then
      delete from public.speaker_round_votes where event_speakers_id = v_seat.id;
      out_outcome := 'continue';
    elsif v_replace_count * 100 >= 66 * v_total then
      update public.event_speakers set left_at = now(), left_reason = 'replaced' where id = v_seat.id;
      delete from public.speaker_round_votes where event_speakers_id = v_seat.id;
      out_outcome := 'decisive-replace';
    else
      update public.event_speakers
      set round_phase = 'closing', closing_ends_at = now() + interval '30 seconds'
      where id = v_seat.id;
      out_outcome := 'narrow-loss';
    end if;

    out_event_speakers_id := v_seat.id;
    out_profile_id := v_seat.profile_id;
    out_guest_id := v_seat.guest_id;
    return next;
  end loop;

  perform public.ensure_stage_round(p_event_id, 'resolve_stage_round');
end;
$$;

grant execute on function public.resolve_stage_round(uuid) to service_role;
revoke execute on function public.resolve_stage_round(uuid) from public;

create or replace function public.resolve_seat_closing(p_event_speakers_id uuid)
returns table (
  out_event_id uuid,
  out_outcome text,
  out_profile_id uuid,
  out_guest_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
begin
  select * into v_row from public.event_speakers where id = p_event_speakers_id and left_at is null;
  if v_row.id is null or v_row.round_phase != 'closing' or now() < v_row.closing_ends_at then
    return;
  end if;

  update public.event_speakers set left_at = now(), left_reason = 'replaced' where id = p_event_speakers_id;
  delete from public.speaker_round_votes where event_speakers_id = p_event_speakers_id;

  perform public.ensure_stage_round(v_row.event_id, 'resolve_seat_closing');

  out_event_id := v_row.event_id;
  out_outcome := 'replaced-after-closing';
  out_profile_id := v_row.profile_id;
  out_guest_id := v_row.guest_id;
  return next;
end;
$$;

grant execute on function public.resolve_seat_closing(uuid) to service_role;
revoke execute on function public.resolve_seat_closing(uuid) from public;
