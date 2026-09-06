-- Issue #21, eighth corrective pass: a real-device report ("Selecting
-- next speaker…" persisting indefinitely despite a visibly eligible,
-- currently-requesting candidate) was traced — after ruling out every
-- client-side cause first, per this pass's own diagnostic-first mandate
-- — to a genuine server-side bug in withdraw_speaker_request(_as_guest),
-- reproduced live against the real linked database:
--
-- Both functions' own "mark this round exhausted once nothing further
-- can come of it" check was written entirely *inside* the
-- `if v_row.is_current_candidate` branch — i.e. it only ever ran when
-- the WITHDRAWING request itself was the currently-reserved candidate.
-- A frozen-but-never-yet-reserved candidate (a real, ordinary case: two
-- candidates get frozen into one round, the higher-ranked one gets
-- reserved for the one currently-open seat, and the *other* one simply
-- withdraws before ever being reserved for anything) withdrawing
-- skipped this whole block — including the exhaustion check — leaving
-- the round sitting in `status = 'active'` forever, with no live
-- reservation and no remaining viable (`pending`, not `selection_failed`)
-- candidate. Because `freeze_speaker_candidates` (migration
-- 00000000000020) is deliberately idempotent — "if an active round
-- already exists, return its existing candidates" — every later-arriving
-- Request-to-Speak was silently invisible to selection for that seat,
-- permanently, for as long as that stale round remained "active." This
-- is not a simulator-only bug: `withdraw_speaker_request` (the real,
-- authenticated-caller path) has the identical gap.
--
-- Fix: the exhaustion check now runs whenever the withdrawing request
-- belonged to a round at all (`v_row.selection_round_id is not null`),
-- not only when it was the round's own currently-reserved candidate —
-- and checks the round's actual current health directly (no live
-- reservation left in it, AND no remaining pending/unfailed candidate
-- left in it) rather than assuming "the withdrawer wasn't reserved" means
-- "some other reservation is still fine." The runner-up-advancement
-- logic above it (only relevant when the withdrawer *was* reserved) is
-- completely unchanged. Never weakens any authorization check — this
-- only changes when a round is marked `exhausted`, never who may claim
-- a seat or which candidate is selected.
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

  if v_row.selection_round_id is not null then
    if v_row.is_current_candidate then
      update public.speaker_requests
      set is_current_candidate = false, selection_failed = true, reserved_seat_number = null
      where id = v_row.id;

      select id into v_next_id
      from public.speaker_requests
      where selection_round_id = v_row.selection_round_id
        and status = 'pending'
        and not selection_failed
        and not is_current_candidate
      order by frozen_rank
      limit 1;

      if v_next_id is not null then
        update public.speaker_requests
        set is_current_candidate = true, reserved_seat_number = v_row.reserved_seat_number
        where id = v_next_id;
      end if;
    end if;

    -- Issue #21, eighth corrective pass: mark exhausted whenever this
    -- round genuinely has no path left — no seat has a live reservation,
    -- and no still-viable candidate remains that could ever be
    -- reserved. Runs regardless of whether the *withdrawing* request was
    -- itself reserved — see this migration's own top comment for the
    -- exact gap this closes.
    if not exists (
      select 1 from public.speaker_requests
      where selection_round_id = v_row.selection_round_id and is_current_candidate
    ) and not exists (
      select 1 from public.speaker_requests
      where selection_round_id = v_row.selection_round_id and status = 'pending' and not selection_failed
    ) then
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

  if v_row.selection_round_id is not null then
    if v_row.is_current_candidate then
      update public.speaker_requests
      set is_current_candidate = false, selection_failed = true, reserved_seat_number = null
      where id = v_row.id;

      select id into v_next_id
      from public.speaker_requests
      where selection_round_id = v_row.selection_round_id
        and status = 'pending'
        and not selection_failed
        and not is_current_candidate
      order by frozen_rank
      limit 1;

      if v_next_id is not null then
        update public.speaker_requests
        set is_current_candidate = true, reserved_seat_number = v_row.reserved_seat_number
        where id = v_next_id;
      end if;
    end if;

    -- Same broadened exhaustion check as withdraw_speaker_request above.
    if not exists (
      select 1 from public.speaker_requests
      where selection_round_id = v_row.selection_round_id and is_current_candidate
    ) and not exists (
      select 1 from public.speaker_requests
      where selection_round_id = v_row.selection_round_id and status = 'pending' and not selection_failed
    ) then
      update public.speaker_selection_rounds set status = 'exhausted', resolved_at = now()
      where id = v_row.selection_round_id and status = 'active';
    end if;
  end if;

  return v_row;
end;
$$;

grant execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) to service_role;
revoke execute on function public.withdraw_speaker_request_as_guest(uuid, uuid) from public;
