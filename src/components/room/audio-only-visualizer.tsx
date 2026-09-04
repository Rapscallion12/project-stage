"use client";

import { useEffect, useRef } from "react";
import { createAudioAnalyser, type LocalAudioTrack, type RemoteAudioTrack } from "livekit-client";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { ProfileLink } from "@/components/room/profile-link";

const BAR_COUNT = 5;
// Empirically: a normal speaking voice through createAudioAnalyser's
// default fftSize sits well under this on `calculateVolume()`'s 0-1
// scale — chosen so a full bar reads as "clearly speaking," not just any
// detectable sound, without needing per-device calibration.
const VOLUME_CEILING = 0.5;
const MIN_BAR_SCALE = 0.15;

/**
 * Media Readiness pass (issue #21), Section 12: the audio-only speaker
 * placeholder — replaces the dead "Camera off" tile area for a seat that
 * is occupied, publishing usable audio, but not video. Reacts to the
 * *real* LiveKit audio track via `createAudioAnalyser` (`livekit-client`'s
 * own exported utility — see this file's sibling doc comments/DECISIONS.md
 * for why this was chosen over both a hand-rolled Web Audio
 * implementation and `@livekit/components-react`'s `BarVisualizer`: that
 * package isn't installed, and `createAudioAnalyser` is already available
 * from the `livekit-client` version this project has). Never fake/random
 * motion — bars are silent (settled at their floor) whenever
 * `calculateVolume()` reports silence, and move only in response to
 * actual signal.
 *
 * **One track drives every viewer of it** — `SpeakerTile` passes whichever
 * of the local participant's own microphone publication, or a remote
 * participant's subscribed microphone publication, is actually playing
 * for *this* viewer (Section 15: local self-view, audience-of-remote, and
 * speaker-viewing-partner all reach this the same way, through whatever
 * track that viewer's own client already holds — no separate local-only
 * code path).
 *
 * **Performance** (Section 14): bar heights are written directly to DOM
 * element styles inside a `requestAnimationFrame` loop — never through
 * `setState` — so a full room of visualizing tiles never triggers a React
 * re-render per audio frame. The rAF loop and the analyser's own
 * AudioContext resources are torn down (via `cleanup()`, the function
 * `createAudioAnalyser` itself returns) whenever `track` changes identity
 * or this component unmounts, so a speaker-swap or a camera toggle back
 * to video never leaks a running analyser/rAF loop.
 */
export function AudioOnlyVisualizer({
  track,
  displayName,
  imageUrl,
  username,
}: {
  track: LocalAudioTrack | RemoteAudioTrack;
  displayName: string;
  imageUrl?: string | null;
  username?: string | null;
}) {
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => {
    const { calculateVolume, cleanup } = createAudioAnalyser(track, { fftSize: 128, smoothingTimeConstant: 0.6 });
    let frame: number;
    // Per-bar phase offsets, so a sustained tone reads as a gentle
    // waveform across the bars rather than every bar snapping to the
    // identical height — purely a presentation detail layered on top of
    // the one real volume reading per frame, not a second data source.
    const phases = Array.from({ length: BAR_COUNT }, (_, i) => i * 0.9);

    function tick() {
      const volume = Math.min(1, calculateVolume() / VOLUME_CEILING);
      const now = performance.now() / 1000;
      barRefs.current.forEach((el, i) => {
        if (!el) return;
        const wobble = 0.75 + 0.25 * Math.sin(now * 4 + phases[i]);
        const scale = MIN_BAR_SCALE + (1 - MIN_BAR_SCALE) * volume * wobble;
        el.style.transform = `scaleY(${scale})`;
      });
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      void cleanup();
    };
  }, [track]);

  return (
    <div
      data-testid="audio-only-visualizer"
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-accent/5 text-foreground"
    >
      <ProfileLink username={username ?? null} ariaLabel={`${displayName}'s profile`}>
        <ParticipantAvatar name={displayName} imageUrl={imageUrl} size="md" />
      </ProfileLink>
      <div aria-hidden="true" className="flex h-6 items-end gap-1">
        {Array.from({ length: BAR_COUNT }, (_, i) => (
          <span
            key={i}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className="h-full w-1 origin-bottom rounded-full bg-accent"
            style={{ transform: `scaleY(${MIN_BAR_SCALE})` }}
          />
        ))}
      </div>
    </div>
  );
}
