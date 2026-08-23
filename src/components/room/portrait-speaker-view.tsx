import { SpeakerStage } from "@/components/room/speaker-stage";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
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
 * **Empty other seat**: also free — `soloMode` still calls the same
 * `renderTile()` used for the ordinary two-tile layout, which already
 * renders the existing "Seat open" placeholder when that seat has no
 * occupant. No separate "waiting for a partner" UI.
 *
 * **What's deliberately not here yet** (later Speaker View phases, each
 * gated on real-device approval): no `SpeakerControlBar` (mic/camera
 * toggles, a purpose-built "Leave the stage") — Phase 3. No speaker
 * composer or ambient comments — Phase 2. No landscape equivalent — not
 * planned this round at all. Concretely, that means this Phase 1 build
 * has **no in-UI way to leave the stage or recover from a mid-session
 * media-activation prompt** (e.g. after a page refresh) — closing the
 * tab or navigating away still releases the seat via the existing
 * LiveKit-webhook disconnect path (issue #13), just not from a button in
 * this view yet.
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

      {/* Same minimal top chrome as Watch Mode's PortraitRoom — status pill (left) + guest identity chip (right), both floating over the video. */}
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
    </div>
  );
}
