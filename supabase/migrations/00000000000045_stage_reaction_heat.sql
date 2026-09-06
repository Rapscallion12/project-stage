-- Interaction/UX pass: server-authoritative rate limiting for directed
-- live-stage emoji reactions (issue #21-adjacent). The reactions
-- themselves are ephemeral — delivered via Supabase Realtime broadcast,
-- never written to a table (see AGENTS.md's "Realtime traffic vs.
-- durable writes" rule: high-frequency ephemeral events persist an
-- aggregate at most, never a row per event). This table is that one
-- aggregate: one row per (event, identity), tracking a continuously
-- draining "heat" value — never individual reaction history.
--
-- Mirrors the client-visible heat meter (SpeakerControlsReactionButton)
-- closely enough that users don't see the two disagree, but this table
-- is the actual security boundary — the client's own meter is UX only
-- and is never trusted to decide whether a reaction is accepted.
--
-- Tuning constants are the function's own default parameters (see
-- below) — centralized here, mirrored in
-- src/lib/reactions/heat-constants.ts for the client-side visual meter.
-- Change both together when tuning.
create table public.stage_reaction_heat (
  event_id uuid not null references public.events (id) on delete cascade,
  profile_id uuid references public.profiles (id) on delete cascade,
  guest_id uuid,
  heat numeric not null default 0,
  in_cooldown boolean not null default false,
  updated_at timestamptz not null default now(),
  constraint stage_reaction_heat_identity_xor check ((profile_id is not null) <> (guest_id is not null))
);

create unique index stage_reaction_heat_identity_idx
  on public.stage_reaction_heat (event_id, coalesce(profile_id, guest_id));

alter table public.stage_reaction_heat enable row level security;
-- No policies: this table is never read or written directly by anon/
-- authenticated — only through record_stage_reaction_attempt below (a
-- SECURITY DEFINER function granted to service_role only), the same
-- "trusted server-only" model already established for guest-identity
-- speaker actions (see lib/supabase/service.ts's own doc comment).

-- Atomic decay-then-accept-or-reject, so concurrent rapid-fire reactions
-- from the same identity serialize on one row lock instead of racing on
-- a separate read-then-write (the same discipline every other
-- concurrency-sensitive RPC in this schema already follows). Returns
-- whether this attempt is accepted; the caller broadcasts the reaction
-- only when accepted, and never on rejection (see room/actions.ts).
--
-- Hysteresis: once in_cooldown, stays blocked until heat has actually
-- drained back down to p_cooldown_exit_heat, not merely below
-- p_max_heat — this is what prevents bouncing between blocked/unblocked
-- right at the boundary.
create function public.record_stage_reaction_attempt(
  p_event_id uuid,
  p_profile_id uuid,
  p_guest_id uuid,
  p_heat_increment numeric default 12,
  p_drain_per_second numeric default 4,
  p_max_heat numeric default 100,
  p_cooldown_exit_heat numeric default 55
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

grant execute on function public.record_stage_reaction_attempt(uuid, uuid, uuid, numeric, numeric, numeric, numeric) to service_role;
revoke execute on function public.record_stage_reaction_attempt(uuid, uuid, uuid, numeric, numeric, numeric, numeric) from public;
