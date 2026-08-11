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

export type LiveRoomConnection = {
  status: ConnectionStatus;
  /** Total participants in the LiveKit room (speakers + audience alike — everyone connects to subscribe). */
  participantCount: number;
  mediaError: "camera" | "microphone" | null;
  /** Looks up a connected participant by LiveKit identity (`profile:<id>` / `guest:<id>`) for media attachment only — never for deciding who's a speaker. See DECISIONS.md. */
  getParticipant: (identity: string) => Participant | undefined;
};

/**
 * Owns the LiveKit `Room` connection lifecycle: connects once per
 * token/url pair, disconnects on unmount, and auto-publishes camera+mic
 * whenever `shouldPublish` says the local participant currently has
 * `canPublish` — on connect, and again every time
 * `RoomEvent.ParticipantPermissionsChanged` fires on the local
 * participant (the live push from issue #13's `syncPublishPermission`).
 * Passing `null` (LiveKit not configured, or no token) skips connecting
 * entirely — the room still works for chat and the DB-sourced speaker
 * roster, just without media, per the graceful-degradation principle.
 */
export function useLiveRoomConnection(params: { livekitUrl: string; token: string } | null): LiveRoomConnection {
  const [status, setStatus] = useState<ConnectionStatus>(params ? "connecting" : "unavailable");
  const [participantCount, setParticipantCount] = useState(0);
  const [participantsVersion, setParticipantsVersion] = useState(0);
  const [mediaError, setMediaError] = useState<"camera" | "microphone" | null>(null);
  const roomRef = useRef<Room | null>(null);

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

    async function syncPublishing() {
      const publish = shouldPublish(room.localParticipant.permissions);
      try {
        await room.localParticipant.setMicrophoneEnabled(publish);
      } catch {
        if (publish) setMediaError("microphone");
      }
      try {
        await room.localParticipant.setCameraEnabled(publish);
      } catch {
        if (publish) setMediaError("camera");
      }
    }

    room
      .on(RoomEvent.Connected, () => {
        setStatus("connected");
        updateCount();
        void syncPublishing();
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
          void syncPublishing();
        }
      });

    room.connect(params.livekitUrl, params.token).catch(() => {
      if (!cancelled) setStatus("disconnected");
    });

    return () => {
      cancelled = true;
      roomRef.current = null;
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

  return { status, participantCount, mediaError, getParticipant };
}
