"use client";

import { useEffect, useState } from "react";
import { SPEAKER_DISCONNECT_GRACE_MS } from "@/lib/speaker-reconnect";

/**
 * Issue #18 reconnect-countdown finding: the deadline is always
 * `disconnectedAt + SPEAKER_DISCONNECT_GRACE_MS` — the exact same
 * server-authoritative boundary `release_expired_disconnected_speaker`
 * enforces (migration 00000000000016) — never a fresh client-invented
 * 11-second timer. Pure, so the boundary math is unit-testable without
 * a ticking clock: given a `disconnectedAt` and the current time, what
 * should the display say right now.
 *
 * Returns `null` when there's nothing to count down (not disconnected).
 * Clamped to 0, never negative — crossing zero is display-only and
 * never implies the seat is still held; the seat's own disappearance
 * from `speakers` (once the server actually releases it) is what
 * actually reflects that, independent of this number.
 */
export function remainingGraceSeconds(disconnectedAt: string | null, now: number): number | null {
  if (!disconnectedAt) return null;
  const deadline = new Date(disconnectedAt).getTime() + SPEAKER_DISCONNECT_GRACE_MS;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

/**
 * Ticks the display once a second while `disconnectedAt` is set,
 * without ever restarting the underlying deadline — a reopened tab
 * partway through an existing grace window shows the correct remaining
 * time immediately (computed from the real `disconnectedAt`), not a
 * fresh 11. Reconnecting (the webhook's `participant_joined` handler
 * clearing `disconnected_at`, delivered here via the same Realtime
 * subscription `speakers` already flows through) sets `disconnectedAt`
 * back to `null`, which immediately stops the interval and returns
 * `null` — no stale timer survives a reconnect, and none needs an
 * explicit teardown beyond this effect's own cleanup (which also
 * covers the seat being released or reassigned entirely, since the
 * caller unmounts along with the rest of Speaker View in that case).
 */
export function useReconnectCountdown(disconnectedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!disconnectedAt) return;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
    // A fresh disconnectedAt (a new disconnect after a prior reconnect)
    // is reflected on this effect's *next* tick (up to 1s later), same
    // granularity every other per-second countdown in this codebase
    // already accepts (see useAutomaticPromotion's own countdown) —
    // not worth a synchronous setState-in-effect call to shave off,
    // which react-hooks/set-state-in-effect already steers away from.
  }, [disconnectedAt]);

  return remainingGraceSeconds(disconnectedAt, now);
}
