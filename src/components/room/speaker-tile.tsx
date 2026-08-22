"use client";

import { useEffect, useRef } from "react";
import { Track, type Participant } from "livekit-client";
import type { MediaError } from "@/hooks/use-live-room-connection";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "?";
}

/** Compact label for the tile's own placeholder — RoomControls still shows the full sentence below; this is just enough to explain the icon at a glance. */
function mediaErrorShortLabel(error: NonNullable<MediaError>): string {
  switch (error.reason) {
    case "permission-denied":
      return "Permission denied";
    case "no-device":
      return `No ${error.source} found`;
    case "device-unavailable":
      return `${error.source === "camera" ? "Camera" : "Microphone"} unavailable`;
    case "init-failed":
      return "Couldn't start";
  }
}

/**
 * Renders one seat. `speaker` (from `event_speakers`, via
 * `useActiveSpeakers`) decides *whether this seat is occupied and by
 * whom* — always authoritative, always shown. `participant` (from
 * `useLiveRoomConnection`, looked up by identity) decides only *whether a
 * video frame is currently available to render* — it's fine for this to
 * be `undefined` (not yet connected) or muted/cameraless even while
 * `speaker` is set; that's exactly the case this split exists for. Never
 * the reverse: a `participant` alone never implies an occupied seat.
 *
 * Issue #22 (dominant-video corrective pass): when this tile is *my own*
 * occupied seat (`isLocal`), it deliberately never renders the big video
 * even though `hasVideo` may be true — `SelfPreview` (SpeakerStage's
 * corner slot) is the one canonical place a speaker sees their own live
 * feed; showing it again here duplicated it. This is presentation-only:
 * `participant` here is `room.localParticipant`, whose track is already
 * published and subscribed by every *other* participant's own client
 * completely independently of what this client renders locally — muting
 * this tile's own video never touches the publication itself, same
 * principle `muted`/no-`<audio>`-element on the local tile already used
 * for the local mic. A remote viewer's `isLocal` is never true for either
 * tile at all (their own identity never matches a seat's occupant), so
 * this never affects what an audience member sees — both real speaker
 * tiles render normally for them, unchanged.
 */
export function SpeakerTile({
  speaker,
  participant,
  isLocal,
  needsMediaActivation = false,
  activateMedia,
  mediaError = null,
  onTapEmptySeat,
  isJoiningSeat = false,
  isReconnecting = false,
}: {
  speaker: EventSpeaker | null;
  participant: Participant | undefined;
  isLocal: boolean;
  /** Issue #15 real-device follow-up: true once the local participant has canPublish but hasn't tapped to activate media yet. Only ever meaningful when isLocal is true — a remote tile never shows this. */
  needsMediaActivation?: boolean;
  /** Must be invoked directly from this tile's own onClick — see useLiveRoomConnection's activateMedia doc comment for why. */
  activateMedia?: () => Promise<void>;
  mediaError?: MediaError;
  /** Issue #27: only meaningful when `speaker` is null. Undefined (not just a no-op) when the viewer already holds a seat — see SpeakerStage. */
  onTapEmptySeat?: () => void;
  isJoiningSeat?: boolean;
  /** Real-device reconnect-grace-period finding: true when `useSpeakerReconnectGrace` has been watching this seat's occupant be absent from LiveKit for a while, still within the grace period — always false for the local viewer's own seat (see that hook's own doc comment for why). Shown as "Speaker reconnecting…" instead of the generic "Camera off", since the seat isn't lost, just temporarily disconnected. */
  isReconnecting?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const cameraPublication = participant?.getTrackPublication(Track.Source.Camera);
  const microphonePublication = participant?.getTrackPublication(Track.Source.Microphone);
  const hasVideo = Boolean(cameraPublication?.track && !cameraPublication.isMuted);
  // Issue #22: this tile's own big video is never shown for the local
  // speaker's own seat — see this component's doc comment. Only affects
  // rendering; the underlying publication is untouched.
  const showBigVideo = hasVideo && !isLocal;

  useEffect(() => {
    const track = cameraPublication?.track;
    const element = videoRef.current;
    if (!track || !element || !showBigVideo) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [cameraPublication?.track, showBigVideo]);

  useEffect(() => {
    if (isLocal) return; // never play back the local participant's own mic
    const track = microphonePublication?.track;
    const element = audioRef.current;
    if (!track || !element || microphonePublication?.isMuted) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [isLocal, microphonePublication?.track, microphonePublication?.isMuted]);

  if (!speaker) {
    // Issue #27: the empty area itself is the entry point now, not a
    // separate "Request the mic" control elsewhere in the room. Tapping
    // it attempts to join directly if the seat is genuinely uncontested;
    // the server decides that (see joinOpenSeat), never this component —
    // a queue existing falls back to the composer's request mode instead
    // of anything shown here.
    return onTapEmptySeat ? (
      <button
        type="button"
        data-testid="empty-seat"
        onClick={onTapEmptySeat}
        disabled={isJoiningSeat}
        className="flex h-full w-full flex-col items-center justify-center gap-1 border border-dashed border-border bg-foreground/[0.02] text-muted transition-colors hover:bg-accent/5 hover:text-accent disabled:opacity-60"
      >
        <p className="text-sm font-medium">{isJoiningSeat ? "Joining…" : "Seat open"}</p>
        {!isJoiningSeat && <p className="text-xs">Tap to join</p>}
      </button>
    ) : (
      <div
        data-testid="empty-seat"
        className="flex h-full w-full flex-col items-center justify-center gap-1 border border-dashed border-border bg-foreground/[0.02] text-muted"
      >
        <p className="text-sm font-medium">Seat open</p>
      </div>
    );
  }

  return (
    <div data-testid="speaker-tile" className="relative h-full w-full overflow-hidden bg-foreground/10">
      {showBigVideo ? (
        // Only ever a remote participant's video now — the local
        // speaker's own feed lives in SelfPreview instead (see this
        // component's doc comment), so there's no local-feedback case to
        // mute here and no local audio element (see the effect above).
        <video ref={videoRef} autoPlay playsInline className="h-full w-full object-cover" />
      ) : isLocal && needsMediaActivation ? (
        // The activation tap-target lives here, on the local participant's
        // own tile — not only in RoomControls' control strip further down
        // the page. Real-device testing found the control strip's button
        // easy to miss entirely: the user is looking at this tile (it's
        // the thing showing "camera off"), not scrolling down to a
        // separate control strip. Same underlying activateMedia() call as
        // RoomControls' button, invoked directly from this element's own
        // onClick — still a real user gesture, still satisfies Safari's
        // requirement. See DECISIONS.md.
        <button
          type="button"
          data-testid="tile-activate-media"
          onClick={() => {
            void activateMedia?.();
          }}
          className="flex h-full w-full flex-col items-center justify-center gap-2 bg-accent/10 text-accent transition-colors hover:bg-accent/15 active:bg-accent/20"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/20 text-lg font-semibold">
            {initials(speaker.display_name)}
          </div>
          <p className="px-4 text-center text-xs font-medium">Tap to enable camera &amp; mic</p>
        </button>
      ) : isLocal && hasVideo ? (
        // I'm live (hasVideo is true — a real, unmuted published track),
        // just not shown here — see this component's doc comment. Framed
        // neutrally/positively, not as "Camera off" (untrue: it's on,
        // it's just deliberately not duplicated in this tile).
        <div
          data-testid="own-seat-live"
          className="flex h-full w-full flex-col items-center justify-center gap-2 bg-accent/5 text-foreground"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-lg font-semibold text-accent">
            {initials(speaker.display_name)}
          </div>
          <p className="px-4 text-center text-xs">You&apos;re live — see your preview in the corner</p>
        </div>
      ) : isReconnecting ? (
        <div
          data-testid="speaker-reconnecting"
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-lg font-semibold text-accent">
            {initials(speaker.display_name)}
          </div>
          <p className="text-xs">Speaker reconnecting…</p>
        </div>
      ) : (
        <div
          data-testid="no-video-placeholder"
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-lg font-semibold text-accent">
            {initials(speaker.display_name)}
          </div>
          <p className="text-xs">{isLocal && mediaError ? mediaErrorShortLabel(mediaError) : "Camera off"}</p>
        </div>
      )}
      {!isLocal && <audio ref={audioRef} autoPlay />}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
        <p className="truncate text-sm font-medium text-white">
          {speaker.display_name}
          {isLocal ? " (you)" : ""}
        </p>
      </div>
    </div>
  );
}
