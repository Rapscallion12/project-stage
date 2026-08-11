"use client";

import { useEffect, useRef } from "react";
import { Track, type Participant } from "livekit-client";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

function initials(name: string): string {
  return name.trim().slice(0, 2).toUpperCase() || "?";
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
 */
export function SpeakerTile({
  speaker,
  participant,
  isLocal,
}: {
  speaker: EventSpeaker | null;
  participant: Participant | undefined;
  isLocal: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  const cameraPublication = participant?.getTrackPublication(Track.Source.Camera);
  const microphonePublication = participant?.getTrackPublication(Track.Source.Microphone);
  const hasVideo = Boolean(cameraPublication?.track && !cameraPublication.isMuted);

  useEffect(() => {
    const track = cameraPublication?.track;
    const element = videoRef.current;
    if (!track || !element || !hasVideo) return;
    track.attach(element);
    return () => {
      track.detach(element);
    };
  }, [cameraPublication?.track, hasVideo]);

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
    return (
      <div
        data-testid="empty-seat"
        className="flex aspect-video flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-foreground/[0.02] text-muted"
      >
        <p className="text-sm font-medium">Seat open</p>
      </div>
    );
  }

  return (
    <div data-testid="speaker-tile" className="relative aspect-video overflow-hidden rounded-lg bg-foreground/10">
      {hasVideo ? (
        // Local video is muted to avoid feedback; there is no local audio
        // element at all (see the effect above) for the same reason.
        <video ref={videoRef} autoPlay playsInline muted={isLocal} className="h-full w-full object-cover" />
      ) : (
        <div
          data-testid="no-video-placeholder"
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted"
        >
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-lg font-semibold text-accent">
            {initials(speaker.display_name)}
          </div>
          <p className="text-xs">Camera off</p>
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
