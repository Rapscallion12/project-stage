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
 * Three more pieces live in this same container, all currently inert —
 * each is a fixed structural anchor a later issue attaches real behavior
 * to, not a placeholder to be swapped out:
 * - The **divider**, between the two tiles — #25 (retention voting)
 *   makes it tappable; not a `<button>` yet because it has no function to
 *   expose to assistive tech until then.
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
}: {
  speakers: EventSpeaker[];
  getParticipant: (identity: string) => Participant | undefined;
  myIdentity: string;
  needsMediaActivation: boolean;
  activateMedia: () => Promise<void>;
  mediaError: MediaError;
  orientation: Orientation;
}) {
  const bySeat = (seatNumber: 1 | 2) => speakers.find((s) => s.seat_number === seatNumber) ?? null;

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
        />
      </div>
    );
  }

  return (
    <div data-testid="room-stage" className="relative h-full w-full overflow-hidden bg-black">
      <div className={orientation === "landscape" ? "flex h-full w-full flex-row" : "flex h-full w-full flex-col"}>
        {renderTile(1)}
        <div
          data-testid="speaker-divider"
          aria-hidden="true"
          className={
            orientation === "landscape"
              ? "relative z-10 w-2 shrink-0 bg-border"
              : "relative z-10 h-2 shrink-0 bg-border"
          }
        >
          <span className="absolute top-1/2 left-1/2 h-5 w-5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-border ring-2 ring-black/20" />
        </div>
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
