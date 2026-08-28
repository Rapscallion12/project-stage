-- Issue #21 corrective pass, follow-up: the very first speaker to claim a
-- seat (before a second one pairs up) makes ensure_stage_round insert an
-- 'awaiting_pairing' placeholder row -- a round that was never actually
-- shown to anyone as active. That placeholder's round_number defaulted
-- to 1, so when the second seat filled moments later and the pairing
-- transitioned to its first genuinely active round, the "already exists,
-- just advance" branch incremented from that placeholder's 1 to 2 --
-- every event's real first shared round displayed as "Round 2", never
-- "Round 1". claim_speaker_seat's normal call pattern is always
-- sequential (one seat, then the other -- exactly how a real audience
-- member's own join, or the simulator's own seeding, both work), so this
-- off-by-one hit every single pairing, not just an edge case.
--
-- Fix: the placeholder starts at round_number 0 -- it was never a real
-- round, so it shouldn't count as one. The other cold-start path (both
-- seats already occupied before any stage_rounds row exists at all --
-- the true-simultaneous-claim case) already inserts directly at
-- round_number 1 and is untouched here; it's a different branch, already
-- correct.
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
      values (p_event_id, 0, v_now, v_now, 'awaiting_pairing')
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
