import { SpeakerStage } from "@/components/room/speaker-stage";
import { SpeakerViewTopChrome } from "@/components/room/speaker-view-top-chrome";
import { SpeakerMediaActivationPrompt } from "@/components/room/speaker-media-activation-prompt";
import { SpeakerControlBar } from "@/components/room/speaker-control-bar";
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
 * its layout deliberately never shares `SelfPreview`'s top-right corner.
 *
 * **Media-activation recovery**: `SpeakerMediaActivationPrompt` — see its
 * own doc comment for why this is a *required* piece, not an optional
 * nicety. `soloMode` never renders the local tile's own activation
 * button, and this view never renders `RoomControls`.
 *
 * **Leave the stage, composer, ambient comments** (issue #18, Phase 2 —
 * added specifically so the join/leave cycle could be stress-tested
 * without navigating away each time): `SpeakerControlBar` reuses the
 * *same* `leaveSpeakerSeat` Server Action `RoomControls` already uses —
 * no new mutation path. The composer is the *same* `ChatPanel` compact
 * mode Watch Mode already uses, with `allowMicRequest={false}` (a
 * seated speaker already holds the seat a mic request would be for) —
 * same `sendMessage` action, same gesture-safety logic, nothing
 * duplicated. `AmbientComments` reads the *same* `messages` array every
 * other composition already receives — being on stage doesn't remove
 * the ability to read or post comments. React/Vote/Gift stay inert via
 * the unchanged `WatchModeControls`. Positioned via the *same*
 * `StageOverlayShell`/`bottom-16 left-3` conventions Watch Mode already
 * established, so nothing new needed to keep them clear of the video.
 *
 * **Empty other seat**: also free — `soloMode` still calls the same
 * `renderTile()` used for the ordinary two-tile layout, which already
 * renders the existing "Seat open" placeholder when that seat has no
 * occupant. No separate "waiting for a partner" UI.
 *
 * **Live mic/camera mute toggles** (issue #18, Phase 2 continued):
 * `SpeakerControlBar` now also takes `microphoneMuted`/`cameraMuted` and
 * `onToggleMicrophone`/`onToggleCamera` — passed straight through from
 * `useLiveRoomConnection` via `EventRoom`'s `layoutProps`, no new state
 * owned here. `canToggleMedia` (`canPublish && !needsMediaActivation`)
 * gates the buttons to only once actually publishing — before that
 * there's no published track to mute at all.
 */
export function PortraitSpeakerView({
  event,
  speakers,
  myIdentity,
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
        activateMedia={activateMedia}
        mediaError={mediaError}
      />

      <div className="pointer-events-none absolute bottom-16 left-3 z-10 max-w-[70%]">
        <AmbientComments messages={messages} />
      </div>

      <StageOverlayShell gradient={false} topClassName="pt-0" className="gap-2">
        <SpeakerControlBar
          eventId={event.id}
          microphoneMuted={microphoneMuted}
          cameraMuted={cameraMuted}
          onToggleMicrophone={toggleMicrophone}
          onToggleCamera={toggleCamera}
          canToggleMedia={canPublish && !needsMediaActivation}
        />
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
        />
      </StageOverlayShell>
    </div>
  );
}
