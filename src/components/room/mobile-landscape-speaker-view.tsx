import { useState } from "react";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { SpeakerViewTopChrome } from "@/components/room/speaker-view-top-chrome";
import { SpeakerMediaActivationPrompt } from "@/components/room/speaker-media-activation-prompt";
import { SpeakerControlBar } from "@/components/room/speaker-control-bar";
import { SpeakerMediaToggles } from "@/components/room/speaker-media-toggles";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { WatchModeControls } from "@/components/room/watch-mode-controls";
import { AmbientComments } from "@/components/room/ambient-comments";
import { ExpandedComments } from "@/components/room/expanded-comments";
import { ChatPanel } from "@/components/lobby/chat-panel";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * "Speaker View" (issue #18, Direction B), landscape — a minimal,
 * role-aware corrective pass, not the full landscape redesign. Rendered
 * by `MobileLandscapeRoom`'s role-router whenever `isSpeaker` is true,
 * mirroring `PortraitSpeakerView` exactly (same `SpeakerStage` `soloMode`,
 * same shared `SpeakerViewTopChrome`, same reused `SelfPreview`, same
 * `SpeakerControlBar`/composer/`AmbientComments`) — the two files exist
 * separately, rather than one component branching internally on
 * orientation, because `MobileLandscapeRoom`'s *audience* composition
 * (Comments Mode, its own `RoomHeader`, the scrim-driven toggle) has
 * nothing in common with Speaker View and would need extensive
 * conditional stripping to coexist in one file — the same reasoning
 * `PortraitRoom`/`PortraitSpeakerView` already established.
 *
 * **Why this exists at all**: before this, rotating a seated speaker's
 * phone from portrait to landscape dropped them straight into
 * `MobileLandscapeRoom`'s ordinary *audience* composition — the old
 * equal-split two-tile grid, `RoomHeader`'s full participant-count/status
 * text, the Comments Mode toggle, `RoomControls`' full "Leave the
 * stage"/"Enable camera & mic" block — none of which reflects "I'm
 * speaking," and all of it undoing the exact role hierarchy Speaker View
 * establishes in portrait. This component is deliberately *not* a full
 * landscape redesign: it reuses the identical `soloMode` full-bleed
 * treatment and top chrome portrait already has, nothing more.
 *
 * **No new video/media logic** — same as `PortraitSpeakerView`: `soloMode`
 * is `SpeakerStage`'s own existing per-tile rendering, called once instead
 * of twice; `SelfPreview` is unconditionally rendered by `SpeakerStage`
 * itself, unrelated to which orientation composition is currently
 * mounted. Rotating between this and `PortraitSpeakerView` is the same
 * "recreate the `<video>` attachment, never reacquire the track, never
 * touch `EventRoom`/`useLiveRoomConnection`" tolerance already relied on
 * for the ordinary Audience/Candidate portrait↔landscape rotation.
 *
 * **Media-activation recovery**: same `SpeakerMediaActivationPrompt` as
 * `PortraitSpeakerView`.
 *
 * **Leave the stage, composer, ambient comments**: same
 * `SpeakerControlBar`/`ChatPanel`(`allowMicRequest={false}`)/
 * `AmbientComments` as `PortraitSpeakerView` — see that component's own
 * doc comment. Included here too (not portrait-only) so rotating during
 * a stress-test session doesn't lose the ability to leave or comment
 * mid-test — a real functional gap, not just a visual inconsistency,
 * since there was previously no way to leave the stage at all once
 * rotated to landscape.
 *
 * **One persistent control row, mic/camera in place of React/Vote, and
 * `AmbientComments`' taller clearance**: same `SpeakerMediaToggles`-in-
 * `WatchModeControls` layout and same `bottom-32` ambient-comments offset
 * as `PortraitSpeakerView` — see that component's own doc comment for the
 * full reasoning (this file mirrors it exactly, same footprint math).
 *
 * **Still deliberately not here**: no desktop equivalent.
 */
export function MobileLandscapeSpeakerView({
  event,
  speakers,
  myIdentity,
  isSpeaker,
  mySeatNumber,
  myInactiveSince,
  identity,
  getParticipant,
  connectionStatus,
  canPublish,
  needsMediaActivation,
  activateMedia,
  mediaError,
  localVideoTrack,
  isJoiningSeat,
  reconnectingIdentities,
  isPreviewBuild,
  simulatedGuestIds,
  stageRound,
  messages,
  reactions,
  pendingRequests,
  onPrepareMedia,
  microphoneMuted,
  cameraMuted,
  toggleMicrophone,
  toggleCamera,
}: RoomLayoutProps) {
  const [commentsOpen, setCommentsOpen] = useState(false);

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
        orientation="landscape"
        onTapEmptySeat={() => {}}
        isJoiningSeat={isJoiningSeat}
        localVideoTrack={localVideoTrack}
        reconnectingIdentities={reconnectingIdentities}
        isPreviewBuild={isPreviewBuild}
        simulatedGuestIds={simulatedGuestIds}
        stageRound={stageRound}
        soloMode
      />

      <SpeakerViewTopChrome event={event} identity={identity} connectionStatus={connectionStatus} />

      <SpeakerMediaActivationPrompt
        needsMediaActivation={needsMediaActivation}
        bothMediaMuted={microphoneMuted && cameraMuted}
        activateMedia={activateMedia}
        mediaError={mediaError}
        inactiveSince={myInactiveSince}
      />

      <div className="pointer-events-none absolute bottom-32 left-3 z-10 max-w-[70%]">
        <AmbientComments messages={messages} onExpand={() => setCommentsOpen(true)} />
      </div>

      <StageOverlayShell
        gradient={false}
        topClassName="pt-0"
        className="gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <SpeakerControlBar eventId={event.id} />
        <WatchModeControls
          composer={
            <ChatPanel
              eventId={event.id}
              messages={messages}
              reactions={reactions}
              micRequestMode={false}
              onMicRequestModeChange={() => {}}
              onHasPendingRequestChange={() => {}}
              onPrepareMedia={onPrepareMedia}
              allowMicRequest={false}
              compact
            />
          }
          micCameraSlot={
            <SpeakerMediaToggles
              microphoneMuted={microphoneMuted}
              cameraMuted={cameraMuted}
              onToggleMicrophone={toggleMicrophone}
              onToggleCamera={toggleCamera}
              canToggleMedia={canPublish && !needsMediaActivation}
            />
          }
        />
      </StageOverlayShell>

      <ExpandedComments
        open={commentsOpen}
        onClose={() => setCommentsOpen(false)}
        eventId={event.id}
        messages={messages}
        reactions={reactions}
        pendingRequests={pendingRequests}
        micRequestMode={false}
        onMicRequestModeChange={() => {}}
        onHasPendingRequestChange={() => {}}
        onPrepareMedia={onPrepareMedia}
        allowMicRequest={false}
      />
    </div>
  );
}
