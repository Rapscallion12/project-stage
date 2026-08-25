-- Issue #18 unified inactive-speaker finding: a speaker seat is scarce —
-- what matters to the product is whether the occupant is meaningfully
-- present, not just whether LiveKit is technically connected. This adds
-- a second, independent grace-period clock for "still connected, but
-- publishing no usable media at all" (both camera and microphone
-- off/muted), reusing the *same* 11-second deadline and release shape
-- migration 00000000000016 already built for a genuine LiveKit
-- disconnect — but as its own column/functions, not by repurposing
-- disconnected_at, so the actual cause stays inspectable in storage.
-- Unlike a disconnect (LiveKit's own webhook reports it), mute state has
-- no server-observable signal in this app at all — this clock can only
-- ever be started/cleared by the speaker's own client reporting what it
-- observes, with the server still owning the authoritative deadline and
-- release decision once told. See src/lib/speaker-presence.ts (the one
-- place both causes collapse into a single `speakerPresence` value) and
-- DECISIONS.md.

alter table public.event_speakers
  add column media_inactive_since timestamptz;

-- New release reason, distinct from 'disconnected' — same seat-release
-- outcome, different cause, kept distinguishable. The original
-- left_reason CHECK (migration 00000000000005) was an unnamed inline
-- column constraint, so its actual generated name is looked up rather
-- than assumed — safer than hardcoding Postgres's default
-- <table>_<column>_check naming against a real shared database.
do $$
declare
  v_constraint_name text;
begin
  select conname into v_constraint_name
  from pg_constraint
  where conrelid = 'public.event_speakers'::regclass
    and contype = 'c'
    and pg_get_constraintdef(oid) ilike '%left_reason%';

  if v_constraint_name is not null then
    execute format('alter table public.event_speakers drop constraint %I', v_constraint_name);
  end if;
end $$;

alter table public.event_speakers
  add constraint event_speakers_left_reason_check check (
    left_reason in ('voluntary', 'replaced', 'moderator_removed', 'event_ended', 'disconnected', 'inactive')
  );

-- ---------------------------------------------------------------------
-- mark_speaker_media_inactive: starts the media-inactivity clock.
-- Mirrors mark_speaker_disconnected exactly (migration 00000000000016)
-- except for what triggers it: the *only* intended caller is the
-- speaker's own connected client, once it observes canPublish with no
-- usable outgoing media (see isLocalMediaInactive) — there's no
-- server-side signal to trust instead, unlike a disconnect. That's a
-- real, deliberate difference in trust model from mark_speaker_disconnected
-- (server-to-server webhook only): the client is trusted to *start* its
-- own grace period honestly, the same way it's already trusted to
-- report its own mute/camera state for every other purpose in this app
-- (there is no adversarial concern here, only an accidental-idle one —
-- see DECISIONS.md). The client is never trusted to *release* the seat
-- itself, same as every other grace-period path: only
-- release_expired_inactive_speaker's own re-derivation from Postgres's
-- clock does that.
--
-- Idempotent by construction: only sets media_inactive_since if it's
-- currently null, so a duplicate report never restarts the clock. A
-- safe no-op for an identity with no active seat.
-- ---------------------------------------------------------------------
create function public.mark_speaker_media_inactive(
  p_event_id uuid,
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
    raise exception 'mark_speaker_media_inactive requires exactly one of p_profile_id/p_guest_id';
  end if;

  update public.event_speakers
  set media_inactive_since = now()
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
    and media_inactive_since is null
  returning * into v_row;

  if v_row.id is null then
    select * into v_row
    from public.event_speakers
    where event_id = p_event_id
      and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
      and left_at is null;
  end if;

  return v_row;
end;
$$;

grant execute on function public.mark_speaker_media_inactive(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- mark_speaker_media_active: clears the media-inactivity clock — called
-- by the speaker's own client the instant either camera or microphone
-- becomes active again (either alone is enough; see
-- isLocalMediaInactive). Scoped to the identity's own active seat row
-- only, same no-op-for-a-reassigned-seat safety as
-- mark_speaker_reconnected.
-- ---------------------------------------------------------------------
create function public.mark_speaker_media_active(
  p_event_id uuid,
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
    raise exception 'mark_speaker_media_active requires exactly one of p_profile_id/p_guest_id';
  end if;

  update public.event_speakers
  set media_inactive_since = null
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.mark_speaker_media_active(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- release_expired_inactive_speaker: the unified, server-authoritative
-- expiration enforcement for *either* cause — a single atomic UPDATE,
-- same race-safety shape as release_expired_disconnected_speaker
-- (migration 00000000000016), just with an OR across both clocks. If
-- either mark_speaker_reconnected or mark_speaker_media_active already
-- cleared its own field (a genuine recovery, however close to the
-- boundary), that half of the OR simply stops matching — a stale/late
-- caller can never evict someone who already recovered via the other
-- clock either, since both conditions are re-checked in the same
-- statement, not decided ahead of time by the caller.
--
-- left_reason records which cause actually crossed the threshold at
-- release time (only meaningful when both could theoretically be set —
-- ordinarily exactly one is) — 'disconnected' if the connection clock
-- expired, 'inactive' otherwise. This is the function every caller
-- should use going forward; release_expired_disconnected_speaker is
-- left exactly as it was (not removed) since nothing about a pure
-- disconnect check is wrong, it's just narrower than what the product
-- now needs.
-- ---------------------------------------------------------------------
create function public.release_expired_inactive_speaker(
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
    and (
      (disconnected_at is not null and disconnected_at <= now() - (p_grace_seconds || ' seconds')::interval)
      or
      (media_inactive_since is not null and media_inactive_since <= now() - (p_grace_seconds || ' seconds')::interval)
    )
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.release_expired_inactive_speaker(uuid, integer, uuid, uuid) to service_role;
