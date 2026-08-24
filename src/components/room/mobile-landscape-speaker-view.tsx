import { SpeakerStage } from "@/components/room/speaker-stage";
import { SpeakerViewTopChrome } from "@/components/room/speaker-view-top-chrome";
import { SpeakerMediaActivationPrompt } from "@/components/room/speaker-media-activation-prompt";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * "Speaker View" (issue #18, Direction B), landscape — a minimal,
 * role-aware corrective pass, not the full landscape redesign. Rendered
 * by `MobileLandscapeRoom`'s role-router whenever `isSpeaker` is true,
 * mirroring `PortraitSpeakerView` exactly (same `SpeakerStage` `soloMode`,
 * same shared `SpeakerViewTopChrome`, same reused `SelfPreview`) — the two
 * files exist separately, rather than one component branching internally
 * on orientation, because `MobileLandscapeRoom`'s *audience* composition
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
 * `PortraitSpeakerView` — see that component's own doc comment and
 * `SpeakerMediaActivationPrompt`'s for why this is required, not
 * optional (a fresh `useLiveRoomConnection` instance that finds itself
 * already seated has no other way to re-publish camera/mic or restore
 * the self-preview in this composition).
 *
 * **What's deliberately not here** (same phase boundary as
 * `PortraitSpeakerView`): no `SpeakerControlBar`, no speaker composer, no
 * ambient comments, no desktop equivalent. No in-UI way to *voluntarily*
 * leave the stage yet — navigating away still releases the seat via the
 * existing disconnect webhook.
 */
export function MobileLandscapeSpeakerView({
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
        orientation="landscape"
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
    </div>
  );
}
