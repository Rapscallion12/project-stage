-- Real bug caught by issue #13's own integration tests: when
-- end_speaker_seat's UPDATE...RETURNING matched zero rows (the intended
-- safe no-op for a profile with no active seat), `v_row` was never
-- assigned by a successful INTO — but an unassigned composite variable in
-- PL/pgSQL is a row of all-NULL *fields*, not SQL NULL itself. Returning
-- it produced a JSON object with every key null (`{"id": null, ...}`)
-- over PostgREST, not JSON `null` as the function's own doc comment
-- promises ("Returns null (not an error) if the profile had no active
-- seat"). `endSpeakerSeat()` in lib/repositories/event-speakers.ts checks
-- `data ?? null`, which only catches genuine JSON null — so callers
-- (including the LiveKit webhook handler, which relies on this for
-- "firing again must not throw") were getting a garbage truthy object
-- instead. Fixed with PL/pgSQL's `FOUND` variable, set by the preceding
-- UPDATE to whether it actually matched a row — the correct tool for
-- this, rather than inspecting a field of the (possibly all-null) row
-- variable.
create or replace function public.end_speaker_seat(p_event_id uuid, p_profile_id uuid, p_reason text)
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

  if not found then
    return null;
  end if;

  return v_row;
end;
$$;
