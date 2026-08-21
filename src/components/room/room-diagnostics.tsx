"use client";

import { useState } from "react";
import type { ConnectionStatus, MediaError } from "@/hooks/use-live-room-connection";

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
        </div>
      )}
    </div>
  );
}
