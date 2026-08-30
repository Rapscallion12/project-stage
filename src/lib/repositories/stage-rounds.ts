import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { SeatIdentity } from "@/lib/repositories/event-speakers";

/**
 * Issue #21 corrective pass: the shared round clock for a stage pairing
 * — see migration 00000000000024's own doc comment for the full
 * reasoning behind moving from independent per-speaker timers to one
 * shared deadline. Continue/Replace itself stays fully per-speaker
 * (`speaker_round_votes`, `castSpeakerRoundVote(AsGuest)` in
 * `event-speakers.ts`, both completely unchanged) — this file only
 * covers the *shared deadline* half of the round lifecycle.
 */
export type StageRoundPhase = "active" | "awaiting_pairing";

export type StageRound = {
  id: string;
  event_id: string;
  round_number: number;
  started_at: string;
  ends_at: string;
  phase: StageRoundPhase;
  updated_at: string;
  /**
   * Issue #21, fifth corrective pass: the identities of whoever was most
   * recently removed the last time both seats went empty simultaneously
   * — authoritatively excluded from the small-room direct-join fallback
   * (Sections 8-15) until a fresh two-speaker pairing is established,
   * never a client-side/timer-based ban. Publicly readable (same tier as
   * every other `stage_rounds` column) so a client can render the right
   * empty-seat state for itself without a second fetch — the real
   * enforcement is `claim_speaker_seat` re-checking this itself, never
   * trusted from here. See migration 00000000000033.
   */
  fallback_excluded_profile_ids: string[];
  fallback_excluded_guest_ids: string[];
};

export type SeatResolutionOutcome = "continue" | "narrow-loss" | "decisive-replace" | "replaced-after-closing";

export type SeatResolution = {
  eventSpeakersId: string;
  outcome: SeatResolutionOutcome;
  identity: SeatIdentity;
};

/** Publicly readable, same tier as `event_speakers_active`/`speaker_round_votes` — the live shared-timer display reads this directly. Null before any seat has ever been claimed for the event. */
export async function getStageRound(eventId: string): Promise<StageRound | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("stage_rounds").select("*").eq("event_id", eventId).maybeSingle();
  return (data as StageRound | null) ?? null;
}

/**
 * Issue #21, third corrective pass: "has this event's stage ever
 * achieved its initial two-speaker pairing" — the authoritative,
 * permanent (never reverts once true) signal that separates initial
 * stage formation (direct seat joins permitted) from ongoing replacement
 * (seat claims require Request-to-Speak selection authorization — see
 * migration 00000000000029's `claim_speaker_seat`). `round_number` only
 * ever reaches 1, and never returns to 0, once `ensure_stage_round` has
 * seen both seats occupied simultaneously at least once — reusing that
 * existing fact rather than a new column. `joinOpenSeat` (room/actions.ts)
 * reads this to return a clean, typed rejection before ever attempting a
 * claim the database would reject anyway; the database's own check
 * (inside `claim_speaker_seat` itself) remains the actual authoritative
 * enforcement, this is purely for a better error message.
 */
export async function isStageEstablished(eventId: string): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.from("stage_rounds").select("round_number").eq("event_id", eventId).maybeSingle();
  return (data?.round_number ?? 0) >= 1;
}

/**
 * The shared round's one authoritative resolution — see migration
 * 00000000000024's `resolve_stage_round` for the full per-seat decision
 * (mirrors `lib/speaker-round.ts`'s `resolveRoundOutcome` exactly, once
 * independently per occupied seat, against the one shared deadline).
 * Trusted-server-only; always safe to call early, late, or repeatedly —
 * a no-op unless a round genuinely exists, is active, and has actually
 * reached its deadline. Returns one entry per occupied seat that was
 * resolved (zero entries when it was a no-op).
 */
export async function resolveStageRound(eventId: string): Promise<SeatResolution[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("resolve_stage_round", { p_event_id: eventId });
  if (error) {
    throw new Error(error.message);
  }
  return (data ?? [])
    .filter((row) => row.out_profile_id !== null || row.out_guest_id !== null)
    .map((row) => ({
      eventSpeakersId: row.out_event_speakers_id!,
      outcome: row.out_outcome as SeatResolutionOutcome,
      identity: row.out_profile_id
        ? { type: "profile" as const, id: row.out_profile_id }
        : { type: "guest" as const, id: row.out_guest_id! },
    }));
}

/**
 * An individual narrow-loss speaker's own 30-second closing period —
 * deliberately separate from `resolveStageRound` (Part 4's "the other
 * speaker should not be forced into that final-30 state"). See
 * migration 00000000000024's `resolve_seat_closing`. Returns `null` for
 * a no-op (not yet expired, or no such closing seat).
 */
export async function resolveSeatClosing(eventSpeakersId: string): Promise<{ eventId: string; identity: SeatIdentity } | null> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("resolve_seat_closing", { p_event_speakers_id: eventSpeakersId });
  if (error) {
    throw new Error(error.message);
  }
  const row = data?.[0];
  if (!row || (row.out_profile_id === null && row.out_guest_id === null)) {
    return null;
  }
  return {
    eventId: row.out_event_id!,
    identity: row.out_profile_id
      ? { type: "profile", id: row.out_profile_id }
      : { type: "guest", id: row.out_guest_id! },
  };
}

/**
 * Idempotent "is the pairing ready for a fresh shared round" check —
 * see migration 00000000000024's `ensure_stage_round`. Every production
 * seat-claim/seat-vacate path already triggers this server-side inside
 * its own RPC (`claim_speaker_seat`, `end_speaker_seat`,
 * `leave_speaker_seat(_as_guest)`) — exposed here mainly for the
 * Session Simulator's own seat-claiming pathways (which call the same
 * underlying `claim_speaker_seat` RPC and so already get this for free
 * too) and for tests that want to assert on the resulting `StageRound`
 * directly.
 */
export async function ensureStageRound(eventId: string): Promise<StageRound> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("ensure_stage_round", { p_event_id: eventId });
  if (error) {
    throw new Error(error.message);
  }
  return data as StageRound;
}
