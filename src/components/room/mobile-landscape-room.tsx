import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { WatchModeControls } from "@/components/room/watch-mode-controls";
import { AmbientComments } from "@/components/room/ambient-comments";
import { SpeakerViewTopChrome } from "@/components/room/speaker-view-top-chrome";
import { MobileLandscapeSpeakerView } from "@/components/room/mobile-landscape-speaker-view";
import { ChatPanel } from "@/components/lobby/chat-panel";
import type { RoomLayoutProps } from "@/components/room/types";

/**
 * A phone rotated sideways, not a small desktop (real-device finding,
 * 2026-08-22): `EventRoom` used to render `LandscapeRoom` (now
 * `DesktopRoom`) for *any* landscape viewport, which turned rotation
 * into a jump to a dashboard-style layout — small video strip, a
 * permanent 320px chat sidebar, the full site header still eating its
 * usual share of an already-short viewport. This component exists so
 * that doesn't happen: same video-first/overlay philosophy as
 * `PortraitRoom` (stage fills the box, chat/controls layer *over* it via
 * the same `StageOverlayShell` both share), just laid out for a wide,
 * short box instead of a tall, narrow one — `SpeakerStage` gets
 * `orientation="landscape"` (side-by-side tiles, not stacked). `EventRoom`
 * mounts this only when `useOrientation()` is `"landscape"` *and*
 * `useIsDesktopViewport()` is false — an iPhone in landscape is
 * comfortably under the desktop width threshold, so it lands here, not
 * in `DesktopRoom`.
 *
 * **Audience/Candidate composition rebuilt onto "05 — Social Stage"**
 * (issue #21, real-device finding: rotating to landscape as an audience
 * member still fell back to the pre-05 legacy interface —
 * `RoomHeader`'s full status bar, the centered "💬 Comments" toggle,
 * `RoomChatPanel` — none of which portrait Watch Mode has used since
 * issue #21's own redesign). This is an *adaptation* of that same
 * approved shell, not a new design system: `SpeakerViewTopChrome` (the
 * minimal status-pill top chrome, reused unchanged — its `SelfPreview`-
 * footprint reservation matters here too, since a candidate can hold a
 * self-preview in landscape exactly as in portrait), `AmbientComments`,
 * and `WatchModeControls` wrapping the *same* compact `ChatPanel` are
 * all the *identical* components/props portrait Watch Mode already
 * uses — nothing here is a landscape-specific reimplementation of chat
 * or media logic. `useCommentsMode`, the modal comments toggle, and
 * `RoomChatPanel` are gone entirely for this composition — same
 * "always-available, no modal gate" model portrait already settled on,
 * not a new one invented for landscape.
 *
 * **Deliberately not a portrait layout stretched sideways**: the one
 * responsive difference from `PortraitRoom` is `SpeakerStage`'s own
 * `orientation="landscape"` (side-by-side tiles, unchanged — two-speaker
 * audience viewing is untouched) — everything else (chrome, controls,
 * ambient comments) reuses portrait's exact components/positioning
 * conventions, since nothing about *them* is portrait-specific; only the
 * stage tiling itself genuinely differs by orientation.
 *
 * **Video geometry never changes** — `SpeakerStage`'s own size/position
 * (and the actual `<video>` elements/LiveKit tracks inside it) stay a
 * sibling of every overlay here, never a child of one; nothing in this
 * composition ever resizes, remounts, or reconnects it. `scrimOpacity`
 * is never passed (defaults to `0`) — there's no Comments Mode left to
 * darken the stage for, matching `PortraitRoom`'s own audience
 * composition exactly.
 *
 * **Role router** (issue #18, Speaker View corrective pass): a seated
 * speaker (`isSpeaker`) is delegated to `MobileLandscapeSpeakerView`
 * instead — a completely different, already-approved composition, left
 * untouched by this pass. Checked before any of this component's own
 * destructuring/JSX, the same discipline `PortraitRoom` already
 * established for its own role router. This component now owns no hooks
 * of its own (the old `useCommentsMode()` call is gone along with
 * Comments Mode itself), so there's no "hooks above the branch" ordering
 * concern left to satisfy here — the role check can sit at the very top.
 */
export function MobileLandscapeRoom(props: RoomLayoutProps) {
  if (props.isSpeaker) {
    return <MobileLandscapeSpeakerView {...props} />;
  }

  const {
    event,
    phase,
    countdownText,
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
  } = props;

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
        onTapEmptySeat={onTapEmptySeat}
        isJoiningSeat={isJoiningSeat}
        localVideoTrack={localVideoTrack}
        reconnectingIdentities={reconnectingIdentities}
      />

      <SpeakerViewTopChrome event={event} identity={identity} connectionStatus={connectionStatus} />

      <div className="pointer-events-none absolute bottom-16 left-3 z-10 max-w-[70%]">
        <AmbientComments messages={messages} />
      </div>

      <StageOverlayShell
        gradient={false}
        topClassName="pt-0"
        className="gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        {joinSeatMessage && (
          <p className="rounded-lg bg-black/35 px-3 py-2 text-xs text-red-400" role="alert">
            {joinSeatMessage}
          </p>
        )}
        {!isSpeaker && hasPendingRequest && (
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
            compact
          />
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
              compact
            />
          }
        />
      </StageOverlayShell>
    </div>
  );
}
