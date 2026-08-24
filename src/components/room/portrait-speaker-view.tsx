import { SpeakerStage } from "@/components/room/speaker-stage";
import { SpeakerViewTopChrome } from "@/components/room/speaker-view-top-chrome";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * "Speaker View" (issue #18, Direction B — full-bleed remote speaker),
 * Phase 1: the static layout only. Rendered by `PortraitRoom`'s
 * role-router whenever `isSpeaker` is true, in place of the ordinary
 * Watch Mode content — never alongside it.
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
 * **Top chrome** (real-device corrective pass, same day): shared with
 * `MobileLandscapeSpeakerView` via `SpeakerViewTopChrome` — see that
 * component's own doc comment for why its layout deliberately never
 * shares `SelfPreview`'s top-right corner. This view originally
 * duplicated Watch Mode's top chrome inline, putting the guest-name chip
 * in that exact corner; real-device testing found that made the
 * self-preview appear to vanish after editing the name — see
 * DECISIONS.md.
 *
 * **Empty other seat**: also free — `soloMode` still calls the same
 * `renderTile()` used for the ordinary two-tile layout, which already
 * renders the existing "Seat open" placeholder when that seat has no
 * occupant. No separate "waiting for a partner" UI.
 *
 * **What's deliberately not here yet** (later Speaker View phases, each
 * gated on real-device approval): no `SpeakerControlBar` (mic/camera
 * toggles, a purpose-built "Leave the stage") — Phase 3. No speaker
 * composer or ambient comments — Phase 2. Concretely, that means this
 * Phase 1 build has **no in-UI way to leave the stage or recover from a
 * mid-session media-activation prompt** (e.g. after a page refresh) —
 * closing the tab or navigating away still releases the seat via the
 * existing LiveKit-webhook disconnect path (issue #13), just not from a
 * button in this view yet.
 */
export function PortraitSpeakerView({
  event,
  speakers,
  myIdentity,
  identity,
  getParticipant,
  connectionStatus,
  needsMediaActivation,
  activateMedia,
  mediaError,
  localVideoTrack,
  isJoiningSeat,
  reconnectingIdentities,
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
    </div>
  );
}
