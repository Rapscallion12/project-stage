import { Track, type Participant } from "livekit-client";

/**
 * Media rendering bugfix pass (real-device report, issue #21): the *one*
 * place "does this participant currently have usable video/audio"
 * gets computed — reading LiveKit's own live publication state directly,
 * never a separately-tracked local boolean (`cameraMuted`/
 * `microphoneMuted` reflect *this tab's own* toggle intent, which is a
 * different question from "is a track actually flowing right now," and
 * can disagree with it during the acquisition/publish window this pass
 * is about).
 *
 * Originally inlined separately in `SpeakerTile` (for every seat) and
 * absent entirely from `SpeakerStage`'s self-preview corner slot (which
 * only ever considered `localVideoTrack`, with no concept of "camera off,
 * mic on" at all) — real-device testing found the local speaker's own
 * corner preview had no audio-visualizer state whatsoever, since
 * `soloMode` (Speaker View) never renders the local participant's own
 * `SpeakerTile` in the first place (see `SpeakerStage`'s own doc comment
 * on `soloMode`). Extracting this here lets both call sites — remote/
 * co-speaker tiles via `SpeakerTile`, and the local self-view corner slot
 * via `SpeakerStage` — derive `hasVideo`/`hasAudio` identically, from the
 * exact same `Participant`/publication API, so "local" and "remote" can
 * never structurally drift apart on what counts as camera-on or mic-on.
 */
export function deriveParticipantMediaState(participant: Participant | undefined): {
  hasVideo: boolean;
  hasAudio: boolean;
  cameraTrack: Track | undefined;
  microphoneTrack: Track | undefined;
} {
  const cameraPublication = participant?.getTrackPublication(Track.Source.Camera);
  const microphonePublication = participant?.getTrackPublication(Track.Source.Microphone);
  const hasVideo = Boolean(cameraPublication?.track && !cameraPublication.isMuted);
  const hasAudio = Boolean(microphonePublication?.track && !microphonePublication.isMuted);
  return {
    hasVideo,
    hasAudio,
    cameraTrack: cameraPublication?.track,
    microphoneTrack: microphonePublication?.track,
  };
}
