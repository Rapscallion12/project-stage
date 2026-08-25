"use client";

import { useEffect, useRef } from "react";
import { reportSpeakerMediaActive, reportSpeakerMediaInactive } from "@/app/events/[id]/room/actions";
import { isLocalMediaInactive } from "@/lib/speaker-presence";

/**
 * Issue #18 unified inactive-speaker finding: the client-observed half
 * of "inactive" that has no server-side signal of its own (see
 * `lib/speaker-presence.ts`'s own doc comment — this app's LiveKit
 * webhook has no track-mute event, so unlike a disconnect, this can only
 * ever be observed here and reported). Runs only for the local speaker's
 * own seat — nothing about anyone else's mute state is observable from
 * this tab, and an ordinary audience member never holds a seat to report
 * on.
 *
 * Reports a transition, not a poll: `isLocalMediaInactive` is recomputed
 * every render from already-live state (`canPublish`,
 * `needsMediaActivation`, `microphoneMuted`, `cameraMuted` — all already
 * driving other UI), and this effect only calls out to the server when
 * that derived boolean actually *changes*, mirroring the "report state
 * transitions, not raw values" shape `useRoleTransitionReset` already
 * established elsewhere in this room. `mark_speaker_media_inactive`/
 * `mark_speaker_media_active` (migration 00000000000017) are both
 * idempotent no-ops when redundantly called, so a duplicate report from
 * a re-render or a race with the effect's own cleanup is harmless — this
 * still only fires on genuine transitions as a matter of not spamming
 * the server, not because a duplicate would be unsafe.
 *
 * The becomes-inactive→active transition intentionally does not
 * distinguish *why* it recovered (tapping "Tap to reconnect" and
 * re-publishing real media, or directly unmuting either track) — both
 * genuinely change `isLocalMediaInactive`'s inputs, so both correctly
 * clear the server-side clock. A UI element that doesn't change any of
 * those four inputs (e.g. tapping a non-functional placeholder) can
 * never trigger this — see this module's own tests.
 */
export function useSpeakerMediaPresenceReporting(params: {
  eventId: string;
  isSpeaker: boolean;
  canPublish: boolean;
  needsMediaActivation: boolean;
  microphoneMuted: boolean;
  cameraMuted: boolean;
}): void {
  const { eventId, isSpeaker, canPublish, needsMediaActivation, microphoneMuted, cameraMuted } = params;
  const isMediaInactive =
    isSpeaker && isLocalMediaInactive({ canPublish, needsMediaActivation, microphoneMuted, cameraMuted });
  const wasMediaInactiveRef = useRef(false);

  useEffect(() => {
    if (isMediaInactive === wasMediaInactiveRef.current) return;
    wasMediaInactiveRef.current = isMediaInactive;
    if (isMediaInactive) {
      void reportSpeakerMediaInactive(eventId);
    } else {
      void reportSpeakerMediaActive(eventId);
    }
  }, [eventId, isMediaInactive]);
}
