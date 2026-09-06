"use client";

import { useState } from "react";
import type { ConnectionStatus, MediaError } from "@/hooks/use-live-room-connection";
import { Track, type Participant } from "livekit-client";
import { getParticipantIdentity } from "@/lib/livekit/token";
import { deriveParticipantMediaState } from "@/lib/participant-media-state";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/**
 * TEMPORARY — added to diagnose issue #15's real-device failure (camera/mic
 * still didn't work on a real iPhone after the gesture-gating fix). Surfaces
 * exactly enough state to distinguish the five failure layers the
 * investigation needs to tell apart: browser permission failure, LiveKit
 * connection failure, token/authorization failure, "not recognized as the
 * seated speaker," and post-permission publish failure. Every value here is
 * already safe to show the room's own occupant (booleans/enums, never a
 * token, key, or secret). Remove once the real-device root cause is
 * confirmed fixed — see DECISIONS.md.
 *
 * Collapsed by default (issue #17 real-device follow-up): this panel was
 * itself found to be a real contributor to a *different* discoverability
 * failure — always-expanded, it added a meaningful chunk of permanent
 * height below the actual room controls, pushing them further from the
 * top of a real phone's viewport. Collapsed to a single-line toggle, it
 * stays available on demand without competing with the product UI for
 * space it doesn't need most of the time.
 *
 * Issue #20: pulled out of the normal room UI entirely — EventRoom only
 * mounts this component when `isDevToolsAvailable()` is true, the same
 * production guard `/dev` uses. No longer floats/obstructs anything for
 * a real visitor; still reachable from a local dev server.
 */
export function RoomDiagnostics({
  identityType,
  isSpeaker,
  hasServerToken,
  liveKitUrlConfigured,
  connectionStatus,
  canPublish,
  needsMediaActivation,
  mediaError,
  participantCount,
  speakers,
  getParticipant,
  myIdentity,
  reconnectingIdentities,
}: {
  identityType: "profile" | "guest";
  isSpeaker: boolean;
  hasServerToken: boolean;
  liveKitUrlConfigured: boolean;
  connectionStatus: ConnectionStatus;
  canPublish: boolean;
  needsMediaActivation: boolean;
  mediaError: MediaError;
  participantCount: number;
  /**
   * Media rendering bugfix pass: added so this panel can show, per seat,
   * exactly which fields `SpeakerTile`/`SpeakerStage`'s own render
   * branch actually reads — real-device reports of a stale camera
   * preview or a missing audio-only visualizer are otherwise
   * unreproducible in this environment (no camera/mic hardware) without
   * something exposing the live values a real device sees. Optional —
   * every existing caller/test that doesn't care about this section can
   * omit all four and see nothing added.
   */
  speakers?: EventSpeaker[];
  getParticipant?: (identity: string) => Participant | undefined;
  myIdentity?: string;
  reconnectingIdentities?: ReadonlySet<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  // Deliberately bypasses LiveKit entirely — calls getUserMedia directly,
  // from this button's own onClick (a real gesture), so a failure here
  // proves the problem is browser/OS-level permission, independent of
  // anything LiveKit-related.
  async function runRawMediaTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((track) => track.stop());
      setTestResult("SUCCESS — the browser granted camera + mic directly.");
    } catch (error) {
      const name = error instanceof Error ? error.name : String(error);
      setTestResult(`FAILED — ${name}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="shrink-0 border-t border-dashed border-amber-500 bg-amber-50 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-1.5 font-semibold"
      >
        <span>Temporary diagnostics (issue #15)</span>
        <span>{expanded ? "▲ Hide" : "▼ Show"}</span>
      </button>
      {expanded && (
        <div className="px-4 pb-3">
          <ul className="mb-3 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
            <li>Identity type: {identityType}</li>
            <li>Recognized as seated speaker: {String(isSpeaker)}</li>
            <li>Server issued a token: {String(hasServerToken)}</li>
            <li>LiveKit client URL configured: {String(liveKitUrlConfigured)}</li>
            <li>LiveKit connection status: {connectionStatus}</li>
            <li>Server grants canPublish: {String(canPublish)}</li>
            <li>Needs media-activation tap: {String(needsMediaActivation)}</li>
            <li>Participants connected: {participantCount}</li>
            <li>Media error: {mediaError ? `${mediaError.source}/${mediaError.reason}` : "none"}</li>
          </ul>
          <button
            type="button"
            onClick={() => void runRawMediaTest()}
            disabled={testing}
            className="rounded border border-amber-600 px-2 py-1 font-medium"
          >
            {testing ? "Testing…" : "Test camera/mic permission directly"}
          </button>
          {testResult && <p className="mt-2 font-medium">{testResult}</p>}
          {speakers && getParticipant && myIdentity && (
            <MediaRenderDebug
              speakers={speakers}
              getParticipant={getParticipant}
              myIdentity={myIdentity}
              reconnectingIdentities={reconnectingIdentities ?? new Set()}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * TEMPORARY — media rendering bugfix pass (real-device report): per-seat
 * dump of exactly what `SpeakerTile`/`SpeakerStage`'s own render branch
 * reads, so a real device can pin down which field is actually stale
 * without guessing. Remove once the two reported bugs (stale camera
 * preview immediately after joining, missing audio-only visualizer) are
 * confirmed fixed on a real device — see SESSION_LOG.md/DECISIONS.md.
 */
function MediaRenderDebug({
  speakers,
  getParticipant,
  myIdentity,
  reconnectingIdentities,
}: {
  speakers: EventSpeaker[];
  getParticipant: (identity: string) => Participant | undefined;
  myIdentity: string;
  reconnectingIdentities: ReadonlySet<string>;
}) {
  return (
    <div className="mt-3 border-t border-dashed border-amber-600 pt-2">
      <p className="mb-1 font-semibold">MEDIA RENDER DEBUG</p>
      {[1, 2].map((seatNumber) => {
        const seat = speakers.find((s) => s.seat_number === seatNumber) ?? null;
        if (!seat) return <p key={seatNumber}>Seat {seatNumber}: empty</p>;
        const identity = getParticipantIdentity(
          seat.profile_id ? { type: "profile", id: seat.profile_id } : { type: "guest", id: seat.guest_id! },
        );
        const isLocal = identity === myIdentity;
        const participant = getParticipant(identity);
        const cameraPub = participant?.getTrackPublication(Track.Source.Camera);
        const micPub = participant?.getTrackPublication(Track.Source.Microphone);
        const media = deriveParticipantMediaState(participant);
        const isInactive = reconnectingIdentities.has(identity);
        const renderBranch = isLocal
          ? media.hasVideo || media.hasAudio
            ? "own-seat-live (neutral text, see corner slot)"
            : isInactive
              ? "inactive"
              : "placeholder"
          : media.hasVideo
            ? "video"
            : isInactive
              ? "inactive"
              : media.hasAudio
                ? "visualizer"
                : "placeholder";
        return (
          <ul key={seatNumber} className="mb-2 grid grid-cols-1 gap-x-4 sm:grid-cols-2">
            <li className="sm:col-span-2 font-medium">
              Seat {seatNumber} — {isLocal ? "LOCAL" : "remote"} — identity: {identity}
            </li>
            <li>Participant sid: {participant?.sid ?? "none"}</li>
            <li>Camera publication exists: {String(Boolean(cameraPub))}</li>
            <li>Camera subscribed: {String(Boolean(cameraPub?.isSubscribed))}</li>
            <li>Camera muted: {String(cameraPub?.isMuted ?? "n/a")}</li>
            <li>Camera track sid: {cameraPub?.trackSid ?? "none"}</li>
            <li>Audio publication exists: {String(Boolean(micPub))}</li>
            <li>Audio subscribed: {String(Boolean(micPub?.isSubscribed))}</li>
            <li>Audio muted: {String(micPub?.isMuted ?? "n/a")}</li>
            <li>Audio track sid: {micPub?.trackSid ?? "none"}</li>
            <li>hasVideo: {String(media.hasVideo)}</li>
            <li>hasAudio: {String(media.hasAudio)}</li>
            <li>inactive: {String(isInactive)}</li>
            <li className="sm:col-span-2">Render branch: {renderBranch}</li>
          </ul>
        );
      })}
    </div>
  );
}
