import { RoomHeader } from "@/components/room/room-header";
import { SpeakerStage } from "@/components/room/speaker-stage";
import { RoomChatPanel } from "@/components/room/room-chat-panel";
import { RoomControls } from "@/components/room/room-controls";
import { StageOverlayShell } from "@/components/room/stage-overlay-shell";
import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import { useCommentsMode } from "@/hooks/use-comments-mode";
import type { RoomLayoutProps } from "@/components/room/types";

/** Comments Mode's own height when open — portrait has more vertical room to spare than landscape, so this can afford to be taller. Tunable, not validated against a real device yet. */
const COMMENTS_MODE_HEIGHT_PX = 320;
const SCRIM_OPACITY_WHEN_OPEN = 0.55;

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
 * **Watch Mode / Comments Mode, tap-driven (issue #21, gesture retired,
 * 2026-08-22)**: this component never got the first (handle-driven) or
 * second (room-level drag) gesture pass at all — it shipped issue #20's
 * always-visible, fixed-height chat strip and stayed there, which is
 * exactly what real-device testing flagged: "comments/composer continue
 * overlapping/competing with the lower speaker area." `useCommentsMode`
 * (a plain boolean, no drag tracking — see its own doc comment) now
 * drives the same two states `MobileLandscapeRoom` uses: **Watch Mode**
 * (`open === false`) renders no chat panel at all, just the compact
 * `comments-toggle`; **Comments Mode** (`open === true`) mounts the full
 * `RoomChatPanel` at `COMMENTS_MODE_HEIGHT_PX` (taller than landscape's,
 * since portrait has more vertical room to spare) and darkens
 * `SpeakerStage`'s scrim. This is a deliberate, temporary foundation —
 * see DECISIONS.md's "Future Figma seam" note — not a redesign: the
 * eventual downward-drag reveal returns once Watch Mode and Comments
 * Mode both have a real, Figma-defined visual target to transition
 * between, not before. Video geometry never changes: `SpeakerStage` is a
 * sibling of the overlay, not a child of it, so toggling Comments Mode
 * never re-renders, resizes, or remounts it.
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
  const { open: commentsOpen, openComments, closeComments } = useCommentsMode();

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
          scrimOpacity={commentsOpen ? SCRIM_OPACITY_WHEN_OPEN : 0}
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
          {/* Watch Mode's one persistent affordance — Comments Mode's own explicit "back to video" control, same button either way. */}
          <button
            type="button"
            data-testid="comments-toggle"
            onClick={commentsOpen ? closeComments : openComments}
            aria-expanded={commentsOpen}
            aria-label={commentsOpen ? "Hide comments" : "Show comments"}
            className="flex h-8 w-full shrink-0 items-center justify-center gap-1 text-sm text-white/70"
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
          {/* Comments Mode only — not rendered at all in Watch Mode, not just shorter. */}
          {commentsOpen && (
            <div style={{ height: COMMENTS_MODE_HEIGHT_PX }} className="min-h-0 shrink-0">
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
          )}
        </StageOverlayShell>
      </div>
    </div>
  );
}
