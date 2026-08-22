"use client";

import { useEffect, useRef } from "react";
import type { LocalVideoTrack } from "livekit-client";

/**
 * Issue #22: the local candidate/speaker's own camera preview, rendered
 * into SpeakerStage's reserved top-right slot (see that component's doc
 * comment for why the slot lives outside the tile grid). The caller
 * (SpeakerStage) only mounts this when `useLiveRoomConnection.localVideoTrack`
 * is non-null — an ordinary audience member with no local media never
 * renders it at all, and it isn't sent to any other participant; it's a
 * `<video>` attached directly to a *local* MediaStreamTrack, nothing
 * published or subscribed.
 *
 * The same `track` object flows in from `EventRoom` unchanged across the
 * whole pending → countdown → published-speaker transition (prepared once
 * by `prepareLocalMedia`, later published in place by `applyPublishState`
 * without ever being re-acquired) — and this component itself stays
 * mounted at the same call site the whole time, so the `<video>` element
 * never gets torn down and recreated either. `key`ing on the track's own
 * `sid` (stable once created) is what guarantees React reuses this same
 * element rather than remounting if a caller's own key ever changes.
 */
export function SelfPreview({ track }: { track: LocalVideoTrack }) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [track]);

  return (
    <div
      data-testid="self-preview"
      className="absolute top-3 right-3 h-24 w-16 overflow-hidden rounded-md border-2 border-accent bg-black shadow-lg sm:h-28 sm:w-20"
    >
      {/* Muted: this is the local camera's own preview, played back to the
          person it belongs to — never their own mic, same reasoning as
          SpeakerTile's local video element. */}
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
      <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] font-medium leading-tight text-white">
        You
      </span>
    </div>
  );
}
