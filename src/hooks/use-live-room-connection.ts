"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Room, RoomEvent, type Participant } from "livekit-client";

export type ConnectionStatus = "unavailable" | "connecting" | "connected" | "reconnecting" | "disconnected";

/**
 * Pure decision function — whether the local participant should currently
 * be publishing. Deliberately separated from the LiveKit event wiring so
 * it's unit-testable without a real Room/connection, same reasoning as
 * `determineCanPublish` in lib/livekit/token.ts. The server has already
 * decided this (the token's grant, kept in sync live by
 * `syncPublishPermission` — issue #13); this just reads that decision off
 * the connected participant's current permissions.
 */
export function shouldPublish(permissions?: { canPublish?: boolean }): boolean {
  return permissions?.canPublish === true;
}

/**
 * Specific camera/mic activation failure reasons, distinguished so the UI
 * can say something true instead of a generic "camera off" — see
 * DECISIONS.md's mobile camera/mic finding. Derived from getUserMedia's
 * own DOMException.name via classifyMediaError below, not guessed.
 */
export type MediaErrorReason = "permission-denied" | "no-device" | "device-unavailable" | "init-failed";

export type MediaError = { source: "camera" | "microphone"; reason: MediaErrorReason } | null;

/**
 * Maps a getUserMedia failure to one of MediaErrorReason's specific,
 * user-facing states via the browser's own DOMException.name — exported
 * so this mapping is unit-testable without a real Room/getUserMedia call,
 * same reasoning as shouldPublish above.
 */
export function classifyMediaError(source: "camera" | "microphone", error: unknown): MediaError {
  const name = error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return { source, reason: "permission-denied" };
    case "NotFoundError":
    case "OverconstrainedError":
      return { source, reason: "no-device" };
    case "NotReadableError":
    case "AbortError":
      return { source, reason: "device-unavailable" };
    default:
      return { source, reason: "init-failed" };
  }
}

export type LiveRoomConnection = {
  status: ConnectionStatus;
  /** Total participants in the LiveKit room (speakers + audience alike — everyone connects to subscribe). */
  participantCount: number;
  /** The most recent camera/mic activation failure, if any. */
  mediaError: MediaError;
  /** Whether the server currently grants this participant canPublish (event_speakers occupancy, kept live by syncPublishPermission — issue #13) — distinct from whether media has actually been activated in this browser tab yet. */
  canPublish: boolean;
  /**
   * True once the local participant has canPublish but hasn't activated
   * camera/mic in this tab yet. The UI must show an explicit affordance
   * for this and call activateMedia() directly from its own tap handler —
   * see activateMedia's comment for why this can't just happen
   * automatically.
   */
  needsMediaActivation: boolean;
  /**
   * Requests camera+mic and publishes them. MUST be called synchronously
   * from within a real user gesture handler (a button's onClick, not a
   * promise continuation or a LiveKit event callback) — iOS/macOS Safari
   * silently refuses to even show the permission prompt for a
   * getUserMedia call that isn't in a gesture's call stack, which is
   * exactly what caused camera/mic to never activate on iPhone (see
   * DECISIONS.md). Once permission has been resolved once in this tab,
   * later canPublish changes (promotion, revocation, re-promotion) resync
   * automatically without another tap — the browser's gesture requirement
   * is specifically for the first permission prompt, not every
   * getUserMedia call, and origin-level camera/mic permission persists
   * across a reconnect within the same tab.
   */
  activateMedia: () => Promise<void>;
  /** Looks up a connected participant by LiveKit identity (`profile:<id>` / `guest:<id>`) for media attachment only — never for deciding who's a speaker. See DECISIONS.md. */
  getParticipant: (identity: string) => Participant | undefined;
};

/**
 * Owns the LiveKit `Room` connection lifecycle: connects once per
 * token/url pair, disconnects on unmount, and keeps `canPublish` in sync
 * with the server's permission grant — on connect, and again every time
 * `RoomEvent.ParticipantPermissionsChanged` fires on the local participant
 * (the live push from issue #13's `syncPublishPermission`). Actually
 * publishing camera/mic tracks only happens automatically once this tab
 * has completed one real, gesture-triggered `activateMedia()` call —
 * before that, `needsMediaActivation` tells the UI to ask for a tap
 * instead of silently (and, on Safari, unsuccessfully) trying to acquire
 * media on its own. Passing `null` (LiveKit not configured, or no token)
 * skips connecting entirely — the room still works for chat and the
 * DB-sourced speaker roster, just without media, per the
 * graceful-degradation principle.
 */
export function useLiveRoomConnection(params: { livekitUrl: string; token: string } | null): LiveRoomConnection {
  const [status, setStatus] = useState<ConnectionStatus>(params ? "connecting" : "unavailable");
  const [participantCount, setParticipantCount] = useState(0);
  const [participantsVersion, setParticipantsVersion] = useState(0);
  const [mediaError, setMediaError] = useState<MediaError>(null);
  const [canPublish, setCanPublish] = useState(false);
  const [mediaActivated, setMediaActivated] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const mediaActivatedRef = useRef(false);
  const applyPublishStateRef = useRef<(publish: boolean) => Promise<void>>(async () => {});

  useEffect(() => {
    // No synchronous setStatus/setMediaError here for the "nothing to
    // connect to" case, or for the initial "connecting" state on a fresh
    // params value — both are already correct from useState's initializer
    // above. Setting state synchronously in an effect body (rather than
    // from a subscribed callback) is a lint violation
    // (react-hooks/set-state-in-effect) for good reason: it's not
    // reacting to an external event, it's just recomputing something the
    // initial render already knew. Every setState below this point is
    // inside a genuine callback — a LiveKit RoomEvent handler or a
    // connect()/track-publish promise's resolution — which is the actual
    // external-system boundary this effect exists to bridge.
    if (!params) return;

    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;
    let cancelled = false;

    const bump = () => setParticipantsVersion((v) => v + 1);
    const updateCount = () => setParticipantCount(1 + room.remoteParticipants.size);

    async function applyPublishState(publish: boolean) {
      try {
        await room.localParticipant.setMicrophoneEnabled(publish);
        setMediaError((prev) => (prev?.source === "microphone" ? null : prev));
      } catch (error) {
        if (publish) setMediaError(classifyMediaError("microphone", error));
      }
      try {
        await room.localParticipant.setCameraEnabled(publish);
        setMediaError((prev) => (prev?.source === "camera" ? null : prev));
      } catch (error) {
        if (publish) setMediaError(classifyMediaError("camera", error));
      }
    }
    applyPublishStateRef.current = applyPublishState;

    function syncCanPublish() {
      const publish = shouldPublish(room.localParticipant.permissions);
      setCanPublish(publish);
      // Disabling never needs a gesture; enabling before this tab's first
      // gesture-triggered activateMedia() call would hit the exact Safari
      // restriction this hook exists to avoid — leave it to
      // needsMediaActivation/activateMedia instead of applying it here.
      if (mediaActivatedRef.current || !publish) {
        void applyPublishState(publish);
      }
    }

    room
      .on(RoomEvent.Connected, () => {
        setStatus("connected");
        updateCount();
        syncCanPublish();
      })
      .on(RoomEvent.Reconnecting, () => setStatus("reconnecting"))
      .on(RoomEvent.Reconnected, () => setStatus("connected"))
      .on(RoomEvent.Disconnected, () => setStatus("disconnected"))
      .on(RoomEvent.ParticipantConnected, () => {
        updateCount();
        bump();
      })
      .on(RoomEvent.ParticipantDisconnected, () => {
        updateCount();
        bump();
      })
      .on(RoomEvent.TrackSubscribed, bump)
      .on(RoomEvent.TrackUnsubscribed, bump)
      .on(RoomEvent.TrackMuted, bump)
      .on(RoomEvent.TrackUnmuted, bump)
      .on(RoomEvent.LocalTrackPublished, bump)
      .on(RoomEvent.LocalTrackUnpublished, bump)
      .on(RoomEvent.ParticipantPermissionsChanged, (_prevPermissions, participant) => {
        bump();
        // Requirement: react immediately if the server revokes or grants
        // canPublish while connected — this is that reaction.
        if (participant === room.localParticipant) {
          syncCanPublish();
        }
      });

    room.connect(params.livekitUrl, params.token).catch(() => {
      if (!cancelled) setStatus("disconnected");
    });

    return () => {
      cancelled = true;
      roomRef.current = null;
      applyPublishStateRef.current = async () => {};
      void room.disconnect();
    };
    // Reconnecting on every render would tear down a healthy call; only
    // the identity of the token/url actually held should restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.livekitUrl, params?.token]);

  const getParticipant = useCallback(
    (identity: string): Participant | undefined => {
      // participantsVersion isn't read below — it's a dependency purely
      // to force callers using this function's identity in a render or
      // effect dependency array to re-run when room membership/tracks
      // change, since the underlying Room/Map mutate in place rather than
      // producing new references React would otherwise notice.
      void participantsVersion;
      const room = roomRef.current;
      if (!room) return undefined;
      if (room.localParticipant.identity === identity) return room.localParticipant;
      return room.remoteParticipants.get(identity);
    },
    [participantsVersion],
  );

  const activateMedia = useCallback(async () => {
    mediaActivatedRef.current = true;
    setMediaActivated(true);
    const room = roomRef.current;
    const publish = room ? shouldPublish(room.localParticipant.permissions) : false;
    await applyPublishStateRef.current(publish);
  }, []);

  return {
    status,
    participantCount,
    mediaError,
    canPublish,
    needsMediaActivation: canPublish && !mediaActivated,
    activateMedia,
    getParticipant,
  };
}
