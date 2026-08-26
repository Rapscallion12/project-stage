import type { EventSpeaker, SeatIdentity } from "@/lib/repositories/event-speakers";

/**
 * Issue #18 consistency fix (real-device finding, 2026-08-24): Speaker
 * View's composition and its bottom control row used to be gated by the
 * *same* `isSpeaker` prop within a single render, so they could never
 * literally disagree at the point they're read — but that was only true
 * because both happened to be fed the same already-computed value.
 * `SpeakerStage` separately re-derived its own "am I speaking / which
 * seat" answer from raw `speakers`/`myIdentity` (see its own previous doc
 * comment, and the `handleTapEmptySeat` guard in `EventRoom`, which
 * already flagged this exact duplication as a latent risk for a
 * different bug). Two independently-maintained computations of the same
 * fact is the actual architecture smell an intermittent "composition
 * says speaker, controls say audience" report points at, even without a
 * provable reproduction — see DECISIONS.md for the investigation this
 * closes.
 *
 * `findMySeatNumber` is now the *one* place "which seat, if any, does
 * this identity occupy" is computed — `EventRoom` calls it once, and
 * every other consumer (`SpeakerStage`, the role routers) receives the
 * result as a plain prop instead of re-deriving it. Pure and testable
 * without a live Supabase/Realtime fixture, same reasoning as
 * `applySpeakerChange`/`findOpenSeat` elsewhere in this codebase.
 */
export function findMySeatNumber(
  speakers: Pick<EventSpeaker, "seat_number" | "profile_id" | "guest_id">[],
  identity: SeatIdentity,
): 1 | 2 | null {
  for (const seatNumber of [1, 2] as const) {
    const seat = speakers.find((s) => s.seat_number === seatNumber);
    if (!seat) continue;
    const matches = identity.type === "profile" ? seat.profile_id === identity.id : seat.guest_id === identity.id;
    if (matches) return seatNumber;
  }
  return null;
}

export type ParticipantRole = "speaker" | "candidate" | "audience";

/**
 * The single derived value both a composition (which room layout
 * renders) and its controls should key off, per the same governing
 * invariant `isSpeaker` already enforced — this just names it and folds
 * in the one other role-like state (`hasPendingRequest`) that existed as
 * a second, separately-checked flag around the room. Not itself a new
 * boolean to keep in sync: it's computed fresh from `isSpeaker`/
 * `hasPendingRequest` every time, never stored.
 */
export function deriveParticipantRole(params: { isSpeaker: boolean; hasPendingRequest: boolean }): ParticipantRole {
  if (params.isSpeaker) return "speaker";
  if (params.hasPendingRequest) return "candidate";
  return "audience";
}
