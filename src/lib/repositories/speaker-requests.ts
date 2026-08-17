import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { SeatIdentity } from "@/lib/repositories/event-speakers";

/**
 * `status` is a Postgres CHECK-constrained text column, not a native
 * enum — see migration 00000000000011. Kept in sync with that CHECK by
 * hand, same discipline as `LeftReason` in event-speakers.ts.
 */
export type RequestStatus = "pending" | "granted" | "withdrawn";

export type SpeakerRequest = {
  id: string;
  event_id: string;
  /** Exactly one of profile_id/guest_id — issue #16, same XOR pattern as EventSpeaker. */
  profile_id: string | null;
  guest_id: string | null;
  message_id: string;
  status: RequestStatus;
  created_at: string;
  resolved_at: string | null;
};

export type RankedSpeakerRequest = {
  request_id: string;
  profile_id: string | null;
  guest_id: string | null;
  message_id: string;
  rank: number;
};

function identityColumn(identity: SeatIdentity) {
  return identity.type === "profile" ? "profile_id" : "guest_id";
}

/**
 * Whether — and which — active pending request an identity (account or
 * guest) currently holds for an event. Public read (speaker_requests has
 * no anon/authenticated write grant — see the migration), used to decide
 * what request-related controls to show a given viewer.
 */
export async function getPendingRequestForIdentity(
  eventId: string,
  identity: SeatIdentity,
): Promise<SpeakerRequest | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("speaker_requests")
    .select("*")
    .eq("event_id", eventId)
    .eq(identityColumn(identity), identity.id)
    .eq("status", "pending")
    .maybeSingle();
  return (data as SpeakerRequest | null) ?? null;
}

/**
 * Atomically creates the request's chat message and its
 * speaker_requests row for an account holder (issue #14's explicit
 * atomicity requirement — see migration 00000000000011's
 * `request_to_speak`). Self-service: `auth.uid()`-gated in Postgres, so
 * the ordinary session-bound client is correct here, same tier as
 * `leaveSpeakerSeat`.
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

/**
 * Same atomic creation for a guest (issue #16). There's no `auth.uid()`
 * equivalent for guests, so this can't be safely self-service the way
 * `requestToSpeak` is — service-role-only, called with the guest id and
 * display name already resolved server-side from the httpOnly session
 * cookie, never accepted as client input. See migration
 * 00000000000012's `request_to_speak_as_guest`.
 */
export async function requestToSpeakAsGuest(
  eventId: string,
  guestId: string,
  displayName: string,
  body: string,
): Promise<{ messageId: string; requestId: string }> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("request_to_speak_as_guest", {
    p_event_id: eventId,
    p_guest_id: guestId,
    p_display_name: displayName,
    p_body: body,
  });
  const row = data?.[0];
  if (error || !row) {
    throw new Error(error?.message ?? "request_to_speak_as_guest returned no row");
  }
  return { messageId: row.message_id, requestId: row.request_id };
}

/** Self-service withdrawal of an account holder's own pending request — same shape as `leaveSpeakerSeat`. */
export async function withdrawSpeakerRequest(eventId: string): Promise<SpeakerRequest> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("withdraw_speaker_request", { p_event_id: eventId });
  if (error || !data) {
    throw new Error(error?.message ?? "withdraw_speaker_request returned no row");
  }
  return data as SpeakerRequest;
}

/** A guest's own withdrawal (issue #16) — same service-role-only tier as `requestToSpeakAsGuest`, for the same reason. */
export async function withdrawSpeakerRequestAsGuest(eventId: string, guestId: string): Promise<SpeakerRequest> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("withdraw_speaker_request_as_guest", {
    p_event_id: eventId,
    p_guest_id: guestId,
  });
  if (error || !data) {
    throw new Error(error?.message ?? "withdraw_speaker_request_as_guest returned no row");
  }
  return data as SpeakerRequest;
}

/**
 * Ranks an event's pending requests by audience support — see migration
 * 00000000000011/00000000000012's `rank_pending_speaker_requests` for the
 * exact ordering (a guest's reputation tiebreak is the same neutral
 * baseline every current account already has). Trusted-server-only
 * (reads `profiles.reputation_score`, which anon/authenticated can't
 * select directly, and is the input to `claimOpenSeat`'s eligibility
 * decision) — service client only, no Server Action wrapper of its own.
 * Not exposed as a public "leaderboard" in this issue; see DECISIONS.md.
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
 * recording the outcome. Identity-agnostic (operates on the request id,
 * not the identity that made it), so issue #16 needed no change here.
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
