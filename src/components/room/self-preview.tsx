"use client";

import { useEffect, useRef } from "react";
import type { LocalVideoTrack } from "livekit-client";
import { cn } from "@/lib/utils";
import { OnSpeakerReactionBursts } from "@/components/room/stage-reactions-overlay";
import type { IncomingStageReaction } from "@/hooks/use-stage-reactions";

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
 * without ever being re-acquired).
 *
 * **This component itself is NOT guaranteed to stay mounted at one call
 * site** (media rendering bugfix pass, real-device report): the Media
 * Readiness pass (issue #21) made this the first case where a candidate's
 * `SelfPreview` genuinely mounts *before* promotion — inside
 * `PortraitRoom`/`MobileLandscapeRoom`'s own audience/candidate
 * composition's `SpeakerStage` — and the moment the seat claim lands and
 * the role router swaps to `PortraitSpeakerView`/
 * `MobileLandscapeSpeakerView`, an entirely different `SpeakerStage`
 * mounts with its own fresh `SelfPreview`/`<video>` element, calling
 * `attach()` a *second* time for the *same*, already-flowing track. Real-
 * device testing found this second attach can render a black/frozen
 * frame that only recovers once the camera is manually toggled off and
 * back on — which works only because `LocalVideoTrack.unmute()` for a
 * camera source fully stops and re-acquires the hardware track, then
 * calls `attachToElement()` fresh on every currently-attached element
 * (confirmed by reading `livekit-client`'s own `LocalVideoTrack.mute()`/
 * `unmute()`/`setMediaStreamTrack()` — `mute()` calls
 * `mediaStreamTrack.stop()`, `unmute()` reacquires via `restart()`). That
 * cure is a real hardware reacquisition, not something to trigger
 * automatically just to fix a paint glitch — `livekit-client`'s own
 * `attachToElement()` already carries an equivalent workaround for a
 * *documented*, similarly-flavored "renders black until something forces
 * a repaint" bug, but only for Safari/Firefox specifically (see its own
 * source comment referencing Safari 15). The repaint nudge below is the
 * same technique — reset `srcObject`, force a fresh decode — applied
 * unconditionally rather than browser-gated, since the exact trigger here
 * (an already-playing track reattached to a brand-new element moments
 * after being detached from another) is specific to *this* remount
 * pattern, not the general case `livekit-client`'s own per-browser
 * special-casing was written for. Harmless if the first attach already
 * painted correctly (Desktop, which has no role router and never hits
 * this remount at all) — resetting `srcObject` to the same stream and
 * replaying is a no-op glitch-wise when nothing was actually stuck.
 *
 * `key`ing on the track's own `sid` (stable once created) is what
 * guarantees React reuses the same element across *this* component's own
 * re-renders, when it does stay at one call site.
 *
 * **`onTap`** (mobile UX correction, live-user-test finding): a seated
 * speaker's own preview is the one persistent, always-visible anchor
 * regardless of `SpeakerStage`'s `soloMode` — tapping it is what
 * `PortraitSpeakerView`/`MobileLandscapeSpeakerView` wire to their own
 * local `soloMode`/normal-stage-view toggle (see those components' own
 * doc comments), letting a speaker see the room "the way the audience
 * sees it" — both speakers at normal size, incoming reactions readable —
 * without touching their seat, publications, or round/vote state at all.
 * This component itself has no opinion on what tapping *means*; it just
 * renders the tap target and a small affordance glyph when a handler is
 * given. Purely additive: every caller that doesn't pass `onTap` (the
 * ordinary pre-claim candidate self-preview, unaffected) renders exactly
 * as before, non-interactive.
 *
 * **`reactions`** (real-device report: "I still cannot see incoming
 * audience emoji reactions in the small speaker self-preview"): audited
 * end to end — this component simply never had a reaction overlay at
 * all (not a filtering bug; there was nothing here to filter). Audience
 * reactions targeting the local speaker already flow through the same
 * `stageReactions.incoming` array every other reaction render reads;
 * `SpeakerStage` (the one caller) is what filters that down to
 * "reactions whose `targetIdentity` is my own identity" and passes the
 * result here — this component itself still has no reaction-domain
 * knowledge, same presentation-only discipline as the rest of this file.
 * Rendered via the *same* `OnSpeakerReactionBursts` every full-size tile
 * already uses (never a second, bespoke overlay), `compact` for the tiny
 * preview's scale — normalized tap coordinates and self-echo suppression
 * are therefore both already correct by construction, inherited from
 * that shared component/hook rather than reimplemented here. Defaults to
 * empty, so every caller that doesn't care renders exactly as before.
 */
export function SelfPreview({
  track,
  onTap,
  reactions = [],
}: {
  track: LocalVideoTrack;
  /** When provided, the preview becomes a real tap target — see this component's own doc comment above `onTap`. */
  onTap?: () => void;
  /** See this component's own `reactions` doc comment above. */
  reactions?: IncomingStageReaction[];
}) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;
    track.attach(element);
    // See this component's own doc comment above: a fresh mount
    // reattaching an already-flowing track to a brand-new element can
    // paint black until something forces the browser to redecode. One
    // rAF tick is enough to be past the attach's own synchronous work
    // (including its own `element.play()` call) without being a
    // perceptible delay; resetting srcObject a second time is what
    // actually forces the repaint, not the delay itself.
    const raf = requestAnimationFrame(() => {
      if (videoRef.current !== element) return;
      const stream = element.srcObject;
      if (!stream) return;
      element.srcObject = null;
      element.srcObject = stream;
      void element.play().catch(() => {
        // Same tolerance attach() itself already applies to its own
        // play() call (see attachToElement in livekit-client) — a
        // rejected replay here is never a reason to surface an error.
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      track.detach(element);
    };
  }, [track]);

  return (
    <div
      data-testid="self-preview"
      onClick={onTap}
      role={onTap ? "button" : undefined}
      tabIndex={onTap ? 0 : undefined}
      onKeyDown={
        onTap
          ? (event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onTap();
              }
            }
          : undefined
      }
      aria-label={onTap ? "Switch stage view" : undefined}
      className={cn(
        "absolute top-3 right-3 h-24 w-16 overflow-hidden rounded-md border-2 border-accent bg-black shadow-lg sm:h-28 sm:w-20",
        onTap && "cursor-pointer",
      )}
    >
      {/* Muted: this is the local camera's own preview, played back to the
          person it belongs to — never their own mic, same reasoning as
          SpeakerTile's local video element. */}
      <video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
      {reactions.length > 0 && <OnSpeakerReactionBursts reactions={reactions} compact />}
      {/* Discoverability affordance (Section 11: "should not rely only on
          an invisible gesture") — a small, unobtrusive expand glyph, never
          a label large enough to clutter the tiny preview. */}
      {onTap && (
        <span
          aria-hidden="true"
          data-testid="self-preview-expand-affordance"
          className="absolute top-0.5 right-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/60 text-[9px] leading-none text-white"
        >
          ⤢
        </span>
      )}
      <span className="absolute bottom-0.5 left-0.5 rounded bg-black/60 px-1 text-[10px] font-medium leading-tight text-white">
        You
      </span>
    </div>
  );
}
