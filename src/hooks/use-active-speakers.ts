"use client";

import { useEffect, useState } from "react";
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
 * The room's speaker roster and status, sourced entirely from
 * `event_speakers` — never from LiveKit's participant/track state. See
 * DECISIONS.md's issue #3 entry: this is what keeps the database
 * authoritative for "who is speaking" even if a speaker mutes, loses
 * camera permission, or has a media hiccup — none of that changes this
 * hook's state, only `useLiveRoomConnection`'s.
 */
export function useActiveSpeakers(
  eventId: string,
  initialSpeakers: EventSpeaker[],
): { speakers: EventSpeaker[]; roomStatus: RoomStatus } {
  const [bySeat, setBySeat] = useState<Record<number, EventSpeaker>>(() => toBySeat(initialSpeakers));

  useEffect(() => {
    const supabase = createClient();

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
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [eventId]);

  const speakers = Object.values(bySeat).sort((a, b) => a.seat_number - b.seat_number);
  return { speakers, roomStatus: getRoomStatus(speakers.length) };
}
