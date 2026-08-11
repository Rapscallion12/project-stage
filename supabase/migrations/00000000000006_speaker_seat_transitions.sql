-- Issue #13: the write path for who occupies a speaker seat. Migration
-- 00000000000005 defined event_speakers as append-only and deliberately
-- left it read-only from the app's perspective — this migration adds the
-- three functions that are now the *only* way a row in that table changes,
-- plus one schema tightening they all depend on. See DECISIONS.md for the
-- full authorization-model reasoning summarized in each function's comment
-- below.

-- Exactly one ACTIVE seat per profile per event, mirroring the existing
-- "one active occupant per seat" index from migration 00000000000005.
-- Nothing before this prevented the same profile from holding two seats in
-- the same event at once; the functions below rely on this constraint to
-- reject that case with a clear Postgres error rather than allowing it
-- silently.
create unique index event_speakers_active_profile_uniq
  on public.event_speakers (event_id, profile_id)
  where left_at is null;

-- ---------------------------------------------------------------------
-- leave_speaker_seat: self-service voluntary leave.
--
-- Ends the CALLER's own active occupancy (found via auth.uid(), never a
-- profile_id parameter) with left_reason = 'voluntary'. auth.uid() being
-- the caller's own identity IS the authorization here — this function can
-- only ever end the seat of whoever is calling it, so it's safe to expose
-- broadly. No UI calls this yet (issue #3/#6 build the room and its
-- controls); it ships as a tested primitive, same pattern issues #1 and #2
-- already established for this feature.
-- ---------------------------------------------------------------------
create function public.leave_speaker_seat(p_event_id uuid)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
begin
  if auth.uid() is null then
    raise exception 'leave_speaker_seat requires an authenticated caller';
  end if;

  update public.event_speakers
  set left_at = now(), left_reason = 'voluntary'
  where event_id = p_event_id
    and profile_id = auth.uid()
    and left_at is null
  returning * into v_row;

  if v_row.id is null then
    raise exception 'no active seat found for this caller in this event';
  end if;

  return v_row;
end;
$$;

grant execute on function public.leave_speaker_seat(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- claim_speaker_seat: atomic assignment/replacement.
--
-- Ends whoever currently holds the target seat (left_reason = 'replaced')
-- and inserts p_profile_id as the new occupant, as a single atomic
-- operation. The partial unique indexes are the actual race-safety
-- backstop if two callers target the same seat (or the same profile)
-- concurrently — the existence check below is only a friendlier early
-- error; the loser of a genuine race gets a 23505 from the INSERT itself,
-- never a double-booked seat.
--
-- Deliberately NOT self-service: takes an explicit p_profile_id rather
-- than reading auth.uid(), and EXECUTE is deliberately not granted to
-- anon/authenticated below — only service_role can call this. This is a
-- server-side primitive only. Phase 3's queue/voting system (not built
-- yet) is what will decide *who* is allowed to claim a seat and when;
-- this function only guarantees that whatever assignment decision gets
-- made lands atomically and race-safely. Granting this to any
-- authenticated caller today would let anyone seize the microphone from
-- the current speaker at will — exactly the failure mode PRODUCT.md's
-- "the audience controls the stage" principle exists to prevent. See
-- DECISIONS.md's authorization-model entry for issue #13.
-- ---------------------------------------------------------------------
create function public.claim_speaker_seat(p_event_id uuid, p_profile_id uuid, p_seat_number smallint)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
begin
  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id and profile_id = p_profile_id and left_at is null
  ) then
    raise exception 'profile % already holds an active seat in event %', p_profile_id, p_event_id;
  end if;

  update public.event_speakers
  set left_at = now(), left_reason = 'replaced'
  where event_id = p_event_id
    and seat_number = p_seat_number
    and left_at is null;

  insert into public.event_speakers (event_id, profile_id, seat_number)
  values (p_event_id, p_profile_id, p_seat_number)
  returning * into v_row;

  return v_row;
end;
$$;

-- No grant to anon/authenticated — see the function comment above.
-- Explicit grant to service_role for the same reason every table grant in
-- this project is explicit (see ARCHITECTURE.md's Data model section):
-- Supabase's service_role bypasses RLS/grants by default, but calling that
-- out in code rather than relying on it silently is the established
-- discipline here.
grant execute on function public.claim_speaker_seat(uuid, uuid, smallint) to service_role;

-- ---------------------------------------------------------------------
-- end_speaker_seat: ends a specific profile's active occupancy for an
-- arbitrary valid reason, without assigning a replacement.
--
-- Same trusted-server-only tier as claim_speaker_seat, for the same root
-- reason — ending someone ELSE's occupancy isn't something auth.uid() can
-- authorize; there's no sense in which "any logged-in user" should be able
-- to remove another speaker. Today the only real caller is the LiveKit
-- webhook handler (left_reason = 'disconnected'), which independently
-- verifies LiveKit's webhook signature before ever calling this — that
-- signature check is the actual authorization; this function just trusts
-- whatever already-verified server code invokes it.
--
-- 'moderator_removed' and 'event_ended' are accepted values with no caller
-- yet: issue #7 (the moderator flag doesn't exist on profiles yet) and a
-- future event-lifecycle feature are what will authorize those, not this
-- migration. Left ready rather than guessed at.
-- ---------------------------------------------------------------------
create function public.end_speaker_seat(p_event_id uuid, p_profile_id uuid, p_reason text)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
begin
  if p_reason not in ('moderator_removed', 'event_ended', 'disconnected') then
    raise exception 'end_speaker_seat does not accept left_reason %; voluntary and replaced have their own dedicated functions', p_reason;
  end if;

  update public.event_speakers
  set left_at = now(), left_reason = p_reason
  where event_id = p_event_id
    and profile_id = p_profile_id
    and left_at is null
  returning * into v_row;

  -- Returns null (not an error) if the profile had no active seat — e.g.
  -- the disconnect webhook firing for someone who was only ever audience,
  -- never seated. A safe no-op is the correct behavior for that case, not
  -- a failure.
  return v_row;
end;
$$;

-- No grant to anon/authenticated — trusted-server-only, see comment above.
grant execute on function public.end_speaker_seat(uuid, uuid, text) to service_role;
