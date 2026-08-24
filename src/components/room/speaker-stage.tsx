import type { LocalVideoTrack, Participant } from "livekit-client";
import { SpeakerTile } from "@/components/room/speaker-tile";
import { SelfPreview } from "@/components/room/self-preview";
import { getParticipantIdentity } from "@/lib/livekit/token";
import { cn } from "@/lib/utils";
import type { MediaError } from "@/hooks/use-live-room-connection";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { Orientation } from "@/hooks/use-orientation";

/**
 * The video-first stage (issue #20) — both seats, full-bleed, filling
 * whatever box the caller gives it (portrait: stacked top/bottom;
 * landscape: side by side, mirroring `useOrientation`'s own values so
 * this never needs its own orientation logic). An empty seat still
 * renders `SpeakerTile`'s own placeholder rather than being omitted, so
 * the two-seat framing never collapses to one column.
 *
 * **Layering model** (fixed after real-device testing found the divider
 * bleeding across chat/controls): this root is `relative z-0`, not just
 * `relative` — `z-0` (a real value, not `auto`) is what actually makes a
 * positioned element establish its own CSS stacking context. Without it,
 * a descendant's `z-index` doesn't stay scoped to this subtree; it
 * escapes to compete in whichever ancestor stacking context it lands in
 * instead — which is exactly what was happening: the divider's old
 * `z-10` was being compared against `stage-bottom-overlay`'s (portrait-
 * room.tsx) stacking level, not contained in here at all, so `10 >
 * auto` put it on top regardless of DOM order. With this root properly
 * containing its own stacking context, nothing inside this component —
 * now or whatever #21/#25 add later — can ever again paint above a
 * sibling layer like the chat/controls overlay. The fix is structural
 * containment, not raising every foreground control's own z-index to
 * outrank the divider one at a time.
 *
 * Three more pieces live in this same container, all currently inert —
 * each is a fixed structural anchor a later issue attaches real behavior
 * to, not a placeholder to be swapped out:
 * - The **divider**, between the two tiles — a plain, unpositioned flex
 *   sibling today (no `z-index` of its own needed: it doesn't overlap
 *   the tiles, and the stage-level containment above is what keeps it
 *   from ever crossing anything outside this component). #25 (retention
 *   voting) makes it tappable; not a `<button>` yet because it has no
 *   function to expose to assistive tech until then. Its center
 *   dot/handle is deliberately not rendered yet — it has no user-facing
 *   function until #21/#25 exist, and an inert decoration was part of
 *   the visual clutter real-device testing flagged; the bar itself
 *   (the actual structural anchor those issues need) stays.
 * - The **self-preview slot**, a fixed corner position — issue #22:
 *   renders `SelfPreview` (the local participant's own camera, attached
 *   directly from `localVideoTrack`) whenever local media is actually
 *   held, and nothing at all otherwise — an ordinary audience member who
 *   hasn't expressed intent to speak never sees a placeholder here. Kept
 *   *outside* the flex row/col below (a sibling, absolutely positioned
 *   against this component's own `relative` root) so it stays visually
 *   anchored to the stage as a whole, never inside either individual
 *   tile, and so the *same* mounted element survives the pending →
 *   countdown → published-speaker transition (this component itself
 *   doesn't unmount across that transition either — see EventRoom).
 *   Top-right, not bottom-right (issue #20's real-device corrective
 *   pass) — the bottom is now the chat/controls overlay's territory.
 *   Deliberately still just the local feed even once actually speaking —
 *   making the *other* speaker dominant on the main stage instead is a
 *   larger visual redesign left to a later issue (possibly #18), not
 *   done here.
 * - **Open-seat visual priority** (real-device finding, 2026-08-22): when
 *   exactly one seat is empty and the viewer isn't a speaker themselves
 *   (so the empty seat is actually tappable — see `onTapEmptySeat`
 *   below), that tile renders first (`order-first`) regardless of
 *   whether it's seat 1 or seat 2. Portrait stacks tiles vertically, so
 *   this is what keeps the open, actionable seat out of the bottom
 *   overlay's territory (see `PortraitRoom`'s own doc comment) instead of
 *   requiring the visitor to somehow work around a fixed-height chat
 *   panel to reach it. Pure CSS `order` on an unchanged, identically-keyed
 *   element — seat numbering/DB assignment, LiveKit subscriptions, and
 *   whatever's already attached to either tile are completely untouched;
 *   nothing here remounts.
 * - The **scrim**, spanning the whole stage — issue #21's own darkening
 *   layer for the comments-overlay focus state, driven via the optional
 *   `scrimOpacity`/`scrimInstant` props below (defaulting to `0`/`false`,
 *   i.e. today's original inert behavior, for `PortraitRoom`/`DesktopRoom`,
 *   which don't pass them yet). `pointer-events-none` always — it must
 *   never block a tap on a tile underneath (e.g. issue #15's "tap to
 *   enable camera & mic" control), darkening is purely visual.
 *
 * `bg-black`, not a theme token — a video stage stays dark regardless of
 * the app's light/dark mode, the same convention any video player uses.
 *
 * **`soloMode`** (issue #18, Speaker View Phase 1): when the viewer holds
 * one of the two seats, `PortraitSpeakerView`/`MobileLandscapeSpeakerView`
 * both pass `true` so the *other* seat's tile fills this entire box — no
 * divider, no equal-sized tile for the viewer's own seat (their own feed
 * is already covered by the self-preview slot below, unconditionally,
 * regardless of this flag). One orientation-agnostic flag, not a
 * per-orientation prop — the sizing/takeover logic itself never differed
 * between portrait and landscape, only which `orientation` value picks
 * stacked vs. side-by-side for the (now singular) remaining tile.
 * Deliberately doesn't add a new tile-rendering path: it's the exact same
 * `renderTile()` used for the ordinary two-tile layout, just called once
 * instead of twice, so every existing per-tile behavior (empty-seat
 * placeholder, reconnect grace, media-activation tap target) carries over
 * unchanged. If the viewer's own seat can't be identified (a defensive
 * fallback, not an expected path — `PortraitSpeakerView` only renders
 * this with `soloMode` when `isSpeaker` is already true), this falls back
 * to the ordinary two-tile layout rather than rendering nothing.
 */
export function SpeakerStage({
  speakers,
  getParticipant,
  myIdentity,
  needsMediaActivation,
  activateMedia,
  mediaError,
  orientation,
  onTapEmptySeat,
  isJoiningSeat,
  localVideoTrack,
  scrimOpacity = 0,
  scrimInstant = false,
  reconnectingIdentities,
  soloMode = false,
}: {
  speakers: EventSpeaker[];
  getParticipant: (identity: string) => Participant | undefined;
  myIdentity: string;
  needsMediaActivation: boolean;
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  orientation: Orientation;
  /** Issue #27: tapping either empty seat tile — omitted entirely (not just disabled) when the viewer already holds a seat, since a seated speaker has no use for it. */
  onTapEmptySeat: () => void;
  isJoiningSeat: boolean;
  /** Issue #22: the local participant's own held camera track, if any — see this component's self-preview-slot doc comment above. */
  localVideoTrack: LocalVideoTrack | null;
  /** Issue #21: 0 (no darkening) to 1 (fully darkened) — see the scrim's own doc comment above. */
  scrimOpacity?: number;
  /** Issue #21: true only for live drag frames — omits the CSS transition so the scrim tracks the finger with zero lag; release/tap-toggle frames leave this false so the settle animates. */
  scrimInstant?: boolean;
  /** Real-device reconnect-grace-period finding: LiveKit identities `useSpeakerReconnectGrace` is currently watching as disconnected-but-within-grace — passed through to whichever tile matches, see SpeakerTile's own isReconnecting doc comment. */
  reconnectingIdentities: ReadonlySet<string>;
  /** Issue #18, Speaker View Phase 1 — see this component's own doc comment above. Defaults to false: every existing caller (MobileLandscapeRoom, DesktopRoom, PortraitRoom's Audience/Candidate path) is completely unaffected. */
  soloMode?: boolean;
}) {
  const bySeat = (seatNumber: 1 | 2) => speakers.find((s) => s.seat_number === seatNumber) ?? null;
  const viewerIsSpeaking = speakers.some((s) => {
    const identity = getParticipantIdentity(
      s.profile_id ? { type: "profile", id: s.profile_id } : { type: "guest", id: s.guest_id! },
    );
    return identity === myIdentity;
  });

  // Issue #18, Speaker View Phase 1: which seat (if any) is the viewer's
  // own — soloMode uses this to render only the *other* seat's tile. Only
  // ever non-null when viewerIsSpeaking is also true.
  const mySeatNumber: 1 | 2 | null = (() => {
    for (const seatNumber of [1, 2] as const) {
      const seat = bySeat(seatNumber);
      if (!seat) continue;
      const identity = getParticipantIdentity(
        seat.profile_id ? { type: "profile", id: seat.profile_id } : { type: "guest", id: seat.guest_id! },
      );
      if (identity === myIdentity) return seatNumber;
    }
    return null;
  })();

  // Real-device finding (2026-08-22): exactly one open seat, viewer not
  // already speaking — that seat is this viewer's one actionable target,
  // so it visually leads regardless of which seat number it happens to
  // be. Both-empty/both-occupied/viewer-is-speaking all leave natural
  // seat-number order alone — there's no single "the" actionable seat to
  // prioritize in those cases.
  const seat1 = bySeat(1);
  const seat2 = bySeat(2);
  const promoteOpenSeat = !viewerIsSpeaking && (seat1 === null) !== (seat2 === null);

  function renderTile(seatNumber: 1 | 2) {
    const seat = seatNumber === 1 ? seat1 : seat2;
    // Issue #16: a seat's occupant identity is whichever of
    // profile_id/guest_id is actually set (the table's own XOR
    // constraint guarantees exactly one) — never assume profile.
    const identity = seat
      ? getParticipantIdentity(
          seat.profile_id ? { type: "profile", id: seat.profile_id } : { type: "guest", id: seat.guest_id! },
        )
      : null;
    return (
      <div
        key={seat?.id ?? `empty-${seatNumber}`}
        className={cn("min-h-0 min-w-0 flex-1", promoteOpenSeat && seat === null && "order-first")}
      >
        <SpeakerTile
          speaker={seat}
          participant={identity ? getParticipant(identity) : undefined}
          isLocal={identity === myIdentity}
          needsMediaActivation={needsMediaActivation}
          activateMedia={activateMedia}
          mediaError={mediaError}
          onTapEmptySeat={viewerIsSpeaking ? undefined : onTapEmptySeat}
          isJoiningSeat={isJoiningSeat}
          isReconnecting={identity !== null && reconnectingIdentities.has(identity)}
          orientation={orientation}
          clearTopChrome={seatNumber === 1}
        />
      </div>
    );
  }

  const renderSolo = soloMode && mySeatNumber !== null;

  return (
    <div data-testid="room-stage" className="relative z-0 h-full w-full overflow-hidden bg-black">
      <div className={orientation === "landscape" ? "flex h-full w-full flex-row" : "flex h-full w-full flex-col"}>
        {renderSolo ? (
          renderTile(mySeatNumber === 1 ? 2 : 1)
        ) : (
          <>
            {renderTile(1)}
            <div
              data-testid="speaker-divider"
              aria-hidden="true"
              className={orientation === "landscape" ? "w-2 shrink-0 bg-border" : "h-2 shrink-0 bg-border"}
            />
            {renderTile(2)}
          </>
        )}
      </div>

      {/* Self-preview slot (issue #22) — hidden entirely, not just an empty placeholder, when there's no local media to show. */}
      {localVideoTrack && <SelfPreview track={localVideoTrack} />}

      {/* Scrim (issue #21) — driven by scrimOpacity; see the doc comment above. */}
      <div
        data-testid="room-scrim"
        aria-hidden="true"
        className={cn("pointer-events-none absolute inset-0 bg-black", !scrimInstant && "transition-opacity duration-200")}
        style={{ opacity: scrimOpacity }}
      />
    </div>
  );
}
