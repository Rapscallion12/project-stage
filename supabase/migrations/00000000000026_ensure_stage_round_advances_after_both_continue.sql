-- Issue #21 corrective pass, follow-up: ensure_stage_round (migration
-- 00000000000024) only advanced a paired stage from its existing round to
-- a fresh one when the round row's phase was 'awaiting_pairing' -- but
-- resolve_stage_round never sets phase to anything when the outcome for
-- both seats is "continue" (it only touches event_speakers rows and
-- speaker_round_votes; stage_rounds.phase stays 'active', with its now-
-- past ends_at, exactly as it was before the deadline). That left a
-- fully-continuing pairing stuck forever on the same expired round: never
-- awaiting_pairing (both seats are still occupied), never actually
-- restarted (ends_at never moves), so the "one shared round" badge would
-- have shown a stale, already-negative countdown until some *other*,
-- unrelated seat vacancy happened to flip phase through awaiting_pairing
-- first. Caught by stage-rounds.test.ts's "both speakers continuing
-- starts a fresh shared round for both" real-database test.
--
-- Fix: also advance when the round is still 'active' but its own
-- deadline has already passed. Safe to check unconditionally here --
-- resolve_stage_round's own guard (`now() < v_round.ends_at then
-- return`) means this function is only ever reached, with 2 seats still
-- occupied and 0 closing, after a deadline has genuinely elapsed; there
-- is no path that calls ensure_stage_round mid-round (before its
-- deadline) with both seats already occupied, since a claim can only
-- raise occupied_count to 2 by filling a *vacant* seat, and vacating a
-- seat already forces the round to awaiting_pairing at that moment.
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
    elsif v_round.phase = 'awaiting_pairing' or v_round.ends_at <= v_now then
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
