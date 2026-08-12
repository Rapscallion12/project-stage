import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * `status` is a Postgres CHECK-constrained text column, not a native
 * enum — see migration 00000000000011. Kept in sync with that CHECK by
 * hand, same discipline as `LeftReason` in event-speakers.ts.
 */
export type RequestStatus = "pending" | "granted" | "withdrawn";

export type SpeakerRequest = {
  id: string;
  event_id: string;
  profile_id: string;
  message_id: string;
  status: RequestStatus;
  created_at: string;
  resolved_at: string | null;
};

export type RankedSpeakerRequest = {
  request_id: string;
  profile_id: string;
  message_id: string;
  rank: number;
};

/**
 * Whether — and which — active pending request a profile currently holds
 * for an event. Public read (speaker_requests has no anon/authenticated
 * write grant — see the migration), used to decide what request-related
 * controls to show a given viewer.
 */
export async function getPendingRequestForProfile(
  eventId: string,
  profileId: string,
): Promise<SpeakerRequest | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("speaker_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq("profile_id", profileId)
    .eq("status", "pending")
    .maybeSingle();
  return (data as SpeakerRequest | null) ?? null;
}

/**
 * Atomically creates the request's chat message and its
 * speaker_requests row (issue #14's explicit atomicity requirement — see
 * migration 00000000000011's `request_to_speak`). Self-service:
 * `auth.uid()`-gated in Postgres, so the ordinary session-bound client is
 * correct here, same tier as `leaveSpeakerSeat`.
 */
export async function requestToSpeak(
  eventId: string,
  body: string,
): Promise<{ messageId: string; requestId: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("request_to_speak", { p_event_id: eventId, p_body: body });
  const row = data?.[0];
  if (error || !row) {
    throw new Error(error?.message ?? "request_to_speak returned no row");
  }
  return { messageId: row.message_id, requestId: row.request_id };
}

/** Self-service withdrawal of the caller's own pending request — same shape as `leaveSpeakerSeat`. */
export async function withdrawSpeakerRequest(eventId: string): Promise<SpeakerRequest> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("withdraw_speaker_request", { p_event_id: eventId });
  if (error || !data) {
    throw new Error(error?.message ?? "withdraw_speaker_request returned no row");
  }
  return data as SpeakerRequest;
}

/**
 * Ranks an event's pending requests by audience support — see migration
 * 00000000000011's `rank_pending_speaker_requests` for the exact
 * ordering. Trusted-server-only (reads `profiles.reputation_score`,
 * which anon/authenticated can't select directly, and is the input to
 * `claimOpenSeat`'s eligibility decision) — service client only, no
 * Server Action wrapper of its own. Not exposed as a public "leaderboard"
 * in this issue; see DECISIONS.md.
 */
export async function rankPendingSpeakerRequests(eventId: string): Promise<RankedSpeakerRequest[]> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("rank_pending_speaker_requests", { p_event_id: eventId });
  if (error) {
    throw new Error(error.message);
  }
  return data ?? [];
}

/**
 * Marks a request granted after `claimOpenSeat` has already verified
 * eligibility and successfully claimed the seat. Plain service-client
 * update, not a function — the sensitive decision (rank/eligibility) was
 * already made in TypeScript before this is ever called; this is just
 * recording the outcome. See DECISIONS.md for why this doesn't need the
 * same atomicity treatment `request_to_speak` does.
 */
export async function markSpeakerRequestGranted(requestId: string): Promise<void> {
  const supabase = createServiceClient();
  const { error } = await supabase
    .from("speaker_requests")
    .update({ status: "granted", resolved_at: new Date().toISOString() })
    .eq("id", requestId)
    .eq("status", "pending");
  if (error) {
    throw new Error(error.message);
  }
}
