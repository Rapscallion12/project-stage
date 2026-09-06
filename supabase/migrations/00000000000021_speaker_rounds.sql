-- Issue #21, Continue/Replace speaker rounds: per-speaker (not
-- per-pairing — see DECISIONS.md's Section I resolution), authoritative,
-- race-safe round state. Modeled directly on the existing #18 machinery
-- (disconnected_at/media_inactive_since + release_if_expired, migration
-- 00000000000018) rather than inventing a new pattern: a deadline lives
-- in the row, a trusted-server RPC re-derives the outcome from
-- Postgres's own clock, and any client can trigger that re-derivation
-- without owning the authoritative decision itself.
--
-- Lives directly on event_speakers, not a separate table — a round
-- belongs to exactly one occupancy episode, the same row that already
-- models "this identity held this seat from X". Column defaults (below)
-- mean every new occupant automatically starts round 1 with a fresh
-- protected window the moment claim_speaker_seat inserts their row — no
-- change needed to that function at all.
alter table public.event_speakers
  add column round_number integer not null default 1,
  add column round_started_at timestamptz not null default now(),
  add column round_ends_at timestamptz not null default (now() + interval '60 seconds'),
  add column round_phase text not null default 'active' check (round_phase in ('active', 'closing')),
  add column closing_ends_at timestamptz,
  add constraint closing_ends_at_matches_phase check (
    (round_phase = 'active' and closing_ends_at is null) or
    (round_phase = 'closing' and closing_ends_at is not null)
  );

-- ---------------------------------------------------------------------
-- speaker_round_votes: one row per (event_speakers occupancy, voter).
-- Deleted in bulk when a round resolves to "continue" (fresh round,
-- fresh votes — Section G: "Votes reset when a new round begins") and
-- when the seat is replaced (the occupancy episode is over). Not
-- versioned by round_number: since old-round rows are always deleted
-- before a new round's votes can accumulate, at most one round's worth
-- of votes ever exists for a given event_speakers row at a time.
-- ---------------------------------------------------------------------
create table public.speaker_round_votes (
  id uuid primary key default gen_random_uuid(),
  event_speakers_id uuid not null references public.event_speakers (id) on delete cascade,
  voter_profile_id uuid references public.profiles (id) on delete cascade,
  voter_guest_id uuid,
  choice text not null check (choice in ('continue', 'replace')),
  created_at timestamptz not null default now(),
  constraint not_both_round_voters check (
    not (voter_profile_id is not null and voter_guest_id is not null)
  ),
  constraint one_round_voter_set check (
    voter_profile_id is not null or voter_guest_id is not null
  )
);

-- One current choice per viewer per speaker's current round — the real
-- backstop; cast_speaker_round_vote's upsert is the friendly wrapper.
create unique index speaker_round_votes_voter_uniq
  on public.speaker_round_votes (event_speakers_id, coalesce(voter_profile_id, voter_guest_id));

alter table public.speaker_round_votes enable row level security;

create policy "Speaker round votes are publicly viewable"
  on public.speaker_round_votes for select
  to anon, authenticated
  using (true);

grant select on public.speaker_round_votes to anon, authenticated;

alter publication supabase_realtime add table public.speaker_round_votes;
-- event_speakers is already in the realtime publication (migration
-- 00000000000010) — round/vote deltas on it flow through the existing
-- subscription useActiveSpeakers already has, no change needed there.

-- ---------------------------------------------------------------------
-- cast_speaker_round_vote: authenticated self-service. Only accepted
-- while the round is 'active' — once it's 'closing', the outcome is
-- already decided (Section H: "the 30 seconds is NOT another survival
-- round... do not start another Continue/Replace vote during those
-- final 30 seconds"), so a vote arriving after that point would be
-- meaningless and is rejected rather than silently accepted and ignored.
-- ---------------------------------------------------------------------
create function public.cast_speaker_round_vote(p_event_speakers_id uuid, p_choice text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid := auth.uid();
  v_phase text;
begin
  if v_profile_id is null then
    raise exception 'cast_speaker_round_vote requires an authenticated caller';
  end if;
  if p_choice not in ('continue', 'replace') then
    raise exception 'cast_speaker_round_vote requires choice to be continue or replace';
  end if;

  select round_phase into v_phase
  from public.event_speakers
  where id = p_event_speakers_id and left_at is null;

  if v_phase is null then
    raise exception 'no active speaker occupancy % to vote on', p_event_speakers_id;
  end if;
  if v_phase != 'active' then
    raise exception 'round % is no longer accepting votes (phase %)', p_event_speakers_id, v_phase;
  end if;

  insert into public.speaker_round_votes (event_speakers_id, voter_profile_id, choice)
  values (p_event_speakers_id, v_profile_id, p_choice)
  on conflict (event_speakers_id, coalesce(voter_profile_id, voter_guest_id))
  do update set choice = excluded.choice, created_at = now();
end;
$$;

grant execute on function public.cast_speaker_round_vote(uuid, text) to authenticated;
revoke execute on function public.cast_speaker_round_vote(uuid, text) from public;

-- Guest variant — service-role-only, same tier as cast_speaker_request_vote_as_guest.
create function public.cast_speaker_round_vote_as_guest(p_event_speakers_id uuid, p_choice text, p_guest_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phase text;
begin
  if p_choice not in ('continue', 'replace') then
    raise exception 'cast_speaker_round_vote_as_guest requires choice to be continue or replace';
  end if;

  select round_phase into v_phase
  from public.event_speakers
  where id = p_event_speakers_id and left_at is null;

  if v_phase is null then
    raise exception 'no active speaker occupancy % to vote on', p_event_speakers_id;
  end if;
  if v_phase != 'active' then
    raise exception 'round % is no longer accepting votes (phase %)', p_event_speakers_id, v_phase;
  end if;

  insert into public.speaker_round_votes (event_speakers_id, voter_guest_id, choice)
  values (p_event_speakers_id, p_guest_id, p_choice)
  on conflict (event_speakers_id, coalesce(voter_profile_id, voter_guest_id))
  do update set choice = excluded.choice, created_at = now();
end;
$$;

grant execute on function public.cast_speaker_round_vote_as_guest(uuid, text, uuid) to service_role;
revoke execute on function public.cast_speaker_round_vote_as_guest(uuid, text, uuid) from public;

-- ---------------------------------------------------------------------
-- resolve_speaker_round: the one authoritative state transition.
-- Trusted-server-only — called from a Server Action whenever any
-- connected client's own scheduled deadline timer fires (see
-- use-speaker-round-resolution.ts), never trusted to run on a schedule
-- of its own (this serverless deployment has no background jobs; same
-- "evaluate on next real activity" reasoning as every other
-- authoritative deadline in this codebase). Always safe to call early
-- or late or repeatedly — re-derives everything from the row's own
-- timestamps and the real vote tally, touches nothing if it's not
-- actually time yet.
--
-- Threshold logic mirrors lib/speaker-round.ts's resolveRoundOutcome
-- exactly (kept in sync by hand, cross-referenced here, same discipline
-- SPEAKER_DISCONNECT_GRACE_SECONDS/11 already established) — integer
-- cross-multiplication, not float division, so there's no rounding
-- ambiguity at the exact 50%/66% boundaries: replace_count*100 compared
-- against threshold*total, never a computed percentage.
-- ---------------------------------------------------------------------
create function public.resolve_speaker_round(p_event_speakers_id uuid)
returns table (outcome text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
  v_continue_count integer;
  v_replace_count integer;
  v_total integer;
begin
  select * into v_row from public.event_speakers where id = p_event_speakers_id and left_at is null;
  if v_row.id is null then
    return query select 'no-active-occupancy'::text;
    return;
  end if;

  if v_row.round_phase = 'closing' then
    if now() < v_row.closing_ends_at then
      return query select 'closing-not-yet-expired'::text;
      return;
    end if;
    -- Guaranteed replacement at the end of the closing period,
    -- regardless of anything that happened during it (Section H: "When
    -- the 30 seconds expires, release/replace the speaker regardless of
    -- any later audience activity").
    update public.event_speakers set left_at = now(), left_reason = 'replaced' where id = p_event_speakers_id;
    delete from public.speaker_round_votes where event_speakers_id = p_event_speakers_id;
    return query select 'replaced-after-closing'::text;
    return;
  end if;

  -- round_phase = 'active'
  if now() < v_row.round_ends_at then
    return query select 'active-not-yet-expired'::text;
    return;
  end if;

  select count(*) filter (where choice = 'continue'), count(*) filter (where choice = 'replace')
  into v_continue_count, v_replace_count
  from public.speaker_round_votes
  where event_speakers_id = p_event_speakers_id;

  v_total := v_continue_count + v_replace_count;

  if v_total = 0 or v_replace_count * 100 <= 50 * v_total then
    -- Continue: zero votes, or Replace at/under 50% (an exact tie stays
    -- Continue per explicit instruction) — fresh round, fresh votes.
    update public.event_speakers
    set round_number = round_number + 1,
        round_started_at = now(),
        round_ends_at = now() + interval '60 seconds'
    where id = p_event_speakers_id;
    delete from public.speaker_round_votes where event_speakers_id = p_event_speakers_id;
    return query select 'continue'::text;
    return;
  end if;

  if v_replace_count * 100 >= 66 * v_total then
    -- Decisive Replace: replaced immediately, at this round's own
    -- boundary — no closing period.
    update public.event_speakers set left_at = now(), left_reason = 'replaced' where id = p_event_speakers_id;
    delete from public.speaker_round_votes where event_speakers_id = p_event_speakers_id;
    return query select 'decisive-replace'::text;
    return;
  end if;

  -- Narrow loss: over 50%, under 66% — the decision is made, but the
  -- speaker gets 30 final seconds to finish their thought. No new round,
  -- no further voting accepted (cast_speaker_round_vote checks phase).
  update public.event_speakers
  set round_phase = 'closing', closing_ends_at = now() + interval '30 seconds'
  where id = p_event_speakers_id;
  return query select 'narrow-loss'::text;
end;
$$;

grant execute on function public.resolve_speaker_round(uuid) to service_role;
revoke execute on function public.resolve_speaker_round(uuid) from public;
