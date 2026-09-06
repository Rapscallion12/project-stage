"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useActiveSpeakers } from "@/hooks/use-active-speakers";
import { useActiveSpeakerRequests } from "@/hooks/use-active-speaker-requests";
import { useAutomaticPromotion } from "@/hooks/use-automatic-promotion";
import { useIsDesktopViewport } from "@/hooks/use-desktop-viewport";
import { useLiveRoomConnection, describeMediaReadinessFailure } from "@/hooks/use-live-room-connection";
import { useLobbyRealtime, type LobbyMessage, type ReactionState } from "@/hooks/use-lobby-realtime";
import { useNow } from "@/hooks/use-now";
import { useOrientation } from "@/hooks/use-orientation";
import { useRoleTransitionReset } from "@/hooks/use-role-transition-reset";
import { useSpeakerReconnectGrace } from "@/hooks/use-speaker-reconnect-grace";
import { useSpeakerMediaPresenceReporting } from "@/hooks/use-speaker-media-presence";
import { useOwnSeatExpirationConfirmation } from "@/hooks/use-own-seat-expiration-confirmation";
import { useSeatReconciliation } from "@/hooks/use-seat-reconciliation";
import { useReleaseStuckLocalMedia } from "@/hooks/use-release-stuck-local-media";
import { useStageRound } from "@/hooks/use-stage-round";
import { useStageRoundResolution } from "@/hooks/use-stage-round-resolution";
import { useStageRoundReconciliation } from "@/hooks/use-stage-round-reconciliation";
import { useSpeakerSelectionReconciliation } from "@/hooks/use-speaker-selection-reconciliation";
import { useProfileDirectory } from "@/hooks/use-profile-directory";
import { useSpeakerInvariantRecovery } from "@/hooks/use-speaker-invariant-recovery";
import { useHasMountedOnClient } from "@/hooks/use-has-mounted-on-client";
import { deriveParticipantRole, findMySeatNumber } from "@/lib/participant-role";
import { inactiveSince } from "@/lib/speaker-presence";
import { PortraitRoom } from "@/components/room/portrait-room";
import { MobileLandscapeRoom } from "@/components/room/mobile-landscape-room";
import { DesktopRoom } from "@/components/room/desktop-room";
import { RoomDiagnostics } from "@/components/room/room-diagnostics";
import { RoomInfoOverlay } from "@/components/room/room-info-overlay";
import { SessionSimulatorPanel } from "@/components/room/session-simulator-panel";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { getParticipantIdentity } from "@/lib/livekit/token";
import { formatCountdown, getEventPhase, type EventPhase } from "@/lib/events";
import { isDevToolsAvailable } from "@/lib/dev-demo";
import { joinOpenSeat } from "@/app/events/[id]/room/actions";
import { useReactionsController } from "@/hooks/use-stage-reactions";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { SpeakerRequest } from "@/lib/repositories/speaker-requests";

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
  identityAvatarUrl = null,
  initialPhase,
  initialToken,
  initialSpeakers,
  initialMessages,
  initialReactions,
  initialHasPendingRequest,
  initialPendingRequests,
  isPreviewBuild,
  isSimulatorUiEnabled,
}: {
  event: Event;
  identity: Identity;
  /** Visual identity pass, Room Info redesign: the signed-in account's own avatar, for `RoomInfoOverlay`'s identity block — `null` for a guest or an account without one yet. Optional/defaulted so every existing test call site stays valid unchanged. */
  identityAvatarUrl?: string | null;
  /** Computed server-side at request time — used until the client clock (useNow) ticks past hydration, so first paint is never wrong (e.g. someone opening an already-live link lands live immediately, not on a placeholder). */
  initialPhase: EventPhase;
  initialToken: string | null;
  initialSpeakers: EventSpeaker[];
  initialMessages: LobbyMessage[];
  initialReactions: Record<string, ReactionState>;
  /** Issue #14: whether the caller already has a pending speaker request, fetched server-side. */
  initialHasPendingRequest: boolean;
  /** Issue #21: every currently-pending speaker request, for "Top Speaker Requests" — see useActiveSpeakerRequests' own doc comment. */
  initialPendingRequests: SpeakerRequest[];
  /** Issue #21, Part 1: computed server-side (`isPreviewOrDevBuild()`) — never re-derived here, since `VERCEL_ENV` isn't reliably readable in a client component. Governs only the full-time round-timer test presentation now — see `isSimulatorUiEnabled` for the Session Simulator panel's own, separate gate (pre-launch interaction pass). */
  isPreviewBuild: boolean;
  /** Pre-launch interaction pass: computed server-side (`isSimulatorUiEnabled()`, lib/preview-mode.ts) — whether the Session Simulator's own UI (panel + collapsed "SIM" pill) should render at all. Deliberately narrower than, and required *in addition to*, `isPreviewBuild` — see that function's own doc comment for why a Vercel preview alone must no longer be enough. */
  isSimulatorUiEnabled: boolean;
}) {
  const { messages, reactions } = useLobbyRealtime(event.id, identity, initialMessages, initialReactions);
  // Moved up from its original spot below (still the "one canonical
  // myIdentity" computation, unchanged) — needed here, before
  // useReactionsController, so the reactions controller can tag the
  // sender's own optimistic reactions and self-filter its own eventual
  // broadcast (real-device follow-up: see that hook's own doc comment).
  const myIdentity = getParticipantIdentity(
    identity.type === "profile" ? { type: "profile", id: identity.id } : { type: "guest", id: identity.id },
  );
  // Pre-launch interaction pass: one shared instance, above every
  // composition/role branch — same discipline as useLiveRoomConnection/
  // useActiveSpeakers above. Named `stageReactions` to avoid colliding
  // with `reactions` above (the unrelated lobby comment-reaction counts).
  const stageReactions = useReactionsController(event.id, myIdentity);
  const { speakers, roomStatus, refetch: refetchSpeakers, getSyncDiagnostics: getSpeakerSyncDiagnostics } = useActiveSpeakers(
    event.id,
    initialSpeakers,
  );
  // Issue #21, sixteenth corrective pass: `refetchSpeakers` now takes an
  // optional `reason` and returns the freshly-fetched rows (so a caller
  // like simulator bootstrap can verify convergence directly — see
  // SessionSimulatorPanel's own doc comment). `onClaimSucceeded`/
  // `useSeatReconciliation`'s own `refetch` prop are typed `() => void`/
  // `() => Promise<void>` and never need the fetched rows themselves —
  // this is the same reconcile, just called without a reason (defaults
  // to "manual") and with its return value discarded, never a second,
  // parallel mechanism.
  const refetchSpeakersAsVoid = useCallback(async () => {
    await refetchSpeakers();
  }, [refetchSpeakers]);
  const { pendingRequests } = useActiveSpeakerRequests(event.id, identity, initialPendingRequests);

  // Issue #27: lifted above the orientation branch — like every other
  // piece of state here, this must survive a rotation, and RoomControls/
  // the composer/the empty-seat tiles are siblings under the branch, not
  // parent/child, so none of them can own this alone anymore.
  const [hasPendingRequest, setHasPendingRequest] = useState(initialHasPendingRequest);
  const [micRequestMode, setMicRequestMode] = useState(false);
  const [joinSeatMessage, setJoinSeatMessage] = useState<string | null>(null);
  const [isJoiningSeat, startJoiningSeat] = useTransition();

  // Session Simulator real-device follow-up: guest ids the simulator has
  // generated in this tab, so SpeakerTile can render an unambiguous
  // "Simulated speaker" placeholder instead of the ordinary "Camera off"
  // one — see RoomLayoutProps' own doc comment. Stays empty (and the
  // registration callback below is never invoked) outside `isPreviewBuild`,
  // since SessionSimulatorPanel — the only caller of it — isn't mounted
  // then either.
  const [simulatedGuestIds, setSimulatedGuestIds] = useState<ReadonlySet<string>>(new Set());
  function registerSimulatedGuestIds(ids: string[]) {
    setSimulatedGuestIds((prev) => new Set([...prev, ...ids]));
  }

  // Issue #21, seventh corrective pass, Sections 8-15: the collapsed
  // room/navigation control's open/closed state — plain local UI state,
  // deliberately not threaded through anything that decides media/seat/
  // LiveKit state (same "presentation only" discipline `commentsOpen`
  // already follows in PortraitRoom/MobileLandscapeRoom). Lives here,
  // not inside any one composition, because the trigger that opens it
  // appears in all three; RoomInfoOverlay itself renders once, below,
  // as a sibling of the composition branch — never a wrapper around it,
  // so opening it can't remount the stage. See RoomInfoOverlay's own
  // doc comment.
  const [roomInfoOpen, setRoomInfoOpen] = useState(false);

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
    //
    // Media Readiness pass (issue #21): the promise itself is captured
    // here, synchronously, in the same gesture-safe call as above — but
    // the *readiness check* it resolves to is awaited inside
    // startJoiningSeat's transition below, not here. This is the same
    // seat-claim invariant this pass adds to useAutomaticPromotion's RTS
    // path: no real claim (joinOpenSeat) fires unless both camera and
    // microphone actually produced usable tracks. A denied/unavailable
    // device now surfaces the same descriptive joinSeatMessage this
    // function already uses for every other non-claim outcome, instead
    // of claiming the seat and letting the existing post-seating grace
    // timer discover the problem 30 seconds later.
    const readinessPromise = connection.prepareLocalMedia();
    startJoiningSeat(async () => {
      const readiness = await readinessPromise;
      if (!readiness.camera.ready || !readiness.microphone.ready) {
        setJoinSeatMessage(describeMediaReadinessFailure(readiness));
        return;
      }
      const result = await joinOpenSeat(event.id);
      if (result.ok) {
        // Issue #18 real-device finding (2026-08-28): previously relied
        // solely on useActiveSpeakers' own Realtime subscription to pick
        // up the new row — exactly the assumption that let a missed
        // delta leave this tab stuck showing the audience composition
        // after a successful claim. A direct, immediate refetch here
        // means a genuinely successful join reflects instantly even if
        // the Realtime INSERT never arrives at all, not just eventually
        // once some other trigger happens to notice the contradiction.
        void refetchSpeakers();
        return;
      }
      if (result.reason === "queue-exists" || result.reason === "selection-required") {
        // Issue #27's explicit queue-protection UX: a bystander tapping
        // an empty tile when a real queue exists falls back to the
        // normal request flow instead of being told "no" and left
        // stranded — this is that fallback, not an error. Issue #21,
        // third corrective pass: `selection-required` means the same
        // fallback applies for a different reason — the stage has moved
        // past initial formation, so this seat is never directly
        // tappable again regardless of queue length; submitting a
        // Request-to-Speak is the only path to it now. This branch
        // shouldn't even be reachable in practice once SpeakerStage
        // stops wiring `onTapEmptySeat` at all for an established-stage
        // empty seat (see that component's own doc comment) — kept as a
        // defensive fallback for a stale client, never trusted alone.
        setMicRequestMode(true);
        return;
      }
      if (result.reason === "already-speaking") {
        // Issue #18 real-device finding (2026-08-27): this is proof of a
        // genuine contradiction, not an ordinary rejection —
        // getActiveSeatForIdentity (server, expiration-aware) just found
        // an active seat for an identity this component's own isSpeaker
        // (derived from useActiveSpeakers' accumulated client state)
        // believed was audience. The dev-facing invariant this captures:
        // participantRole/isSpeaker said "audience" while the
        // authoritative seat lookup said otherwise for the same
        // identity — that combination should be structurally
        // impossible once useActiveSpeakers' state is genuinely synced.
        // Un-gated (not NODE_ENV-conditional) so this is inspectable via
        // remote devtools on a real device, matching this room's other
        // real-device diagnostics.
        console.error(
          "[EventRoom] contradiction: joinOpenSeat found an active seat for this identity while participantRole/isSpeaker said audience — reconciling from a fresh server read.",
          { participantRole, isSpeaker, mySeatNumber, authoritativeSeatNumber: result.seatNumber },
        );
        // Reconciles this tab's speakers state from the same
        // authoritative source getActiveSeatForIdentity just read,
        // instead of leaving the user stuck on a dead-end error — see
        // useActiveSpeakers' own doc comment for why its accumulated
        // state could have drifted in the first place.
        void refetchSpeakers();
        return;
      }
      if (result.reason === "fallback-excluded") {
        // Issue #21, fifth corrective pass, Section 10: this identity was
        // one of the speaker(s) just removed the last time both seats
        // went empty — not eligible to instantly reclaim a fallback
        // seat this recovery cycle. Framed as guidance, not a dead-end:
        // Request-to-Speak is still open to them (Section 11).
        setJoinSeatMessage("You can't immediately rejoin after being removed — try Request to Speak instead.");
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
  // Issue #18 unified inactive-speaker finding: the viewer's own
  // active-seat row (if any) carries whichever of `disconnected_at`/
  // `media_inactive_since` is set — both delivered here via the same
  // Realtime subscription `speakers` already flows through, independent
  // of this tab's own LiveKit connection state (a network drop the
  // LiveKit server detects reaches this tab over Realtime even if this
  // tab's own UI is still rendering). `inactiveSince` collapses both
  // into the one deadline `SpeakerMediaActivationPrompt`/`SpeakerTile`
  // show the real remaining grace time from — never a fresh,
  // client-invented countdown. See lib/speaker-presence.ts.
  const myInactiveSince = inactiveSince(speakers.find((s) => s.seat_number === mySeatNumber));

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

  // Issue #21, seventh corrective pass: the narrower
  // `mobile-landscape-live-active` body class (and its two
  // short-landscape-only CSS rules) that used to hide the site header
  // only for the mobile landscape composition is retired — `room-active`
  // above now hides it unconditionally for every composition (see
  // globals.css's own doc comment), so a second, narrower mechanism for
  // the same outcome is no longer needed.

  // Issue #23: replaces the manual "Claim your seat" button. Called
  // unconditionally here (above the phase==="upcoming" early return
  // below), same discipline as every other piece of live state in this
  // component — must survive rotation, and RoomControls (which renders
  // the countdown UI) is a presentation-only descendant, not where this
  // can live.
  // Issue #21, sixth corrective pass: real-device testing found
  // next-speaker promotion taking several seconds longer than it should
  // — traced to `useAutomaticPromotion`'s eligibility detection being a
  // *pure poll* (`checkPromotionEligibility`, every
  // `POLL_INTERVAL_MS`), entirely blind to the `pendingRequests` state
  // this component already has live, Realtime-pushed, right here —
  // including each request's own `is_current_candidate`/
  // `reserved_seat_number`, set by the exact same reservation RPC the
  // poll would eventually re-discover on its own next tick. A candidate
  // could be reserved for a seat and have that fact sitting in this
  // component's own state for up to a full poll interval before the
  // hook's *separate* server round-trip happened to notice. This is the
  // reactive fast path: derived directly from already-live data, passed
  // in as an additional, immediate trigger — the poll remains as a
  // bounded backstop (for a missed Realtime delta), no longer the only
  // path. See `useAutomaticPromotion`'s own doc comment for how it's
  // used, and DECISIONS.md for the full diagnosis.
  const myIdentityColumn = identity.type === "profile" ? "profile_id" : "guest_id";
  const isCurrentlyReservedCandidate = pendingRequests.some(
    (r) => r.is_current_candidate && r.reserved_seat_number !== null && r[myIdentityColumn] === identity.id,
  );

  const { countdown: promotionCountdown, cancel: cancelPromotion } = useAutomaticPromotion({
    eventId: event.id,
    hasPendingRequest,
    isCurrentlyReservedCandidate,
    isSpeaker,
    phase,
    needsMediaActivation: connection.needsMediaActivation,
    mediaError: connection.mediaError,
    cameraReady: connection.mediaReadiness.camera.ready,
    microphoneReady: connection.mediaReadiness.microphone.ready,
    onHasPendingRequestChange: setHasPendingRequest,
    // Issue #18 real-device finding (2026-08-28): the same immediate,
    // direct refetch as handleTapEmptySeat's own successful join above —
    // a successful automatic-promotion claim previously relied solely on
    // isSpeaker eventually flipping via Realtime (see this hook's own
    // doc comment on the countdown overlay staying frozen at 0 until
    // then), which is exactly the assumption a missed delta breaks.
    // Passed directly, not wrapped in a fresh arrow function each render
    // — refetchSpeakers is already a stable reference (useActiveSpeakers'
    // own useCallback), and this hook's claim effect depends on it, so an
    // unstable identity here would re-schedule its countdown timer on
    // every unrelated EventRoom re-render.
    onClaimSucceeded: refetchSpeakersAsVoid,
  });

  // Issue #18 real-device finding (2026-08-28): the automatic,
  // no-second-tap-required version of the same reconciliation
  // `handleTapEmptySeat`'s `already-speaking` branch already does
  // manually — see this hook's own doc comment for the exact triggers
  // (a LiveKit-confirmed publish permission the client's own role still
  // doesn't reflect, and returning to a backgrounded tab). Never a
  // second role flag: it only ever calls the same `refetchSpeakers`
  // already used everywhere else in this component.
  useSeatReconciliation({
    isSpeaker,
    canPublish: connection.canPublish,
    refetch: refetchSpeakersAsVoid,
  });

  // Issue #21 corrective pass, real-device finding: closes the stuck
  // self-preview/no-Leave-Stage state a lost seat-claim race could leave
  // behind — see this hook's own doc comment for the exact mechanism.
  // General fix (not simulator-specific): releases local media whenever
  // every legitimate reason to hold it is absent.
  useReleaseStuckLocalMedia({
    isSpeaker,
    isJoiningSeat,
    hasPendingRequest,
    promotionCountdown,
    micRequestMode,
    localVideoTrack: connection.localVideoTrack,
    releaseLocalMedia: connection.releaseLocalMedia,
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

  // Issue #21 corrective pass: the shared round clock's live state —
  // resyncs on every Realtime SUBSCRIBED, same discipline
  // useActiveSpeakers already established.
  const stageRound = useStageRound(event.id);

  // Issue #21, Part 1/15 (corrective pass: now one shared deadline per
  // stage pairing, plus per-seat closing deadlines): schedules the
  // authoritative resolution trigger — runs unconditionally (not gated
  // on canConnect/isSpeaker), so any connected client, audience
  // included, can be the one whose timer fires and keeps a round
  // resolving even if neither seated speaker's own tab is around to do
  // it. See the hook's own doc comment.
  useStageRoundResolution(event.id, stageRound, speakers);

  // Issue #21, fourth corrective pass: the reactive backstop for the
  // same invariant — re-verifies the shared round against actual current
  // occupancy whenever occupancy itself changes. See the hook's own doc
  // comment for why this is needed in addition to the resolution effect
  // above (that one resolves an *already-active* round at its deadline;
  // this one catches the round ever being active without a genuinely
  // established pairing in the first place).
  useStageRoundReconciliation(event.id, speakers);

  // Issue #21, sixteenth corrective pass: the inverse invariant —
  // `useStageRoundReconciliation` above re-verifies the shared round
  // against this tab's own *speaker* occupancy; nothing previously
  // checked the other direction. A real-device snapshot caught exactly
  // this combination: client round #7 active, client seats occupied:
  // none, for 13+ seconds. See the hook's own doc comment for why this
  // is a bounded safety net, not the primary fix (that's event-driven
  // reconciliation at the actual mutation sites, e.g.
  // SessionSimulatorPanel's own bootstrap-confirmation calls below).
  useSpeakerInvariantRecovery(stageRound, speakers.length, refetchSpeakers);

  // Issue #21, fifth corrective pass, Section 6: the same reactive-
  // backstop discipline, for candidate selection/reservation this time —
  // see the hook's own doc comment for why event-driven selection alone
  // (triggered only by an eligible candidate's own polling) isn't always
  // enough. Any connected client re-verifies whenever its own view of
  // occupancy or the pending-request pool changes.
  const { getReconcileDiagnostics: getSelectionReconcileDiagnostics } = useSpeakerSelectionReconciliation(event.id, speakers, pendingRequests);

  // Issue #29: every profile_id currently visible anywhere in this
  // room's own live state — speakers, comment authors, RTS candidates —
  // resolved once here (not per-surface) and passed straight through.
  // `useProfileDirectory`'s own stable, deduplicated key means this is
  // safe to recompute on every render without re-querying on every
  // unrelated state change. Called unconditionally here, alongside this
  // component's other hooks — every early return below (the "upcoming"
  // phase, the neutral pre-mount state) happens *after* this point, so
  // calling it any later would violate rules-of-hooks.
  const visibleProfileIds = [
    ...speakers.map((s) => s.profile_id),
    ...messages.map((m) => m.author_profile_id),
    ...pendingRequests.map((r) => r.profile_id),
  ].filter((id): id is string => id !== null);
  const profileDirectory = useProfileDirectory(visibleProfileIds);

  // Issue #18 unified inactive-speaker finding: the client-observed half
  // of "inactive" (see lib/speaker-presence.ts) — reports this tab's own
  // media-presence transitions to the server, which owns the actual
  // grace-period clock/release the same way it already does for a
  // genuine LiveKit disconnect. Only meaningful while this identity
  // holds a seat; a no-op hook call otherwise.
  useSpeakerMediaPresenceReporting({
    eventId: event.id,
    isSpeaker,
    canPublish: connection.canPublish,
    needsMediaActivation: connection.needsMediaActivation,
    microphoneMuted: connection.microphoneMuted,
    cameraMuted: connection.cameraMuted,
  });

  // Issue #18 expiration-enforcement finding: the returning speaker's
  // own confirmation trigger — useSpeakerReconnectGrace above
  // deliberately never schedules an eviction check for the viewer's own
  // seat, so without this, an identity alone in the room (no co-speaker/
  // audience tab to trigger it on their behalf) could sit at "· 0s"
  // indefinitely. Reuses myInactiveSince — the same deadline the visible
  // countdown itself is derived from — never a second timer.
  useOwnSeatExpirationConfirmation(event.id, myInactiveSince);

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
    profileDirectory,
    myIdentity,
    identity,
    identityAvatarUrl,
    isSpeaker,
    mySeatNumber,
    participantRole,
    myInactiveSince,
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
    mediaReadiness: connection.mediaReadiness,
    acquiringMedia: connection.acquiringMedia,
    localVideoTrack: connection.localVideoTrack,
    onPrepareMedia: connection.prepareLocalMedia,
    reconnectingIdentities,
    messages,
    reactions,
    pendingRequests,
    microphoneMuted: connection.microphoneMuted,
    cameraMuted: connection.cameraMuted,
    toggleMicrophone: connection.toggleMicrophone,
    toggleCamera: connection.toggleCamera,
    isPreviewBuild,
    simulatedGuestIds,
    stageRound,
    onOpenRoomInfo: () => setRoomInfoOpen(true),
    stageReactions,
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
      {/*
       * Issue #21, seventh corrective pass, Sections 8-15: rendered once,
       * here — a sibling of the composition branch above, never a
       * wrapper around it. See RoomInfoOverlay's own doc comment for why
       * this placement is what guarantees opening/closing it can never
       * remount the stage or reset any live room state.
       */}
      <RoomInfoOverlay
        open={roomInfoOpen}
        onClose={() => setRoomInfoOpen(false)}
        event={event}
        roomStatus={roomStatus}
        identity={identity}
        identityAvatarUrl={identityAvatarUrl}
      />
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
          speakers={speakers}
          getParticipant={connection.getParticipant}
          myIdentity={myIdentity}
          reconnectingIdentities={reconnectingIdentities}
        />
      )}
      {/*
       * Issue #21, Part 5, narrowed by the pre-launch interaction pass:
       * the actual security boundary is every simulator Server Action
       * independently re-checking `isPreviewOrDevBuild()` itself
       * (`VERCEL_ENV !== "production"` — see lib/preview-mode.ts) — this
       * conditional render is defense in depth, not the enforcement.
       * `isSimulatorUiEnabled` is a second, deliberately narrower
       * condition required in addition — an ordinary Vercel preview
       * (now also used to test the real launch-facing experience) no
       * longer shows this UI on its own; see that function's own doc
       * comment. Deliberately outside the main room div, same reasoning
       * as RoomDiagnostics above: tooling, not part of the consumer room
       * UI.
       */}
      {isPreviewBuild && isSimulatorUiEnabled && (
        <SessionSimulatorPanel
          eventId={event.id}
          speakers={speakers}
          pendingRequests={pendingRequests}
          messages={messages}
          stageRound={stageRound}
          realJoinInProgress={isJoiningSeat || promotionCountdown !== null}
          onSimulatedIdentitiesCreated={registerSimulatedGuestIds}
          // Issue #21, sixteenth corrective pass: the same canonical
          // reconcile function every other trigger in this component
          // uses (SUBSCRIBED, visibility, focus, the invariant check
          // above, the already-speaking contradiction below) — bootstrap
          // calls this directly after its own authoritative seat
          // confirmation, tagged "bootstrap", instead of only trusting
          // Realtime to eventually deliver the same INSERT this tab's
          // own mutation just caused. One canonical stage speaker state,
          // never a simulator-specific duplicate.
          refetchSpeakers={refetchSpeakers}
          getSpeakerSyncDiagnostics={getSpeakerSyncDiagnostics}
          getSelectionReconcileDiagnostics={getSelectionReconcileDiagnostics}
          stageReactions={stageReactions}
          // Issue #21, seventh corrective pass, Section 19: defense in
          // depth alongside SessionSimulatorPanel's own database cleanup
          // — an explicit fresh read of speaker occupancy, the same
          // "don't just trust an incremental Realtime delta arrived"
          // discipline useActiveSpeakers' own SUBSCRIBED-triggers-
          // refetch already uses elsewhere. messages/pendingRequests/
          // stageRound each already correctly clear a deleted row via
          // their own Realtime DELETE handlers (see useStageRound's own
          // doc comment for the real bug fixed there) — this covers the
          // one remaining case a missed delta could leave stale.
          onSimulatorReset={() => {
            setSimulatedGuestIds(new Set());
            void refetchSpeakers();
          }}
        />
      )}
    </div>
  );
}
