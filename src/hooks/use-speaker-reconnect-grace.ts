"use client";

import { useEffect, useMemo, useRef } from "react";
import { checkAndEvictInactiveSpeaker } from "@/app/events/[id]/room/actions";
import { getParticipantIdentity } from "@/lib/livekit/token";
import { SPEAKER_DISCONNECT_GRACE_MS } from "@/lib/speaker-reconnect";
import { inactiveSince } from "@/lib/speaker-presence";
import type { EventSpeaker, SeatIdentity } from "@/lib/repositories/event-speakers";

/**
 * Issue #18 UX finding, broadened by the unified inactive-speaker
 * finding: this used to derive "who's disconnected" from a client-local
 * heuristic (a seat the DB still shows occupied, but with no matching
 * entry in LiveKit's own live participant list) and run the grace period
 * as its own client-side timer — the seat was actually already gone
 * server-side the instant LiveKit reported the disconnect, so the "grace
 * period" was a purely visual illusion. It's now a thin client-side
 * trigger around a genuinely server-authoritative clock — for *either*
 * of two independent causes, collapsed into one here via
 * `inactiveSince` (`lib/speaker-presence.ts`): a genuine LiveKit
 * disconnect (`disconnected_at`, set by the webhook's `participant_left`
 * handler) or the seat's own occupant reporting itself media-inactive
 * (`media_inactive_since`, set by that speaker's own connected client —
 * see `useSpeakerMediaPresenceReporting`). Both already flow through to
 * `speakers` here via the same Realtime subscription `useActiveSpeakers`
 * already has, so "who's currently in a grace window, for either reason"
 * is a *pure derivation* from already-subscribed state, not a second
 * thing this hook has to detect.
 *
 * What this hook still does locally: schedule, per inactive seat, a
 * `setTimeout` for roughly when the grace period should elapse, and ask
 * the server to check then (`checkAndEvictInactiveSpeaker`) — but that
 * server call re-derives the real decision from Postgres's own clock and
 * the row's own `disconnected_at`/`media_inactive_since` (see
 * `release_expired_inactive_speaker`, migration 00000000000017), so this
 * timer only ever *triggers* a check; it never decides anything. Firing
 * early, late, or redundantly (several viewers' timers landing around
 * the same moment) is harmless — the server-side atomic UPDATE either
 * finds the threshold genuinely cleared or it doesn't.
 *
 * Runs for every connected viewer, audience included — not scoped to
 * just the other active speaker the way issue #25's own heartbeat is
 * scoped to avoid *continuous* audience-wide polling. This schedules at
 * most one deferred call per genuine inactivity window, not a recurring
 * interval, so the cost doesn't scale with audience size the same way
 * continuous polling would — and it's what guarantees a *solo* inactive
 * speaker (no co-speaker around to notice) still eventually gets
 * released, as long as anyone at all is watching.
 *
 * The viewer's own seat is explicitly excluded (`myIdentity`) — nothing
 * about a client watching its own occupancy makes sense here; if it's
 * genuinely disconnected, this tab isn't running JS to schedule anything
 * anyway (and if it's merely media-inactive, that speaker's own tab is
 * the one reporting it in the first place, not scheduling an eviction
 * check on itself).
 *
 * No longer takes a `getParticipant` lookup at all (unlike the previous,
 * LiveKit-live-participant-comparing design) — `inactiveSince` is now
 * the single source this derives from.
 */
export function useSpeakerReconnectGrace(params: {
  eventId: string;
  speakers: EventSpeaker[];
  myIdentity: string;
  /** False before LiveKit ever connects (e.g. still lobby_open) — kept for interface parity with the previous design; no longer changes the derivation itself, since that's now sourced from `speakers` regardless of this tab's own connection state. */
  enabled: boolean;
}): ReadonlySet<string> {
  const { eventId, speakers, myIdentity, enabled } = params;
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  // Pure derivation from already-subscribed, server-authoritative state —
  // no client-side "are they really gone" heuristic left at all.
  // `inactiveSince` collapses both causes (disconnected_at,
  // media_inactive_since) into the one deadline that actually governs
  // this seat right now.
  const inactive = useMemo(() => {
    const map = new Map<string, { seatIdentity: SeatIdentity; since: string }>();
    if (!enabled) return map;
    for (const speaker of speakers) {
      const since = inactiveSince(speaker);
      if (!since) continue;
      const seatIdentity: SeatIdentity = speaker.profile_id
        ? { type: "profile", id: speaker.profile_id }
        : { type: "guest", id: speaker.guest_id! };
      const identity = getParticipantIdentity(seatIdentity);
      if (identity === myIdentity) continue;
      map.set(identity, { seatIdentity, since });
    }
    return map;
  }, [speakers, myIdentity, enabled]);

  useEffect(() => {
    const timers = timersRef.current;

    for (const [identity, timer] of timers) {
      if (!inactive.has(identity)) {
        clearTimeout(timer);
        timers.delete(identity);
      }
    }

    for (const [identity, entry] of inactive) {
      if (timers.has(identity)) continue;
      const elapsedMs = Date.now() - new Date(entry.since).getTime();
      const remainingMs = Math.max(0, SPEAKER_DISCONNECT_GRACE_MS - elapsedMs);
      const timer = setTimeout(() => {
        timers.delete(identity);
        // The actual eviction decision is made server-side, independent
        // of this timer having fired — see checkAndEvictInactiveSpeaker's
        // own doc comment.
        void checkAndEvictInactiveSpeaker(eventId, entry.seatIdentity);
      }, remainingMs);
      timers.set(identity, timer);
    }
  }, [eventId, inactive]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return useMemo(() => new Set(inactive.keys()), [inactive]);
}
