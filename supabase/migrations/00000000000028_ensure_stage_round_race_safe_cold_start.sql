-- Issue #21, second corrective pass: real-device testing found the
-- simulator's "Start Simulated Session" intermittently produced an
-- incomplete two-speaker stage -- fixed by Stop/Start again, which is
-- exactly the signature of a lost race, not a flaky UI.
--
-- Root cause, traced (not papered over with a retry): ensure_stage_round
-- read seat occupancy BEFORE acquiring/creating the stage_rounds row, and
-- its cold-start INSERT had no conflict handling. When both seats of a
-- brand-new event are claimed at nearly the same instant (the
-- simulator's own seedTwoSpeakers used Promise.allSettled to claim seat 1
-- and seat 2 in parallel -- and two real people tapping both open seats
-- within the same instant is a legitimate, if rare, production scenario
-- too), both concurrent claim_speaker_seat calls could reach
-- ensure_stage_round with *no* stage_rounds row yet visible to either
-- transaction's own snapshot. Both would then attempt to INSERT the
-- row -- the loser hit stage_rounds_event_uniq's bare unique_violation,
-- an uncaught Postgres error that rolled back its ENTIRE transaction,
-- including the seat claim itself. That's why only one seat ever
-- appeared: the other claim never actually failed at the "seat already
-- occupied" guard -- it failed invisibly, several statements later,
-- inside this function's own bookkeeping.
--
-- Fix, in two parts:
-- 1. The cold-start INSERT now uses `ON CONFLICT (event_id) DO NOTHING`
--    -- the loser discovers the winner's row instead of raising.
-- 2. Seat-occupancy is now read AFTER the round row is locked/created,
--    not before. This isn't just cosmetic: Postgres blocks a second
--    transaction's conflicting INSERT until the first COMMITS (standard
--    behavior for two transactions racing the same unique constraint),
--    so by the time the second (initially-blocked) transaction resumes
--    and reads occupancy, the first transaction's own seat claim has
--    already committed and is visible -- both seats are correctly seen
--    as occupied by whichever transaction resolves second, and the
--    shared round starts 'active' immediately rather than staying stuck
--    at 'awaiting_pairing' until some unrelated later trigger notices.
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
    if v_round.phase = 'active' then
      update public.stage_rounds
      set phase = 'awaiting_pairing', updated_at = v_now
      where id = v_round.id
      returning * into v_round;
    end if;
  end if;

  return v_round;
end;
$$;
