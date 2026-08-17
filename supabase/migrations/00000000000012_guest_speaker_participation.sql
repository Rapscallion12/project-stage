-- Issue #16: guest speaker participation, as an explicit, reversible
-- prototype/testing-phase exception to the account-only speaking rule
-- from migrations 00000000000005/00000000000011 (see PRODUCT.md and
-- DECISIONS.md). Guests can request the mic and become speakers so the
-- core social experiment can be tested without account-creation
-- friction, WITHOUT expanding what an anonymous client can authorize:
-- every write below stays on exactly the same trust tier it was already
-- on (service_role-only for seat writes, auth.uid()-only for self-service
-- request writes) — this migration only widens *which identity shape*
-- those already-trusted callers may act on, never who may call them.
--
-- The security question this design answers: can a guest's identity be
-- trusted enough to gate `canPublish`, without ever letting an anonymous
-- client tell Postgres *which* guest it is? Guest identity is a bare,
-- httpOnly-cookie-derived session id (see src/lib/guest.ts) — trustworthy
-- as a durable identifier when a *server* resolves it (already the case
-- for guest chat authorship), but RLS/`auth.uid()` has no equivalent for
-- guests the way it does for accounts. So guest-authorizing writes cannot
-- be granted to `anon` the way `request_to_speak`'s self-service,
-- auth.uid()-derived path safely is — they go through the same
-- service_role tier `claim_speaker_seat`/`end_speaker_seat` already use,
-- called only from Server Actions that resolve the guest id server-side
-- and never accept it as client input.

-- ---------------------------------------------------------------------
-- event_speakers: profile_id becomes nullable, guest_id added, exactly
-- one of the two required — same XOR pattern
-- event_chat_messages/event_chat_message_reactions already established
-- for guest vs. account authorship (migration 00000000000003).
-- ---------------------------------------------------------------------
alter table public.event_speakers
  alter column profile_id drop not null,
  add column guest_id uuid,
  add constraint event_speakers_exactly_one_identity check (
    (profile_id is not null) <> (guest_id is not null)
  );

-- Replaces migration 00000000000006's profile-only active-seat index with
-- a coalesce version — same shape as the existing reaction-dedup index
-- (event_chat_message_reactions_identity_uniq).
drop index public.event_speakers_active_profile_uniq;
create unique index event_speakers_active_identity_uniq
  on public.event_speakers (event_id, coalesce(profile_id, guest_id))
  where left_at is null;

-- ---------------------------------------------------------------------
-- speaker_requests: same nullable/XOR/coalesce treatment.
-- ---------------------------------------------------------------------
alter table public.speaker_requests
  alter column profile_id drop not null,
  add column guest_id uuid,
  add constraint speaker_requests_exactly_one_identity check (
    (profile_id is not null) <> (guest_id is not null)
  );

drop index public.speaker_requests_active_uniq;
create unique index speaker_requests_active_identity_uniq
  on public.speaker_requests (event_id, coalesce(profile_id, guest_id))
  where status = 'pending';

-- ---------------------------------------------------------------------
-- claim_speaker_seat: already service_role-only, already took an
-- explicit target identity rather than auth.uid() — the smallest
-- extension is widening that identity to optionally be a guest,
-- XOR-validated, in the SAME function (not a second overload: Postgres
-- resolves overloads by parameter *types*, and a profile-only vs.
-- guest-only version would both be (uuid, uuid, smallint) — not a valid
-- overload at all; one function with nullable identity params, mirroring
-- the table's own constraint, is both the only option and the clearest
-- one). p_profile_id/p_guest_id/p_guest_display_name default to null so
-- an existing profile-only caller (and the existing "not callable by an
-- ordinary authenticated user" grant test) still resolves to this same
-- function without passing every parameter. Must drop first: changing
-- the parameter list is not a same-signature CREATE OR REPLACE.
--
-- display_name handling differs deliberately by identity: for a profile,
-- unchanged from migration 00000000000010 — read from profiles.display_name
-- server-side, never a caller-supplied parameter (so guests, who can't
-- read profiles under RLS, still see who's speaking, and a caller can't
-- lie about a profile's own name). Guests have no profiles row to read
-- from at all, so p_guest_display_name is required for that branch —
-- the caller (claimSpeakerSeat) already has it from the guest's own
-- session cookie (see src/lib/guest.ts), the same source the guest's
-- chat messages already snapshot their name from.
-- ---------------------------------------------------------------------
drop function public.claim_speaker_seat(uuid, uuid, smallint);

create function public.claim_speaker_seat(
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

  update public.event_speakers
  set left_at = now(), left_reason = 'replaced'
  where event_id = p_event_id
    and seat_number = p_seat_number
    and left_at is null;

  insert into public.event_speakers (event_id, profile_id, guest_id, seat_number, display_name)
  values (p_event_id, p_profile_id, p_guest_id, p_seat_number, v_display_name)
  returning * into v_row;

  return v_row;
end;
$$;

-- No grant to anon/authenticated — same trusted-server-only tier as
-- before, unchanged.
grant execute on function public.claim_speaker_seat(uuid, smallint, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------
-- end_speaker_seat: same identity-widening treatment. No display_name
-- concern here — it never sets one, only ends a row.
-- ---------------------------------------------------------------------
drop function public.end_speaker_seat(uuid, uuid, text);

create function public.end_speaker_seat(
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

  return v_row;
end;
$$;

grant execute on function public.end_speaker_seat(uuid, text, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- request_to_speak_internal: the shared atomic message+request insert,
-- factored out so the existing self-service (auth.uid()) path and a new
-- guest path can share it without duplicating the atomicity guarantee.
-- Never granted to anyone directly — only callable from the two wrapper
-- functions below, both security definer, so this needs no grant of its
-- own (a plain internal SQL call, never routed through PostgREST).
-- ---------------------------------------------------------------------
create function public.request_to_speak_internal(
  p_event_id uuid,
  p_profile_id uuid,
  p_guest_id uuid,
  p_display_name text,
  p_body text
)
returns table (message_id uuid, request_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_message_id uuid;
  v_request_id uuid;
begin
  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id
      and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
      and left_at is null
  ) then
    raise exception 'identity % is already an active speaker in event %', coalesce(p_profile_id, p_guest_id), p_event_id;
  end if;

  if exists (
    select 1 from public.speaker_requests
    where event_id = p_event_id
      and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
      and status = 'pending'
  ) then
    raise exception 'identity % already has a pending request in event %', coalesce(p_profile_id, p_guest_id), p_event_id;
  end if;

  insert into public.event_chat_messages (event_id, author_profile_id, author_guest_id, author_display_name, body, is_speaker_request)
  values (p_event_id, p_profile_id, p_guest_id, p_display_name, p_body, true)
  returning id into v_message_id;

  insert into public.speaker_requests (event_id, profile_id, guest_id, message_id)
  values (p_event_id, p_profile_id, p_guest_id, v_message_id)
  returning id into v_request_id;

  return query select v_message_id, v_request_id;
end;
$$;

-- ---------------------------------------------------------------------
-- request_to_speak: UNCHANGED self-service shape (auth.uid()-derived,
-- granted to authenticated) — kept as its own function rather than
-- folded into one signature with the guest path, because its
-- authorization mechanism is genuinely different (auth.uid() can't be
-- spoofed by the caller; there is no guest equivalent), not just a
-- different parameter. Now delegates to the shared internal function.
-- ---------------------------------------------------------------------
create or replace function public.request_to_speak(p_event_id uuid, p_body text)
returns table (message_id uuid, request_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile_id uuid := auth.uid();
  v_display_name text;
begin
  if v_profile_id is null then
    raise exception 'request_to_speak requires an authenticated caller';
  end if;

  select display_name into v_display_name from public.profiles where id = v_profile_id;
  if v_display_name is null then
    raise exception 'profile % does not exist', v_profile_id;
  end if;

  return query select * from public.request_to_speak_internal(p_event_id, v_profile_id, null, v_display_name, p_body);
end;
$$;

-- ---------------------------------------------------------------------
-- request_to_speak_as_guest: new, service_role-only entry point. Takes
-- an explicit p_guest_id/p_display_name rather than deriving them —
-- there is no auth.uid() equivalent for guests, so this can only be
-- safely called by already-trusted server code (the Server Action, which
-- resolves the guest id from the httpOnly cookie server-side and never
-- accepts it as client input), never granted to anon.
-- ---------------------------------------------------------------------
create function public.request_to_speak_as_guest(
  p_event_id uuid,
  p_guest_id uuid,
  p_display_name text,
  p_body text
)
returns table (message_id uuid, request_id uuid)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query select * from public.request_to_speak_internal(p_event_id, null, p_guest_id, p_display_name, p_body);
end;
$$;

grant execute on function public.request_to_speak_as_guest(uuid, uuid, text, text) to service_role;
revoke execute on function public.request_to_speak_as_guest(uuid, uuid, text, text) from public;

-- ---------------------------------------------------------------------
-- withdraw_speaker_request_as_guest: same split as request_to_speak —
-- self-service path (withdraw_speaker_request) unchanged, new
-- service_role-only guest path.
-- ---------------------------------------------------------------------
create function public.withdraw_speaker_request_as_guest(p_event_id uuid, p_guest_id uuid)
returns public.speaker_requests
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.speaker_requests;
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

  return v_row;
end;
$$;

grant execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) to service_role;
revoke execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- leave_speaker_seat_as_guest: same split as leave_speaker_seat — a
-- seated guest needs a voluntary-leave path too (RoomControls' existing
-- "Leave the stage" control is identity-agnostic and will call this for
-- a guest speaker). Self-service isn't possible for guests the same way
-- (no auth.uid()), so this is service_role-only, called with the
-- server-resolved guest id.
-- ---------------------------------------------------------------------
create function public.leave_speaker_seat_as_guest(p_event_id uuid, p_guest_id uuid)
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

  return v_row;
end;
$$;

grant execute on function public.leave_speaker_seat_as_guest(uuid, uuid) to service_role;
revoke execute on function public.leave_speaker_seat_as_guest(uuid, uuid) from public;

-- ---------------------------------------------------------------------
-- rank_pending_speaker_requests: inner join on profiles dropped guest
-- rows entirely (a guest has no profiles row) — changed to a left join,
-- with a guest's reputation tiebreak treated as the same neutral
-- baseline every current account already has (nothing mutates
-- reputation_score yet regardless — see DECISIONS.md's issue #14 entry).
-- The OUT parameter list is also changing (new guest_id column), which
-- Postgres won't allow via CREATE OR REPLACE — same drop-first pattern
-- as claim_speaker_seat/end_speaker_seat above.
-- ---------------------------------------------------------------------
drop function public.rank_pending_speaker_requests(uuid);

create function public.rank_pending_speaker_requests(p_event_id uuid)
returns table (request_id uuid, profile_id uuid, guest_id uuid, message_id uuid, rank bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    sr.id as request_id,
    sr.profile_id,
    sr.guest_id,
    sr.message_id,
    row_number() over (
      order by count(r.id) desc, coalesce(p.reputation_score, 0) desc, sr.created_at asc
    ) as rank
  from public.speaker_requests sr
  left join public.profiles p on p.id = sr.profile_id
  left join public.event_chat_message_reactions r on r.message_id = sr.message_id
  where sr.event_id = p_event_id and sr.status = 'pending'
  group by sr.id, sr.profile_id, sr.guest_id, sr.message_id, p.reputation_score, sr.created_at;
$$;

grant execute on function public.rank_pending_speaker_requests(uuid) to service_role;
revoke execute on function public.rank_pending_speaker_requests(uuid) from public;
