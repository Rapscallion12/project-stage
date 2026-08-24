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
/**
 * Issue #18 self-preview consistency finding (real-device report:
 * Speaker View occasionally rendered without the floating self-preview
 * even though the camera was actually live). Pure decision function —
 * whether `localVideoTrack` state should be reconciled from an
 * already-existing LiveKit camera publication, rather than treated as
 * "no camera" — so the actual branching logic is unit-testable without
 * a real Room/WebRTC surface, same reasoning as `shouldPublish` above.
 * Deliberately does not know about `participantRole`/`isSpeaker` at all:
 * `canPublish` (the server-granted LiveKit permission, itself derived
 * from the same `event_speakers` occupancy — see ARCHITECTURE.md's
 * LiveKit authorization model) is the correct signal at *this* layer,
 * matching this codebase's existing DB-authoritative-for-role /
 * LiveKit-authoritative-for-media-state separation (see
 * `useActiveSpeakers`'s own doc comment) — not a second, competing role
 * flag.
 */
export function shouldReconcileLocalVideoTrack(params: {
  canPublish: boolean;
  hasLocalVideoTrack: boolean;
  cameraMuted: boolean;
  publication: { hasTrack: boolean; isMuted: boolean } | null;
}): boolean {
  if (!params.canPublish || params.hasLocalVideoTrack || params.cameraMuted) return false;
  if (!params.publication) return false;
  return params.publication.hasTrack && !params.publication.isMuted;
}

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
  /** Issue #18, Speaker View Phase 2 (mic/camera toggles): whether the local participant's own published microphone/camera are currently muted. Both start `false` on every fresh hook instance, matching a newly-published track's real default state. */
  microphoneMuted: boolean;
  cameraMuted: boolean;
  /**
   * Toggles mute on the *already-published* microphone/camera track in
   * place — `LocalTrack.mute()`/`.unmute()`, never
   * `setMicrophoneEnabled`/`setCameraEnabled`. Those convenience methods
   * unpublish-and-stop the underlying hardware track on disable and
   * re-run `createLocalTracks`/`getUserMedia` on re-enable — a real
   * reacquisition, and on iOS Safari specifically, one that isn't
   * guaranteed to succeed without a fresh gesture at all (see
   * DECISIONS.md). `mute()`/`unmute()` instead toggles the send state on
   * the exact same `MediaStreamTrack` already held — no new hardware
   * access, no new permission prompt, and it's what correctly notifies
   * every other participant via `TrackMuted`/`TrackUnmuted`. A no-op if
   * there's no published track for that source yet (not currently
   * publishing).
   */
  toggleMicrophone: () => Promise<void>;
  toggleCamera: () => Promise<void>;
};

/**
 * Owns the LiveKit `Room` connection lifecycle: connects once `params` is
 * non-null (see below for exactly what "once" means), disconnects on
 * unmount, and keeps `canPublish` in sync with the server's permission
 * grant — on connect, and again every time
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
 *
 * **Connects once the *token's presence* flips, not once per distinct
 * token string** — see the connect effect's own comment below for the
 * real-device bug this fixes (a guest-name edit minting a fresh-but-
 * equivalent token and silently forcing a full reconnect). A later
 * render carrying a *different* token string for an *already-connected*
 * room is not treated as a reason to reconnect; only the room's own live
 * `ParticipantPermissionsChanged` push is.
 */
export function useLiveRoomConnection(params: { livekitUrl: string; token: string } | null): LiveRoomConnection {
  const [status, setStatus] = useState<ConnectionStatus>(params ? "connecting" : "unavailable");
  const [participantCount, setParticipantCount] = useState(0);
  const [participantsVersion, setParticipantsVersion] = useState(0);
  const [mediaError, setMediaError] = useState<MediaError>(null);
  const [canPublish, setCanPublish] = useState(false);
  const [mediaActivated, setMediaActivated] = useState(false);
  const [localVideoTrack, setLocalVideoTrack] = useState<LocalVideoTrack | null>(null);
  const [microphoneMuted, setMicrophoneMuted] = useState(false);
  const [cameraMuted, setCameraMuted] = useState(false);
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
      // connect). Mute state resets alongside it — a later republish (a
      // leave-then-rejoin within the same mounted session, not a fresh
      // page load) acquires a genuinely new track, which always starts
      // unmuted, so any prior mute toggle here must not carry over.
      if (!publish) {
        setLocalVideoTrack(null);
        setMicrophoneMuted(false);
        setCameraMuted(false);
      }
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
    // Real-device finding (issue #18 Speaker View corrective pass):
    // deliberately `Boolean(params?.token)`, not `params?.token` itself.
    // A guest editing their display name sets a cookie in a Server
    // Action, which (per Next.js's own documented cookie-mutation
    // behavior) re-renders the current page's Server Components —
    // re-running `getLiveKitToken`, which mints a brand-new JWT
    // (`AccessToken.toJwt()` signs a fresh token, byte-different, on
    // every call) with *identical* grants. With the token's own string
    // value in this dependency array, that alone was enough to tear down
    // this effect — disconnecting the live `Room`, nulling
    // `localVideoTrack` via `stopPreparedTracks()`, then reconnecting and
    // re-publishing camera/mic via `setCameraEnabled`/
    // `setMicrophoneEnabled` (a real `getUserMedia` reacquisition, since
    // an already-published speaker's tracks have already left
    // `preparedTracksRef`) — and `localVideoTrack` was never set back to
    // non-null by that particular re-publish path, permanently hiding
    // the self-preview. This is exactly backwards from how this
    // project's own authorization model already says token changes
    // should be handled: "token expiry doesn't enforce anything...
    // revocation happens live via syncPublishPermission()'s push to an
    // already-connected participant, no reconnect required" (see
    // ARCHITECTURE.md's LiveKit authorization model section) — a token
    // refreshed for unrelated reasons (a cookie write, not a permission
    // change) was never supposed to be a reconnect signal at all.
    // Depending on presence rather than value preserves the one
    // legitimate case this effect must still react to (the documented
    // null-params → real-params transition, e.g. phase flipping to
    // "ready") while never tearing down an already-healthy connection
    // just because a later render happens to carry a newer token string
    // for the same room. Reconnecting on every render for any other
    // reason would tear down a healthy call too; only the url actually
    // held, or the token's presence flipping, should restart this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.livekitUrl, Boolean(params?.token)]);

  /**
   * Issue #18 self-preview consistency finding (real-device report:
   * Speaker View occasionally rendered without the floating self-preview
   * even though the camera was actually live). Investigated the
   * suspected failure paths directly:
   * - `SelfPreview` itself attaches/re-attaches correctly whenever its
   *   `track` prop changes (see its own `useEffect`) — it's only ever
   *   mounted at all when `localVideoTrack` is non-null (see
   *   `SpeakerStage`), so a missing preview traces back to
   *   `localVideoTrack` state being null, not a layout/z-index issue or
   *   a stale attach.
   * - The ordinary paths (`prepareLocalMedia`'s own `setLocalVideoTrack`
   *   call, `applyPublishState`'s prepared-tracks branch) already set
   *   `localVideoTrack` directly and don't appear to have a code-level
   *   gap — but `syncCanPublish()`'s own gesture-safety guard
   *   (`mediaActivatedRef.current || !publish`) deliberately *skips*
   *   publishing if the server's permission push arrives before this
   *   tab's own `createLocalTracks()` has resolved (issue #27's direct
   *   join calls `prepareLocalMedia()` fire-and-forget, concurrently with
   *   the seat claim, so this ordering is genuinely possible) — in that
   *   window, publishing is correctly deferred to `prepareLocalMedia`'s
   *   own tail check instead, which re-reads permissions fresh. No
   *   concrete gap was found in that specific handoff, but the number of
   *   independent async completions involved (Realtime, LiveKit
   *   permission push, getUserMedia, publish) makes a rare ordering this
   *   analysis didn't model plausible.
   *
   * Rather than keep chasing an exact reproduction, this is a defensive
   * reconciliation for the general invariant: whenever this tab is
   * permitted to publish (`canPublish`) and the camera is genuinely live
   * and unmuted in the Room, `localVideoTrack` must reflect it. It never
   * re-acquires media (no `createLocalTracks`/`getUserMedia`, so no
   * permission prompt), never reconnects, and isn't a poll — it only
   * re-runs when something real already changed (`canPublish`,
   * `localVideoTrack`, `cameraMuted`, or `participantsVersion`, which
   * `RoomEvent.LocalTrackPublished`/etc. already bump). Logs loudly in
   * development when it actually does something, so a real recurrence
   * on-device leaves a concrete trace instead of silently self-healing.
   */
  useEffect(() => {
    const room = roomRef.current;
    const publication = room?.localParticipant.getTrackPublication(Track.Source.Camera) ?? null;
    const shouldReconcile = shouldReconcileLocalVideoTrack({
      canPublish,
      hasLocalVideoTrack: localVideoTrack !== null,
      cameraMuted,
      publication: publication ? { hasTrack: Boolean(publication.track), isMuted: publication.isMuted } : null,
    });
    if (!shouldReconcile || !publication?.track) return;
    if (process.env.NODE_ENV !== "production") {
      console.error(
        "[useLiveRoomConnection] localVideoTrack was missing while an unmuted camera publication already existed — reconciling from the existing publication instead of re-acquiring media.",
      );
    }
    setLocalVideoTrack(publication.track as LocalVideoTrack);
    // participantsVersion isn't read directly — see getParticipant's own
    // comment on why it's a dependency purely to force a re-check when
    // room/track state mutates in place.
  }, [canPublish, localVideoTrack, cameraMuted, participantsVersion]);

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

  /**
   * Issue #18, Speaker View Phase 2: toggles mute in place on the
   * already-published microphone track — see `LiveRoomConnection`'s own
   * doc comment for why this calls `LocalTrack.mute()`/`.unmute()`
   * rather than `setMicrophoneEnabled`, which would stop/reacquire the
   * hardware track instead. A no-op if nothing is actually published yet
   * for this source (e.g. `needsMediaActivation` still true) — there's
   * no track to mute.
   */
  const toggleMicrophone = useCallback(async () => {
    const room = roomRef.current;
    const track = room?.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
    if (!track) return;
    const nextMuted = !track.isMuted;
    if (nextMuted) {
      await track.mute();
    } else {
      await track.unmute();
    }
    setMicrophoneMuted(nextMuted);
  }, []);

  /** Same as `toggleMicrophone`, for the camera track. */
  const toggleCamera = useCallback(async () => {
    const room = roomRef.current;
    const track = room?.localParticipant.getTrackPublication(Track.Source.Camera)?.track;
    if (!track) return;
    const nextMuted = !track.isMuted;
    if (nextMuted) {
      await track.mute();
    } else {
      await track.unmute();
    }
    setCameraMuted(nextMuted);
  }, []);

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
    microphoneMuted,
    cameraMuted,
    toggleMicrophone,
    toggleCamera,
  };
}
