-- Reaction cooldown correction (real-device report, issue #21-adjacent):
-- cooldown previously exited at p_cooldown_exit_heat = 55 (hysteresis to
-- avoid bouncing right at the boundary). Explicit product decision: once
-- a sender hits the cap and enters cooldown, sending stays blocked for
-- the *entire* drain back to genuinely empty — cooldown now only exits
-- once decayed heat has reached 0, not partway down. `CREATE OR REPLACE
-- FUNCTION` with the identical signature/body as migration 00000000000045,
-- changing only the `p_cooldown_exit_heat` default from 55 to 0 — every
-- other tuning value (+12 heat, 4/sec drain, cap 100) is unchanged, and
-- the decay/hysteresis *mechanism* itself (still atomic, still row-locked,
-- still `in_cooldown` persisted so re-entering cooldown at partial decay
-- can't happen) is untouched. See src/lib/reactions/constants.ts's own
-- REACTION_HEAT_COOLDOWN_EXIT, changed to match in the same commit — the
-- server's copy here remains the actual security boundary; the client's
-- is UX only.
create or replace function public.record_stage_reaction_attempt(
  p_event_id uuid,
  p_profile_id uuid,
  p_guest_id uuid,
  p_heat_increment numeric default 12,
  p_drain_per_second numeric default 4,
  p_max_heat numeric default 100,
  p_cooldown_exit_heat numeric default 0
)
returns table (accepted boolean, heat_after numeric, in_cooldown_after boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_now timestamptz := now();
  v_elapsed_seconds numeric;
  v_decayed_heat numeric;
  v_effective_cooldown boolean;
  v_new_heat numeric;
  v_new_cooldown boolean;
begin
  if (p_profile_id is not null) = (p_guest_id is not null) then
    raise exception 'record_stage_reaction_attempt requires exactly one of p_profile_id/p_guest_id';
  end if;

  insert into public.stage_reaction_heat (event_id, profile_id, guest_id, heat, in_cooldown, updated_at)
  values (p_event_id, p_profile_id, p_guest_id, 0, false, v_now)
  on conflict (event_id, coalesce(profile_id, guest_id)) do nothing;

  select * into v_row
  from public.stage_reaction_heat
  where event_id = p_event_id
    and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id)
  for update;

  v_elapsed_seconds := greatest(0, extract(epoch from (v_now - v_row.updated_at)));
  v_decayed_heat := greatest(0, v_row.heat - (p_drain_per_second * v_elapsed_seconds));
  v_effective_cooldown := v_row.in_cooldown and v_decayed_heat > p_cooldown_exit_heat;

  if v_effective_cooldown then
    update public.stage_reaction_heat
      set heat = v_decayed_heat, in_cooldown = true, updated_at = v_now
      where event_id = p_event_id and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id);
    return query select false, v_decayed_heat, true;
    return;
  end if;

  v_new_heat := least(p_max_heat, v_decayed_heat + p_heat_increment);
  v_new_cooldown := v_new_heat >= p_max_heat;

  update public.stage_reaction_heat
    set heat = v_new_heat, in_cooldown = v_new_cooldown, updated_at = v_now
    where event_id = p_event_id and coalesce(profile_id, guest_id) = coalesce(p_profile_id, p_guest_id);

  return query select true, v_new_heat, v_new_cooldown;
end;
$$;

-- Grants are re-established by CREATE OR REPLACE keeping the existing
-- function's ownership/ACL, but re-asserted explicitly here anyway —
-- cheap, and makes this migration's own security posture self-evident
-- without needing to cross-reference migration 00000000000045.
grant execute on function public.record_stage_reaction_attempt(uuid, uuid, uuid, numeric, numeric, numeric, numeric) to service_role;
revoke execute on function public.record_stage_reaction_attempt(uuid, uuid, uuid, numeric, numeric, numeric, numeric) from public;
