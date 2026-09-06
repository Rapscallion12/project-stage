import { useLayoutEffect, useRef, useState } from "react";
import type { LocalAudioTrack, LocalVideoTrack, Participant, RemoteAudioTrack } from "livekit-client";
import { SpeakerTile } from "@/components/room/speaker-tile";
import { SelfPreview } from "@/components/room/self-preview";
import { AudioOnlyVisualizer } from "@/components/room/audio-only-visualizer";
import { ReactionSideLane } from "@/components/room/stage-reactions-overlay";
import { getParticipantIdentity } from "@/lib/livekit/token";
import { deriveParticipantMediaState } from "@/lib/participant-media-state";
import { cn } from "@/lib/utils";
import { useStageRoundCountdown } from "@/hooks/use-stage-round-countdown";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";
import type { MediaError, MediaReadinessState } from "@/hooks/use-live-room-connection";
import type { ReactionsController } from "@/hooks/use-stage-reactions";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { Orientation } from "@/hooks/use-orientation";
import type { StageRound } from "@/lib/repositories/stage-rounds";
import type { Identity } from "@/lib/identity";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { ProfileDirectoryEntry } from "@/hooks/use-profile-directory";

/**
 * The video-first stage (issue #20) — both seats, full-bleed, filling
 * whatever box the caller gives it (portrait: stacked top/bottom;
 * landscape: side by side, mirroring `useOrientation`'s own values so
 * this never needs its own orientation logic). An empty seat still
 * renders `SpeakerTile`'s own placeholder rather than being omitted, so
 * the two-seat framing never collapses to one column.
 *
 * **Layering model** (fixed after real-device testing found the divider
 * bleeding across chat/controls): this root is `relative z-0`, not just
 * `relative` — `z-0` (a real value, not `auto`) is what actually makes a
 * positioned element establish its own CSS stacking context. Without it,
 * a descendant's `z-index` doesn't stay scoped to this subtree; it
 * escapes to compete in whichever ancestor stacking context it lands in
 * instead — which is exactly what was happening: the divider's old
 * `z-10` was being compared against `stage-bottom-overlay`'s (portrait-
 * room.tsx) stacking level, not contained in here at all, so `10 >
 * auto` put it on top regardless of DOM order. With this root properly
 * containing its own stacking context, nothing inside this component —
 * now or whatever #21/#25 add later — can ever again paint above a
 * sibling layer like the chat/controls overlay. The fix is structural
 * containment, not raising every foreground control's own z-index to
 * outrank the divider one at a time.
 *
 * Three more pieces live in this same container, all currently inert —
 * each is a fixed structural anchor a later issue attaches real behavior
 * to, not a placeholder to be swapped out:
 * - The **divider**, between the two tiles — a plain, unpositioned flex
 *   sibling today (no `z-index` of its own needed: it doesn't overlap
 *   the tiles, and the stage-level containment above is what keeps it
 *   from ever crossing anything outside this component). #25 (retention
 *   voting) makes it tappable; not a `<button>` yet because it has no
 *   function to expose to assistive tech until then. Its center
 *   dot/handle is deliberately not rendered yet — it has no user-facing
 *   function until #21/#25 exist, and an inert decoration was part of
 *   the visual clutter real-device testing flagged; the bar itself
 *   (the actual structural anchor those issues need) stays.
 * - The **self-preview slot**, a fixed corner position — issue #22:
 *   renders `SelfPreview` (the local participant's own camera, attached
 *   directly from `localVideoTrack`) whenever local media is actually
 *   held, and nothing at all otherwise — an ordinary audience member who
 *   hasn't expressed intent to speak never sees a placeholder here. Kept
 *   *outside* the flex row/col below (a sibling, absolutely positioned
 *   against this component's own `relative` root) so it stays visually
 *   anchored to the stage as a whole, never inside either individual
 *   tile, and so the *same* mounted element survives the pending →
 *   countdown → published-speaker transition (this component itself
 *   doesn't unmount across that transition either — see EventRoom).
 *   Top-right, not bottom-right (issue #20's real-device corrective
 *   pass) — the bottom is now the chat/controls overlay's territory.
 *   Deliberately still just the local feed even once actually speaking —
 *   making the *other* speaker dominant on the main stage instead is a
 *   larger visual redesign left to a later issue (possibly #18), not
 *   done here.
 * - **Open-seat visual priority** (real-device finding, 2026-08-22): when
 *   exactly one seat is empty and the viewer isn't a speaker themselves
 *   (so the empty seat is actually tappable — see `onTapEmptySeat`
 *   below), that tile renders first (`order-first`) regardless of
 *   whether it's seat 1 or seat 2. Portrait stacks tiles vertically, so
 *   this is what keeps the open, actionable seat out of the bottom
 *   overlay's territory (see `PortraitRoom`'s own doc comment) instead of
 *   requiring the visitor to somehow work around a fixed-height chat
 *   panel to reach it. Pure CSS `order` on an unchanged, identically-keyed
 *   element — seat numbering/DB assignment, LiveKit subscriptions, and
 *   whatever's already attached to either tile are completely untouched;
 *   nothing here remounts.
 * - The **scrim**, spanning the whole stage — issue #21's own darkening
 *   layer for the comments-overlay focus state, driven via the optional
 *   `scrimOpacity`/`scrimInstant` props below (defaulting to `0`/`false`,
 *   i.e. today's original inert behavior, for `PortraitRoom`/`DesktopRoom`,
 *   which don't pass them yet). `pointer-events-none` always — it must
 *   never block a tap on a tile underneath (e.g. issue #15's "tap to
 *   enable camera & mic" control), darkening is purely visual.
 *
 * `bg-black`, not a theme token — a video stage stays dark regardless of
 * the app's light/dark mode, the same convention any video player uses.
 *
 * **`soloMode`** (issue #18, Speaker View Phase 1): when the viewer holds
 * one of the two seats, `PortraitSpeakerView`/`MobileLandscapeSpeakerView`
 * both pass `true` so the *other* seat's tile fills this entire box — no
 * divider, no equal-sized tile for the viewer's own seat (their own feed
 * is already covered by the self-preview slot below, unconditionally,
 * regardless of this flag). One orientation-agnostic flag, not a
 * per-orientation prop — the sizing/takeover logic itself never differed
 * between portrait and landscape, only which `orientation` value picks
 * stacked vs. side-by-side for the (now singular) remaining tile.
 * Deliberately doesn't add a new tile-rendering path: it's the exact same
 * `renderTile()` used for the ordinary two-tile layout, just called once
 * instead of twice, so every existing per-tile behavior (empty-seat
 * placeholder, reconnect grace, media-activation tap target) carries over
 * unchanged. If the viewer's own seat can't be identified (a defensive
 * fallback, not an expected path — `PortraitSpeakerView` only renders
 * this with `soloMode` when `isSpeaker` is already true), this falls back
 * to the ordinary two-tile layout rather than rendering nothing.
 *
 * **`isSpeaker`/`mySeatNumber` are received, never re-derived** (issue
 * #18 consistency fix, real-device finding, 2026-08-24): this component
 * used to compute its own `viewerIsSpeaking`/`mySeatNumber` from raw
 * `speakers`/`myIdentity`, independently of `EventRoom`'s own `isSpeaker`
 * — a second, separately-maintained answer to the same question,
 * already flagged as a latent risk in `EventRoom`'s `handleTapEmptySeat`
 * guard even before this fix. `EventRoom` now computes both once (via
 * `findMySeatNumber`, see `lib/participant-role.ts`) and passes them
 * down as plain props — this component just reads them. `myIdentity` is
 * still a prop, but only for `isLocal`/tile-level identity matching, not
 * for re-deriving role. See DECISIONS.md for the investigation.
 */
export function SpeakerStage({
  speakers,
  getParticipant,
  myIdentity,
  isSpeaker,
  mySeatNumber,
  needsMediaActivation,
  activateMedia,
  mediaError,
  orientation,
  onTapEmptySeat,
  isJoiningSeat,
  localVideoTrack,
  scrimOpacity = 0,
  scrimInstant = false,
  reconnectingIdentities,
  soloMode = false,
  isPreviewBuild = false,
  simulatedGuestIds,
  stageRound = null,
  viewerIdentity = null,
  pendingRequests = [],
  profileDirectory = {},
  stageReactions,
}: {
  speakers: EventSpeaker[];
  getParticipant: (identity: string) => Participant | undefined;
  myIdentity: string;
  /** The single authoritative "am I currently a speaker" value — computed once in EventRoom (see `lib/participant-role.ts`), not re-derived here. */
  isSpeaker: boolean;
  /** Which seat (if any) the viewer holds — computed once in EventRoom alongside `isSpeaker`, from the same data. Only ever non-null when `isSpeaker` is also true. */
  mySeatNumber: 1 | 2 | null;
  needsMediaActivation: boolean;
  activateMedia: () => Promise<MediaReadinessState>;
  mediaError: MediaError;
  orientation: Orientation;
  /** Issue #27: tapping either empty seat tile — omitted entirely (not just disabled) when the viewer already holds a seat, since a seated speaker has no use for it. */
  onTapEmptySeat: () => void;
  isJoiningSeat: boolean;
  /** Issue #22: the local participant's own held camera track, if any — see this component's self-preview-slot doc comment above. */
  localVideoTrack: LocalVideoTrack | null;
  /** Issue #21: 0 (no darkening) to 1 (fully darkened) — see the scrim's own doc comment above. */
  scrimOpacity?: number;
  /** Issue #21: true only for live drag frames — omits the CSS transition so the scrim tracks the finger with zero lag; release/tap-toggle frames leave this false so the settle animates. */
  scrimInstant?: boolean;
  /** Real-device reconnect-grace-period finding: LiveKit identities `useSpeakerReconnectGrace` is currently watching as disconnected-but-within-grace — passed through to whichever tile matches, see SpeakerTile's own isReconnecting doc comment. */
  reconnectingIdentities: ReadonlySet<string>;
  /** Issue #18, Speaker View Phase 1 — see this component's own doc comment above. Defaults to false: every existing caller (MobileLandscapeRoom, DesktopRoom, PortraitRoom's Audience/Candidate path) is completely unaffected. */
  soloMode?: boolean;
  /** Issue #21, Part 1: threaded straight through to each SpeakerTile — see that component's own doc comment. Defaults to false, same "additive, existing callers unaffected" shape as every other optional prop here. */
  isPreviewBuild?: boolean;
  /** Session Simulator real-device follow-up: guest ids the simulator generated in this tab — see RoomLayoutProps' own doc comment. Optional so every non-preview caller/test can omit it; treated as empty when absent. */
  simulatedGuestIds?: ReadonlySet<string>;
  /** Issue #21 corrective pass: the shared round clock for the current pairing — see this component's own "shared round badge" doc comment below. Optional, defaulting to null (no badge), so every existing caller/test that doesn't care can omit it. */
  stageRound?: StageRound | null;
  /** Issue #21, fifth corrective pass: the viewer's own identity — used only to check `stageRound`'s fallback-exclusion arrays (see the `fallbackOpen`/`amIExcludedFromFallback` doc comment below). Named distinctly from `myIdentity` (the LiveKit-format string used for tile/participant matching) to avoid confusion between the two. Optional, defaulting to null, so tests that don't care about the fallback state don't need to thread it through. */
  viewerIdentity?: Identity | null;
  /** Issue #21, fifth corrective pass: every currently-pending Request-to-Speak request — used only to decide each empty seat's display state ("selecting" vs. "waiting" vs. "fallback-open"), never to re-derive anything authorization already decides server-side. Optional, defaulting to empty, so every existing caller/test that doesn't care can omit it. */
  pendingRequests?: RankedPendingRequest[];
  /** Issue #29: `profile_id` → `{username, avatarUrl}` for every currently-visible speaker with a public profile — see `useProfileDirectory`'s own doc comment. Optional, defaulting to empty, so every existing caller/test that doesn't care can omit it. */
  profileDirectory?: Record<string, ProfileDirectoryEntry>;
  /** Pre-launch interaction pass: the one shared reactions controller (see `useReactionsController`, instantiated once in `EventRoom`) — drives directed double-tap sending, on-speaker/side rendering, and is entirely absent (undefined) for any caller/test that doesn't care about reactions at all. Named `stageReactions`, not `reactions`, to avoid colliding with `RoomLayoutProps`' own pre-existing `reactions` field (the lobby comment-reaction counts — a different, unrelated concept). */
  stageReactions?: ReactionsController;
}) {
  const stageRoundDisplay = useStageRoundCountdown(stageRound, isPreviewBuild);
  const prefersReducedMotion = usePrefersReducedMotion();

  // Pre-launch interaction pass, Section 7: purely local visual ordering
  // — never touches which seatNumber renderTile(1)/renderTile(2) below
  // actually describes (authoritative seat identity, media, votes,
  // reactions all key off that unchanged seatNumber/identity), only
  // which DOM position each call's *result* lands in. Local `useState`,
  // not persisted — this component only exists at all for the audience/
  // candidate composition (a seated speaker's own Speaker View uses
  // `soloMode`, which has no top/bottom relationship to swap — see this
  // component's own `soloMode` doc comment), and audience viewers never
  // undergo the role-router remount that would otherwise reset it.
  const [swapped, setSwapped] = useState(false);
  const tileRefs = useRef<Record<1 | 2, HTMLDivElement | null>>({ 1: null, 2: null });
  const prevRectsRef = useRef<Record<1 | 2, DOMRect | null>>({ 1: null, 2: null });

  // FLIP animation: capture positions *before* the reorder commits, then
  // in a layout effect after it, measure the new positions and animate
  // from the old delta back to zero — the tiles visibly exchange places
  // instead of teleporting. Skipped entirely under prefers-reduced-motion
  // (Section 11) — the reorder itself still happens, just instantly.
  useLayoutEffect(() => {
    if (prefersReducedMotion) return;
    (Object.keys(tileRefs.current) as unknown as Array<1 | 2>).forEach((seatNumber) => {
      const el = tileRefs.current[seatNumber];
      const prev = prevRectsRef.current[seatNumber];
      if (!el || !prev) return;
      const next = el.getBoundingClientRect();
      const dy = prev.top - next.top;
      if (Math.abs(dy) < 1) return;
      el.style.transition = "none";
      el.style.transform = `translateY(${dy}px)`;
      // Force a reflow so the browser registers the starting transform
      // before animating to zero — the standard FLIP technique.
      void el.offsetHeight;
      requestAnimationFrame(() => {
        el.style.transition = "transform 280ms ease";
        el.style.transform = "";
      });
    });
    prevRectsRef.current = { 1: null, 2: null };
  }, [swapped, prefersReducedMotion]);

  function handleSwapTap() {
    prevRectsRef.current = {
      1: tileRefs.current[1]?.getBoundingClientRect() ?? null,
      2: tileRefs.current[2]?.getBoundingClientRect() ?? null,
    };
    setSwapped((current) => !current);
  }
  if (process.env.NODE_ENV !== "production" && soloMode && !isSpeaker) {
    // Issue #18 consistency fix: soloMode and isSpeaker are two props
    // from the same caller that must agree — only PortraitSpeakerView/
    // MobileLandscapeSpeakerView ever pass soloMode, and only once their
    // own role router has already confirmed isSpeaker. If this ever
    // fires, the composition and the authoritative role prop have
    // genuinely diverged (a real bug), not just this component's own
    // internal logic — the defensive fallback below still keeps the UI
    // safe, but this makes the divergence loud instead of silent.
    console.error(
      "[SpeakerStage] soloMode=true but isSpeaker=false — Speaker View composition rendered without the role that's supposed to gate it. This should be impossible; check the caller.",
    );
  }

  const bySeat = (seatNumber: 1 | 2) => speakers.find((s) => s.seat_number === seatNumber) ?? null;

  // Issue #16: a seat's occupant identity is whichever of
  // profile_id/guest_id is actually set (the table's own XOR constraint
  // guarantees exactly one) — never assume profile. Factored out (real-
  // device follow-up) so both renderTile() and the stage-level Side-lane
  // region computation below share the exact same derivation.
  function identityForSeat(seat: EventSpeaker | null): string | null {
    return seat
      ? getParticipantIdentity(
          seat.profile_id ? { type: "profile", id: seat.profile_id } : { type: "guest", id: seat.guest_id! },
        )
      : null;
  }

  // Real-device finding (2026-08-22): exactly one open seat, viewer not
  // already speaking — that seat is this viewer's one actionable target,
  // so it visually leads regardless of which seat number it happens to
  // be. Both-empty/both-occupied/viewer-is-speaking all leave natural
  // seat-number order alone — there's no single "the" actionable seat to
  // prioritize in those cases.
  const seat1 = bySeat(1);
  const seat2 = bySeat(2);
  // Issue #21, third corrective pass: "has this stage ever achieved its
  // initial two-speaker pairing" — permanent once true, reusing
  // `stageRound.round_number` exactly as `isStageEstablished`
  // (lib/repositories/stage-rounds.ts, the server-side source of truth
  // this mirrors) does. Once true, an empty seat is never a direct-join
  // opportunity again — see `onTapEmptySeat`'s gating and
  // `replacementPending` below.
  const established = stageRound !== null && stageRound.round_number >= 1;
  // Issue #21, fifth corrective pass, Sections 1-2: an empty seat only
  // ever shows "Selecting next speaker…" while there's genuinely
  // somebody eligible to select — the existence of *any* pending
  // request is enough (selection now proceeds immediately once one
  // exists; see `ensureActiveSelectionRound`), not a per-seat
  // reservation check the client would otherwise have to poll for. This
  // is what "the wrong thing was papering over slow selection with
  // display state" actually gets fixed by: the display now reflects
  // real pool state, not a client-derived guess.
  const hasEligibleRequests = pendingRequests.length > 0;
  // Sections 8-15: the small-room fallback — a direct join is legal
  // again only when both seats are empty AND nobody is eligible to
  // select from. `amIExcludedFromFallback` reads the same authoritative
  // exclusion arrays `claim_speaker_seat` itself enforces (migration
  // 00000000000033) — this is purely a display decision (which state to
  // show, whether to wire the tap handler at all); the actual gate is
  // always server-side, never trusted from here alone.
  const bothSeatsEmpty = seat1 === null && seat2 === null;
  const fallbackOpen = established && bothSeatsEmpty && !hasEligibleRequests;
  const amIExcludedFromFallback =
    fallbackOpen &&
    stageRound !== null &&
    viewerIdentity !== null &&
    (viewerIdentity.type === "profile"
      ? stageRound.fallback_excluded_profile_ids.includes(viewerIdentity.id)
      : stageRound.fallback_excluded_guest_ids.includes(viewerIdentity.id));
  const canFallbackJoin = fallbackOpen && !amIExcludedFromFallback;
  const promoteOpenSeat = !isSpeaker && !established && (seat1 === null) !== (seat2 === null);

  function emptySeatState(seat: EventSpeaker | null, seatNumber: 1 | 2): "joining" | "selecting" | "waiting" | "fallback-open" | undefined {
    if (seat !== null || !established) return undefined;
    // Issue #21, sixth corrective pass, Section 14: "once selection has
    // succeeded, advance the UI state" — a real-device pass found
    // "Selecting next speaker…" staying on screen for the *entire*
    // intentional Going Live countdown even after a candidate was
    // already reserved, reading as stuck when it wasn't. A candidate
    // reserved for *this specific seat* (`reserved_seat_number`, set by
    // the same atomic reservation RPC — see `ensureActiveSelectionRound`)
    // means selection is done; only their own Going Live countdown/seat
    // claim remains, which is a different, already-in-progress state.
    const reservedForThisSeat = pendingRequests.some(
      (r) => r.is_current_candidate && r.reserved_seat_number === seatNumber,
    );
    if (reservedForThisSeat) return "joining";
    if (hasEligibleRequests) return "selecting";
    if (canFallbackJoin) return "fallback-open";
    return "waiting";
  }

  function renderTile(seatNumber: 1 | 2) {
    const seat = seatNumber === 1 ? seat1 : seat2;
    const identity = identityForSeat(seat);
    const seatState = emptySeatState(seat, seatNumber);
    // Real-device follow-up ("Side mode must preserve local sender
    // feedback"): On Speaker mode still shows every reaction targeting
    // this tile, from anyone. Side mode shows on-speaker only the
    // *viewer's own* reactions here — their immediate, exact-tap-location
    // confirmation of "I reacted here" — never a duplicate of what
    // already shows once the sender's own accepted broadcast returns
    // (see useStageReactions' own id-dedup doc comment), and never
    // *other* viewers' reactions, which Side mode moves into the lane(s)
    // below instead. Hidden mode (showReactions=false) suppresses all of
    // this uniformly, sender included — Section 6's own requirement.
    const onSpeakerReactions =
      identity && stageReactions
        ? stageReactions.incoming.filter(
            (r) => r.targetIdentity === identity && (stageReactions.displayMode === "on-speaker" || r.senderIdentity === stageReactions.myIdentity),
          )
        : [];
    const showOnSpeakerReactions = Boolean(stageReactions && stageReactions.showReactions);
    return (
      <div
        key={seat?.id ?? `empty-${seatNumber}`}
        ref={(el) => {
          tileRefs.current[seatNumber] = el;
        }}
        className={cn("min-h-0 min-w-0 flex-1", promoteOpenSeat && seat === null && "order-first")}
      >
        <SpeakerTile
          speaker={seat}
          participant={identity ? getParticipant(identity) : undefined}
          isLocal={identity === myIdentity}
          needsMediaActivation={needsMediaActivation}
          activateMedia={activateMedia}
          mediaError={mediaError}
          // Issue #21, third/fifth corrective passes: an empty seat is a
          // tap target only while it's genuinely a direct-join
          // opportunity — never established (unchanged), or the
          // small-room fallback specifically. The database's own
          // `claim_speaker_seat` (migrations 00000000000029/00033)
          // enforces both independently regardless of what this prop
          // does; this is what keeps the *tile itself* from ever
          // inviting a tap that could only fail.
          onTapEmptySeat={isSpeaker || (seat === null && established && seatState !== "fallback-open") ? undefined : onTapEmptySeat}
          isJoiningSeat={isJoiningSeat}
          isInactive={identity !== null && reconnectingIdentities.has(identity)}
          orientation={orientation}
          clearTopChrome={seatNumber === 1}
          isPreviewBuild={isPreviewBuild}
          isSimulated={Boolean(seat?.guest_id && simulatedGuestIds?.has(seat.guest_id))}
          emptySeatState={seatState}
          profileEntry={seat?.profile_id ? profileDirectory[seat.profile_id] : undefined}
          // Pre-launch interaction pass, Section 2: `identity` here is
          // this seat's own authoritative occupant, computed the same
          // way regardless of which visual slot (top/bottom, left/right)
          // this renderTile() call happens to be placed in — see the
          // timer-swap section below for why swapping *never* changes
          // which seatNumber a given renderTile() call describes.
          onDoubleTapReact={
            identity && stageReactions ? (x, y) => void stageReactions.send(identity, stageReactions.selectedEmoji, x, y) : undefined
          }
          onSpeakerReactions={onSpeakerReactions}
          showOnSpeakerReactions={showOnSpeakerReactions}
        />
      </div>
    );
  }

  // Media rendering bugfix pass (real-device report, issue #21): the
  // local participant's own self-view corner slot now has to decide
  // between video, an audio-only visualizer, and nothing — not just
  // "video or nothing" (issue #22's original scope, from before a
  // speaker could ever toggle their camera off while remaining a valid
  // speaker). `cameraPublished` distinguishes "genuinely published to the
  // Room" (authoritative — see deriveParticipantMediaState) from "not
  // published yet" (a candidate's own prepared-but-unpublished
  // localVideoTrack, still legitimately shown ahead of any claim — see
  // SelfPreview's own doc comment on the pending → speaker transition).
  // Once actually published, the publication is authoritative even if
  // `localVideoTrack` itself is stale or still points at a since-stopped
  // MediaStreamTrack (camera toggled off stops the underlying hardware
  // track — see LocalVideoTrack.mute() in livekit-client — so falling
  // back to localVideoTrack post-toggle would show a dead, black frame
  // instead of the visualizer). Deliberately reads the *same*
  // `deriveParticipantMediaState` helper `SpeakerTile` uses for every
  // other seat — Section 4's own instruction: local and remote must
  // converge on one canonical participant/publication-derived state,
  // never a separate local-only boolean.
  const localParticipant = getParticipant(myIdentity);
  const localMediaState = deriveParticipantMediaState(localParticipant);
  const cameraPublished = localMediaState.cameraTrack !== undefined;
  const showSelfVideo = cameraPublished ? localMediaState.hasVideo : localVideoTrack !== null;
  const showSelfAudioOnly = !showSelfVideo && cameraPublished && localMediaState.hasAudio;

  const renderSolo = soloMode && mySeatNumber !== null;
  // Pre-launch interaction pass, Section 7: portrait's stacked layout is
  // the *only* one with a real top/bottom relationship — `orientation
  // === "landscape"` covers both DesktopRoom (side-by-side, no role
  // router) and MobileLandscapeRoom (also side-by-side — this codebase's
  // "landscape" always means a row, never a stack, see this component's
  // own layout `className` above), so swapping stays meaningless there
  // by construction, not by a separate desktop-specific check. Both
  // seats must be occupied (Section 7: "do not allow timer swapping when
  // only one speaker exists") and this can't be `renderSolo` (a seated
  // speaker's own Speaker View has nothing to swap — see `soloMode`'s
  // own doc comment).
  const canSwapSpeakers = orientation === "portrait" && !renderSolo && seat1 !== null && seat2 !== null;
  const firstSeat = swapped ? 2 : 1;
  const secondSeat = swapped ? 1 : 2;

  // Real-device follow-up ("Side mode must preserve which speaker was
  // targeted" + "timer swap interaction is critical"): *other* viewers'
  // reactions for the Side lane(s) — the current viewer's own reactions
  // are deliberately excluded here (they render on-speaker instead, at
  // their exact tap location — see renderTile's own onSpeakerReactions
  // above). Bucketed by *current local visual slot*, derived from
  // firstSeat/secondSeat (which already flips with `swapped`), never
  // from seat 1/2 directly — authoritative targeting (targetIdentity)
  // stays completely untouched either way; this only decides where each
  // already-correctly-targeted reaction visually lands for this one
  // viewer. Portrait only, per Section 4: landscape/desktop keep the
  // original single unsplit lane (see ReactionSideLane's own doc
  // comment) — a deliberate, reported scope decision, not an oversight.
  const otherViewersReactions = stageReactions ? stageReactions.incoming.filter((r) => r.senderIdentity !== stageReactions.myIdentity) : [];
  const firstSlotIdentity = identityForSeat(firstSeat === 1 ? seat1 : seat2);
  const secondSlotIdentity = identityForSeat(secondSeat === 1 ? seat1 : seat2);
  const soloIdentity = renderSolo ? identityForSeat(mySeatNumber === 1 ? seat2 : seat1) : null;

  return (
    <div data-testid="room-stage" className="stage-container relative z-0 h-full w-full overflow-hidden bg-black">
      <div
        className={cn(
          "flex h-full w-full",
          orientation === "landscape" ? "flex-row stage-tiles-landscape" : "flex-col",
        )}
      >
        {renderSolo ? (
          renderTile(mySeatNumber === 1 ? 2 : 1)
        ) : (
          <>
            {renderTile(firstSeat)}
            <div
              data-testid="speaker-divider"
              aria-hidden="true"
              className={cn(
                "shrink-0 bg-border",
                orientation === "landscape" ? "w-2 stage-divider-landscape" : "h-2",
              )}
            />
            {renderTile(secondSeat)}
          </>
        )}
      </div>

      {/* Self-preview slot (issue #22, extended by the media rendering
          bugfix pass) — hidden entirely, not just an empty placeholder,
          when there's no local media to show at all. Video takes the
          slot when the camera's genuinely on (or not yet published,
          during candidacy — see showSelfVideo's own derivation above);
          the compact audio-only visualizer takes it instead once the
          camera is authoritatively off but the mic is genuinely
          publishing — the same corner box, same position, never a
          second local-preview surface. */}
      {showSelfVideo && localVideoTrack ? (
        <SelfPreview track={localVideoTrack} />
      ) : showSelfAudioOnly ? (
        <div
          data-testid="self-preview-audio-only"
          className="absolute top-3 right-3 h-24 w-16 overflow-hidden rounded-md border-2 border-accent bg-black shadow-lg sm:h-28 sm:w-20"
        >
          <AudioOnlyVisualizer
            track={localMediaState.microphoneTrack as LocalAudioTrack | RemoteAudioTrack}
            compact
          />
          <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] font-medium leading-tight text-white">
            You
          </span>
        </div>
      ) : null}

      {/* Shared round badge (issue #21 corrective pass) — see this component's own doc comment above the stageRound prop; rendered exactly once, here, never per-tile. Pre-launch interaction pass, Section 7: becomes tappable (speaker swap) only in portrait with both seats occupied — see StageRoundBadge's own doc comment. */}
      {stageRoundDisplay && (
        <StageRoundBadge display={stageRoundDisplay} onSwapTap={canSwapSpeakers ? handleSwapTap : undefined} />
      )}

      {/* Pre-launch interaction pass, Section 4B, refined by a real-device
          follow-up: the "Side" reaction display mode for *other viewers'*
          reactions — rendered once at the stage level, never per-tile.
          Portrait, two-tile case: two lanes, each pre-filtered to whichever
          seat currently occupies that visual slot (follows local timer-swap
          ordering — see firstSlotIdentity/secondSlotIdentity above).
          soloMode/landscape: one unsplit lane (soloMode filtered to the one
          visible tile's identity; landscape unfiltered, matching this
          feature's original, unchanged behavior there — see
          ReactionSideLane's own doc comment). */}
      {stageReactions && stageReactions.showReactions && stageReactions.displayMode === "side" && (
        renderSolo ? (
          <ReactionSideLane reactions={otherViewersReactions.filter((r) => r.targetIdentity === soloIdentity)} />
        ) : orientation === "portrait" ? (
          <>
            <ReactionSideLane reactions={otherViewersReactions.filter((r) => r.targetIdentity === firstSlotIdentity)} region="top" />
            <ReactionSideLane reactions={otherViewersReactions.filter((r) => r.targetIdentity === secondSlotIdentity)} region="bottom" />
          </>
        ) : (
          <ReactionSideLane reactions={otherViewersReactions} />
        )
      )}

      {/* Scrim (issue #21) — driven by scrimOpacity; see the doc comment above. */}
      <div
        data-testid="room-scrim"
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 bg-black", !scrimInstant && "transition-opacity duration-200")}
        style={{ opacity: scrimOpacity }}
      />
    </div>
  );
}

/**
 * Issue #21, second corrective pass (real-device finding): the badge
 * previously sat at the top of the whole stage box (`top-2`), which put
 * it directly under — visually overlapping — the room header's own
 * top-of-screen chrome (the event title pill in `PortraitRoom` et al.
 * are separate absolutely-positioned overlays at the *same* top edge).
 * It now sits dead center of the stage instead: both tiles are equal
 * `flex-1` siblings (stacked in portrait, side-by-side in landscape), so
 * the exact center of this box is always the seam the `speaker-divider`
 * itself occupies — "the boundary between the two speaker areas," per
 * explicit instruction, in *both* orientations from one position, not a
 * per-orientation special case. Nothing else in this component's layout
 * (top chrome, self-preview, ambient comments, controls, Vote panel) is
 * ever positioned at center-stage, so this reaches a clean spot no other
 * layer contests. `pointer-events-none` so it never blocks a tap on a
 * tile underneath, same discipline the scrim already uses — except when
 * `onSwapTap` is provided (pre-launch interaction pass, Section 7), in
 * which case this becomes a real, focusable button instead: the timer
 * stays visually identical (same text, same position), just tappable,
 * with a small, restrained swap-arrows glyph added so it reads as "you
 * can tap this" without turning into a large new control cluttering the
 * stage's center — a subtle discoverability nudge, not a redesign.
 * Tapping it never changes the *displayed* time — it still reads exactly
 * the same authoritative shared-round countdown either way; only which
 * speaker sits on top changes (see `handleSwapTap`/`canSwapSpeakers`
 * above).
 */
function StageRoundBadge({
  display,
  onSwapTap,
}: {
  display: { remainingSeconds: number; roundNumber: number };
  onSwapTap?: () => void;
}) {
  const text = `Round ${display.roundNumber} · ${display.remainingSeconds}s`;
  if (!onSwapTap) {
    return (
      <div
        data-testid="stage-round-timer"
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white shadow"
      >
        {text}
      </div>
    );
  }
  return (
    <button
      type="button"
      data-testid="stage-round-timer"
      onClick={onSwapTap}
      aria-label={`${text}. Tap to swap which speaker is on top.`}
      className="pointer-events-auto absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white shadow transition-colors hover:bg-black/75"
    >
      <span>{text}</span>
      <span aria-hidden="true" className="text-white/50">
        ⇅
      </span>
    </button>
  );
}
