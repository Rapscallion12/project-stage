/**
 * Issue #18 UX finding: single source of truth for the speaker
 * disconnect grace period, shared between the server-authoritative
 * enforcement (`release_expired_disconnected_speaker`, called from
 * `checkAndEvictDisconnectedSpeaker` — room/actions.ts) and the
 * client-side trigger that schedules when to ask the server to check
 * (`useSpeakerReconnectGrace`). The server's own `disconnected_at`
 * comparison is what's actually authoritative; this constant only needs
 * to match on both sides so the client's trigger fires close to the
 * real boundary, not to enforce it.
 */
export const SPEAKER_DISCONNECT_GRACE_SECONDS = 11;
export const SPEAKER_DISCONNECT_GRACE_MS = SPEAKER_DISCONNECT_GRACE_SECONDS * 1000;
