"use client";

import { useEffect, useRef } from "react";
import { confirmOwnSeatExpiration } from "@/app/events/[id]/room/actions";
import { useReconnectCountdown } from "@/hooks/use-reconnect-countdown";

/**
 * Issue #18 expiration-enforcement finding: the returning speaker's own
 * client-side trigger for confirming its own seat's expiration the
 * instant its local countdown reaches zero — closing the gap where an
 * identity alone in the room (no co-speaker/audience tab around to
 * schedule `checkAndEvictInactiveSpeaker` on their behalf —
 * `useSpeakerReconnectGrace` deliberately never watches the viewer's own
 * seat) could sit at "· 0s" indefinitely with nothing ever asking the
 * server to actually check.
 *
 * Reuses `useReconnectCountdown` directly (the same pure derivation
 * driving the visible "Tap to reconnect · Ns"/"Resume speaking · Ns"
 * text) rather than inventing a second countdown — this hook only adds
 * a side effect on top of the same number, it never computes its own
 * deadline.
 *
 * Fires `confirmOwnSeatExpiration` once per distinct deadline, on the
 * transition into 0 (not on every render while it stays at 0) — the
 * server's own atomic re-derivation from Postgres's clock decides
 * whether anything actually happens; this is a trigger, never an
 * assertion of expiry. Tracks *which* `inactiveSince` value it already
 * confirmed for (not just a boolean) so a genuinely new deadline — a
 * fresh disconnect after a recovery — still gets its own confirmation
 * even if it never passed through `null` in between.
 */
export function useOwnSeatExpirationConfirmation(eventId: string, inactiveSince: string | null): void {
  const remainingSeconds = useReconnectCountdown(inactiveSince);
  const confirmedForRef = useRef<string | null>(null);

  useEffect(() => {
    if (inactiveSince === null || remainingSeconds !== 0) return;
    if (confirmedForRef.current === inactiveSince) return;
    confirmedForRef.current = inactiveSince;
    void confirmOwnSeatExpiration(eventId);
  }, [eventId, inactiveSince, remainingSeconds]);
}
