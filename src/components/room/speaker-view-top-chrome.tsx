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
 */
export function SpeakerViewTopChrome({
  event,
  identity,
  connectionStatus,
}: {
  event: Event;
  identity: Identity;
  connectionStatus: ConnectionStatus;
}) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start gap-2 p-3">
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
  );
}
