export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      event_chat_message_reactions: {
        Row: {
          created_at: string
          emoji: string
          id: string
          message_id: string
          reactor_guest_id: string | null
          reactor_profile_id: string | null
        }
        Insert: {
          created_at?: string
          emoji?: string
          id?: string
          message_id: string
          reactor_guest_id?: string | null
          reactor_profile_id?: string | null
        }
        Update: {
          created_at?: string
          emoji?: string
          id?: string
          message_id?: string
          reactor_guest_id?: string | null
          reactor_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_chat_message_reactions_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "event_chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_chat_message_reactions_reactor_profile_id_fkey"
            columns: ["reactor_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      event_chat_messages: {
        Row: {
          author_display_name: string
          author_guest_id: string | null
          author_profile_id: string | null
          body: string
          created_at: string
          event_id: string
          id: string
          is_speaker_request: boolean
        }
        Insert: {
          author_display_name: string
          author_guest_id?: string | null
          author_profile_id?: string | null
          body: string
          created_at?: string
          event_id: string
          id?: string
          is_speaker_request?: boolean
        }
        Update: {
          author_display_name?: string
          author_guest_id?: string | null
          author_profile_id?: string | null
          body?: string
          created_at?: string
          event_id?: string
          id?: string
          is_speaker_request?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "event_chat_messages_author_profile_id_fkey"
            columns: ["author_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_chat_messages_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      event_speakers: {
        Row: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        Insert: {
          closing_ends_at?: string | null
          disconnected_at?: string | null
          display_name: string
          event_id: string
          guest_id?: string | null
          id?: string
          joined_at?: string
          left_at?: string | null
          left_reason?: string | null
          media_inactive_since?: string | null
          profile_id?: string | null
          round_ends_at?: string
          round_number?: number
          round_phase?: string
          round_started_at?: string
          seat_number: number
        }
        Update: {
          closing_ends_at?: string | null
          disconnected_at?: string | null
          display_name?: string
          event_id?: string
          guest_id?: string | null
          id?: string
          joined_at?: string
          left_at?: string | null
          left_reason?: string | null
          media_inactive_since?: string | null
          profile_id?: string | null
          round_ends_at?: string
          round_number?: number
          round_phase?: string
          round_started_at?: string
          seat_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "event_speakers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_speakers_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string
          description: string
          format: string
          id: string
          is_permanent_test: boolean
          lobby_opens_at: string
          scheduled_start: string
          title: string
        }
        Insert: {
          created_at?: string
          description?: string
          format?: string
          id?: string
          is_permanent_test?: boolean
          lobby_opens_at: string
          scheduled_start: string
          title: string
        }
        Update: {
          created_at?: string
          description?: string
          format?: string
          id?: string
          is_permanent_test?: boolean
          lobby_opens_at?: string
          scheduled_start?: string
          title?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string
          id: string
          reliability_score: number
          reputation_score: number
        }
        Insert: {
          created_at?: string
          display_name: string
          id: string
          reliability_score?: number
          reputation_score?: number
        }
        Update: {
          created_at?: string
          display_name?: string
          id?: string
          reliability_score?: number
          reputation_score?: number
        }
        Relationships: []
      }
      speaker_request_votes: {
        Row: {
          created_at: string
          event_id: string
          id: string
          request_id: string
          voter_guest_id: string | null
          voter_profile_id: string | null
        }
        Insert: {
          created_at?: string
          event_id: string
          id?: string
          request_id: string
          voter_guest_id?: string | null
          voter_profile_id?: string | null
        }
        Update: {
          created_at?: string
          event_id?: string
          id?: string
          request_id?: string
          voter_guest_id?: string | null
          voter_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "speaker_request_votes_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaker_request_votes_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "speaker_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaker_request_votes_voter_profile_id_fkey"
            columns: ["voter_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      speaker_requests: {
        Row: {
          created_at: string
          event_id: string
          frozen_rank: number | null
          frozen_vote_count: number | null
          guest_id: string | null
          id: string
          is_current_candidate: boolean
          message_id: string
          profile_id: string | null
          resolved_at: string | null
          selection_failed: boolean
          selection_round_id: string | null
          status: string
        }
        Insert: {
          created_at?: string
          event_id: string
          frozen_rank?: number | null
          frozen_vote_count?: number | null
          guest_id?: string | null
          id?: string
          is_current_candidate?: boolean
          message_id: string
          profile_id?: string | null
          resolved_at?: string | null
          selection_failed?: boolean
          selection_round_id?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          frozen_rank?: number | null
          frozen_vote_count?: number | null
          guest_id?: string | null
          id?: string
          is_current_candidate?: boolean
          message_id?: string
          profile_id?: string | null
          resolved_at?: string | null
          selection_failed?: boolean
          selection_round_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "speaker_requests_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaker_requests_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "event_chat_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaker_requests_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaker_requests_selection_round_id_fkey"
            columns: ["selection_round_id"]
            isOneToOne: false
            referencedRelation: "speaker_selection_rounds"
            referencedColumns: ["id"]
          },
        ]
      }
      speaker_round_votes: {
        Row: {
          choice: string
          created_at: string
          event_speakers_id: string
          id: string
          voter_guest_id: string | null
          voter_profile_id: string | null
        }
        Insert: {
          choice: string
          created_at?: string
          event_speakers_id: string
          id?: string
          voter_guest_id?: string | null
          voter_profile_id?: string | null
        }
        Update: {
          choice?: string
          created_at?: string
          event_speakers_id?: string
          id?: string
          voter_guest_id?: string | null
          voter_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "speaker_round_votes_event_speakers_id_fkey"
            columns: ["event_speakers_id"]
            isOneToOne: false
            referencedRelation: "event_speakers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaker_round_votes_event_speakers_id_fkey"
            columns: ["event_speakers_id"]
            isOneToOne: false
            referencedRelation: "event_speakers_active"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "speaker_round_votes_voter_profile_id_fkey"
            columns: ["voter_profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      speaker_selection_rounds: {
        Row: {
          event_id: string
          frozen_at: string
          id: string
          resolved_at: string | null
          status: string
        }
        Insert: {
          event_id: string
          frozen_at?: string
          id?: string
          resolved_at?: string | null
          status?: string
        }
        Update: {
          event_id?: string
          frozen_at?: string
          id?: string
          resolved_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "speaker_selection_rounds_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
      stage_rounds: {
        Row: {
          ends_at: string
          event_id: string
          id: string
          phase: string
          round_number: number
          started_at: string
          updated_at: string
        }
        Insert: {
          ends_at?: string
          event_id: string
          id?: string
          phase?: string
          round_number?: number
          started_at?: string
          updated_at?: string
        }
        Update: {
          ends_at?: string
          event_id?: string
          id?: string
          phase?: string
          round_number?: number
          started_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stage_rounds_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      event_speakers_active: {
        Row: {
          disconnected_at: string | null
          display_name: string | null
          event_id: string | null
          guest_id: string | null
          id: string | null
          joined_at: string | null
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          seat_number: number | null
        }
        Insert: {
          disconnected_at?: string | null
          display_name?: string | null
          event_id?: string | null
          guest_id?: string | null
          id?: string | null
          joined_at?: string | null
          left_at?: string | null
          left_reason?: string | null
          media_inactive_since?: string | null
          profile_id?: string | null
          seat_number?: number | null
        }
        Update: {
          disconnected_at?: string | null
          display_name?: string | null
          event_id?: string | null
          guest_id?: string | null
          id?: string | null
          joined_at?: string | null
          left_at?: string | null
          left_reason?: string | null
          media_inactive_since?: string | null
          profile_id?: string | null
          seat_number?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "event_speakers_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_speakers_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      cast_speaker_request_vote: {
        Args: { p_event_id: string; p_message_id: string }
        Returns: {
          voted_request_id: string
        }[]
      }
      cast_speaker_request_vote_as_guest: {
        Args: { p_event_id: string; p_guest_id: string; p_message_id: string }
        Returns: {
          voted_request_id: string
        }[]
      }
      cast_speaker_round_vote: {
        Args: { p_choice: string; p_event_speakers_id: string }
        Returns: undefined
      }
      cast_speaker_round_vote_as_guest: {
        Args: {
          p_choice: string
          p_event_speakers_id: string
          p_guest_id: string
        }
        Returns: undefined
      }
      claim_speaker_seat: {
        Args: {
          p_bypass_selection_authorization?: boolean
          p_event_id: string
          p_guest_display_name?: string
          p_guest_id?: string
          p_profile_id?: string
          p_seat_number: number
        }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      end_speaker_seat: {
        Args: {
          p_event_id: string
          p_guest_id?: string
          p_profile_id?: string
          p_reason: string
        }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      ensure_stage_round: {
        Args: { p_event_id: string }
        Returns: {
          ends_at: string
          event_id: string
          id: string
          phase: string
          round_number: number
          started_at: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "stage_rounds"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      freeze_speaker_candidates: {
        Args: { p_event_id: string }
        Returns: {
          guest_id: string
          is_current: boolean
          message_id: string
          profile_id: string
          rank: number
          request_id: string
          round_id: string
          vote_count: number
        }[]
      }
      is_speaker_seat_active: {
        Args: {
          p_disconnected_at: string
          p_grace_seconds?: number
          p_left_at: string
          p_media_inactive_since: string
        }
        Returns: boolean
      }
      leave_speaker_seat: {
        Args: { p_event_id: string }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      leave_speaker_seat_as_guest: {
        Args: { p_event_id: string; p_guest_id: string }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mark_speaker_disconnected: {
        Args: { p_event_id: string; p_guest_id?: string; p_profile_id?: string }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mark_speaker_media_active: {
        Args: { p_event_id: string; p_guest_id?: string; p_profile_id?: string }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mark_speaker_media_inactive: {
        Args: { p_event_id: string; p_guest_id?: string; p_profile_id?: string }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      mark_speaker_reconnected: {
        Args: { p_event_id: string; p_guest_id?: string; p_profile_id?: string }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      rank_pending_speaker_requests: {
        Args: { p_event_id: string }
        Returns: {
          guest_id: string
          message_id: string
          profile_id: string
          rank: number
          request_id: string
        }[]
      }
      release_expired_disconnected_speaker: {
        Args: {
          p_event_id: string
          p_grace_seconds: number
          p_guest_id?: string
          p_profile_id?: string
        }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      release_expired_inactive_speaker: {
        Args: {
          p_event_id: string
          p_grace_seconds: number
          p_guest_id?: string
          p_profile_id?: string
        }
        Returns: {
          closing_ends_at: string | null
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          media_inactive_since: string | null
          profile_id: string | null
          round_ends_at: string
          round_number: number
          round_phase: string
          round_started_at: string
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      release_if_expired: {
        Args: { p_event_id: string; p_guest_id: string; p_profile_id: string }
        Returns: undefined
      }
      request_to_speak: {
        Args: { p_body: string; p_event_id: string }
        Returns: {
          message_id: string
          request_id: string
        }[]
      }
      request_to_speak_as_guest: {
        Args: {
          p_body: string
          p_display_name: string
          p_event_id: string
          p_guest_id: string
        }
        Returns: {
          message_id: string
          request_id: string
        }[]
      }
      request_to_speak_internal: {
        Args: {
          p_body: string
          p_display_name: string
          p_event_id: string
          p_guest_id: string
          p_profile_id: string
        }
        Returns: {
          message_id: string
          request_id: string
        }[]
      }
      reset_speaker_candidate_pool: {
        Args: { p_event_id: string; p_winning_request_id: string }
        Returns: undefined
      }
      resolve_seat_closing: {
        Args: { p_event_speakers_id: string }
        Returns: {
          out_event_id: string
          out_guest_id: string
          out_outcome: string
          out_profile_id: string
        }[]
      }
      resolve_stage_round: {
        Args: { p_event_id: string }
        Returns: {
          out_event_speakers_id: string
          out_guest_id: string
          out_outcome: string
          out_profile_id: string
        }[]
      }
      set_current_speaker_candidate: {
        Args: { p_request_id: string; p_round_id: string }
        Returns: undefined
      }
      withdraw_speaker_request: {
        Args: { p_event_id: string }
        Returns: {
          created_at: string
          event_id: string
          frozen_rank: number | null
          frozen_vote_count: number | null
          guest_id: string | null
          id: string
          is_current_candidate: boolean
          message_id: string
          profile_id: string | null
          resolved_at: string | null
          selection_failed: boolean
          selection_round_id: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "speaker_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      withdraw_speaker_request_as_guest: {
        Args: { p_event_id: string; p_guest_id: string }
        Returns: {
          created_at: string
          event_id: string
          frozen_rank: number | null
          frozen_vote_count: number | null
          guest_id: string | null
          id: string
          is_current_candidate: boolean
          message_id: string
          profile_id: string | null
          resolved_at: string | null
          selection_failed: boolean
          selection_round_id: string | null
          status: string
        }
        SetofOptions: {
          from: "*"
          to: "speaker_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
