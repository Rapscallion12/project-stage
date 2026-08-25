import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * Issue #18 unified inactive-speaker finding: a speaker seat is scarce —
 * what matters to the *product* is whether the occupant is meaningfully
 * present on stage, not which specific technical condition caused them
 * not to be. Two independent, separately-tracked causes both resolve to
 * the same product-level state:
 *
 *  - A genuine LiveKit disconnect (`disconnected_at`, set by the
 *    webhook's `participant_left` handler — migration 00000000000016).
 *  - Still connected, but publishing no usable media at all — both
 *    camera and microphone off/muted (`media_inactive_since`, set by
 *    this tab's own report when it detects that state — migration
 *    00000000000017). Server-unobservable by construction (this app's
 *    LiveKit webhook has no track-mute event), so unlike a disconnect,
 *    this one can only ever be client-observed and server-recorded —
 *    the server still owns the authoritative clock and release decision
 *    once told, the same as it always has for disconnects.
 *
 * Kept as two separate columns/functions specifically so the *cause*
 * stays inspectable in storage ("continue distinguishing... where
 * technically necessary") — this module is the one place that collapses
 * them into the single stage-level concept the UI actually needs:
 * `speakerPresence = active | inactive`, and one shared deadline.
 */
export type SpeakerPresence = "active" | "inactive";

type PresenceFields = Pick<EventSpeaker, "disconnected_at" | "media_inactive_since">;

/**
 * The single timestamp every reconnect/inactivity display (the
 * returning speaker's own prompt, and the audience's tile) should
 * derive its countdown from — never `disconnected_at` or
 * `media_inactive_since` read individually by a component. If, in the
 * rare case both are set (e.g. the speaker was already muted when the
 * network also dropped), the *earlier* one governs: that's genuinely
 * when this seat stopped being useful, and the grace period shouldn't
 * restart just because a second cause layered on top of an
 * already-running clock.
 */
export function inactiveSince(speaker: PresenceFields | null | undefined): string | null {
  if (!speaker) return null;
  const candidates = [speaker.disconnected_at, speaker.media_inactive_since].filter(
    (value): value is string => value !== null,
  );
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, current) => (new Date(current) < new Date(earliest) ? current : earliest));
}

/** Pure derivation from the same two fields — never a separate, independently-maintained flag. */
export function deriveSpeakerPresence(speaker: PresenceFields | null | undefined): SpeakerPresence {
  return inactiveSince(speaker) !== null ? "inactive" : "active";
}

/**
 * Whether a currently-connected local participant is publishing no
 * usable media at all — the client-observable half of "inactive" that
 * has no server-side signal of its own (see this module's own doc
 * comment). True both when media was never activated at all
 * (`needsMediaActivation`) and when it was activated but both tracks
 * are now muted — from the stage's perspective these are the same
 * fact: nothing is currently being transmitted. Always false while
 * `canPublish` is false (not a speaker, or not yet granted) — this is
 * about a *seated* speaker's own media state, not eligibility.
 */
export function isLocalMediaInactive(params: {
  canPublish: boolean;
  needsMediaActivation: boolean;
  microphoneMuted: boolean;
  cameraMuted: boolean;
}): boolean {
  if (!params.canPublish) return false;
  return params.needsMediaActivation || (params.microphoneMuted && params.cameraMuted);
}
