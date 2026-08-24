"use client";

import { useEffect, useState, useTransition } from "react";
import { useActiveSpeakers } from "@/hooks/use-active-speakers";
import { useAutomaticPromotion } from "@/hooks/use-automatic-promotion";
import { useIsDesktopViewport } from "@/hooks/use-desktop-viewport";
import { useLiveRoomConnection } from "@/hooks/use-live-room-connection";
import { useLobbyRealtime, type LobbyMessage, type ReactionState } from "@/hooks/use-lobby-realtime";
import { useNow } from "@/hooks/use-now";
import { useOrientation } from "@/hooks/use-orientation";
import { useRoleTransitionReset } from "@/hooks/use-role-transition-reset";
import { useSpeakerReconnectGrace } from "@/hooks/use-speaker-reconnect-grace";
import { useHasMountedOnClient } from "@/hooks/use-has-mounted-on-client";
import { deriveParticipantRole, findMySeatNumber } from "@/lib/participant-role";
import { PortraitRoom } from "@/components/room/portrait-room";
import { MobileLandscapeRoom } from "@/components/room/mobile-landscape-room";
import { DesktopRoom } from "@/components/room/desktop-room";
import { RoomDiagnostics } from "@/components/room/room-diagnostics";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { getParticipantIdentity } from "@/lib/livekit/token";
import { formatCountdown, getEventPhase, type EventPhase } from "@/lib/events";
import { isDevToolsAvailable } from "@/lib/dev-demo";
import { joinOpenSeat } from "@/app/events/[id]/room/actions";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL || null;

/**
 * The one persistent event experience (issue #17) — replaces the old
 * three-route event→lobby→room split. This is the single place
 * useActiveSpeakers, useLiveRoomConnection, useLobbyRealtime,
 * useOrientation, useIsDesktopViewport, and (new in #17) the event-phase
 * clock are called. Everything below it (the pre-lobby countdown view,
 * and the three room compositions for lobby_open/ready) is presentation
 * only, reading from this component's state. This is what makes the
 * lobby→live transition genuine — not a redirect that tears down and
 * rebuilds chat/speakers/LiveKit, but the same mounted hooks simply
 * being fed a new `phase` value, the same way rotation already worked:
 * see ARCHITECTURE.md's mobile orientation implementation notes for the
 * precedent this follows (hooks live above the branch, never inside it).
 *
 * **Three compositions, not two** (real-device finding, 2026-08-22):
 * `orientation` alone used to pick between `PortraitRoom` and
 * `LandscapeRoom`, which meant a desktop browser window (also
 * `orientation: landscape`, since that media query is about aspect
 * ratio, not device class) and a phone rotated sideways got the *same*
 * component — a real-device test found that wrong: rotating a phone
 * jumped straight into a permanent-sidebar, dashboard-style layout that
 * abandoned the video-first philosophy portrait already had. Same
 * product model, different composition by form factor now: `orientation`
 * (existing) still decides portrait vs. landscape *within* mobile;
 * `useIsDesktopViewport()` (new, a width threshold — deliberately not
 * `width > height`, see that hook's own doc comment) decides mobile vs.
 * desktop as an independent axis. `PortraitRoom` and
 * `MobileLandscapeRoom` share the same overlay-over-stage philosophy
 * (literally share `StageOverlayShell`); `DesktopRoom` (renamed from
 * `LandscapeRoom`) is the one composition with a real sidebar, reserved
 * for viewports that genuinely have the width to spare for one.
 *
 * **`room-active` body class**: toggled here for the site-wide
 * `SiteHeader` (root layout, outside this component's own tree — see
 * globals.css) to shrink itself specifically on a short mobile-landscape
 * viewport while inside a room. Scoping *which* pages get that
 * treatment needs a signal `SiteHeader` (a route-agnostic server
 * component) can't derive on its own; the actual viewport decision still
 * happens entirely in CSS (a `(orientation: landscape) and (max-height:
 * …)` media query), this class only marks "currently inside a room" for
 * that CSS to key off. Added on mount, removed on unmount — never left
 * stuck on after navigating away.
 *
 * **`mobile-landscape-live-active` body class** (issue #18/#21): the
 * same pattern, one level more specific — tracks "the live-room mobile
 * landscape composition (`MobileLandscapeRoom`, audience *or* speaker)
 * is actually rendering" rather than "any room is mounted," so the site
 * header can be hidden outright (not just shrunk) in short landscape
 * viewports for either role. Originally speaker-only
 * (`speaker-view-active`); broadened once real-device testing found
 * audience landscape needed the exact same treatment once it moved onto
 * the "05" shell too — one class, one CSS rule, not two nearly-identical
 * ones. See globals.css's own comment.
 */
export function EventRoom({
  event,
  identity,
  initialPhase,
  initialToken,
  initialSpeakers,
  initialMessages,
  initialReactions,
  initialHasPendingRequest,
}: {
  event: Event;
  identity: Identity;
  /** Computed server-side at request time — used until the client clock (useNow) ticks past hydration, so first paint is never wrong (e.g. someone opening an already-live link lands live immediately, not on a placeholder). */
  initialPhase: EventPhase;
  initialToken: string | null;
  initialSpeakers: EventSpeaker[];
  initialMessages: LobbyMessage[];
  initialReactions: Record<string, ReactionState>;
  /** Issue #14: whether the caller already has a pending speaker request, fetched server-side. */
  initialHasPendingRequest: boolean;
}) {
  const { messages, reactions } = useLobbyRealtime(event.id, identity, initialMessages, initialReactions);
  const { speakers, roomStatus } = useActiveSpeakers(event.id, initialSpeakers);

  // Issue #27: lifted above the orientation branch — like every other
  // piece of state here, this must survive a rotation, and RoomControls/
  // the composer/the empty-seat tiles are siblings under the branch, not
  // parent/child, so none of them can own this alone anymore.
  const [hasPendingRequest, setHasPendingRequest] = useState(initialHasPendingRequest);
  const [micRequestMode, setMicRequestMode] = useState(false);
  const [joinSeatMessage, setJoinSeatMessage] = useState<string | null>(null);
  const [isJoiningSeat, startJoiningSeat] = useTransition();

  function handleTapEmptySeat() {
    // Issue #18, Speaker View real-device finding: `SpeakerStage`'s own
    // `viewerIsSpeaking` check already omits `onTapEmptySeat` entirely
    // for a seated viewer (never wires a click handler to the empty-tile
    // button at all — see its own doc comment), which is what actually
    // makes the tile inert in the normal case. But that's a *second*,
    // independently-recomputed check, deep in the tree, and this
    // function had no guard of its own — it trusted every caller to
    // never invoke it while seated. If it ever were reachable regardless
    // (a future composition change, a stale prop, anything), it would
    // have called `prepareLocalMedia()` unconditionally below — and for
    // an *already-published* speaker, `preparedTracksRef` is empty (the
    // original tracks already transferred to the Room on publish), so
    // that call would **not** have been the usual no-op: it would have
    // acquired a second, unpublished `getUserMedia()` track and
    // overwritten `localVideoTrack` state with it via `setLocalVideoTrack`,
    // pointing the self-preview at an orphaned track instead of the one
    // actually being published. This early return is the single source
    // of truth this function should have had from the start — `isSpeaker`
    // is already computed once, right here, from the same data
    // `SpeakerStage` re-derives independently; checking it directly at
    // the point where the mutating action actually originates means
    // nothing downstream has to get its own re-derivation exactly right
    // for this to stay safe. `joinOpenSeat`'s own server-side check
    // (`getActiveSeatForIdentity` — see room/actions.ts) was already a
    // second, real guard against an actual seat swap even without this;
    // this closes the client-side gap in front of it.
    if (isSpeaker) return;
    setJoinSeatMessage(null);
    // Issue #22 convergence (real-device finding, 2026-08-22): tapping an
    // open seat is the same expressed intent to speak as the composer's
    // mic-request submit, so it gets the same readiness treatment —
    // called synchronously here, directly from the tile's own onClick
    // (this function's caller), not from inside startJoiningSeat's
    // transition callback below, for the identical Safari gesture reason
    // ChatPanel's onSubmit already documents. Reuses prepareLocalMedia
    // as-is (idempotent, no new hook) — the existing publish path already
    // publishes whatever's prepared once canPublish flips true, regardless
    // of which entry point acquired it, so a successful claim below needs
    // no further wiring to publish without a second permission prompt. On
    // any failure (including queue-exists, which falls back to the same
    // composer request mode), the tracks are deliberately left held, not
    // released — the candidate/audience state this returns to can still
    // use them (retry, or the composer fallback), same as
    // prepareLocalMedia already leaves them for a composer request that
    // hasn't been promoted yet.
    void connection.prepareLocalMedia();
    startJoiningSeat(async () => {
      const result = await joinOpenSeat(event.id);
      if (result.ok) {
        // useActiveSpeakers' own Realtime subscription picks up the new
        // event_speakers row and isSpeaker flips on its own from there —
        // nothing else to update locally, same as claimOpenSeat today.
        return;
      }
      if (result.reason === "queue-exists") {
        // Issue #27's explicit queue-protection UX: a bystander tapping
        // an empty tile when a real queue exists falls back to the
        // normal request flow instead of being told "no" and left
        // stranded — this is that fallback, not an error.
        setMicRequestMode(true);
        return;
      }
      setJoinSeatMessage(result.error);
    });
  }

  const nowMs = useNow();
  const phase = nowMs === null ? initialPhase : getEventPhase(event, new Date(nowMs));

  // LiveKit only connects once genuinely live — canConnect flipping from
  // false to true while this component stays mounted is what lets the
  // room go live in place: useLiveRoomConnection was already designed to
  // handle a null-to-real params transition (see its own doc comment),
  // so this doesn't remount or refetch anything, it just starts using
  // the token already fetched at initial page load.
  const canConnect = Boolean(LIVEKIT_URL && initialToken && phase === "ready");
  const connection = useLiveRoomConnection(canConnect ? { livekitUrl: LIVEKIT_URL!, token: initialToken! } : null);

  const orientation = useOrientation();
  const isDesktopViewport = useIsDesktopViewport();
  // Issue #18 first-load consistency finding — see this hook's own doc
  // comment for the exact hydration race this closes (a seated speaker
  // intermittently landing in the wrong, role-unaware composition on a
  // fresh page load).
  const hasMountedOnClient = useHasMountedOnClient();

  // See this component's own doc comment ("room-active body class").
  useEffect(() => {
    document.body.classList.add("room-active");
    return () => {
      document.body.classList.remove("room-active");
    };
  }, []);

  const myIdentity = getParticipantIdentity(
    identity.type === "profile" ? { type: "profile", id: identity.id } : { type: "guest", id: identity.id },
  );
  // Issue #18 consistency fix: the *one* place "which seat, if any, does
  // this identity hold" gets computed — everything downstream (isSpeaker,
  // the role routers, SpeakerStage's own solo-tile selection) reads the
  // result as a plain prop instead of re-deriving it independently. See
  // lib/participant-role.ts's own doc comment for the investigation this
  // closes. Issue #16: a guest can hold a seat too (prototype-testing
  // exception — see PRODUCT.md/DECISIONS.md), so this matches whichever
  // identity column is actually set on the seat row, not just profile_id.
  const mySeatNumber = findMySeatNumber(speakers, identity);
  const isSpeaker = mySeatNumber !== null;
  const participantRole = deriveParticipantRole({ isSpeaker, hasPendingRequest });
  // Issue #18 reconnect-countdown finding: the viewer's own active-seat
  // row (if any) carries their own `disconnected_at` — set by the
  // webhook's `participant_left` handler and delivered here via the same
  // Realtime subscription `speakers` already flows through, independent
  // of this tab's own LiveKit connection state (a network drop the
  // LiveKit server detects reaches this tab over Realtime even if this
  // tab's own UI is still rendering). `SpeakerMediaActivationPrompt`
  // uses this to show the real remaining grace time instead of a fresh,
  // client-invented countdown — see lib/speaker-reconnect.ts.
  const myDisconnectedAt = speakers.find((s) => s.seat_number === mySeatNumber)?.disconnected_at ?? null;

  // Issue #18 first-load consistency finding: dev-only trace of the
  // exact ordering that determines which composition renders, so a
  // recurrence of "role says speaker but the wrong composition shows"
  // leaves a concrete, inspectable log instead of needing to be
  // reproduced blind. Fires after each commit (not during render), so
  // it reflects what actually painted, not a discarded intermediate
  // render.
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    console.debug("[EventRoom] composition inputs", {
      hasMountedOnClient,
      isDesktopViewport,
      orientation,
      phase,
      participantRole,
      isSpeaker,
      mySeatNumber,
    });
  }, [hasMountedOnClient, isDesktopViewport, orientation, phase, participantRole, isSpeaker, mySeatNumber]);

  // Issue #18 consistency fix: becoming a speaker invalidates any
  // candidate-only local state — see useRoleTransitionReset's own doc
  // comment for why this is the single reconciliation point rather than
  // relying on each individual promotion path (claimOpenSeat's countdown
  // resolution, joinOpenSeat's direct join) to remember to clear its own
  // piece of it.
  useRoleTransitionReset({
    isSpeaker,
    onReset: () => {
      setHasPendingRequest(false);
      setMicRequestMode(false);
      setJoinSeatMessage(null);
    },
  });

  // Issue #18/#21: mirrors the `room-active` class above, but tracks
  // "the live-room mobile landscape composition is actually rendering"
  // specifically (not just "a room is mounted") — see globals.css's own
  // comment for what this actually does (hides the site header in short
  // landscape viewports, reclaiming space for the full-bleed
  // composition). Originally gated on `isSpeaker` alone; broadened to
  // `phase !== "upcoming" && !isDesktopViewport && orientation ===
  // "landscape"` once audience landscape moved onto the same "05" shell
  // and needed the identical treatment — this condition is true exactly
  // when `MobileLandscapeRoom` (either its audience or its speaker
  // branch) is the composition `EventRoom` is about to render below, so
  // it covers both without needing two separate classes/CSS rules. A
  // separate effect, not folded into the `room-active` one above, since
  // this one's dependency set is real and can change repeatedly across a
  // single mount (rotating, getting promoted, resizing past the desktop
  // threshold), unlike `room-active`'s mount-once/unmount-once
  // lifecycle.
  useEffect(() => {
    const inMobileLandscapeLiveRoom = phase !== "upcoming" && !isDesktopViewport && orientation === "landscape";
    document.body.classList.toggle("mobile-landscape-live-active", inMobileLandscapeLiveRoom);
    return () => {
      document.body.classList.remove("mobile-landscape-live-active");
    };
  }, [phase, isDesktopViewport, orientation]);

  // Issue #23: replaces the manual "Claim your seat" button. Called
  // unconditionally here (above the phase==="upcoming" early return
  // below), same discipline as every other piece of live state in this
  // component — must survive rotation, and RoomControls (which renders
  // the countdown UI) is a presentation-only descendant, not where this
  // can live.
  const { countdown: promotionCountdown, cancel: cancelPromotion } = useAutomaticPromotion({
    eventId: event.id,
    hasPendingRequest,
    isSpeaker,
    phase,
    needsMediaActivation: connection.needsMediaActivation,
    mediaError: connection.mediaError,
    onHasPendingRequestChange: setHasPendingRequest,
  });

  // Real-device reconnect-grace-period finding, issue #18 UX finding:
  // enabled only once LiveKit is actually meant to be connected
  // (canConnect/"ready") — kept for interface parity even though the
  // hook's own derivation no longer depends on this tab's LiveKit
  // connection state at all (see its own doc comment).
  const reconnectingIdentities = useSpeakerReconnectGrace({
    eventId: event.id,
    speakers,
    myIdentity,
    enabled: canConnect,
  });

  // Issue #22: "Withdraw" (waiting) and "Cancel" (mid-countdown) both route
  // through cancelPromotion — releasing any held-but-unpublished tracks
  // here too, once, covers both the same way withdrawing already
  // uniformly does for the request itself. A promoted-and-published
  // speaker leaving via "Leave the stage" doesn't go through this path at
  // all (see RoomControls) — that's handled by the existing
  // canPublish → false reaction inside useLiveRoomConnection instead.
  function handleCancelPromotion() {
    connection.releaseLocalMedia();
    cancelPromotion();
  }

  if (phase === "upcoming") {
    const now = nowMs === null ? null : new Date(nowMs);
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 overflow-hidden p-6 text-center">
        <h1 className="text-xl font-semibold">{event.title}</h1>
        {event.description && <p className="max-w-md text-sm text-muted">{event.description}</p>}
        <p className="text-sm text-muted">
          {now ? (
            <>
              Lobby opens in{" "}
              <span className="font-medium text-foreground">{formatCountdown(event.lobby_opens_at, now)}</span>
            </>
          ) : (
            "…"
          )}
        </p>
        {identity.type === "guest" && <GuestNameEditor initialName={identity.displayName} />}
      </div>
    );
  }

  const countdownText =
    phase === "lobby_open" && nowMs !== null ? `Live in ${formatCountdown(event.scheduled_start, new Date(nowMs))}` : null;

  const layoutProps = {
    event,
    phase,
    countdownText,
    roomStatus,
    speakers,
    myIdentity,
    identity,
    isSpeaker,
    mySeatNumber,
    participantRole,
    myDisconnectedAt,
    hasPendingRequest,
    onHasPendingRequestChange: setHasPendingRequest,
    promotionCountdown,
    onCancelPromotion: handleCancelPromotion,
    micRequestMode,
    onMicRequestModeChange: setMicRequestMode,
    onTapEmptySeat: handleTapEmptySeat,
    isJoiningSeat,
    joinSeatMessage,
    getParticipant: connection.getParticipant,
    participantCount: connection.participantCount,
    connectionStatus: connection.status,
    canPublish: connection.canPublish,
    needsMediaActivation: connection.needsMediaActivation,
    activateMedia: connection.activateMedia,
    mediaError: connection.mediaError,
    localVideoTrack: connection.localVideoTrack,
    onPrepareMedia: connection.prepareLocalMedia,
    reconnectingIdentities,
    messages,
    reactions,
    microphoneMuted: connection.microphoneMuted,
    cameraMuted: connection.cameraMuted,
    toggleMicrophone: connection.toggleMicrophone,
    toggleCamera: connection.toggleCamera,
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="min-h-0 flex-1">
        {!hasMountedOnClient ? (
          // Issue #18 first-load consistency finding: viewport/orientation
          // are unknown on the server and guessed (mobile-portrait) for
          // the client's first hydration pass — committing to a real
          // composition on that guess is exactly what let a seated
          // speaker's first paint briefly show Speaker View and then get
          // silently replaced by DesktopRoom (no role router at all) once
          // the guess corrected. A brief neutral state here, instead,
          // means the *next* render — once useHasMountedOnClient flips
          // true and orientation/isDesktopViewport already reflect the
          // real client — is the only one that ever picks a composition.
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-black text-white/70">
            {isSpeaker && <p className="text-sm font-medium">Reconnecting to stage…</p>}
          </div>
        ) : isDesktopViewport ? (
          <DesktopRoom {...layoutProps} />
        ) : orientation === "landscape" ? (
          <MobileLandscapeRoom {...layoutProps} />
        ) : (
          <PortraitRoom {...layoutProps} />
        )}
      </div>
      {/*
       * Issue #20: pulled out of the normal room UI entirely — it was
       * floating/obstructing real controls on real devices (see issue
       * #17's real-device follow-up, and RoomDiagnostics' own doc
       * comment). Still mounted, but only outside production, the same
       * `isDevToolsAvailable()` gate `/dev` and its Server Actions already
       * use — a real phone testing the deployed app never sees this; a
       * local dev server still can for real-device debugging.
       */}
      {isDevToolsAvailable() && (
        <RoomDiagnostics
          identityType={identity.type}
          isSpeaker={isSpeaker}
          hasServerToken={initialToken !== null}
          liveKitUrlConfigured={Boolean(LIVEKIT_URL)}
          connectionStatus={connection.status}
          canPublish={connection.canPublish}
          needsMediaActivation={connection.needsMediaActivation}
          mediaError={connection.mediaError}
          participantCount={connection.participantCount}
        />
      )}
    </div>
  );
}
