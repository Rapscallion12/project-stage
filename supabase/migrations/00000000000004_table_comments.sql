-- Schema-level documentation, mirroring ARCHITECTURE.md's Data model
-- section. Zero-risk (COMMENT ON changes no structure, privileges, or
-- data) — this migration doubles as the first end-to-end proof that the
-- CLI workflow (write locally, apply via `supabase db push`) actually
-- works against the linked project, without hand-pasting SQL into the
-- dashboard.
comment on table public.profiles is
  'One row per account (never per guest). See ARCHITECTURE.md''s Guest identity section.';
comment on table public.events is
  'Scheduled sessions. No room/speaker columns by design — see this table''s creation comment in 00000000000003.';
comment on table public.event_chat_messages is
  'Pre-show lobby chat, scoped to the event. Guest-eligible via author_profile_id XOR author_guest_id.';
comment on table public.event_chat_message_reactions is
  'Message upvotes. Insert-only for everyone — see this table''s creation comment in 00000000000003 for why.';
