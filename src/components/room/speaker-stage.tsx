import type { Participant } from "livekit-client";
import { SpeakerTile } from "@/components/room/speaker-tile";
import { getParticipantIdentity } from "@/lib/livekit/token";
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
 * - The **self-preview slot**, a fixed corner position — #22 renders the
 *   local participant's persistent camera preview into it. Kept
 *   *outside* the flex row/col below (a sibling, absolutely positioned
 *   against this component's own `relative` root) so it stays visually
 *   anchored to the stage as a whole, never inside either individual
 *   tile. Top-right, not bottom-right (issue #20's real-device corrective
 *   pass) — the bottom is now the chat/controls overlay's territory.
 * - The **scrim**, spanning the whole stage — #21 will animate its
 *   opacity as chat/voting focus panels open above it. `opacity-0` and
 *   `pointer-events-none` today: present in the DOM (so #21 doesn't need
 *   to introduce a new layer, just start animating this one) but
 *   invisible and inert, so it can never block a tap on a tile
 *   underneath (e.g. issue #15's "tap to enable camera & mic" control).
 *
 * `bg-black`, not a theme token — a video stage stays dark regardless of
 * the app's light/dark mode, the same convention any video player uses.
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
}) {
  const bySeat = (seatNumber: 1 | 2) => speakers.find((s) => s.seat_number === seatNumber) ?? null;
  const viewerIsSpeaking = speakers.some((s) => {
    const identity = getParticipantIdentity(
      s.profile_id ? { type: "profile", id: s.profile_id } : { type: "guest", id: s.guest_id! },
    );
    return identity === myIdentity;
  });

  function renderTile(seatNumber: 1 | 2) {
    const seat = bySeat(seatNumber);
    // Issue #16: a seat's occupant identity is whichever of
    // profile_id/guest_id is actually set (the table's own XOR
    // constraint guarantees exactly one) — never assume profile.
    const identity = seat
      ? getParticipantIdentity(
          seat.profile_id ? { type: "profile", id: seat.profile_id } : { type: "guest", id: seat.guest_id! },
        )
      : null;
    return (
      <div key={seat?.id ?? `empty-${seatNumber}`} className="min-h-0 min-w-0 flex-1">
        <SpeakerTile
          speaker={seat}
          participant={identity ? getParticipant(identity) : undefined}
          isLocal={identity === myIdentity}
          needsMediaActivation={needsMediaActivation}
          activateMedia={activateMedia}
          mediaError={mediaError}
          onTapEmptySeat={viewerIsSpeaking ? undefined : onTapEmptySeat}
          isJoiningSeat={isJoiningSeat}
        />
      </div>
    );
  }

  return (
    <div data-testid="room-stage" className="relative z-0 h-full w-full overflow-hidden bg-black">
      <div className={orientation === "landscape" ? "flex h-full w-full flex-row" : "flex h-full w-full flex-col"}>
        {renderTile(1)}
        <div
          data-testid="speaker-divider"
          aria-hidden="true"
          className={orientation === "landscape" ? "w-2 shrink-0 bg-border" : "h-2 shrink-0 bg-border"}
        />
        {renderTile(2)}
      </div>

      {/* Self-preview slot (issue #22 renders into this) */}
      <div
        data-testid="self-preview-slot"
        aria-hidden="true"
        className="pointer-events-none absolute top-3 right-3 h-24 w-16 rounded-md border border-dashed border-white/30 bg-white/5 sm:h-28 sm:w-20"
      />

      {/* Scrim (issue #21 animates this) */}
      <div
        data-testid="room-scrim"
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-black opacity-0 transition-opacity duration-200"
      />
    </div>
  );
}
