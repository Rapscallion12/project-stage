"use client";

import { useEffect, useRef, useState } from "react";
import { checkAndEvictDisconnectedSpeaker } from "@/app/events/[id]/room/actions";
import { getParticipantIdentity } from "@/lib/livekit/token";
import type { Participant } from "livekit-client";
import type { EventSpeaker, SeatIdentity } from "@/lib/repositories/event-speakers";

/** Tunable, not architectural doctrine — ~20-30s per the product ask. */
export const RECONNECT_GRACE_PERIOD_MS = 25_000;

/**
 * Real-device finding: the LiveKit webhook evicts a seat the instant
 * `participant_left` fires — no grace period — so a seated speaker who
 * merely refreshes, blips offline, or briefly loses signal loses their
 * seat outright, the same as someone who genuinely left. This is the
 * client-side half of the fix: watches every *other* occupied seat for a
 * gap between the DB's occupancy (`event_speakers`, via
 * `useActiveSpeakers`) and LiveKit's own live participant list
 * (`getParticipant`) — a seat still recognized server-side with no
 * connected LiveKit participant. Purely a local *trigger*: after
 * `RECONNECT_GRACE_PERIOD_MS` of that gap persisting, calls the
 * server-re-validated `checkAndEvictDisconnectedSpeaker` (room/actions.ts)
 * — the actual eviction decision is never made here, only requested. If
 * the participant reconnects before the timer fires, the seat naturally
 * drops out of the "disconnected" set on the next render and the pending
 * timer is cleared, never reaching the server at all.
 *
 * Runs for every connected viewer, audience included — not scoped to
 * just the other active speaker the way issue #25's own heartbeat is
 * scoped to avoid *continuous* audience-wide polling. This schedules at
 * most one deferred call per genuine disconnect event, not a recurring
 * interval, so the cost doesn't scale with audience size the same way
 * continuous polling would — and it's what guarantees a *solo*
 * disconnected speaker (no co-speaker around to notice) still eventually
 * gets released, as long as anyone at all is watching.
 *
 * The viewer's own seat is explicitly excluded (`myIdentity`) — a client
 * reconnecting itself (e.g. right after its own page refresh) would
 * otherwise transiently see *itself* as "disconnected" during the brief
 * window before its own LiveKit connection finishes establishing, and
 * start a grace timer against its own seat for no reason.
 */
export function useSpeakerReconnectGrace(params: {
  eventId: string;
  speakers: EventSpeaker[];
  getParticipant: (identity: string) => Participant | undefined;
  myIdentity: string;
  /** False before LiveKit ever connects (e.g. still lobby_open) — every `getParticipant` lookup returns undefined then for reasons that have nothing to do with anyone actually disconnecting, so the watch must stay off, not treat that as a room full of disconnected speakers. */
  enabled: boolean;
}): ReadonlySet<string> {
  const { eventId, speakers, getParticipant, myIdentity, enabled } = params;
  const [reconnecting, setReconnecting] = useState<ReadonlySet<string>>(new Set());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const timers = timersRef.current;
    if (!enabled) {
      // `enabled` only ever transitions false → true (it tracks
      // `canConnect`, itself derived from the event's phase, which only
      // moves forward within a session) — so this branch's job is purely
      // "stay off during the very first renders before LiveKit is even
      // meant to connect," a state the initial `useState(new Set())`
      // already got right. No setState call needed here (a lint
      // violation for a genuine reason — see useLiveRoomConnection's own
      // comment on this exact rule): there's nothing to correct.
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      return;
    }

    const disconnectedNow = new Map<string, SeatIdentity>();
    for (const speaker of speakers) {
      const seatIdentity: SeatIdentity = speaker.profile_id
        ? { type: "profile", id: speaker.profile_id }
        : { type: "guest", id: speaker.guest_id! };
      const identity = getParticipantIdentity(seatIdentity);
      if (identity === myIdentity) continue;
      if (!getParticipant(identity)) disconnectedNow.set(identity, seatIdentity);
    }

    for (const [identity, timer] of timers) {
      if (!disconnectedNow.has(identity)) {
        clearTimeout(timer);
        timers.delete(identity);
      }
    }

    for (const [identity, seatIdentity] of disconnectedNow) {
      if (timers.has(identity)) continue;
      const timer = setTimeout(() => {
        timers.delete(identity);
        setReconnecting(new Set(timers.keys()));
        // The actual eviction decision is made server-side, independent
        // of this timer having fired — see checkAndEvictDisconnectedSpeaker's
        // own doc comment.
        void checkAndEvictDisconnectedSpeaker(eventId, seatIdentity);
      }, RECONNECT_GRACE_PERIOD_MS);
      timers.set(identity, timer);
    }

    // A functional update, comparing contents rather than unconditionally
    // creating a new Set — this effect's own deps include `getParticipant`,
    // whose reference legitimately changes on unrelated room activity
    // (any track/participant update bumps it), so re-running with an
    // unchanged outcome must not still produce a new object identity: that
    // would set state every time, which schedules a render, which (if a
    // caller's own getParticipant happens to be recreated per-render, as
    // opposed to memoized) can re-trigger this same effect indefinitely.
    setReconnecting((prev) => {
      const nextKeys = [...timers.keys()];
      if (prev.size === nextKeys.length && nextKeys.every((key) => prev.has(key))) return prev;
      return new Set(nextKeys);
    });
  }, [eventId, speakers, getParticipant, myIdentity, enabled]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return reconnecting;
}
