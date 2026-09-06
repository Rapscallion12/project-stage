import { GuestNameEditor } from "@/components/lobby/guest-name-editor";
import type { ConnectionStatus } from "@/hooks/use-live-room-connection";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";

/**
 * Minimal top chrome shared by `PortraitSpeakerView` and
 * `MobileLandscapeSpeakerView` (issue #18) — a status pill and, for a
 * guest, the name-edit chip. Extracted once both orientations needed the
 * identical structure (an existing duplication, not a speculative one —
 * see `StageOverlayShell`'s own doc comment for the same reasoning).
 *
 * **Both anchored left, deliberately never `justify-between`** (real-device
 * finding, issue #18 corrective pass): `SpeakerStage` always renders
 * `SelfPreview` fixed at `top-3 right-3`, in *every* composition,
 * regardless of role — Speaker View is no exception. The Watch Mode top
 * chrome this was copied from puts the guest-name chip at the opposite,
 * right-hand end of the row precisely because Watch Mode's ordinary
 * audience layout doesn't have anything else claiming that corner. Speaker
 * View does: putting the chip there put it directly on top of the
 * self-preview box. Worse, the edit-mode `<Input>` used to additionally
 * carry `text-sm`, which silently overrode `Input`'s own
 * iOS-Safari-auto-zoom protection (fixed in `GuestNameEditor` itself) — the
 * combination of "wrong position" and "triggers a real zoom" is what made
 * the self-preview appear to vanish after tapping the name. Keeping both
 * pieces on the left removes the positional collision outright, regardless
 * of the zoom fix; this component doesn't touch `SelfPreview` at all.
 *
 * **`pr-20 sm:pr-24` reserves `SelfPreview`'s own responsive footprint**
 * (real-device finding, follow-up): left-anchoring alone doesn't stop
 * overflow — on a narrow phone, the status pill and guest chip's combined
 * natural width can still reach into the top-right corner where
 * `SelfPreview` renders (`w-16`/`sm:w-20` at `right-3`), since padding
 * alone doesn't clip flex children from rendering past it. The same
 * "reserve the self-preview's footprint via responsive right padding"
 * pattern `MobileLandscapeRoom`'s own header overlay already uses
 * (`pr-16 sm:pr-20` there, matching `SelfPreview`'s own breakpoint
 * classes) — applied here with `min-w-0 flex-1` on the status pill so it
 * actually shrinks/truncates under that narrower budget instead of
 * overflowing it, the same flexbox-shrink discipline already required
 * for the Watch Mode composer. The guest chip stays `shrink-0` — already
 * capped by its own `max-w-[9rem]` truncation internally, and higher
 * priority to keep fully legible than the event title.
 */
export function SpeakerViewTopChrome({
  event,
  identity,
  connectionStatus,
  onOpenRoomInfo,
}: {
  event: Event;
  identity: Identity;
  connectionStatus: ConnectionStatus;
  /** Issue #21, seventh corrective pass, Section 9: the status pill doubles as the room/navigation entry point — the "simplest coherent solution" per explicit instruction, rather than a second floating control competing for the same corner. See RoomInfoOverlay's own doc comment. */
  onOpenRoomInfo: () => void;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-2 p-3 pr-20 sm:pr-24">
      <button
        type="button"
        data-testid="watch-status-pill"
        onClick={onOpenRoomInfo}
        aria-label={`Room info and navigation for ${event.title}`}
        className="pointer-events-auto flex min-w-0 flex-1 items-center gap-1.5 rounded-full border border-white/30 bg-black/35 py-1.5 pr-3 pl-2.5 text-xs text-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />
        <span className="min-w-0 truncate font-medium">{event.title}</span>
        {connectionStatus !== "connected" && (
          <span className="shrink-0 text-white/70">
            {connectionStatus === "connecting" && "· Connecting…"}
            {connectionStatus === "reconnecting" && "· Reconnecting…"}
            {connectionStatus === "disconnected" && "· Connection lost"}
            {connectionStatus === "unavailable" && "· Video unavailable"}
          </span>
        )}
        <span aria-hidden="true" className="shrink-0 text-white/60">
          ▾
        </span>
      </button>
      {identity.type === "guest" && (
        <div className="pointer-events-auto shrink-0">
          <GuestNameEditor initialName={identity.displayName} variant="chip" />
        </div>
      )}
    </div>
  );
}
