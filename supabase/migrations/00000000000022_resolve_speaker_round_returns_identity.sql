-- Issue #21: resolve_speaker_round now also returns the occupancy row's
-- own event_id/profile_id/guest_id alongside the outcome — needed so
-- the calling Server Action can immediately revoke LiveKit publish
-- rights on a replacement outcome, the same "instant revoke, not left
-- to the next token request" discipline ARCHITECTURE.md's LiveKit
-- authorization model already requires for every other eviction path
-- (see checkAndEvictInactiveSpeaker). Returned unconditionally (even for
-- a no-op outcome) so the caller never needs a second fetch either way.
drop function public.resolve_speaker_round(uuid);

create function public.resolve_speaker_round(p_event_speakers_id uuid)
returns table (outcome text, event_id uuid, profile_id uuid, guest_id uuid)
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
    return query select 'no-active-occupancy'::text, null::uuid, null::uuid, null::uuid;
    return;
  end if;

  if v_row.round_phase = 'closing' then
    if now() < v_row.closing_ends_at then
      return query select 'closing-not-yet-expired'::text, v_row.event_id, v_row.profile_id, v_row.guest_id;
      return;
    end if;
    update public.event_speakers set left_at = now(), left_reason = 'replaced' where id = p_event_speakers_id;
    delete from public.speaker_round_votes where event_speakers_id = p_event_speakers_id;
    return query select 'replaced-after-closing'::text, v_row.event_id, v_row.profile_id, v_row.guest_id;
    return;
  end if;

  if now() < v_row.round_ends_at then
    return query select 'active-not-yet-expired'::text, v_row.event_id, v_row.profile_id, v_row.guest_id;
    return;
  end if;

  select count(*) filter (where choice = 'continue'), count(*) filter (where choice = 'replace')
  into v_continue_count, v_replace_count
  from public.speaker_round_votes
  where event_speakers_id = p_event_speakers_id;

  v_total := v_continue_count + v_replace_count;

  if v_total = 0 or v_replace_count * 100 <= 50 * v_total then
    update public.event_speakers
    set round_number = round_number + 1,
        round_started_at = now(),
        round_ends_at = now() + interval '60 seconds'
    where id = p_event_speakers_id;
    delete from public.speaker_round_votes where event_speakers_id = p_event_speakers_id;
    return query select 'continue'::text, v_row.event_id, v_row.profile_id, v_row.guest_id;
    return;
  end if;

  if v_replace_count * 100 >= 66 * v_total then
    update public.event_speakers set left_at = now(), left_reason = 'replaced' where id = p_event_speakers_id;
    delete from public.speaker_round_votes where event_speakers_id = p_event_speakers_id;
    return query select 'decisive-replace'::text, v_row.event_id, v_row.profile_id, v_row.guest_id;
    return;
  end if;

  update public.event_speakers
  set round_phase = 'closing', closing_ends_at = now() + interval '30 seconds'
  where id = p_event_speakers_id;
  return query select 'narrow-loss'::text, v_row.event_id, v_row.profile_id, v_row.guest_id;
end;
$$;

grant execute on function public.resolve_speaker_round(uuid) to service_role;
revoke execute on function public.resolve_speaker_round(uuid) from public;
