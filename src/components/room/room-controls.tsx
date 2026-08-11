"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { leaveSpeakerSeat } from "@/app/events/[id]/room/actions";

/**
 * The one speaker-facing control this issue ships: voluntarily stepping
 * down, via issue #13's `leaveSpeakerSeat` action (self-service,
 * `auth.uid()`-gated all the way down — see migration
 * 00000000000006). Mic/camera mute toggles are deliberately not built
 * here — requirement 5 only calls for automatic publish based on the
 * server-issued token, not manual controls; left for a follow-up rather
 * than expanding this issue's scope.
 */
export function RoomControls({ eventId }: { eventId: string }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleLeave() {
    setError(null);
    startTransition(async () => {
      const result = await leaveSpeakerSeat(eventId);
      if ("error" in result) setError(result.error);
    });
  }

  return (
    <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-4 py-3">
      <Button variant="secondary" onClick={handleLeave} disabled={isPending}>
        {isPending ? "Leaving…" : "Leave the stage"}
      </Button>
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
