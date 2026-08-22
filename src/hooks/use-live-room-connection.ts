"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createLocalTracks,
  Room,
  RoomEvent,
  Track,
  type LocalTrack,
  type LocalVideoTrack,
  type Participant,
} from "livekit-client";

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
  /**
   * Issue #22: the locally held camera track, prepared or already
   * published — the same object throughout, so a `<video>` element
   * attached to it keeps playing uninterrupted across the pending →
   * promoted transition. Null for anyone who hasn't called
   * prepareLocalMedia() (i.e. every ordinary audience member).
   */
  localVideoTrack: LocalVideoTrack | null;
  /**
   * Issue #22: acquires camera+mic once, ahead of any seat, so a candidate
   * has a self-preview while waiting and so promotion can publish without
   * a second permission prompt. MUST be called synchronously from within a
   * real user gesture (the mic-request submit) — same Safari constraint as
   * activateMedia's own doc comment. Idempotent: a no-op if tracks are
   * already held or an acquisition is already in flight. Failures surface
   * through mediaError, classified the same way activateMedia's failures
   * are; this tab's existing recovery affordance (needsMediaActivation →
   * activateMedia) still works normally afterward since prepareLocalMedia
   * failing leaves no tracks held.
   */
  prepareLocalMedia: () => Promise<void>;
  /**
   * Issue #22: stops and releases any held-but-not-yet-published tracks —
   * for withdrawing a pending request before promotion. Already-published
   * tracks (an active speaker leaving) are unaffected here; that path is
   * handled by the existing canPublish → false reaction, which unpublishes
   * regardless of how the track was originally published. Safe to call
   * with nothing held.
   */
  releaseLocalMedia: () => void;
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
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | null>(null);
  const roomRef = useRef<Room | null>(null);
  const mediaActivatedRef = useRef(false);
  const applyPublishStateRef = useRef<(publish: boolean) => Promise<void>>(async () => {});
  const preparedTracksRef = useRef<LocalTrack[]>([]);
  const preparingRef = useRef(false);

  const stopPreparedTracks = useCallback(() => {
    for (const track of preparedTracksRef.current) track.stop();
    preparedTracksRef.current = [];
    setLocalVideoTrack(null);
  }, []);

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
      // Issue #22: a candidate who already prepared tracks (via
      // prepareLocalMedia, ahead of promotion) publishes those directly —
      // no second getUserMedia call, no second permission prompt. Falls
      // through to the ordinary setCameraEnabled/setMicrophoneEnabled path
      // below for everyone else (e.g. issue #27's direct join, which never
      // pre-acquires).
      if (publish && preparedTracksRef.current.length > 0) {
        const stillHeld: LocalTrack[] = [];
        for (const track of preparedTracksRef.current) {
          const source = track.kind === Track.Kind.Video ? "camera" : "microphone";
          try {
            await room.localParticipant.publishTrack(track);
            setMediaError((prev) => (prev?.source === source ? null : prev));
          } catch (error) {
            // Publish failed even though the track itself is already held
            // (permission was never the problem here) — keep it in the ref
            // rather than orphaning the open hardware, so a later retry or
            // cleanup can still find and stop it.
            setMediaError(classifyMediaError(source, error));
            stillHeld.push(track);
          }
        }
        // Successfully published tracks' ownership transfers to the Room
        // here on — LiveKit's own setCameraEnabled(false)/
        // setMicrophoneEnabled(false) (the existing unpublish path, driven
        // by the canPublish → false reaction when a speaker leaves) now
        // owns stopping those. localVideoTrack state is left untouched:
        // the self-preview keeps rendering the same track uninterrupted
        // after publish, exactly as required.
        preparedTracksRef.current = stillHeld;
        return;
      }
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
      // Disabling (a speaker leaving the stage) means setCameraEnabled(false)
      // just stopped the same track object localVideoTrack points to —
      // clear the state so the self-preview slot hides again, same as an
      // ordinary audience member with no local media. A no-op for anyone
      // who never held a track (the common publish=false case on initial
      // connect).
      if (!publish) setLocalVideoTrack(null);
    }
    applyPublishStateRef.current = applyPublishState;

    function syncCanPublish() {
      const publish = shouldPublish(room.localParticipant.permissions);
      setCanPublish(publish);
      // Disabling never needs a gesture; enabling before this tab's first
      // gesture-triggered activateMedia() (or prepareLocalMedia()) call
      // would hit the exact Safari restriction this hook exists to avoid —
      // leave it to needsMediaActivation/activateMedia instead of applying
      // it here.
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
      // Prepared-but-never-published tracks (e.g. leaving the room while
      // still a waiting candidate) hold real hardware open — stop them
      // explicitly, since LiveKit's own Room never learned about them.
      stopPreparedTracks();
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

  const prepareLocalMedia = useCallback(async () => {
    if (preparingRef.current || preparedTracksRef.current.length > 0) return;
    preparingRef.current = true;
    try {
      const tracks = await createLocalTracks({ audio: true, video: true });
      preparedTracksRef.current = tracks;
      // A real gesture just resolved a getUserMedia call in this tab —
      // that satisfies the same Safari constraint activateMedia's own
      // gesture requirement exists for, so later canPublish changes
      // (promotion) can publish these tracks with no further tap.
      mediaActivatedRef.current = true;
      setMediaActivated(true);
      const videoTrack = tracks.find(
        (track): track is LocalVideoTrack => track.kind === Track.Kind.Video,
      );
      setLocalVideoTrack(videoTrack ?? null);
      const room = roomRef.current;
      if (room && shouldPublish(room.localParticipant.permissions)) {
        await applyPublishStateRef.current(true);
      }
    } catch (error) {
      // createLocalTracks acquires camera+mic together (deliberately — one
      // combined permission prompt instead of two); a rejection can't be
      // cleanly attributed to just one device, so this is classified
      // against "camera" as the more central failure mode for this
      // product rather than added as a third, more precise error source.
      setMediaError(classifyMediaError("camera", error));
    } finally {
      preparingRef.current = false;
    }
  }, []);

  /**
   * Real-device finding: a seated speaker who hard-refreshes keeps their
   * seat and gets a fresh token with `canPublish: true` server-side (see
   * DECISIONS.md — refresh destroys nothing here that isn't *supposed*
   * to reset), but every piece of *this tab's* media state starts over —
   * `mediaActivated`, `localVideoTrack`, and any prepared tracks are all
   * back to their initial, empty values. Tapping "Enable camera & mic"
   * used to call `setCameraEnabled`/`setMicrophoneEnabled` directly —
   * LiveKit's own convenience methods, which acquire *and* publish in
   * one step but never touch `localVideoTrack` — so publishing worked
   * (every other participant saw/heard the recovered speaker correctly)
   * while this tab's own self-preview stayed empty, indistinguishable
   * from a broken camera. Routing through `prepareLocalMedia` instead
   * means every activation path — composer request, direct join, and
   * this recovery tap — acquires media exactly one way, so
   * `localVideoTrack` is reconstructed correctly regardless of which one
   * triggered it; `prepareLocalMedia`'s own tail check
   * (`shouldPublish` → `applyPublishState(true)`) then publishes
   * immediately since this tab is already a recognized speaker.
   */
  const activateMedia = useCallback(async () => {
    await prepareLocalMedia();
  }, [prepareLocalMedia]);

  const releaseLocalMedia = useCallback(() => {
    stopPreparedTracks();
  }, [stopPreparedTracks]);

  return {
    status,
    participantCount,
    mediaError,
    canPublish,
    needsMediaActivation: canPublish && !mediaActivated,
    activateMedia,
    getParticipant,
    localVideoTrack,
    prepareLocalMedia,
    releaseLocalMedia,
  };
}
