"use client";

import { useEffect, useState } from "react";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

/**
 * Issue #21, sixth corrective pass, Sections 1-3, 20-21: real-device
 * testing reported next-speaker promotion "taking far too long" with no
 * way to tell *where* the time was actually going — every prior report
 * only had "Selecting next speaker…" to look at, which says nothing
 * about whether a candidate has already been picked, is mid-countdown,
 * or genuinely has nobody eligible yet. This hook records real,
 * observed timestamps (`Date.now()`, never an estimate) for each
 * transition this client can actually see, per seat:
 *
 * - `vacantAt`: the moment this client's own `speakers` state first
 *   showed this seat empty (the start of the current cycle).
 * - `candidatesFoundAt`: the moment `pendingRequests` first went
 *   non-empty while this seat was vacant.
 * - `reservedAt`: the moment a `pendingRequests` entry first showed
 *   `reserved_seat_number` matching this seat *and* `is_current_candidate`
 *   — the atomic reservation RPC's own result becoming visible to this
 *   client (via Realtime or a reconciliation poll, whichever arrives
 *   first — this hook doesn't know or care which).
 * - `occupiedAt`: the moment `speakers` first showed this seat occupied.
 *
 * **Recorded in an effect, not during render** — this codebase's own
 * lint configuration (`react-hooks/refs`, `react-hooks/purity`)
 * forbids both reading/writing a ref's `.current` during render and
 * calling `Date.now()` directly in a component/hook body, for the same
 * underlying reason `useNow()` (hooks/use-now.ts) documents at length:
 * render can run more than once for a single commit, and must stay a
 * pure function of props/state. `useEffect` runs once, after the commit
 * that actually reflects a genuine prop change, which is exactly the
 * one moment each transition needs to be timestamped — the state update
 * this schedules re-renders essentially immediately afterward (the same
 * browser task, not a new interval or poll), so this does not
 * reintroduce the "stale by a whole cycle" latency this diagnostic
 * feature exists to expose elsewhere.
 *
 * **What this can and can't measure**: this is client-observed timing,
 * not server-side instrumentation — it tells you how long *this
 * browser tab* took to see each transition, which is exactly what a
 * real-device report describes ("it looked stuck"). It cannot
 * distinguish "the server was slow" from "this client's own Realtime
 * subscription was slow to deliver the update" — both show up as the
 * same gap here. For the server-side portion specifically, see
 * `two-seat-selection-fallback.test.ts`'s real-database timing
 * assertions, which measure the reservation RPC directly.
 *
 * **A new cycle starts the moment a seat is next observed vacant** —
 * all four timestamps reset to null at that point, so a seat that gets
 * replaced repeatedly always shows the *current* cycle's own timing,
 * never a stale total from a previous occupant.
 */
export type SeatPromotionTiming = {
  vacantAt: number | null;
  candidatesFoundAt: number | null;
  reservedAt: number | null;
  occupiedAt: number | null;
};

export type SeatPromotionTimingState = Record<1 | 2, SeatPromotionTiming>;

const EMPTY_TIMING: SeatPromotionTiming = {
  vacantAt: null,
  candidatesFoundAt: null,
  reservedAt: null,
  occupiedAt: null,
};

function freshState(): SeatPromotionTimingState {
  return { 1: { ...EMPTY_TIMING }, 2: { ...EMPTY_TIMING } };
}

/** Pure — computes the next timing state for one seat from its previous state and this render's inputs. Called from the effect below, never during render itself. */
function nextTimingForSeat(
  previous: SeatPromotionTiming,
  occupied: boolean,
  hasCandidates: boolean,
  reservedForThisSeat: boolean,
  now: number,
): SeatPromotionTiming {
  if (occupied) {
    return previous.occupiedAt === null ? { ...previous, occupiedAt: now } : previous;
  }

  // Vacant. A fresh cycle starts the moment this seat is seen vacant
  // *after* having been seen occupied (or on first observation) —
  // `occupiedAt` being set means the previous cycle actually completed.
  // Falls through to the same candidatesFoundAt/reservedAt checks below
  // rather than returning immediately: this same tick's inputs can
  // already show candidates/a reservation (e.g. this hook mounting mid
  // cycle, or a seat vacating and being re-reserved in the same
  // Realtime batch) — resetting and stopping here would silently drop
  // that signal until *some other, unrelated* prop change happened to
  // re-run this effect, which may never come.
  let next: SeatPromotionTiming =
    previous.vacantAt === null || previous.occupiedAt !== null
      ? { vacantAt: now, candidatesFoundAt: null, reservedAt: null, occupiedAt: null }
      : previous;

  if (hasCandidates && next.candidatesFoundAt === null) {
    next = { ...next, candidatesFoundAt: now };
  }
  if (reservedForThisSeat && next.reservedAt === null) {
    next = { ...next, reservedAt: now };
  }
  return next;
}

export function useSeatPromotionTiming(
  speakers: EventSpeaker[],
  pendingRequests: RankedPendingRequest[],
): SeatPromotionTimingState {
  const [timing, setTiming] = useState<SeatPromotionTimingState>(freshState);

  useEffect(() => {
    // `Date.now()` is read here (never during render — see the doc
    // comment above) and handed to a genuinely async continuation below,
    // so the `setTiming` call runs in a callback rather than
    // synchronously within the effect body itself — this codebase's
    // `react-hooks/set-state-in-effect` lint rule flags the latter. The
    // `await` is a single microtask, not a meaningful delay, so the
    // timestamp captured just above it is still this commit's real time.
    const now = Date.now();
    let cancelled = false;
    void (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setTiming((previous) => {
        let changed = false;
        const next = { ...previous };
        for (const seatNumber of [1, 2] as const) {
          const occupied = speakers.some((s) => s.seat_number === seatNumber);
          const hasCandidates = pendingRequests.length > 0;
          const reservedForThisSeat = pendingRequests.some((r) => r.is_current_candidate && r.reserved_seat_number === seatNumber);
          const updated = nextTimingForSeat(previous[seatNumber], occupied, hasCandidates, reservedForThisSeat, now);
          if (updated !== previous[seatNumber]) {
            next[seatNumber] = updated;
            changed = true;
          }
        }
        // Same object identity when nothing actually changed — avoids an
        // unnecessary re-render on an effect run that only re-confirmed
        // the existing state (e.g. an unrelated prop change that still
        // passed the same speakers/pendingRequests shape).
        return changed ? next : previous;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [speakers, pendingRequests]);

  return timing;
}
