/**
 * Hand-written Supabase database types, kept in sync with
 * `supabase/migrations/`. Once the Supabase CLI is set up, replace this
 * file by running:
 *
 *   npx supabase gen types typescript --project-id <id> > src/types/database.ts
 *
 * Until then, this file is the source of truth for the app's view of the
 * schema and must be updated by hand alongside any new migration.
 *
 * Every table needs `Relationships: []` and the schema needs `Views`/
 * `Functions` (even empty) — @supabase/postgrest-js's generic constraints
 * require this exact shape, and silently fall back to `never` row types
 * everywhere if it's missing, with no type error pointing at the cause.
 * This was a latent bug in this file from the very first migration; it
 * just went unnoticed until this milestone's first `.from(...).select()`
 * call actually exercised it.
 */
export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: {
          id: string;
          display_name: string;
          reliability_score: number;
          reputation_score: number;
          created_at: string;
        };
        Insert: {
          id: string;
          display_name: string;
          reliability_score?: number;
          reputation_score?: number;
          created_at?: string;
        };
        Update: {
          id?: string;
          display_name?: string;
          reliability_score?: number;
          reputation_score?: number;
          created_at?: string;
        };
        Relationships: [];
      };
      events: {
        Row: {
          id: string;
          title: string;
          description: string;
          scheduled_start: string;
          lobby_opens_at: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          title: string;
          description?: string;
          scheduled_start: string;
          lobby_opens_at: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          title?: string;
          description?: string;
          scheduled_start?: string;
          lobby_opens_at?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      event_chat_messages: {
        Row: {
          id: string;
          event_id: string;
          author_profile_id: string | null;
          author_guest_id: string | null;
          author_display_name: string;
          body: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          event_id: string;
          author_profile_id?: string | null;
          author_guest_id?: string | null;
          author_display_name: string;
          body: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          event_id?: string;
          author_profile_id?: string | null;
          author_guest_id?: string | null;
          author_display_name?: string;
          body?: string;
          created_at?: string;
        };
        Relationships: [];
      };
      event_chat_message_reactions: {
        Row: {
          id: string;
          message_id: string;
          reactor_profile_id: string | null;
          reactor_guest_id: string | null;
          emoji: string;
          created_at: string;
        };
        Insert: {
          id?: string;
          message_id: string;
          reactor_profile_id?: string | null;
          reactor_guest_id?: string | null;
          emoji?: string;
          created_at?: string;
        };
        Update: {
          id?: string;
          message_id?: string;
          reactor_profile_id?: string | null;
          reactor_guest_id?: string | null;
          emoji?: string;
          created_at?: string;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
};
