import { SpeakerStage } from "@/components/room/speaker-stage";
import { SpeakerViewTopChrome } from "@/components/room/speaker-view-top-chrome";
import { SpeakerMediaActivationPrompt } from "@/components/room/speaker-media-activation-prompt";
import { SpeakerControlBar } from "@/components/room/speaker-control-bar";
import { SpeakerMediaToggles } from "@/components/room/speaker-media-toggles";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { WatchModeControls } from "@/components/room/watch-mode-controls";
import { AmbientComments } from "@/components/room/ambient-comments";
import { ChatPanel } from "@/components/lobby/chat-panel";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * "Speaker View" (issue #18, Direction B — full-bleed remote speaker).
 * Rendered by `PortraitRoom`'s role-router whenever `isSpeaker` is true,
 * in place of the ordinary Watch Mode content — never alongside it.
 *
 * **Full-bleed video, no new track handling**: `SpeakerStage` already
 * owns every seat-tile-rendering concern (empty-seat placeholder, media
 * activation, reconnect grace, `<video>` attach/detach); this component
 * only adds `soloMode`, which tells `SpeakerStage` to render just the
 * *other* seat's tile at full size instead of two equal tiles with a
 * divider — see `SpeakerStage`'s own doc comment. Nothing about
 * `EventRoom`/`useLiveRoomConnection` changes, so the underlying LiveKit
 * `Room`/subscriptions are completely unaffected by this composition
 * swap; only the `<video>` DOM node serving the other speaker's
 * already-subscribed track gets a one-time re-attach at the moment
 * `isSpeaker` flips, the same tolerated "recreated, never reacquired"
 * behavior every existing orientation/viewport composition swap already
 * relies on (see ARCHITECTURE.md's Mobile orientation implementation
 * section).
 *
 * **Self-preview reused, not rebuilt**: `SpeakerStage` already renders
 * `SelfPreview` unconditionally whenever `localVideoTrack` is held,
 * regardless of role — `soloMode` doesn't touch that logic at all, so
 * the viewer's own floating camera preview needs no changes here.
 *
 * **Top chrome**: shared with `MobileLandscapeSpeakerView` via
 * `SpeakerViewTopChrome` — see that component's own doc comment for why
 * its layout reserves `SelfPreview`'s own responsive footprint rather
 * than just avoiding it positionally.
 *
 * **Media-activation recovery**: `SpeakerMediaActivationPrompt` — see its
 * own doc comment for why this is a *required* piece, not an optional
 * nicety. `soloMode` never renders the local tile's own activation
 * button, and this view never renders `RoomControls`.
 *
 * **One persistent control row, mic/camera in place of React/Vote**
 * (issue #18, UI cleanup pass — real-device finding: a floating
 * mic/camera row above the composer *and* the persistent bottom row read
 * as two separate, crowded control regions): `WatchModeControls`'
 * `micCameraSlot` now carries `SpeakerMediaToggles` — the *exact same*
 * toggle buttons that used to float in `SpeakerControlBar`'s own row,
 * relocated, not reimplemented (see that component's own doc comment).
 * The row reads Comment · Mic · Camera · Gift for a seated speaker,
 * mirroring Watch Mode's Comment · React · Vote · Gift exactly in
 * structure — same component, same positions, only the 2nd/3rd slot's
 * content differs. `SpeakerControlBar` is back to just "Leave the
 * stage," stacked above this row with its own bottom-safe-area padding
 * (`pb-[max(0.75rem,env(safe-area-inset-bottom))]`) so it clears the
 * home-indicator region on notched iPhones instead of a flat `pb-3`.
 *
 * **`AmbientComments` cleared above the full control-region footprint**,
 * not Watch Mode's own `bottom-16` — Speaker View's bottom overlay is
 * taller (an extra leave-stage row above the main control row), so
 * reusing Watch Mode's offset let the lowest bubble render behind the
 * controls. `bottom-32` clears the worst case (leave pill + gap + control
 * row + safe-area padding) with room to spare; this is Speaker-View-
 * specific and doesn't touch Watch Mode's own conservative-but-adequate
 * `bottom-16`.
 *
 * **Composer**: the *same* `ChatPanel` compact mode Watch Mode already
 * uses, with `allowMicRequest={false}` (a seated speaker already holds
 * the seat a mic request would be for) — same `sendMessage` action, same
 * gesture-safety logic, nothing duplicated. `AmbientComments` reads the
 * *same* `messages` array every other composition already receives —
 * being on stage doesn't remove the ability to read or post comments.
 *
 * **Empty other seat**: also free — `soloMode` still calls the same
 * `renderTile()` used for the ordinary two-tile layout, which already
 * renders the existing "Seat open" placeholder when that seat has no
 * occupant. No separate "waiting for a partner" UI.
 */
export function PortraitSpeakerView({
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
  messages,
  reactions,
  onPrepareMedia,
  microphoneMuted,
  cameraMuted,
  toggleMicrophone,
  toggleCamera,
}: RoomLayoutProps) {
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
        onTapEmptySeat={() => {}}
        isJoiningSeat={isJoiningSeat}
        localVideoTrack={localVideoTrack}
        reconnectingIdentities={reconnectingIdentities}
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
        <AmbientComments messages={messages} />
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
    </div>
  );
}
