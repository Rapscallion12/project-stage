-- Issue #14: the speaker request queue. Deliberately not a generic
-- waiting-list table — "request the mic" and "submit a comment" (two
-- separate account-holder capabilities in PRODUCT.md) become one action:
-- a mic request IS a chat message, with a flag on it. Ranking is a
-- read-time computation over the same reaction signal chat already has,
-- not a stored order. See DECISIONS.md for the full design reasoning.

-- Permanent marker, set once at insert, never flipped back — this is a
-- "was this message submitted as a mic request" fact, not a live "is it
-- currently pending" status (that's speaker_requests.status, below). A
-- chat message with this flag is otherwise a completely normal message:
-- same reactions, same realtime feed, same rendering path. This is what
-- keeps a future pinned/featured-comment surface an additive query and a
-- new UI, not a schema change — it would render exactly these message
-- rows (joined against active speaker_requests) through the existing
-- RoomChatPanel `featuredSlot` seam (issue #3).
alter table public.event_chat_messages
  add column is_speaker_request boolean not null default false;

-- Lifecycle only — never duplicates message content. profile_id is the
-- durable identity reference; message_id points at the actual request
-- text, which lives in event_chat_messages exactly once. Account-only,
-- like event_speakers (PRODUCT.md: requesting the mic is account-only).
create table public.speaker_requests (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  message_id uuid not null references public.event_chat_messages (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'granted', 'withdrawn')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint resolved_at_matches_status check (
    (status = 'pending' and resolved_at is null) or
    (status != 'pending' and resolved_at is not null)
  )
);

-- One active request per profile per event — same shape as
-- event_speakers_active_seat_uniq. The real race-safety backstop for
-- request_to_speak below; its own pre-check is only a friendlier error.
create unique index speaker_requests_active_uniq
  on public.speaker_requests (event_id, profile_id)
  where status = 'pending';

create index speaker_requests_event_id_idx on public.speaker_requests (event_id);

alter table public.speaker_requests enable row level security;

-- Public, like event_speakers — the audience (guests included) needs to
-- see who's requesting, same as they see who's speaking.
create policy "Speaker requests are publicly viewable"
  on public.speaker_requests for select
  to anon, authenticated
  using (true);

-- No insert policy: every request is created via request_to_speak below,
-- which needs to write event_chat_messages and speaker_requests
-- atomically — something no combination of table-level RLS policies can
-- guarantee across two tables. See that function's comment.
--
-- No policy allowing a caller to set status = 'granted' either: that
-- transition only ever happens via the service client, after verifying
-- rank/eligibility server-side (issue #14's actual authorization gate) —
-- letting an ordinary authenticated request self-grant would be exactly
-- the exposure issue #13's claim_speaker_seat design was built to
-- prevent, and this is the same shape of risk.
grant select on public.speaker_requests to anon, authenticated;

alter publication supabase_realtime add table public.speaker_requests;

-- ---------------------------------------------------------------------
-- request_to_speak: atomic creation of a mic request.
--
-- Creates the chat message and the speaker_requests row as a single
-- function call — either both exist or neither does, the same
-- atomicity guarantee a single PL/pgSQL function body gets for free
-- (one function call = one implicit transaction; any exception rolls
-- back every statement already run inside it, including the message
-- insert). This is *why* it's a function and not two sequential
-- application-level inserts: a partial success (message posted, request
-- row missing, or vice versa) would leave an orphaned row either way,
-- exactly what this migration must not allow.
--
-- Looks up the caller's own profiles.display_name and uses auth.uid()
-- for profile_id — never accepted as parameters — same discipline
-- claim_speaker_seat already established (migration 00000000000010).
-- ---------------------------------------------------------------------
create function public.request_to_speak(p_event_id uuid, p_body text)
returns table (message_id uuid, request_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid := auth.uid();
  v_display_name text;
  v_message_id uuid;
  v_request_id uuid;
begin
  if v_profile_id is null then
    raise exception 'request_to_speak requires an authenticated caller';
  end if;

  select display_name into v_display_name from public.profiles where id = v_profile_id;
  if v_display_name is null then
    raise exception 'profile % does not exist', v_profile_id;
  end if;

  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id and profile_id = v_profile_id and left_at is null
  ) then
    raise exception 'profile % is already an active speaker in event %', v_profile_id, p_event_id;
  end if;

  if exists (
    select 1 from public.speaker_requests
    where event_id = p_event_id and profile_id = v_profile_id and status = 'pending'
  ) then
    raise exception 'profile % already has a pending request in event %', v_profile_id, p_event_id;
  end if;

  insert into public.event_chat_messages (event_id, author_profile_id, author_display_name, body, is_speaker_request)
  values (p_event_id, v_profile_id, v_display_name, p_body, true)
  returning id into v_message_id;

  insert into public.speaker_requests (event_id, profile_id, message_id)
  values (p_event_id, v_profile_id, v_message_id)
  returning id into v_request_id;

  return query select v_message_id, v_request_id;
end;
$$;

-- Self-service only (auth.uid()-derived, no profile_id parameter), so
-- this is safe to grant broadly, same tier as leave_speaker_seat.
-- PostgreSQL grants EXECUTE to PUBLIC by default on function creation —
-- issue #13 shipped with this silently unrevoked and it was a real,
-- exploitable bug (migration 00000000000008 fixed it after the fact).
-- Every function below does this correctly from the start this time.
grant execute on function public.request_to_speak(uuid, text) to authenticated;
revoke execute on function public.request_to_speak(uuid, text) from public;

-- ---------------------------------------------------------------------
-- withdraw_speaker_request: self-service, same shape as
-- leave_speaker_seat — ends only the caller's own pending request,
-- auth.uid()-gated, stamps resolved_at server-side rather than trusting
-- a client-supplied timestamp.
-- ---------------------------------------------------------------------
create function public.withdraw_speaker_request(p_event_id uuid)
returns public.speaker_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.speaker_requests;
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

  return v_row;
end;
$$;

grant execute on function public.withdraw_speaker_request(uuid) to authenticated;
revoke execute on function public.withdraw_speaker_request(uuid) from public;

-- ---------------------------------------------------------------------
-- rank_pending_speaker_requests: ranks an event's pending requests by
-- audience support (reaction count on the request's own message,
-- descending), profiles.reputation_score as a tiebreak (currently
-- always 0 for everyone — nothing mutates it yet, so this is a harmless
-- no-op today, not a blocker), then recency.
--
-- Trusted-server-only, same tier as claim_speaker_seat/end_speaker_seat:
-- it reads profiles.reputation_score, which anon/authenticated can't
-- select directly (migration 00000000000001), and it's the input to
-- issue #14's actual eligibility decision (top-3 self-service claim),
-- not something to expose as a public "leaderboard" endpoint in this
-- issue. No anon/authenticated grant, no Server Action wrapper.
-- ---------------------------------------------------------------------
create function public.rank_pending_speaker_requests(p_event_id uuid)
returns table (request_id uuid, profile_id uuid, message_id uuid, rank bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    sr.id as request_id,
    sr.profile_id,
    sr.message_id,
    row_number() over (
      order by count(r.id) desc, p.reputation_score desc, sr.created_at asc
    ) as rank
  from public.speaker_requests sr
  join public.profiles p on p.id = sr.profile_id
  left join public.event_chat_message_reactions r on r.message_id = sr.message_id
  where sr.event_id = p_event_id and sr.status = 'pending'
  group by sr.id, sr.profile_id, sr.message_id, p.reputation_score, sr.created_at;
$$;

grant execute on function public.rank_pending_speaker_requests(uuid) to service_role;
revoke execute on function public.rank_pending_speaker_requests(uuid) from public;
