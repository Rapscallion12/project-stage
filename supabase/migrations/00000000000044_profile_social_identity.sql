-- Issue #29 (first profile/social-identity pass): extends the existing
-- `profiles` table (created migration 00000000000001) rather than
-- building a parallel identity system — audited first, per explicit
-- instruction. `profiles` already has exactly one row per account,
-- auto-provisioned on signup, `display_name`, and `created_at` (used
-- directly as "joined date" — no new column needed for that). This
-- migration adds everything else V1 profiles need: a unique public
-- username, avatar, bio, and social links.
--
-- ---------------------------------------------------------------------
-- username: nullable (existing accounts have none until they choose
-- one — see the doc comment on `public_profiles` below for why "no
-- username yet" means "no public profile yet," not a broken account),
-- stored already-normalized to lowercase (case-insensitive uniqueness
-- via a plain unique constraint on the stored value, rather than a
-- second display-case column + a functional index — the simpler of the
-- two correct options, and matches how most platforms with case-
-- insensitive handles actually store them). `@`-free (the `@` is a
-- presentation prefix, added only when displaying/routing, never
-- stored). Reserved names blocked at the database layer, not just in
-- the client, so this constraint holds regardless of which code path
-- writes it.
-- ---------------------------------------------------------------------
alter table public.profiles
  add column username text unique,
  add column avatar_url text,
  add column bio text,
  add column social_links jsonb not null default '{}'::jsonb,
  add constraint username_format check (
    username is null or username ~ '^[a-z0-9_]{3,20}$'
  ),
  add constraint username_not_reserved check (
    username is null or username <> all (array[
      'admin', 'api', 'login', 'logout', 'signup', 'events', 'profile', 'profiles',
      'dev', 'join', 'auth', 'settings', 'about', 'support', 'help', 'terms',
      'privacy', 'contact', 'null', 'undefined', 'root', 'staff', 'moderator',
      'system', 'virtualstage', 'virtual-stage', 'home', 'www', 'mail', 'ftp',
      'blog', 'app', 'static', 'public', 'assets', 'favicon', 'me', 'you'
    ])
  ),
  add constraint bio_length check (bio is null or char_length(bio) <= 160);

-- ---------------------------------------------------------------------
-- public_profiles: the one and only surface a guest (anon) ever reads
-- profile data through. Deliberately NOT `security_invoker` — unlike
-- `event_speakers_active` (which uses `security_invoker = true` because
-- its own base table already has a public-select RLS policy for the
-- querying role), `profiles`' own base-table RLS is staying exactly
-- authenticated-only, unchanged by this migration. This view is the
-- intended exception to that: an explicit, narrow, owner-rights view
-- (Postgres's standard "restricted public slice of a sensitive table"
-- pattern) that reads through regardless of the querying role's own
-- RLS on the base table — its own explicit column list *is* the entire
-- security boundary, not an afterthought. `reliability_score`/
-- `reputation_score` (internal MVP fields, never meant for public
-- display — see migration 00000000000001) are deliberately excluded by
-- simply not being in this list; the raw `id` (the same value as
-- `auth.users.id`) is included because `follows` rows and internal
-- joins need it, but no normal public-facing URL in this app ever
-- surfaces it directly — `/profile/[username]` is the public URL, never
-- `/profile/[id]`.
--
-- `where username is not null`: an account that hasn't chosen a
-- username yet has no public profile at all — nothing to view, nothing
-- to link to. This is what makes "prompted to choose a username when
-- completing their profile" a real invariant rather than a suggestion:
-- there is no route that can resolve them until they do.
--
-- An explicit column list, not `select *` — the exact discipline
-- migration 00000000000042 established after `event_speakers_active`'s
-- own frozen-`select *` bug: a future column added to `profiles` now
-- requires a conscious decision (and a migration) to expose it here,
-- never an automatic, invisible leak.
-- ---------------------------------------------------------------------
create view public.public_profiles as
  select
    id,
    username,
    display_name,
    avatar_url,
    bio,
    social_links,
    created_at
  from public.profiles
  where username is not null;

grant select on public.public_profiles to anon, authenticated;

-- ---------------------------------------------------------------------
-- follows: minimal follower/following relationship. Composite primary
-- key (not a surrogate id) structurally forbids a duplicate follow row
-- outright — "follow" is idempotent by construction (a second insert of
-- the same pair is a unique-violation the repository layer treats as
-- "already following," never a new row). The check constraint blocks
-- self-follow at the same authoritative layer, not just in the UI.
-- ---------------------------------------------------------------------
create table public.follows (
  follower_id uuid not null references public.profiles (id) on delete cascade,
  following_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, following_id),
  constraint no_self_follow check (follower_id <> following_id)
);

-- Reverse-direction lookups (a profile's own follower list/count) hit
-- this constantly; the primary key itself only serves follower_id-first
-- lookups (a profile's own following list/count) efficiently.
create index follows_following_id_idx on public.follows (following_id);

alter table public.follows enable row level security;

-- Public read — follower/following counts (and, if a future pass adds
-- list views) are meant to be visible to guests viewing a profile, per
-- this pass's own explicit instruction: "Guests viewing profiles should
-- be able to see follower/following counts."
create policy "Follows are publicly viewable"
  on public.follows for select
  to anon, authenticated
  using (true);

-- A caller may only ever create a follow row where *they* are the
-- follower — never on another identity's behalf.
create policy "Users can follow as themselves"
  on public.follows for insert
  to authenticated
  with check (follower_id = auth.uid());

-- Unfollow: may only delete their own follow rows.
create policy "Users can unfollow as themselves"
  on public.follows for delete
  to authenticated
  using (follower_id = auth.uid());

grant select on public.follows to anon, authenticated;
grant insert, delete on public.follows to authenticated;

-- ---------------------------------------------------------------------
-- Avatar storage: no Supabase Storage bucket exists anywhere in this
-- project yet (checked before writing this — grepped every migration
-- and every source file). A public bucket, scoped storage paths
-- (`{auth.uid()}/...`), and RLS on `storage.objects` are the standard,
-- minimal-safe pattern for user-owned public images — not a bespoke
-- media-management system.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 5242880, array['image/jpeg', 'image/png', 'image/webp']);

-- Public read — avatars are public images by nature (the whole point is
-- other viewers, including guests, see them).
create policy "Avatar images are publicly viewable"
  on storage.objects for select
  to anon, authenticated
  using (bucket_id = 'avatars');

-- Write access scoped to the caller's own folder
-- (`{auth.uid()}/<filename>`) — `storage.foldername` splits the object
-- path on `/` and returns it as a text array; index 1 is the top-level
-- folder segment. A user can never write into another user's folder,
-- upload/overwrite (`upsert`) their own avatar, or delete it.
create policy "Users can upload their own avatar"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can update their own avatar"
  on storage.objects for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy "Users can delete their own avatar"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
