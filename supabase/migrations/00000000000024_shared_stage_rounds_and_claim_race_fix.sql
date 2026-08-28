-- Issue #21, corrective pass: real-device testing found two things that
-- had to be fixed together.
--
-- (1) claim_speaker_seat had no optimistic-concurrency check: it always
-- unconditionally ended "whichever row is currently active" for a seat
-- and inserted a new one. Every legitimate caller (a genuinely open
-- seat) never has an active row to begin with -- resolve_speaker_round/
-- end_speaker_seat already end a seat's row (left_at) before it's ever
-- eligible to be claimed again. The only time this unconditional
-- replace ever fired against an ALREADY-active row was exactly the real
-- bug a tester hit: their own real join landed first, then a second
-- claim (the Session Simulator's background promotion poll, racing the
-- same RPC) silently ended their brand-new row and replaced it with a
-- simulated identity -- with no exception, no signal, nothing to catch.
-- Fixed generally, for every caller, not just the simulator: the RPC now
-- raises if an active row already exists, exactly like it already does
-- for "this identity already holds a seat" a few lines above. This also
-- closes the door on ANY future two-caller race for the same seat
-- (two real users, a real user vs. a moderator action, etc.), not only
-- the simulator's.
--
-- (2) The round model moves from independent per-speaker timers to one
-- shared round per stage pairing -- "the two people are participating
-- in one conversation window." Continue/Replace is still voted on and
-- resolved per speaker independently (speaker_round_votes,
-- cast_speaker_round_vote(_as_guest), and event_speakers' own
-- round_phase='closing'/closing_ends_at for an individual narrow-loss
-- speaker's final 30s, are all reused completely unchanged in shape) --
-- only the *deadline* that triggers resolution becomes shared, tracked
-- in a new stage_rounds table (one row per event). event_speakers'
-- existing round_number/round_started_at/round_ends_at columns stay
-- (a full drop would break every existing read path for little benefit)
-- but are now mirrors of the shared clock, kept in sync by
-- ensure_stage_round below -- this is what lets
-- cast_speaker_round_vote's existing "round_phase = active" check keep
-- working completely unmodified.

-- ---------------------------------------------------------------------
-- Fix (1): claim_speaker_seat requires the seat to be genuinely open.
-- Same signature, same grants -- CREATE OR REPLACE is safe (no
-- parameter-list change, unlike migration 00000000000012's DROP+CREATE).
-- ---------------------------------------------------------------------
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

  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id
      and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
      and left_at is null
  ) then
    raise exception 'identity % already holds an active seat in event %', coalesce(p_profile_id, p_guest_id), p_event_id;
  end if;

  -- The fix: a seat that's already occupied is never silently replaced
  -- -- the caller must have genuinely lost a race, and gets a real
  -- exception (every existing caller already treats this as "someone
  -- else got there first, not fatal": joinOpenSeat's try/catch ->
  -- "That seat was just taken", the simulator's try/catch -> silently
  -- not-fatal).
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

-- ---------------------------------------------------------------------
-- stage_rounds: the shared clock, one row per event.
-- ---------------------------------------------------------------------
create table public.stage_rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  round_number integer not null default 1,
  started_at timestamptz not null default now(),
  ends_at timestamptz not null default (now() + interval '60 seconds'),
  -- 'active': counting down toward a shared resolution.
  -- 'awaiting_pairing': the shared deadline was already reached (or no
  -- round has ever started), at least one seat isn't ready (empty, or
  -- an individual narrow-loss closing period still running), and the
  -- next shared round hasn't started -- not a countdown a client should
  -- render as ticking.
  phase text not null default 'awaiting_pairing' check (phase in ('active', 'awaiting_pairing')),
  updated_at timestamptz not null default now()
);

create unique index stage_rounds_event_uniq on public.stage_rounds (event_id);

alter table public.stage_rounds enable row level security;

create policy "Stage rounds are publicly viewable"
  on public.stage_rounds for select
  to anon, authenticated
  using (true);

grant select on public.stage_rounds to anon, authenticated;

alter table public.stage_rounds replica identity full;
alter publication supabase_realtime add table public.stage_rounds;

-- ---------------------------------------------------------------------
-- ensure_stage_round: idempotent "is the pairing ready for a fresh
-- shared round" check. Safe, and intended, to call from many trigger
-- points: after any successful seat claim (wired into
-- claim_speaker_seat itself, above -- every caller gets this for free),
-- after any seat's individual closing period resolves, and after the
-- shared round itself resolves (both below). Starts a fresh round --
-- and syncs every actively-continuing occupied seat's own
-- round_number/round_started_at/round_ends_at to match, so
-- cast_speaker_round_vote's unmodified "round_phase = active" check and
-- every existing per-seat reader keep working -- only when both seats
-- are occupied and neither is in its own closing window; otherwise
-- marks (or leaves) the stage 'awaiting_pairing'.
-- ---------------------------------------------------------------------
create function public.ensure_stage_round(p_event_id uuid)
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
begin
  select count(*), count(*) filter (where round_phase = 'closing')
  into v_occupied_count, v_closing_count
  from public.event_speakers
  where event_id = p_event_id and left_at is null;

  select * into v_round from public.stage_rounds where event_id = p_event_id for update;

  if v_occupied_count = 2 and v_closing_count = 0 then
    if v_round.id is null then
      insert into public.stage_rounds (event_id, round_number, started_at, ends_at, phase)
      values (p_event_id, 1, v_now, v_now + interval '60 seconds', 'active')
      returning * into v_round;
    elsif v_round.phase = 'awaiting_pairing' then
      update public.stage_rounds
      set round_number = v_round.round_number + 1,
          started_at = v_now,
          ends_at = v_now + interval '60 seconds',
          phase = 'active',
          updated_at = v_now
      where id = v_round.id
      returning * into v_round;
    end if;

    update public.event_speakers
    set round_number = v_round.round_number,
        round_started_at = v_round.started_at,
        round_ends_at = v_round.ends_at
    where event_id = p_event_id and left_at is null and round_phase = 'active';
  else
    if v_round.id is null then
      insert into public.stage_rounds (event_id, round_number, started_at, ends_at, phase)
      values (p_event_id, 1, v_now, v_now, 'awaiting_pairing')
      returning * into v_round;
    elsif v_round.phase = 'active' then
      update public.stage_rounds
      set phase = 'awaiting_pairing', updated_at = v_now
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
-- resolve_stage_round: the shared deadline's one authoritative
-- resolution. Re-derives from Postgres's own clock (never trusted to
-- run on a schedule); safe to call early/late/repeatedly -- a no-op
-- unless a round genuinely exists, is 'active', and has actually
-- reached ends_at. Resolves each occupied seat's Continue/Replace
-- outcome *independently* -- same thresholds, same speaker_round_votes
-- tally, same integer cross-multiplication the old per-seat
-- resolve_speaker_round used (superseded, dropped below) -- against the
-- one shared deadline, then calls ensure_stage_round once to decide
-- whether the pairing can start its next shared round immediately
-- (every seat continued) or must wait (any vacancy/closing).
-- ---------------------------------------------------------------------
create function public.resolve_stage_round(p_event_id uuid)
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

  perform public.ensure_stage_round(p_event_id);
end;
$$;

grant execute on function public.resolve_stage_round(uuid) to service_role;
revoke execute on function public.resolve_stage_round(uuid) from public;

-- ---------------------------------------------------------------------
-- resolve_seat_closing: an individual narrow-loss speaker's own 30s
-- closing period -- deliberately separate from resolve_stage_round
-- (this is exactly the case the shared clock is NOT supposed to govern:
-- Part 4's "the other speaker should not be forced into that final-30
-- state"). Guaranteed replacement at expiry regardless of anything that
-- happened during it, same as the superseded per-seat version.
-- ---------------------------------------------------------------------
create function public.resolve_seat_closing(p_event_speakers_id uuid)
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

  perform public.ensure_stage_round(v_row.event_id);

  out_event_id := v_row.event_id;
  out_outcome := 'replaced-after-closing';
  out_profile_id := v_row.profile_id;
  out_guest_id := v_row.guest_id;
  return next;
end;
$$;

grant execute on function public.resolve_seat_closing(uuid) to service_role;
revoke execute on function public.resolve_seat_closing(uuid) from public;

-- A voluntary/moderator departure also creates a vacancy the shared
-- round must react to (mark 'awaiting_pairing' if it was active) --
-- same reasoning as claim_speaker_seat above, applied symmetrically to
-- the seat-vacating side of the lifecycle.
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
    perform public.ensure_stage_round(p_event_id);
  end if;

  return v_row;
end;
$$;

grant execute on function public.end_speaker_seat(uuid, text, uuid, uuid) to service_role;

-- Voluntary leave ("Leave the stage") creates the exact same kind of
-- vacancy end_speaker_seat does -- same ensure_stage_round call, both
-- identity variants.
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

  perform public.ensure_stage_round(p_event_id);

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

  perform public.ensure_stage_round(p_event_id);

  return v_row;
end;
$$;

-- The old per-speaker resolver is fully superseded by
-- resolve_stage_round/resolve_seat_closing above -- dropped rather than
-- left dead, so nothing can accidentally call it and produce a second,
-- unsynchronized round transition.
drop function public.resolve_speaker_round(uuid);
