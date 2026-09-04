"use client";

import { Button } from "@/components/ui/button";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";

/**
 * Media Readiness pass (issue #21), Sections 3/6/8/9. Shown exactly once,
 * for exactly one reason: the RTS/auto-promotion countdown
 * (`useAutomaticPromotion`) has reached zero for this candidate but
 * `claimOpenSeat` is deliberately being withheld — see that hook's own
 * doc comment — until camera *and* microphone both report ready. This is
 * the "READY TO SPEAK?" gate Section 3 asks for: point-of-use only (never
 * shown to plain audience, never shown before a real candidacy exists),
 * and — once both devices report ready — this component simply stops
 * being rendered; the claim that was already gated on that same
 * readiness fires on its own the very next tick, no extra confirmation
 * step of its own (Section 10).
 *
 * Two render contexts share this one component rather than each growing
 * their own copy of the same per-device status logic:
 * - `compact` (desktop `RoomControls`, inline in its existing pending-
 *   candidate block, replacing "Going live in 0…" for this one instant).
 * - default (`PortraitRoom`/`MobileLandscapeRoom`'s center-stage overlay
 *   slot, in place of `CountdownOverlay`, once countdown hits 0).
 *
 * Device rows use the same three device-error reasons `mediaErrorMessage`
 * (room-controls.tsx) already classifies from — this is deliberately a
 * *different*, shorter presentation (a status word per device, not a full
 * sentence) since Section 9 asks for "simple, not a full Zoom-style
 * settings screen," but they name the same underlying reasons and never
 * surface a raw browser error string.
 */
function deviceStatus(
  device: MediaReadinessState["camera"],
  acquiring: boolean,
): { label: string; ok: boolean } {
  if (device.ready) return { label: "Ready", ok: true };
  if (acquiring) return { label: "Checking…", ok: false };
  switch (device.error) {
    case "permission-denied":
      return { label: "Needs permission", ok: false };
    case "no-device":
      return { label: "Not available", ok: false };
    case "device-unavailable":
      return { label: "In use elsewhere", ok: false };
    case "init-failed":
      return { label: "Couldn't start", ok: false };
    default:
      return { label: "Not checked yet", ok: false };
  }
}

function DeviceRow({
  name,
  status,
  mutedClass,
}: {
  name: string;
  status: { label: string; ok: boolean };
  mutedClass: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className={mutedClass}>{name}</span>
      <span className={status.ok ? "font-medium text-emerald-500" : mutedClass}>
        {status.ok ? "✓ " : ""}
        {status.label}
      </span>
    </div>
  );
}

export function StageReadinessPrompt({
  mediaReadiness,
  acquiringMedia,
  onPrepareMedia,
  onCancel,
  compact = false,
}: {
  mediaReadiness: MediaReadinessState;
  acquiringMedia: boolean;
  onPrepareMedia: () => Promise<MediaReadinessState>;
  onCancel: () => void;
  compact?: boolean;
}) {
  const cameraStatus = deviceStatus(mediaReadiness.camera, acquiringMedia);
  const micStatus = deviceStatus(mediaReadiness.microphone, acquiringMedia);
  // Neither device has ever actually been attempted (both null-error,
  // both not-ready, not currently acquiring): this is the very first
  // "Ready to speak?" prompt, before the candidate has tapped anything.
  // Distinct from a *failed* attempt below, which needs "Try again" copy
  // and, for a permission denial specifically, a settings hint (Section
  // 6/8) instead.
  const neverAttempted = !acquiringMedia && mediaReadiness.camera.error === null && mediaReadiness.microphone.error === null;
  const hasFailure = !acquiringMedia && (mediaReadiness.camera.error !== null || mediaReadiness.microphone.error !== null);
  const permissionBlocked =
    mediaReadiness.camera.error === "permission-denied" || mediaReadiness.microphone.error === "permission-denied";

  function handleTap() {
    // Called directly from this click — the real user gesture Safari
    // requires, same requirement `activateMedia`/`onPrepareMedia` are
    // already called from elsewhere in this codebase.
    void onPrepareMedia();
  }

  const headingClass = compact ? "text-sm font-medium" : "text-sm font-medium text-white";
  const mutedClass = compact ? "text-muted" : "text-white/70";
  const boxClass = compact ? "bg-muted/50" : "bg-black/30";
  const hintClass = compact ? "text-xs text-muted" : "text-xs text-white/60";

  const body = (
    <>
      <p className={headingClass}>{hasFailure ? "Camera & microphone required" : "Ready to speak?"}</p>
      {!neverAttempted && (
        <div className={`flex flex-col gap-1 rounded-md px-3 py-2 ${boxClass}`}>
          <DeviceRow name="Camera" status={cameraStatus} mutedClass={mutedClass} />
          <DeviceRow name="Microphone" status={micStatus} mutedClass={mutedClass} />
        </div>
      )}
      {hasFailure && (
        <p className={hintClass}>
          {permissionBlocked
            ? "Check your browser's site settings to allow camera and microphone access, then try again."
            : "Try again, or check that no other app is using your camera or microphone."}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={handleTap} disabled={acquiringMedia}>
          {acquiringMedia ? "Checking…" : hasFailure ? "Try again" : "Enable camera & microphone"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={acquiringMedia}>
          Not now
        </Button>
      </div>
    </>
  );

  if (compact) {
    return (
      <div data-testid="stage-readiness-prompt" className="flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
        {body}
      </div>
    );
  }

  return (
    <div
      data-testid="stage-readiness-prompt"
      className="pointer-events-auto flex w-[min(20rem,90vw)] flex-col gap-3 rounded-xl bg-black/70 p-4 text-center backdrop-blur"
    >
      {body}
    </div>
  );
}
