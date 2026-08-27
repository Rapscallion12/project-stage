import { useState } from "react";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { WatchModeControls } from "@/components/room/watch-mode-controls";
import { AmbientComments } from "@/components/room/ambient-comments";
import { ExpandedComments } from "@/components/room/expanded-comments";
import { SpeakerVotePanel } from "@/components/room/speaker-vote-panel";
import { CountdownOverlay } from "@/components/room/countdown-overlay";
import { PortraitSpeakerView } from "@/components/room/portrait-speaker-view";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { ChatPanel } from "@/components/lobby/chat-panel";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * "05 — Social Stage" (issue #21, approved Figma interaction model):
 * video-first Watch Mode with minimal top chrome and a persistent
 * bottom control row, replacing the previous Watch Mode / Comments
 * Mode split entirely rather than running the two side by side. See
 * DECISIONS.md for the full investigation/plan this implements and the
 * phased rollout it's part of.
 *
 * **Phase 1 (static shell)** shipped the layout with every control
 * inert. **Phase 2 (this revision)** makes the composer real: the
 * `WatchModeControls` composer slot now renders `ChatPanel`'s
 * `compact` mode directly — the *same* `sendMessage`/
 * `submitSpeakerRequest` actions, the *same* `micRequestMode` contract,
 * the *same* synchronous `onPrepareMedia()` submit order ChatPanel
 * already had (see its own doc comment) — nothing about that logic is
 * duplicated here, only the surrounding chrome differs. React/Vote/Gift
 * stay `disabled` placeholders until their own later phase.
 *
 * **No separate "Request sent" bar** (issue #18 UX finding, real-device
 * report): a compact `RoomControls` pill used to render here for a
 * pending, not-yet-promoted request — removed entirely after it was
 * found overlapping the composer/ambient request comment once the
 * bottom row got crowded. The composer's own mic button now carries the
 * pending state itself (see `ChatPanel`'s own doc comment for the
 * three-state design and why the existing badged ambient "requesting the
 * mic" chat message is already sufficient feedback that a request went
 * through). The actual stale-state bug this general area surfaced
 * earlier (a granted-then-abandoned request resurrecting a "still
 * pending" UI after leaving the stage) was fixed at its root in
 * `useAutomaticPromotion`/`withdrawSpeakerRequest`/
 * `useRoleTransitionReset`, not here — see DECISIONS.md.
 *
 * **Discussion Expanded** (issue #21, "05d"): tapping an ambient comment
 * bubble opens `ExpandedComments`, a tap-open bottom sheet for
 * intentionally browsing the live comment stream. Deliberately *not*
 * wired to the composer's own focus/tap — an earlier version of this
 * feature tried that and it broke the already-approved "tap the
 * composer, type, send" flow (every composer tap opened the full sheet
 * first). `commentsOpen` is plain local state here, never lifted to
 * `EventRoom`, so it has no causal path to role/seat/media state at all.
 * See `ExpandedComments`' own doc comment.
 *
 * **What still doesn't exist yet** (later phases, each gated on the
 * user's own real-device approval of the previous one):
 * - No ambient comment/reaction layers yet (Phases 5, 6).
 * - React/Vote/Gift emblems are still inert (Phases 5/6, 7).
 * - Desktop is untouched (it already has a persistent chat sidebar).
 *
 * **Minimal top chrome**: a small translucent status pill (live dot +
 * room title, appending a connection-status word only when it's not
 * simply "connected" — the one piece of `RoomHeader`'s job that's
 * safety-relevant enough not to silently drop) replaces `RoomHeader`
 * entirely for this composition. `RoomHeader` itself is untouched and
 * still used by `MobileLandscapeRoom`/`DesktopRoom`. Participant/viewer
 * count is deliberately omitted here, matching the approved Figma
 * design's explicit minimalism — not lost data (`participantCount` is
 * still received as a prop), just not surfaced in this permanent chrome
 * for now; trivial to add back if it's missed on real-device review.
 *
 * **Video stays full-bleed** — `SpeakerStage` renders with no `scrimOpacity`
 * (nothing to darken for yet; that returns in Phase 4) and nothing here
 * changes its size. The top chrome and bottom controls are both
 * absolutely-positioned overlays, siblings of the stage, never
 * containers it sits inside — the same "video geometry is stable, only
 * what's layered over it changes" invariant this room has held since
 * issue #20, still true for everything in Phase 1.
 *
 * **The conversation-seam slot is preserved, not filled**: `SpeakerStage`
 * already renders an inert `speaker-divider` between the two tiles
 * (built for #25's future use). Per explicit instruction, this phase
 * does not add a fabricated countdown/timer there — a real conversation
 * timer needs a real timing model that doesn't exist yet. The reserved
 * slot stays exactly as SpeakerStage already defined it.
 *
 * **RoomControls / join-seat feedback still need a legible background**
 * without `StageOverlayShell`'s old always-on gradient wash (that wash
 * was sized for a permanently-visible chat block; the new design's
 * controls carry their own individual translucent backgrounds). Passes
 * `gradient={false}` and gives `RoomControls`/the alert their own small
 * `.stage-overlay`-scoped backing via a wrapper here, rather than
 * editing `RoomControls` itself — it's a fully separate concern from
 * Watch Mode and shouldn't need to know this redesign happened.
 *
 * **Role router (issue #18, Speaker View Phase 1)**: everything above
 * this point in the doc comment describes the Audience/Candidate
 * composition only. A seated speaker (`isSpeaker`) is delegated entirely
 * to `PortraitSpeakerView` instead — a different composition, not a
 * variant of this one — before any of this component's own JSX renders.
 * See `PortraitSpeakerView`'s own doc comment for what that view does
 * and doesn't include yet.
 */
export function PortraitRoom(props: RoomLayoutProps) {
  // Issue #21: must be called before the role-router's early return below
  // — React's rules of hooks require every hook to run unconditionally on
  // every render, regardless of which composition ultimately renders.
  // Unused if participantRole is "speaker" (PortraitSpeakerView owns its
  // own instance instead), but still has to be called here.
  const [commentsOpen, setCommentsOpen] = useState(false);

  // Issue #18, Speaker View Phase 1 — see this component's own doc
  // comment above. Checked before any of this component's own
  // destructuring/JSX, so a seated speaker never sees so much as a
  // flash of the Audience/Candidate composition. Issue #18 consistency
  // fix: keys off `participantRole`, the one derived value both this
  // composition choice and (via which file renders) the bottom control
  // row are meant to share — see lib/participant-role.ts.
  if (props.participantRole === "speaker") {
    return <PortraitSpeakerView {...props} />;
  }

  const {
    event,
    phase,
    countdownText,
    speakers,
    myIdentity,
    identity,
    isSpeaker,
    mySeatNumber,
    hasPendingRequest,
    onHasPendingRequestChange,
    promotionCountdown,
    onCancelPromotion,
    micRequestMode,
    onMicRequestModeChange,
    onTapEmptySeat,
    isJoiningSeat,
    joinSeatMessage,
    getParticipant,
    connectionStatus,
    canPublish,
    needsMediaActivation,
    activateMedia,
    mediaError,
    localVideoTrack,
    onPrepareMedia,
    reconnectingIdentities,
    isPreviewBuild,
    messages,
    reactions,
    pendingRequests,
  } = props;

  return (
    <div className="relative h-full min-h-0 w-full overflow-hidden">
      <SpeakerStage
        speakers={speakers}
        getParticipant={getParticipant}
        myIdentity={myIdentity}
        isSpeaker={isSpeaker}
        mySeatNumber={mySeatNumber}
        needsMediaActivation={needsMediaActivation}
        activateMedia={activateMedia}
        mediaError={mediaError}
        orientation="portrait"
        onTapEmptySeat={onTapEmptySeat}
        isJoiningSeat={isJoiningSeat}
        localVideoTrack={localVideoTrack}
        reconnectingIdentities={reconnectingIdentities}
        isPreviewBuild={isPreviewBuild}
        // Issue #18 UX finding: dims the stage behind the center-stage
        // "Going live" countdown — SpeakerStage's own existing scrim
        // mechanism (issue #21), reused rather than a second dimming
        // layer. 0 the rest of the time, same as every other caller.
        scrimOpacity={promotionCountdown !== null ? 0.6 : 0}
      />

      {/* Minimal top chrome — status pill (left) + guest identity chip (right), both floating over the video, neither reserving space from it. */}
      <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-2 p-3">
        <div
          data-testid="watch-status-pill"
          className="pointer-events-auto flex items-center gap-1.5 rounded-full border border-white/30 bg-black/35 py-1.5 pr-3 pl-2.5 text-xs text-white/90"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
          <span className="max-w-[10rem] truncate font-medium">{event.title}</span>
          {connectionStatus !== "connected" && (
            <span className="text-white/70">
              {connectionStatus === "connecting" && "· Connecting…"}
              {connectionStatus === "reconnecting" && "· Reconnecting…"}
              {connectionStatus === "disconnected" && "· Connection lost"}
              {connectionStatus === "unavailable" && "· Video unavailable"}
            </span>
          )}
        </div>
        {identity.type === "guest" && (
          <div className="pointer-events-auto">
            <GuestNameEditor initialName={identity.displayName} variant="chip" />
          </div>
        )}
      </div>

      {/*
        Ambient comments (issue #21, Phase 3) — lower-left, absolutely
        positioned against this component's own `relative` root, same
        click-through pattern as the top chrome above: the outer wrapper
        is `pointer-events-none` (so a tap in its margin still reaches
        `SpeakerStage`/`onTapEmptySeat` underneath), each individual
        bubble opts back into `pointer-events-auto` itself (see
        AmbientComments's own doc comment on why — the future
        Discussion-Expanded tap target).

        `bottom-16` (64px) clears the composer row's own worst case
        (44px emblem height + 12px shell padding = 56px from the
        viewport bottom) with a few px of breathing room, and sits
        below the top chrome and the self-preview slot, so it never
        touches the persistent controls or either speaker tile's
        identity treatment. Not reserving layout space — this is an
        overlay, not a flow sibling, so it never resizes/reflows the
        video underneath it.
      */}
      {promotionCountdown !== null ? (
        // Issue #18 UX finding: becoming a speaker is a significant
        // transition, not another notification — the countdown takes
        // over the stage instead of competing with the ordinary bottom
        // composer/controls and ambient comments. Presentation only:
        // `promotionCountdown`/`onCancelPromotion` are the same
        // `useAutomaticPromotion` state/action every other rendering of
        // this countdown already used — see CountdownOverlay's own doc
        // comment. Once isSpeaker flips true, this component isn't even
        // the one rendering anymore (the role router above swaps to
        // PortraitSpeakerView), so there's no frame where this and
        // Speaker View can coexist.
        <CountdownOverlay countdown={promotionCountdown} onCancel={onCancelPromotion} />
      ) : (
        <>
          <div className="pointer-events-none absolute bottom-16 left-3 z-10 max-w-[70%]">
            <AmbientComments messages={messages} onExpand={() => setCommentsOpen(true)} />
          </div>

          <StageOverlayShell gradient={false} topClassName="pt-0" className="gap-2">
            {joinSeatMessage && (
              <p
                className="rounded-lg bg-black/35 px-3 py-2 text-xs text-red-400"
                role="alert"
              >
                {joinSeatMessage}
              </p>
            )}
            {isSpeaker && (
              <div className="rounded-2xl bg-black/35">
                <RoomControls
                  eventId={event.id}
                  isSpeaker={isSpeaker}
                  hasPendingRequest={hasPendingRequest}
                  promotionCountdown={promotionCountdown}
                  onCancelPromotion={onCancelPromotion}
                  canPublish={canPublish}
                  needsMediaActivation={needsMediaActivation}
                  activateMedia={activateMedia}
                  onPrepareMedia={onPrepareMedia}
                  mediaError={mediaError}
                  connectionStatus={connectionStatus}
                  phase={phase}
                  countdownText={countdownText}
                />
              </div>
            )}
            <WatchModeControls
              composer={
                <ChatPanel
                  eventId={event.id}
                  messages={messages}
                  reactions={reactions}
                  micRequestMode={micRequestMode}
                  onMicRequestModeChange={onMicRequestModeChange}
                  onHasPendingRequestChange={onHasPendingRequestChange}
                  onPrepareMedia={onPrepareMedia}
                  hasPendingRequest={!isSpeaker && hasPendingRequest}
                  onCancelPendingRequest={onCancelPromotion}
                  compact
                />
              }
              voteSlot={<SpeakerVotePanel speakers={speakers} isPreviewBuild={isPreviewBuild} />}
            />
          </StageOverlayShell>

          <ExpandedComments
            open={commentsOpen}
            onClose={() => setCommentsOpen(false)}
            eventId={event.id}
            messages={messages}
            reactions={reactions}
            pendingRequests={pendingRequests}
            micRequestMode={micRequestMode}
            onMicRequestModeChange={onMicRequestModeChange}
            onHasPendingRequestChange={onHasPendingRequestChange}
            onPrepareMedia={onPrepareMedia}
            hasPendingRequest={!isSpeaker && hasPendingRequest}
            onCancelPendingRequest={onCancelPromotion}
          />
        </>
      )}
    </div>
  );
}
