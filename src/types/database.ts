/**
 * Hand-written Supabase database types, kept in sync with
 * `supabase/migrations/`. Once a real Supabase project exists, replace this
 * file by running:
 *
 *   npx supabase gen types typescript --project-id <id> > src/types/database.ts
 *
 * Until then, this file is the source of truth for the app's view of the
 * schema and must be updated by hand alongside any new migration.
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
      };
    };
  };
};
