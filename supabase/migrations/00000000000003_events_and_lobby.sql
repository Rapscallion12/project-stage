-- Scheduled events: the entry point for every future live session.
-- Deliberately has no room/speaker/video columns. A single event may
-- later host multiple simultaneous conversation rooms (see
-- ARCHITECTURE.md), so room-specific state belongs in a future
-- `event_rooms`-style table, never on this one — that's what keeps
-- multi-room support a schema *addition* later instead of a redesign.
create table public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text not null default '',
  scheduled_start timestamptz not null,
  lobby_opens_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint lobby_opens_before_start check (lobby_opens_at <= scheduled_start)
);

create index events_scheduled_start_idx on public.events (scheduled_start);

alter table public.events enable row level security;

create policy "Events are publicly viewable"
  on public.events for select
  to anon, authenticated
  using (true);

-- Explicit grant, not left to dashboard defaults — see the profiles-grants
-- lesson in migration 00000000000002. No insert/update/delete grant: event
-- creation isn't a feature yet (no moderator/host UI), so there's
-- deliberately no policy for it either; RLS denies by default.
grant select on public.events to anon, authenticated;

-- Pre-show lobby chat, scoped to the event (not a room) — see the events
-- comment above. When multi-room support lands, the lobby stays
-- event-level; per-room chat (if ever needed) would be a separate table.
create table public.event_chat_messages (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references public.events (id) on delete cascade,
  author_profile_id uuid references public.profiles (id) on delete set null,
  author_guest_id uuid,
  -- Snapshot of the sender's display name at send-time, not a live join to
  -- profiles: guests have no profile row to join to, and a message
  -- shouldn't visually change if an account holder renames later.
  author_display_name text not null,
  body text not null,
  created_at timestamptz not null default now(),
  -- Not "exactly one of the two" — that would break the moment an
  -- account's profile row is deleted (on delete set null would null out
  -- author_profile_id, leaving both columns null, which a stricter
  -- "exactly one" check would then reject as an update-time constraint
  -- violation on a row nobody's touching). Only forbid claiming to be
  -- both a guest and an account holder at once; RLS below is what
  -- actually enforces "exactly one, and it must be you" at insert time.
  constraint not_both_authors check (
    not (author_profile_id is not null and author_guest_id is not null)
  ),
  constraint body_not_blank check (length(btrim(body)) > 0 and length(body) <= 500)
);

create index event_chat_messages_event_id_created_at_idx
  on public.event_chat_messages (event_id, created_at);

alter table public.event_chat_messages enable row level security;

create policy "Chat messages are publicly viewable"
  on public.event_chat_messages for select
  to anon, authenticated
  using (true);

create policy "Authenticated users can send messages as themselves"
  on public.event_chat_messages for insert
  to authenticated
  with check (author_profile_id = auth.uid() and author_guest_id is null);

-- Guests are never authenticated, so this can't verify the guest_id in the
-- payload actually belongs to the requester the way auth.uid() does for
-- accounts — matching the accepted MVP limitation already documented in
-- ARCHITECTURE.md's guest-identity design (this is a public prototype
-- chat, not a system with anything private to protect per-guest).
create policy "Guests can send messages under their guest identity"
  on public.event_chat_messages for insert
  to anon
  with check (author_profile_id is null and author_guest_id is not null);

grant select, insert on public.event_chat_messages to anon, authenticated;

-- Required for Supabase Realtime's Postgres Changes to broadcast inserts.
-- Easy to forget, and forgetting it doesn't error — it just means "chat
-- never updates live," discovered only by testing, not by reading an
-- error message. Documented explicitly so it isn't missed.
alter publication supabase_realtime add table public.event_chat_messages;

-- Message reactions. Insert-only by design — there is deliberately no
-- delete policy for anyone. Allowing an account holder to delete their
-- own reaction is easy (RLS can check reactor_profile_id = auth.uid()),
-- but allowing a *guest* to un-react would require verifying which guest
-- is asking, which an anon-key request can't prove. Opening delete to any
-- anon request naming any reactor_guest_id isn't an "accepted MVP
-- limitation" the way guest vote-stuffing is (PRODUCT.md) — it's a
-- trivial, undirected griefing vector (delete everyone's reactions on
-- every message). Add-only avoids it entirely; "un-reacting" can follow
-- once real guest auth exists to make it safe.
create table public.event_chat_message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.event_chat_messages (id) on delete cascade,
  reactor_profile_id uuid references public.profiles (id) on delete cascade,
  reactor_guest_id uuid,
  emoji text not null default '👍',
  created_at timestamptz not null default now(),
  constraint not_both_reactors check (
    not (reactor_profile_id is not null and reactor_guest_id is not null)
  )
);

-- One reaction per identity per message per emoji — same
-- COALESCE(profile_id, guest_id) dedup pattern promised in
-- ARCHITECTURE.md's guest-identity/rate-limiting design.
create unique index event_chat_message_reactions_identity_uniq
  on public.event_chat_message_reactions (
    message_id, emoji, coalesce(reactor_profile_id, reactor_guest_id)
  );

alter table public.event_chat_message_reactions enable row level security;

create policy "Reactions are publicly viewable"
  on public.event_chat_message_reactions for select
  to anon, authenticated
  using (true);

create policy "Authenticated users can react as themselves"
  on public.event_chat_message_reactions for insert
  to authenticated
  with check (reactor_profile_id = auth.uid() and reactor_guest_id is null);

create policy "Guests can react under their guest identity"
  on public.event_chat_message_reactions for insert
  to anon
  with check (reactor_profile_id is null and reactor_guest_id is not null);

grant select, insert on public.event_chat_message_reactions to anon, authenticated;

alter publication supabase_realtime add table public.event_chat_message_reactions;
