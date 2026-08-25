-- Issue #18 expiration-enforcement finding (real-device report): a
-- stored deadline (disconnected_at/media_inactive_since) was not
-- enough. Nothing guaranteed release_expired_inactive_speaker actually
-- ran at the exact moment a deadline passed — it only runs when some
-- connected client's local timer estimates the deadline and asks the
-- server to check (useSpeakerReconnectGrace). Until that happens, the
-- row's own left_at stays null, and every ownership-relevant read in
-- this app (getActiveSeatForIdentity → LiveKit token minting's
-- canPublish; listActiveSpeakers → findOpenSeat's "which seat is open"
-- decision; claim_speaker_seat's/request_to_speak's own "does this
-- identity already hold a seat" guards) only ever checked left_at is
-- null — with no awareness that the row might already be logically
-- expired. The old, expired occupant could reconnect and successfully
-- republish; nobody else could be offered the seat.
--
-- The fix is a single canonical "is this occupancy row authoritatively
-- active right now" predicate, evaluated against Postgres's own now(),
-- applied to every read/write that decides seat ownership or
-- availability — so a late reconnect fails on server time alone even if
-- the physical row hasn't been cleaned up yet, exactly matching the
-- "client may trigger cleanup; server decides expiration" principle the
-- existing disconnect-grace-period design already established (migration
-- 00000000000016) and issue #18's UX finding restated explicitly this
-- round. See DECISIONS.md.

-- ---------------------------------------------------------------------
-- is_speaker_seat_active: the one predicate every ownership-relevant
-- query below is built from. A row is active iff it hasn't been ended
-- (left_at is null) AND neither inactivity clock has crossed the grace
-- period. p_grace_seconds defaults to the product's one shared 11-second
-- window (SPEAKER_DISCONNECT_GRACE_SECONDS on the TypeScript side) but
-- stays parameterized so tests can probe the boundary precisely.
-- ---------------------------------------------------------------------
create function public.is_speaker_seat_active(
  p_left_at timestamptz,
  p_disconnected_at timestamptz,
  p_media_inactive_since timestamptz,
  p_grace_seconds integer default 11
) returns boolean
language sql
stable
as $$
  select p_left_at is null
    and (p_disconnected_at is null or p_disconnected_at > now() - (p_grace_seconds || ' seconds')::interval)
    and (p_media_inactive_since is null or p_media_inactive_since > now() - (p_grace_seconds || ' seconds')::interval)
$$;

grant execute on function public.is_speaker_seat_active(timestamptz, timestamptz, timestamptz, integer) to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- event_speakers_active: the read-side half — every currently-active
-- occupancy row, using is_speaker_seat_active's default 11s grace
-- rather than the base table's own left_at is null. listActiveSpeakers
-- and getActiveSeatForIdentity (lib/repositories/event-speakers.ts) now
-- select from this view instead of the base table, so token minting's
-- canPublish and findOpenSeat's "which seat is open" decision both stop
-- trusting a row that's merely not-yet-cleaned-up as still active.
-- security_invoker so it's evaluated under the querying role's own RLS
-- visibility (the base table's own public-select policy), not the
-- view owner's — Postgres 15+, which Supabase runs.
-- ---------------------------------------------------------------------
create view public.event_speakers_active
with (security_invoker = true)
as
  select *
  from public.event_speakers
  where public.is_speaker_seat_active(left_at, disconnected_at, media_inactive_since);

grant select on public.event_speakers_active to anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- release_if_expired: the write-side half — releases an identity's own
-- row, but only if it's genuinely past its own deadline (not just "has
-- an active seat"). Called at the top of every write-path function
-- below that decides "does this identity already hold a seat," so a
-- logically-expired-but-not-yet-cleaned-up row can never block a
-- legitimate re-entry via the active-identity unique index
-- (event_speakers_active_identity_uniq). A genuinely active row is
-- left completely untouched.
-- ---------------------------------------------------------------------
create function public.release_if_expired(
  p_event_id uuid,
  p_profile_id uuid,
  p_guest_id uuid
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.event_speakers
  set left_at = now(),
      left_reason = case
        when disconnected_at is not null and disconnected_at <= now() - interval '11 seconds' then 'disconnected'
        else 'inactive'
      end
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
    and not public.is_speaker_seat_active(left_at, disconnected_at, media_inactive_since);
end;
$$;

-- Only called from other security definer functions below — no direct
-- anon/authenticated grant needed, same tier as the functions that call it.
grant execute on function public.release_if_expired(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- release_expired_inactive_speaker: redefined (same signature) to
-- delegate its threshold logic to is_speaker_seat_active rather than
-- its own separate OR-of-two-conditions — one predicate, not two
-- independently-maintained copies of the same 11-second rule.
-- Behavior is unchanged; this is a consistency refactor, not a new rule.
-- ---------------------------------------------------------------------
create or replace function public.release_expired_inactive_speaker(
  p_event_id uuid,
  p_grace_seconds integer,
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
    raise exception 'release_expired_inactive_speaker requires exactly one of p_profile_id/p_guest_id';
  end if;

  update public.event_speakers
  set left_at = now(),
      left_reason = case
        when disconnected_at is not null and disconnected_at <= now() - (p_grace_seconds || ' seconds')::interval
          then 'disconnected'
        else 'inactive'
      end
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
    and not public.is_speaker_seat_active(left_at, disconnected_at, media_inactive_since, p_grace_seconds)
  returning * into v_row;

  return v_row;
end;
$$;

-- ---------------------------------------------------------------------
-- claim_speaker_seat: redefined (same signature) to release the
-- caller's own row first if it's only *logically* still active — see
-- release_if_expired's own doc comment. Everything else (the seat-number
-- replace, the identity-guard exists-check, display_name handling) is
-- unchanged; a genuinely active existing seat still correctly raises the
-- same exception it always did.
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

  perform public.release_if_expired(p_event_id, p_profile_id, p_guest_id);

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

-- ---------------------------------------------------------------------
-- request_to_speak_internal: redefined (same signature) with the same
-- release_if_expired guard, so a genuinely-expired identity can request
-- the mic again instead of being told "already an active speaker" by a
-- row that's only technically still open.
-- ---------------------------------------------------------------------
create or replace function public.request_to_speak_internal(
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
  perform public.release_if_expired(p_event_id, p_profile_id, p_guest_id);

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
