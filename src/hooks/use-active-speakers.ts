"use client";

import { useCallback, useEffect, useRef, useState } from "react";
// Realtime subscription calls the Supabase client directly, same
// documented exception as useLobbyRealtime — see ARCHITECTURE.md's Vendor
// portability section.
import { createClient } from "@/lib/supabase/client";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import { getRoomStatus, type RoomStatus } from "@/lib/room-status";

/**
 * Applies one `event_speakers` row (an INSERT for a new occupant, or an
 * UPDATE when someone's `left_at` gets set) to the current active-speaker
 * map, keyed by seat. A pure function, exported so the merge logic is
 * testable without a live Supabase Realtime connection — same reasoning
 * as `determineCanPublish` in lib/livekit/token.ts.
 */
export function applySpeakerChange(
  current: Record<number, EventSpeaker>,
  row: EventSpeaker,
): Record<number, EventSpeaker> {
  if (row.left_at !== null) {
    // Only remove if this is still the row we have for that seat — an
    // UPDATE for a since-superseded row must not clobber a newer
    // occupant already in state.
    if (current[row.seat_number]?.id !== row.id) return current;
    const next = { ...current };
    delete next[row.seat_number];
    return next;
  }
  return { ...current, [row.seat_number]: row };
}

function toBySeat(speakers: EventSpeaker[]): Record<number, EventSpeaker> {
  const map: Record<number, EventSpeaker> = {};
  for (const speaker of speakers) map[speaker.seat_number] = speaker;
  return map;
}

/**
 * Issue #18 real-device finding (2026-08-27): a real-device retest
 * captured a seated speaker (self-preview live, LiveKit `canPublish`
 * granted, `getActiveSeatForIdentity` server-side correctly finding
 * their row) whose *client-side* `mySeatNumber`/`isSpeaker`/
 * `participantRole` had nonetheless settled on "audience" for the rest
 * of the session — provably wrong, since the same identity's own
 * `joinOpenSeat` attempt was rejected with "You're already speaking,"
 * meaning the server's authoritative `event_speakers_active` and this
 * hook's accumulated client-side state had genuinely diverged.
 *
 * Root cause: this hook previously only ever applied *incremental*
 * `postgres_changes` deltas on top of `initialSpeakers`, with no
 * reconciliation mechanism at all. Supabase Realtime's Postgres-CDC
 * subscriptions are not guaranteed to replay events missed during a
 * connection gap (a WebSocket drop and automatic reconnect — common on
 * mobile networks, exactly this project's primary real-device target) —
 * a single missed INSERT or UPDATE could silently leave this hook's
 * state wrong for the rest of the mounted session, with nothing to
 * self-correct it. `mySeatNumber` (`EventRoom`, via `findMySeatNumber`)
 * is the *one* canonical value `participantRole`/`isSpeaker`/the role
 * routers/self-preview eligibility already all derive from — the fix
 * belongs here, at the data source, not in another independent
 * role-ish flag layered on top of it.
 *
 * `fetchActiveSpeakers` reads the same expiration-aware
 * `event_speakers_active` view (migration 00000000000018)
 * `listActiveSpeakers` uses server-side — this hook's state is now
 * genuinely resynced to the same authoritative source
 * `getActiveSeatForIdentity` reads, not just "whatever deltas happened
 * to arrive."
 */
async function fetchActiveSpeakers(
  supabase: ReturnType<typeof createClient>,
  eventId: string,
): Promise<EventSpeaker[]> {
  const { data } = await supabase.from("event_speakers_active").select("*").eq("event_id", eventId);
  return (data ?? []) as EventSpeaker[];
}

/**
 * The room's speaker roster and status, sourced entirely from
 * `event_speakers` — never from LiveKit's participant/track state. See
 * DECISIONS.md's issue #3 entry: this is what keeps the database
 * authoritative for "who is speaking" even if a speaker mutes, loses
 * camera permission, or has a media hiccup — none of that changes this
 * hook's state, only `useLiveRoomConnection`'s.
 *
 * Issue #18 real-device finding (2026-08-27): resyncs a full, fresh read
 * — replacing accumulated state outright, not patching it — on every
 * `SUBSCRIBED` callback from the Realtime channel (the initial
 * subscription *and* every automatic reconnect after a drop), and
 * exposes `refetch` for a caller to trigger the same resync explicitly
 * once it has independent proof of a contradiction (see
 * `joinOpenSeat`'s `already-speaking` result and `EventRoom`'s own
 * handling of it). See `fetchActiveSpeakers`'s own doc comment for the
 * root cause this closes.
 */
export function useActiveSpeakers(
  eventId: string,
  initialSpeakers: EventSpeaker[],
): { speakers: EventSpeaker[]; roomStatus: RoomStatus; refetch: () => Promise<void> } {
  const [bySeat, setBySeat] = useState<Record<number, EventSpeaker>>(() => toBySeat(initialSpeakers));
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null);

  useEffect(() => {
    const supabase = createClient();
    supabaseRef.current = supabase;

    const channel = supabase
      .channel(`event-speakers:${eventId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "event_speakers", filter: `event_id=eq.${eventId}` },
        (payload) => setBySeat((prev) => applySpeakerChange(prev, payload.new as EventSpeaker)),
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "event_speakers", filter: `event_id=eq.${eventId}` },
        (payload) => setBySeat((prev) => applySpeakerChange(prev, payload.new as EventSpeaker)),
      )
      .subscribe((status) => {
        // Fires on the initial successful subscription *and* on every
        // automatic reconnect after a drop — both are moments this
        // hook's accumulated deltas could already be stale, so both get
        // a full resync rather than trusting whatever was accumulated
        // going in. See this module's own doc comment.
        if (status === "SUBSCRIBED") {
          void fetchActiveSpeakers(supabase, eventId).then((fresh) => setBySeat(toBySeat(fresh)));
        }
      });

    return () => {
      supabaseRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  const refetch = useCallback(async () => {
    const supabase = supabaseRef.current;
    if (!supabase) return;
    const fresh = await fetchActiveSpeakers(supabase, eventId);
    setBySeat(toBySeat(fresh));
  }, [eventId]);

  const speakers = Object.values(bySeat).sort((a, b) => a.seat_number - b.seat_number);
  return { speakers, roomStatus: getRoomStatus(speakers.length), refetch };
}
