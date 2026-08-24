-- Issue #18 UX finding: the LiveKit webhook (api/livekit/webhook/route.ts)
-- used to call end_speaker_seat the instant participant_left fired — no
-- grace period at all, server-side. A client-side hook
-- (useSpeakerReconnectGrace) layered a *visual* "Speaker reconnecting…"
-- state on top of that, comparing DB occupancy against LiveKit's live
-- participant list and, after its own local timer, asking the server to
-- re-check — but the seat itself was already gone the instant LiveKit
-- reported the disconnect. This migration makes the grace period genuinely
-- server-authoritative: a disconnect starts a clock stored in Postgres
-- (disconnected_at), and only a stale-enough disconnected_at — computed by
-- Postgres itself, not trusted from any caller — ever actually releases the
-- seat. See DECISIONS.md for the full design.

alter table public.event_speakers
  add column disconnected_at timestamptz;

-- ---------------------------------------------------------------------
-- mark_speaker_disconnected: starts the grace period. The *only* intended
-- caller is the LiveKit webhook's participant_left handler, right after it
-- verifies LiveKit's own webhook signature — same trusted-server-only tier
-- as end_speaker_seat, for the same reason (no anon/authenticated grant).
--
-- Idempotent by construction: only sets disconnected_at if it's currently
-- null, so a duplicate/retried participant_left delivery for the same
-- disconnect never restarts the clock. If the identity has no active seat
-- (never seated, or already released), this is a safe no-op — same
-- philosophy as end_speaker_seat's own no-op case.
-- ---------------------------------------------------------------------
create function public.mark_speaker_disconnected(
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
    raise exception 'mark_speaker_disconnected requires exactly one of p_profile_id/p_guest_id';
  end if;

  update public.event_speakers
  set disconnected_at = now()
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
    and disconnected_at is null
  returning * into v_row;

  if v_row.id is null then
    -- Already marked disconnected (duplicate delivery), already released
    -- some other way, or never seated — return whatever active seat (if
    -- any) currently exists rather than a bare null, so a caller can
    -- still tell "no active seat at all" apart from "already marked."
    select * into v_row
    from public.event_speakers
    where event_id = p_event_id
      and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
      and left_at is null;
  end if;

  return v_row;
end;
$$;

grant execute on function public.mark_speaker_disconnected(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- mark_speaker_reconnected: clears the grace-period clock. The intended
-- caller is the LiveKit webhook's participant_joined handler — the same
-- authoritative, server-to-server signal disconnection uses, not
-- anything the client asserts about itself. Scoped to the identity's
-- *own* active seat row only (never by seat_number), which is exactly
-- what makes a stale reconnect signal for an already-released/reclaimed
-- seat a harmless no-op: that identity's row is no longer the active one
-- for that seat (left_at is already set), so this WHERE clause simply
-- doesn't match it — it can never reach across to a *different*
-- identity's row for the same seat_number.
-- ---------------------------------------------------------------------
create function public.mark_speaker_reconnected(
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
    raise exception 'mark_speaker_reconnected requires exactly one of p_profile_id/p_guest_id';
  end if;

  update public.event_speakers
  set disconnected_at = null
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.mark_speaker_reconnected(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------
-- release_expired_disconnected_speaker: the actual, server-authoritative
-- expiration enforcement. Called opportunistically from a connected
-- client's local trigger (useSpeakerReconnectGrace) once it estimates the
-- grace period has elapsed for a seat it's watching — but, exactly like
-- checkAndEvictDisconnectedSpeaker before it, that caller is never
-- trusted directly: this function re-derives the real decision from
-- Postgres's own clock and the row's own disconnected_at, and only
-- releases if that math actually clears the threshold right now.
--
-- Race safety is the WHERE clause, not a separate check-then-write step:
-- a single UPDATE, atomic per row in Postgres. If mark_speaker_reconnected
-- already cleared disconnected_at (a genuine reconnect, however close to
-- the boundary), disconnected_at is not null fails and nothing happens —
-- a stale/late-firing caller can never evict someone who already
-- reconnected. If some earlier call already released the seat, left_at is
-- null fails too. Both guards live in the same statement, so there is no
-- window between "decide" and "write" for a concurrent reconnect (or a
-- second release attempt) to land in.
-- ---------------------------------------------------------------------
create function public.release_expired_disconnected_speaker(
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
    raise exception 'release_expired_disconnected_speaker requires exactly one of p_profile_id/p_guest_id';
  end if;

  update public.event_speakers
  set left_at = now(), left_reason = 'disconnected'
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
    and left_at is null
    and disconnected_at is not null
    and disconnected_at <= now() - (p_grace_seconds || ' seconds')::interval
  returning * into v_row;

  return v_row;
end;
$$;

grant execute on function public.release_expired_disconnected_speaker(uuid, integer, uuid, uuid) to service_role;
