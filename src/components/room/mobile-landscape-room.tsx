import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { useCommentsFocus } from "@/hooks/use-comments-focus";
import type { RoomLayoutProps } from "@/components/room/types";

/** h-24's own equivalent — identical to today's height at rest (progress 0), zero regression for the collapsed default. */
const COLLAPSED_CHAT_HEIGHT_PX = 96;
/** Tunable, not validated against a real short landscape viewport yet — see this pass's own verification report. */
const EXPANDED_CHAT_HEIGHT_PX = 160;
const MAX_SCRIM_OPACITY = 0.55;

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
 * **Comments reveal, room-level gesture (issue #21, re-architected
 * 2026-08-22)**: real-device testing found the original handle-driven
 * design wrong at the root — requiring a user to locate and grab a tiny
 * handle isn't "the room feels naturally vertically navigable," it's a
 * slider widget. This component's own outer stage wrapper (the `relative
 * min-h-0 flex-1` div immediately below) is now the gesture surface
 * itself — `useCommentsFocus`'s `surfaceProps` are spread directly onto
 * it, so a downward drag started from almost anywhere on the broad
 * video/background area reveals the comments overlay; no handle to find
 * first. See that hook's own doc comment for exactly how it tells a
 * room-level drag apart from a tap on a real control (buttons, the
 * composer, the message list) — every one of those keeps working
 * completely normally, untouched by this. A small toggle
 * (`comments-toggle`) remains as the explicit, always-reliable
 * alternative — required per instruction, not merely a nicety: tapping
 * 💬 in Watch Mode or the collapse control once open drives the *exact
 * same* `open` state the gesture does, never a second, parallel UI.
 *
 * **Video geometry never changes** — `SpeakerStage`'s own size/position
 * (and the actual `<video>` elements/LiveKit tracks inside it) are
 * completely untouched by any of this; only `scrimOpacity` and the chat
 * wrapper's height (both existing, purely presentational values) animate
 * with reveal progress. The room's own `RoomHeader` stays a translucent
 * top overlay (reclaims its document-flow footprint for the stage);
 * `pr-16`/`pr-20` on its wrapper reserves room for the top-right
 * self-preview so the two don't visually collide.
 *
 * **Reveal hierarchy**: `GuestNameEditor`/`joinSeatMessage` and
 * `RoomControls` sit *above* the reveal, fixed-size and always visible —
 * low-priority account/identity utility never competes with, or defines,
 * what the gesture actually reveals. Comments + composer are that one
 * thing (via the chat wrapper's own height animating), matching the
 * priority order the product asks for (comments, composer, reactions,
 * request-to-speak — the last already lives in `RoomControls`, already
 * fixed-position/always-visible, not gated behind the reveal at all).
 */
export function MobileLandscapeRoom({
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
  const { open: commentsOpen, progress, dragging, openComments, closeComments, surfaceProps } = useCommentsFocus();
  const chatHeightPx =
    COLLAPSED_CHAT_HEIGHT_PX + (EXPANDED_CHAT_HEIGHT_PX - COLLAPSED_CHAT_HEIGHT_PX) * progress;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* The gesture surface: a real DOM ancestor of every tile/button/composer beneath it, not a transparent layer on top — see useCommentsFocus's own doc comment for why that distinction is what lets taps on real controls keep working untouched. */}
      <div className="relative min-h-0 flex-1" {...surfaceProps}>
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
          scrimOpacity={progress * MAX_SCRIM_OPACITY}
          scrimInstant={dragging}
          reconnectingIdentities={reconnectingIdentities}
        />
        {/* Room header as a translucent top overlay — reclaims its document-flow footprint for the stage, same reasoning as the bottom overlay below. Right padding leaves room for the top-right self-preview so the two don't collide. */}
        <div
          data-testid="room-header-overlay"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-black/60 to-transparent"
        >
          <div className="stage-overlay pointer-events-auto pr-16 sm:pr-20">
            <RoomHeader
              eventTitle={event.title}
              roomStatus={roomStatus}
              countdownText={countdownText}
              participantCount={participantCount}
              connectionStatus={connectionStatus}
              compact
            />
          </div>
        </div>
        <StageOverlayShell topClassName="pt-8">
          {/* Fixed-size, always visible, never part of the reveal — low-priority metadata stays out of what the gesture/💬 actually shows. */}
          {identity.type === "guest" && <GuestNameEditor initialName={identity.displayName} />}
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
          {/* The one explicit, always-reliable trigger — same open/close state the broad-surface drag reaches, never a second parallel UI. Also acts as the subtle "more content below" visual hint the gesture surface itself doesn't otherwise provide. */}
          <button
            type="button"
            data-testid="comments-toggle"
            onClick={commentsOpen ? closeComments : openComments}
            aria-expanded={commentsOpen}
            aria-label={commentsOpen ? "Hide comments" : "Show comments"}
            className="flex h-7 w-full shrink-0 items-center justify-center gap-1 text-xs text-white/70"
          >
            {commentsOpen ? (
              <>
                <span aria-hidden="true">⌄</span> Hide
              </>
            ) : (
              <>
                <span aria-hidden="true">💬</span> Comments
              </>
            )}
          </button>
          <div style={{ height: chatHeightPx }} className="min-h-0 shrink-0">
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
