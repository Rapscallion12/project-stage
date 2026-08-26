-- Issue #21, Phase 1: Request-to-Speak voting + ranked Top 3 + server-
-- authoritative weighted selection. See DECISIONS.md for the full state
-- machine and the reasoning behind each design choice below.
--
-- Three new pieces:
-- 1. speaker_request_votes — a request vote is NOT the same thing as an
--    ordinary comment like (event_chat_message_reactions, untouched):
--    exactly one active vote per identity per event, transferable,
--    toggle-off on re-tapping the same request. That exclusivity can't
--    be expressed by the reactions table's per-message independent-
--    toggle design, so this is a genuinely separate table, not a reuse.
-- 2. speaker_selection_rounds + new columns on speaker_requests — when a
--    seat opens, the current Top 3 (by vote count) is *frozen* (ranking
--    and membership fixed even as live votes keep changing in the
--    background) and one candidate is marked the current pick. A failed
--    pick advances to the next unfailed candidate in the SAME frozen
--    round, never re-ranks from live data mid-round.
-- 3. speaker_requests.status gains 'expired' — the bulk "pool reset" the
--    product spec requires on any successful join: every other still-
--    pending request (whether or not it was ever part of a frozen
--    round) ends, not just the winner's. Distinct from 'withdrawn'
--    (voluntary) since this is not the requester's own action.

-- ---------------------------------------------------------------------
-- speaker_request_votes
-- ---------------------------------------------------------------------
create table public.speaker_request_votes (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  voter_profile_id uuid references public.profiles (id) on delete cascade,
  voter_guest_id uuid,
  request_id uuid not null references public.speaker_requests (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint not_both_voters check (
    not (voter_profile_id is not null and voter_guest_id is not null)
  ),
  constraint one_voter_set check (
    voter_profile_id is not null or voter_guest_id is not null
  )
);

-- Exactly one active vote per identity per event — the exclusivity
-- Section A requires. Enforced here, not just in the RPC, as the real
-- race-safety backstop (same "constraint is the truth, function is the
-- friendly wrapper" discipline as speaker_requests_active_uniq).
create unique index speaker_request_votes_voter_uniq
  on public.speaker_request_votes (event_id, coalesce(voter_profile_id, voter_guest_id));

create index speaker_request_votes_request_id_idx on public.speaker_request_votes (request_id);

alter table public.speaker_request_votes enable row level security;

-- Public, same as speaker_requests itself — anyone needs to see vote
-- counts to render ranking, and see whether a given request is "mine".
create policy "Speaker request votes are publicly viewable"
  on public.speaker_request_votes for select
  to anon, authenticated
  using (true);

-- No insert/update/delete policy: every vote is cast via
-- cast_speaker_request_vote(_as_guest) below, which needs the
-- transfer/toggle logic (delete-if-same, upsert-otherwise) atomically —
-- the same reasoning speaker_requests itself already documents for why
-- it has no direct insert policy.
grant select on public.speaker_request_votes to anon, authenticated;

alter publication supabase_realtime add table public.speaker_request_votes;

-- ---------------------------------------------------------------------
-- speaker_selection_rounds
-- ---------------------------------------------------------------------
create table public.speaker_selection_rounds (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  status text not null default 'active' check (status in ('active', 'resolved', 'exhausted')),
  frozen_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- At most one round in flight per event at a time.
create unique index speaker_selection_rounds_active_uniq
  on public.speaker_selection_rounds (event_id)
  where status = 'active';

alter table public.speaker_selection_rounds enable row level security;

create policy "Speaker selection rounds are publicly viewable"
  on public.speaker_selection_rounds for select
  to anon, authenticated
  using (true);

grant select on public.speaker_selection_rounds to anon, authenticated;

-- Trusted-server-only writes, same tier as event_speakers/speaker_requests
-- themselves — no insert/update policy or grant for anon/authenticated.

-- ---------------------------------------------------------------------
-- speaker_requests: selection-round bookkeeping columns + 'expired' status
-- ---------------------------------------------------------------------
alter table public.speaker_requests
  add column selection_round_id uuid references public.speaker_selection_rounds (id) on delete set null,
  add column frozen_rank smallint,
  add column frozen_vote_count integer,
  add column is_current_candidate boolean not null default false,
  add column selection_failed boolean not null default false;

-- At most one current candidate per round.
create unique index speaker_requests_current_candidate_uniq
  on public.speaker_requests (selection_round_id)
  where is_current_candidate;

-- The original status CHECK (migration 00000000000011) was an unnamed
-- inline column constraint — its actual generated name is looked up
-- rather than assumed, same safer pattern migration 00000000000017
-- established for this exact situation.
do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
  from pg_constraint
  where conrelid = 'public.speaker_requests'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%status%pending%granted%withdrawn%';

  if v_constraint_name is not null then
    execute format('alter table public.speaker_requests drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.speaker_requests
  add constraint speaker_requests_status_check
    check (status in ('pending', 'granted', 'withdrawn', 'expired'));

-- resolved_at_matches_status (migration 00000000000011) already requires
-- resolved_at whenever status != 'pending' — 'expired' satisfies that
-- unchanged, no further constraint edit needed.

-- ---------------------------------------------------------------------
-- cast_speaker_request_vote: authenticated self-service. Resolves the
-- CURRENTLY pending (or mid-selection) request for the given message,
-- then transfers/toggles the caller's one active vote onto it.
--
-- Toggle-off: re-casting on the same request the caller already voted
-- for deletes the vote instead of no-op-ing — Section A's explicit
-- "double-tapping the currently selected request again removes the
-- vote entirely."
-- Transfer: voting for a different request replaces the existing row
-- (delete old + insert new) rather than a second row ever existing —
-- the unique index is the backstop, this is the friendly path to it.
-- ---------------------------------------------------------------------
create function public.cast_speaker_request_vote(p_event_id uuid, p_message_id uuid)
returns table (voted_request_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid := auth.uid();
  v_request_id uuid;
  v_existing_request_id uuid;
begin
  if v_profile_id is null then
    raise exception 'cast_speaker_request_vote requires an authenticated caller';
  end if;

  select id into v_request_id
  from public.speaker_requests
  where event_id = p_event_id and message_id = p_message_id and status in ('pending')
  order by created_at desc
  limit 1;

  if v_request_id is null then
    raise exception 'no active speaker request found for message %', p_message_id;
  end if;

  select request_id into v_existing_request_id
  from public.speaker_request_votes
  where event_id = p_event_id and voter_profile_id = v_profile_id;

  if v_existing_request_id = v_request_id then
    delete from public.speaker_request_votes
    where event_id = p_event_id and voter_profile_id = v_profile_id;
    return query select null::uuid;
    return;
  end if;

  delete from public.speaker_request_votes
  where event_id = p_event_id and voter_profile_id = v_profile_id;

  insert into public.speaker_request_votes (event_id, voter_profile_id, request_id)
  values (p_event_id, v_profile_id, v_request_id);

  return query select v_request_id;
end;
$$;

grant execute on function public.cast_speaker_request_vote(uuid, uuid) to authenticated;
revoke execute on function public.cast_speaker_request_vote(uuid, uuid) from public;

-- Guest variant — service-role-only, same tier as request_to_speak_as_guest.
create function public.cast_speaker_request_vote_as_guest(p_event_id uuid, p_message_id uuid, p_guest_id uuid)
returns table (voted_request_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request_id uuid;
  v_existing_request_id uuid;
begin
  select id into v_request_id
  from public.speaker_requests
  where event_id = p_event_id and message_id = p_message_id and status in ('pending')
  order by created_at desc
  limit 1;

  if v_request_id is null then
    raise exception 'no active speaker request found for message %', p_message_id;
  end if;

  select request_id into v_existing_request_id
  from public.speaker_request_votes
  where event_id = p_event_id and voter_guest_id = p_guest_id;

  if v_existing_request_id = v_request_id then
    delete from public.speaker_request_votes
    where event_id = p_event_id and voter_guest_id = p_guest_id;
    return query select null::uuid;
    return;
  end if;

  delete from public.speaker_request_votes
  where event_id = p_event_id and voter_guest_id = p_guest_id;

  insert into public.speaker_request_votes (event_id, voter_guest_id, request_id)
  values (p_event_id, p_guest_id, v_request_id);

  return query select v_request_id;
end;
$$;

grant execute on function public.cast_speaker_request_vote_as_guest(uuid, uuid, uuid) to service_role;
revoke execute on function public.cast_speaker_request_vote_as_guest(uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- freeze_speaker_candidates: ranks currently-pending requests by vote
-- count (desc), tiebroken deterministically (created_at asc, then id
-- asc — a full, stable order even for simultaneous votes/requests),
-- takes the top 3, and freezes them into a new active round. Does NOT
-- pick a winner — that's a weighted-random decision made in application
-- code (lib/speaker-selection.ts) so the probability curve is isolated,
-- unit-testable, and swappable without touching SQL. Trusted-server-
-- only, same tier as rank_pending_speaker_requests.
--
-- Returns nothing (0 rows) if there are no pending requests at all —
-- Section C's "0 candidates: seat remains open normally" case; the
-- caller creates no round in that case.
-- ---------------------------------------------------------------------
create function public.freeze_speaker_candidates(p_event_id uuid)
returns table (
  round_id uuid,
  request_id uuid,
  profile_id uuid,
  guest_id uuid,
  message_id uuid,
  rank smallint,
  vote_count integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_round_id uuid;
begin
  if not exists (
    select 1 from public.speaker_requests where event_id = p_event_id and status = 'pending'
  ) then
    return;
  end if;

  insert into public.speaker_selection_rounds (event_id) values (p_event_id)
  returning id into v_round_id;

  with ranked as (
    select
      sr.id as r_id,
      sr.profile_id as r_profile_id,
      sr.guest_id as r_guest_id,
      sr.message_id as r_message_id,
      count(v.id) as r_vote_count,
      row_number() over (
        order by count(v.id) desc, sr.created_at asc, sr.id asc
      ) as r_rank
    from public.speaker_requests sr
    left join public.speaker_request_votes v on v.request_id = sr.id
    where sr.event_id = p_event_id and sr.status = 'pending'
    group by sr.id
    order by r_rank
    limit 3
  )
  update public.speaker_requests sr
  set selection_round_id = v_round_id,
      frozen_rank = ranked.r_rank,
      frozen_vote_count = ranked.r_vote_count
  from ranked
  where sr.id = ranked.r_id;

  return query
    select v_round_id, sr.id, sr.profile_id, sr.guest_id, sr.message_id, sr.frozen_rank, sr.frozen_vote_count
    from public.speaker_requests sr
    where sr.selection_round_id = v_round_id
    order by sr.frozen_rank;
end;
$$;

grant execute on function public.freeze_speaker_candidates(uuid) to service_role;
revoke execute on function public.freeze_speaker_candidates(uuid) from public;

-- ---------------------------------------------------------------------
-- set_current_speaker_candidate: commits the weighted-random pick (or a
-- runner-up advancement) computed in application code. Validates the
-- request actually belongs to the given round and hasn't already
-- failed, so a stale/bogus call can't hijack an unrelated round.
-- ---------------------------------------------------------------------
create function public.set_current_speaker_candidate(p_round_id uuid, p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.speaker_requests
  set is_current_candidate = false
  where selection_round_id = p_round_id and is_current_candidate;

  update public.speaker_requests
  set is_current_candidate = true
  where id = p_request_id and selection_round_id = p_round_id and not selection_failed;
end;
$$;

grant execute on function public.set_current_speaker_candidate(uuid, uuid) to service_role;
revoke execute on function public.set_current_speaker_candidate(uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- withdraw_speaker_request / withdraw_speaker_request_as_guest:
-- extended (CREATE OR REPLACE, same signature) so that withdrawing the
-- round's current candidate also advances selection to the next
-- unfailed candidate in the SAME frozen round (never re-ranks from live
-- votes mid-round) — Section D's "proceed to the next eligible
-- runner-up... a failed winner must not be repeatedly selected." If no
-- unfailed candidate remains, the round is marked 'exhausted' — Section
-- D's "return to the normal open/request state."
-- ---------------------------------------------------------------------
create or replace function public.withdraw_speaker_request(p_event_id uuid)
returns public.speaker_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.speaker_requests;
  v_next_id uuid;
begin
  if auth.uid() is null then
    raise exception 'withdraw_speaker_request requires an authenticated caller';
  end if;

  update public.speaker_requests
  set status = 'withdrawn', resolved_at = now()
  where event_id = p_event_id
    and profile_id = auth.uid()
    and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no pending request found for this caller in event %', p_event_id;
  end if;

  if v_row.is_current_candidate and v_row.selection_round_id is not null then
    update public.speaker_requests
    set is_current_candidate = false, selection_failed = true
    where id = v_row.id;

    select id into v_next_id
    from public.speaker_requests
    where selection_round_id = v_row.selection_round_id
      and status = 'pending'
      and not selection_failed
      and id != v_row.id
    order by frozen_rank
    limit 1;

    if v_next_id is not null then
      update public.speaker_requests set is_current_candidate = true where id = v_next_id;
    else
      update public.speaker_selection_rounds set status = 'exhausted', resolved_at = now()
      where id = v_row.selection_round_id and status = 'active';
    end if;
  end if;

  return v_row;
end;
$$;

grant execute on function public.withdraw_speaker_request(uuid) to authenticated;
revoke execute on function public.withdraw_speaker_request(uuid) from public;

create or replace function public.withdraw_speaker_request_as_guest(p_event_id uuid, p_guest_id uuid)
returns public.speaker_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.speaker_requests;
  v_next_id uuid;
begin
  update public.speaker_requests
  set status = 'withdrawn', resolved_at = now()
  where event_id = p_event_id
    and guest_id = p_guest_id
    and status = 'pending'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no pending request found for this guest in event %', p_event_id;
  end if;

  if v_row.is_current_candidate and v_row.selection_round_id is not null then
    update public.speaker_requests
    set is_current_candidate = false, selection_failed = true
    where id = v_row.id;

    select id into v_next_id
    from public.speaker_requests
    where selection_round_id = v_row.selection_round_id
      and status = 'pending'
      and not selection_failed
      and id != v_row.id
    order by frozen_rank
    limit 1;

    if v_next_id is not null then
      update public.speaker_requests set is_current_candidate = true where id = v_next_id;
    else
      update public.speaker_selection_rounds set status = 'exhausted', resolved_at = now()
      where id = v_row.selection_round_id and status = 'active';
    end if;
  end if;

  return v_row;
end;
$$;

grant execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) to service_role;
revoke execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- reset_speaker_candidate_pool: Section E's authoritative, race-safe
-- pool reset. Called once, immediately after a successful claim/grant.
-- Resolves the active round (if any) and expires every OTHER still-
-- pending request for the event — not just the winner's — and clears
-- every vote for the event. Runners-up do NOT remain queued; anyone
-- (including the just-seated speaker, once they leave) must submit a
-- fresh request afterward.
-- ---------------------------------------------------------------------
create function public.reset_speaker_candidate_pool(p_event_id uuid, p_winning_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.speaker_selection_rounds
  set status = 'resolved', resolved_at = now()
  where event_id = p_event_id and status = 'active';

  update public.speaker_requests
  set status = 'expired', resolved_at = now(), is_current_candidate = false
  where event_id = p_event_id
    and status = 'pending'
    and id != p_winning_request_id;

  delete from public.speaker_request_votes where event_id = p_event_id;
end;
$$;

grant execute on function public.reset_speaker_candidate_pool(uuid, uuid) to service_role;
revoke execute on function public.reset_speaker_candidate_pool(uuid, uuid) from public;
