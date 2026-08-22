import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * Video-first (issue #20, corrective pass): the stage takes 100% of the
 * space below the header — controls and the compact chat strip no longer
 * consume a separate flex sibling below it, they're an absolutely
 * positioned overlay *over* the stage instead, anchored to the bottom.
 * The first pass got this wrong (a smaller-but-still-separate block below
 * the video, not a layer over it) and failed its own real-device
 * gut-check; this is the fix, not a new issue — see DECISIONS.md.
 *
 * `.stage-overlay` (globals.css) re-scopes the theme's color tokens to
 * fixed, dark-appropriate values for this subtree only — the overlay sits
 * over live video unconditionally, regardless of the visitor's own
 * light/dark preference, so `ChatPanel`/`RoomControls`/`Input`/`Button`
 * need to render legibly against that video, not against whatever the
 * app's normal page background happens to be. None of those components
 * change; they already use theme tokens (`text-muted`, `border-border`,
 * `text-accent`), which pick up the re-scoped values automatically.
 *
 * The bottom gradient is a *separate* concern from the stage's own
 * `room-scrim` (still `opacity-0`, still issue #21's job to animate for
 * focus-state darkening) — this one is always-on, for baseline legibility
 * of the always-visible compact chat, not something a later issue
 * animates.
 *
 * `z-10` here, `z-0` on `SpeakerStage`'s own root — an explicit,
 * unambiguous "the interface overlay is always above the stage" rule,
 * not left to depend on DOM order being the tiebreak. See
 * `SpeakerStage`'s own doc comment for why the stage needs its own
 * contained stacking context regardless (real-device testing found the
 * speaker divider bleeding across this exact overlay before that fix).
 *
 * **Click-through outer layer + interactive inner one** (real-device
 * finding, 2026-08-22): with a seat open and the other occupied, the
 * open seat's tile can end up (partly) underneath this overlay's
 * bounding box — `SpeakerStage` now visually promotes the open seat out
 * of that territory when it's actionable (see its own doc comment), but
 * the overlay itself previously had no `pointer-events` distinction at
 * all, so even its purely-decorative top gradient padding captured taps
 * meant for whatever's beneath it. Extracted into `StageOverlayShell`
 * (shared with `MobileLandscapeRoom`, the other composition that layers
 * chat over the stage instead of beside it) once both needed the
 * identical outer-click-through/inner-interactive structure.
 *
 * Still zero gesture/drag/expand logic — the same `ChatPanel` instance
 * used here (via `RoomChatPanel`) is what issue #21 will later make
 * expandable via a drag handle, without ever swapping which component is
 * mounted. This pass only changes *where* it renders, not *what* it does.
 */
export function PortraitRoom({
  event,
  phase,
  countdownText,
  roomStatus,
  speakers,
  myIdentity,
  identity,
  isSpeaker,
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
  participantCount,
  connectionStatus,
  canPublish,
  needsMediaActivation,
  activateMedia,
  mediaError,
  localVideoTrack,
  onPrepareMedia,
  reconnectingIdentities,
  messages,
  reactions,
}: RoomLayoutProps) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <RoomHeader
        eventTitle={event.title}
        roomStatus={roomStatus}
        countdownText={countdownText}
        participantCount={participantCount}
        connectionStatus={connectionStatus}
      />
      <div className="relative min-h-0 flex-1">
        <SpeakerStage
          speakers={speakers}
          getParticipant={getParticipant}
          myIdentity={myIdentity}
          needsMediaActivation={needsMediaActivation}
          activateMedia={activateMedia}
          mediaError={mediaError}
          orientation="portrait"
          onTapEmptySeat={onTapEmptySeat}
          isJoiningSeat={isJoiningSeat}
          localVideoTrack={localVideoTrack}
          reconnectingIdentities={reconnectingIdentities}
        />
        <StageOverlayShell>
          {identity.type === "guest" && <GuestNameEditor initialName={identity.displayName} />}
          {/* Issue #27: feedback for a failed empty-seat tap (e.g. the guest account-prompt) — a queue-exists result never lands here, it switches the composer to request mode instead. */}
          {joinSeatMessage && (
            <p className="text-xs text-red-500" role="alert">
              {joinSeatMessage}
            </p>
          )}
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
          <div className="h-40 min-h-0">
            <RoomChatPanel
              eventId={event.id}
              messages={messages}
              reactions={reactions}
              micRequestMode={micRequestMode}
              onMicRequestModeChange={onMicRequestModeChange}
              onHasPendingRequestChange={onHasPendingRequestChange}
              onPrepareMedia={onPrepareMedia}
              className="h-full"
            />
          </div>
        </StageOverlayShell>
      </div>
    </div>
  );
}
