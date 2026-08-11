-- Issue #3: the live room renders "who's speaking" entirely from
-- event_speakers (never from LiveKit's own participant/track state — see
-- DECISIONS.md) so a speaker's seat stays correctly displayed even if
-- their media has trouble. That requires a name to show for each seat,
-- and `profiles` RLS deliberately never grants `anon` a read (migration
-- 00000000000001) — guests can watch the room with no account, so a
-- guest viewer has no way to resolve `profile_id` into a display name via
-- a join.
--
-- `display_name` here is a **denormalized snapshot for public/guest
-- rendering**, the same pattern `event_chat_messages.author_display_name`
-- already established for the identical problem: guests can see who's
-- talking without needing profiles access, and a speaker's on-screen name
-- doesn't shift mid-show if they rename their account while seated.
-- `profile_id` remains the durable identity reference — every
-- authorization check, uniqueness constraint, and future join still goes
-- through it; `display_name` is presentation-only and never trusted for
-- anything else.
alter table public.event_speakers add column display_name text not null;

-- Populated by claim_speaker_seat itself from profiles.display_name at
-- the moment of assignment (never accepted as a parameter from the
-- caller) — the function already runs security definer with full table
-- access, so this is a read, not a new grant. Guarding against a null
-- lookup turns a would-be not-null-constraint violation (opaque) into a
-- clear error if p_profile_id somehow doesn't resolve to a real profile.
create or replace function public.claim_speaker_seat(p_event_id uuid, p_profile_id uuid, p_seat_number smallint)
returns public.event_speakers
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.event_speakers;
  v_display_name text;
begin
  if exists (
    select 1 from public.event_speakers
    where event_id = p_event_id and profile_id = p_profile_id and left_at is null
  ) then
    raise exception 'profile % already holds an active seat in event %', p_profile_id, p_event_id;
  end if;

  select display_name into v_display_name from public.profiles where id = p_profile_id;
  if v_display_name is null then
    raise exception 'profile % does not exist', p_profile_id;
  end if;

  update public.event_speakers
  set left_at = now(), left_reason = 'replaced'
  where event_id = p_event_id
    and seat_number = p_seat_number
    and left_at is null;

  insert into public.event_speakers (event_id, profile_id, seat_number, display_name)
  values (p_event_id, p_profile_id, p_seat_number, v_display_name)
  returning * into v_row;

  return v_row;
end;
$$;

-- So the room can subscribe to seat changes live (who joined/left a seat)
-- instead of polling — same mechanism event_chat_messages/
-- event_chat_message_reactions already use (migration 00000000000003).
-- Table-level RLS/grants are unchanged by publication membership: this
-- only controls which *changes* get broadcast to already-authorized
-- readers, it doesn't grant any new read access.
alter publication supabase_realtime add table public.event_speakers;
