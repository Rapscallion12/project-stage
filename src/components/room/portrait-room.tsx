import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { WatchModeControls } from "@/components/room/watch-mode-controls";
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
 * **What still doesn't exist yet** (later phases, each gated on the
 * user's own real-device approval of the previous one):
 * - There is no way to *read* comments or open a discussion surface
 *   yet (Discussion Expanded is Phase 4) — only sending is live.
 * - No ambient comment/reaction layers yet (Phases 3, 5, 6).
 * - React/Vote/Gift emblems are still inert (Phases 5/6, 7).
 * - Desktop and mobile landscape are untouched — this file only
 *   affects `PortraitRoom`.
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
 */
export function PortraitRoom({
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
        onTapEmptySeat={onTapEmptySeat}
        isJoiningSeat={isJoiningSeat}
        localVideoTrack={localVideoTrack}
        reconnectingIdentities={reconnectingIdentities}
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

      <StageOverlayShell gradient={false} topClassName="pt-0" className="gap-2">
        {joinSeatMessage && (
          <p
            className="rounded-lg bg-black/35 px-3 py-2 text-xs text-red-400"
            role="alert"
          >
            {joinSeatMessage}
          </p>
        )}
        {(isSpeaker || hasPendingRequest) && (
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
              compact
            />
          }
        />
      </StageOverlayShell>
    </div>
  );
}
