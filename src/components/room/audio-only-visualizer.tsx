"use client";

import { useEffect, useRef } from "react";
import { createAudioAnalyser, type LocalAudioTrack, type RemoteAudioTrack } from "livekit-client";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { ProfileLink } from "@/components/room/profile-link";
import { cn } from "@/lib/utils";

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
 *
 * **AudioContext resume** (media rendering bugfix pass, real-device
 * report): `createAudioAnalyser` (`livekit-client`) creates a *brand new*
 * `AudioContext` every call — confirmed by reading its actual
 * implementation, not assumed — and browsers commonly start a
 * programmatically-created `AudioContext` in a `suspended` state unless
 * it's created synchronously inside a user-gesture handler, which this
 * effect is not (it fires from a prop/render change, not a click).
 * `createAudioAnalyser` itself only recovers from this by attaching a
 * one-time `click` listener on `document.body` (see its own source) —
 * meaning a viewer who never happens to click anywhere after this
 * mounts would see permanently-silent bars even with real audio flowing,
 * indistinguishable from "the visualizer doesn't work." Resuming
 * explicitly here (via the returned `analyser`'s own `.context`) closes
 * that gap without waiting on an incidental future click.
 */
export function AudioOnlyVisualizer({
  track,
  displayName = "",
  imageUrl,
  username,
  compact = false,
}: {
  track: LocalAudioTrack | RemoteAudioTrack;
  /** Unused when `compact` — the corner slot has no room for an identity block, and the viewer's own identity is already shown elsewhere in the room chrome. */
  displayName?: string;
  imageUrl?: string | null;
  username?: string | null;
  /** Media rendering bugfix pass: the local self-view corner slot (SpeakerStage) needs a small, identity-free rendering of the same real bars — not a second visualizer implementation. Defaults to false (the existing full-tile treatment, with avatar/name, unchanged for remote/co-speaker tiles). */
  compact?: boolean;
}) {
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { calculateVolume, analyser, cleanup } = createAudioAnalyser(track, {
      fftSize: 128,
      smoothingTimeConstant: 0.6,
    });
    // `AnalyserNode.context` is typed as the more general `BaseAudioContext`
    // (which also covers OfflineAudioContext, with no `.resume()`) — but
    // `createAudioAnalyser` (livekit-client) only ever constructs a real
    // `AudioContext` for it, confirmed by reading its own implementation.
    const audioContext = analyser.context as AudioContext;
    void audioContext.resume().catch(() => {
      // Some browsers refuse to resume outside a user gesture regardless —
      // createAudioAnalyser's own click-listener fallback still covers
      // that case; this is a best-effort head start, not the only path.
    });
    // TEMPORARY — media rendering bugfix pass (real-device report):
    // dev-only debug attributes on the root element, updated in the same
    // rAF tick as the bars themselves (a raw DOM write, not React state —
    // see this component's own Performance doc comment for why that
    // matters). Lets a real device's devtools inspect exactly what this
    // instance's analyser is doing (track sid, context state, latest
    // amplitude) without needing a separate visible UI — never rendered
    // in production. Remove once both reported bugs are confirmed fixed.
    const debug = process.env.NODE_ENV !== "production";
    const debugElement = rootRef.current;
    if (debug && debugElement) {
      debugElement.dataset.analyserTrackSid = track.sid ?? "unknown";
      debugElement.dataset.analyserContextState = analyser.context.state;
    }
    let frame: number;
    // Per-bar phase offsets, so a sustained tone reads as a gentle
    // waveform across the bars rather than every bar snapping to the
    // identical height — purely a presentation detail layered on top of
    // the one real volume reading per frame, not a second data source.
    const phases = Array.from({ length: BAR_COUNT }, (_, i) => i * 0.9);

    function tick() {
      const rawVolume = calculateVolume();
      const volume = Math.min(1, rawVolume / VOLUME_CEILING);
      const now = performance.now() / 1000;
      barRefs.current.forEach((el, i) => {
        if (!el) return;
        const wobble = 0.75 + 0.25 * Math.sin(now * 4 + phases[i]);
        const scale = MIN_BAR_SCALE + (1 - MIN_BAR_SCALE) * volume * wobble;
        el.style.transform = `scaleY(${scale})`;
      });
      if (debug && debugElement) {
        debugElement.dataset.analyserRafActive = "true";
        debugElement.dataset.analyserAmplitude = rawVolume.toFixed(3);
        debugElement.dataset.analyserContextState = analyser.context.state;
      }
      frame = requestAnimationFrame(tick);
    }
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      if (debug && debugElement) debugElement.dataset.analyserRafActive = "false";
      void cleanup();
    };
  }, [track]);

  const bars = (
    <div aria-hidden="true" className={cn("flex items-end gap-1", compact ? "h-4" : "h-6")}>
      {Array.from({ length: BAR_COUNT }, (_, i) => (
        <span
          key={i}
          ref={(el) => {
            barRefs.current[i] = el;
          }}
          className={cn("origin-bottom rounded-full bg-accent", compact ? "w-0.5" : "w-1")}
          style={{ transform: `scaleY(${MIN_BAR_SCALE})` }}
        />
      ))}
    </div>
  );

  if (compact) {
    // Media rendering bugfix pass: the self-view corner slot (SpeakerStage)
    // already shows the viewer's own identity elsewhere in the room chrome
    // — this fills the same small box SelfPreview's <video> otherwise
    // occupies, just the bars, on the same dark background.
    return (
      <div
        ref={rootRef}
        data-testid="audio-only-visualizer"
        className="flex h-full w-full items-center justify-center bg-black"
      >
        {bars}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      data-testid="audio-only-visualizer"
      className="flex h-full w-full flex-col items-center justify-center gap-3 bg-accent/5 text-foreground"
    >
      <ProfileLink username={username ?? null} ariaLabel={`${displayName}'s profile`}>
        <ParticipantAvatar name={displayName} imageUrl={imageUrl} size="md" />
      </ProfileLink>
      {bars}
    </div>
  );
}
