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
    PostgrestVersion: "14.15"
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
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
          seat_number: number
        }
        Insert: {
          disconnected_at?: string | null
          display_name: string
          event_id: string
          guest_id?: string | null
          id?: string
          joined_at?: string
          left_at?: string | null
          left_reason?: string | null
          profile_id?: string | null
          seat_number: number
        }
        Update: {
          disconnected_at?: string | null
          display_name?: string
          event_id?: string
          guest_id?: string | null
          id?: string
          joined_at?: string
          left_at?: string | null
          left_reason?: string | null
          profile_id?: string | null
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
      speaker_requests: {
        Row: {
          created_at: string
          event_id: string
          guest_id: string | null
          id: string
          message_id: string
          profile_id: string | null
          resolved_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          event_id: string
          guest_id?: string | null
          id?: string
          message_id: string
          profile_id?: string | null
          resolved_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          event_id?: string
          guest_id?: string | null
          id?: string
          message_id?: string
          profile_id?: string | null
          resolved_at?: string | null
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
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      claim_speaker_seat: {
        Args: {
          p_event_id: string
          p_guest_display_name?: string
          p_guest_id?: string
          p_profile_id?: string
          p_seat_number: number
        }
        Returns: {
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
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
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      leave_speaker_seat: {
        Args: { p_event_id: string }
        Returns: {
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
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
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
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
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
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
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
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
          disconnected_at: string | null
          display_name: string
          event_id: string
          guest_id: string | null
          id: string
          joined_at: string
          left_at: string | null
          left_reason: string | null
          profile_id: string | null
          seat_number: number
        }
        SetofOptions: {
          from: "*"
          to: "event_speakers"
          isOneToOne: true
          isSetofReturn: false
        }
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
      withdraw_speaker_request: {
        Args: { p_event_id: string }
        Returns: {
          created_at: string
          event_id: string
          guest_id: string | null
          id: string
          message_id: string
          profile_id: string | null
          resolved_at: string | null
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
          guest_id: string | null
          id: string
          message_id: string
          profile_id: string | null
          resolved_at: string | null
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
