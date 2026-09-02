"use client";

import { useEffect, useRef } from "react";
import { Track, type Participant } from "livekit-client";
import { cn } from "@/lib/utils";
import { useReconnectCountdown } from "@/hooks/use-reconnect-countdown";
import { useSpeakerRoundCountdown } from "@/hooks/use-speaker-round-countdown";
import { inactiveSince } from "@/lib/speaker-presence";
import { ParticipantAvatar } from "@/components/room/participant-avatar";
import { ProfileLink } from "@/components/room/profile-link";
import type { MediaError } from "@/hooks/use-live-room-connection";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { Orientation } from "@/hooks/use-orientation";
import type { ProfileDirectoryEntry } from "@/hooks/use-profile-directory";

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
  isInactive: isInactiveProp = false,
  orientation = "landscape",
  clearTopChrome = false,
  isPreviewBuild = false,
  isSimulated = false,
  emptySeatState,
  profileEntry,
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
  /**
   * Issue #18 unified inactive-speaker finding: true while this seat's
   * occupant is inactive for *either* reason — a genuine LiveKit
   * disconnect (`disconnected_at`) or still connected but publishing no
   * usable media (`media_inactive_since`) — and the server-side grace
   * period hasn't yet expired. See `useSpeakerReconnectGrace`'s own doc
   * comment. Always false for the local viewer's own seat.
   *
   * **Not the sole source of truth** (issue #18 real-device finding,
   * 2026-08-25, generalized by the unified inactive-speaker finding): a
   * real-device retest found "Camera off" still showing during an active
   * grace period — traced to this prop being an *independently
   * re-derived* signal (via `reconnectingIdentities`, itself gated by
   * this tab's own `canConnect`) that could disagree with the seat's own
   * `inactiveSince(speaker)`, which this component already reads
   * directly for the countdown itself. This component now ORs the two
   * together (see `isInactive` below, the local const) so the seat's own
   * authoritative field always wins regardless of whatever the caller's
   * derived set says — "inactivity UI must take precedence over generic
   * media-off UI" is now true by construction from a single field, not
   * by keeping two independent derivations in sync by hand. Kept as a
   * prop (not removed) since `SpeakerStage`'s existing
   * `reconnectingIdentities` plumbing still does real scheduling work
   * (triggering the server-side eviction check) — only the *display*
   * decision no longer trusts it alone.
   *
   * Shown as "Speaker inactive…" (issue #18 audience-countdown finding:
   * with the remaining seconds, once known) instead of the generic
   * "Camera off", since the seat isn't lost, just temporarily inactive.
   * The audience never needs to know which of the two causes applies —
   * both read identically here, on purpose.
   */
  isInactive?: boolean;
  /**
   * Issue #21 (05 interaction model): portrait gets the new lightweight
   * top-anchored identity treatment (a small presence dot + name with a
   * drop-shadow, no background bar) — landscape keeps today's original
   * bottom-gradient name label completely unchanged. Landscape's own
   * `RoomHeader`-as-overlay already occupies the top of both tiles (they
   * sit side by side, both starting at y=0), so moving the label there
   * would collide with it; that's out of scope for this pass ("no
   * landscape redesign beyond avoiding regressions" — see DECISIONS.md).
   * Optional, defaulting to `"landscape"` (today's original treatment) —
   * the one real caller, `SpeakerStage`, always passes this explicitly;
   * the default only matters for tests that don't care which identity
   * treatment renders.
   */
  orientation?: Orientation;
  /** Only meaningful in portrait: true for whichever tile renders visually first (seat 1, or the promoted-open-seat's sibling when reordered) — offsets the identity label below the room's own top-chrome status pill/guest chip so they don't overlap. The second tile has nothing above it and needs no offset. */
  clearTopChrome?: boolean;
  /** Issue #21, Part 1: computed server-side (`isPreviewOrDevBuild()`) and threaded down unchanged — see lib/preview-mode.ts. Governs only whether the round timer badge below reveals early (full-round, for testing) or waits for the real product's final-~10s window; never changes the deadline itself. */
  isPreviewBuild?: boolean;
  /**
   * Session Simulator real-device follow-up: true when this occupied
   * seat's `guest_id` is one the simulator generated in this browser tab
   * (see RoomLayoutProps' own doc comment). Purely cosmetic — swaps the
   * ordinary "Camera off" no-video placeholder for an unambiguous
   * "Simulated speaker" one, so it's never mistaken for a real technical
   * problem while testing. No fake LiveKit video, no change to `hasVideo`/
   * `participant` handling — a simulated identity never actually connects
   * to LiveKit, so it always falls through to the same no-video branch a
   * real speaker who hasn't turned their camera on would; this only
   * changes what that branch says.
   */
  isSimulated?: boolean;
  /**
   * Issue #21, fifth/sixth corrective passes: which of four established-
   * stage empty-seat states this tile is in — only meaningful when
   * `speaker` is null and the stage has ever achieved its initial
   * pairing (see `SpeakerStage`'s own `established` doc comment).
   * Undefined for a never-established stage's ordinary "Seat open"/
   * tap-to-join tile.
   * - `"joining"`: a candidate has already been reserved for *this*
   *   seat (selection is done — only their own Going Live countdown/
   *   seat claim remains) — issue #21, sixth corrective pass, Section
   *   14: real-device testing found "Selecting next speaker…" staying
   *   on screen through the entire intentional countdown even after
   *   selection had already succeeded, reading as stuck. Non-
   *   interactive.
   * - `"selecting"`: at least one eligible Request-to-Speak candidate
   *   exists, but none is reserved for *this* seat yet — an active,
   *   short-lived transition, not a passive wait. Non-interactive;
   *   `onTapEmptySeat` is never wired for this case.
   * - `"waiting"`: established, empty, but nobody is currently eligible
   *   to select (and the small-room fallback below doesn't apply to
   *   *this* viewer right now) — accurately communicates there's
   *   genuinely nobody to select, per explicit instruction not to show
   *   "Selecting next speaker…" when there's nobody to select.
   *   Non-interactive.
   * - `"fallback-open"`: both seats are empty, there are zero eligible
   *   requests, and this viewer isn't excluded (Section 8-15's
   *   small-room recovery mode) — tappable, same `onTapEmptySeat` prop
   *   the never-established case already uses (the server-side handler
   *   itself now covers both cases — see `joinOpenSeat`).
   */
  emptySeatState?: "joining" | "selecting" | "waiting" | "fallback-open";
  /** Issue #29: this seat's occupant's own public profile, if `speaker.profile_id` has one — see `useProfileDirectory`'s own doc comment. Undefined for a guest, a simulated identity, or an account that hasn't chosen a username yet; every one of those keeps today's exact non-navigable, initials-only avatar. */
  profileEntry?: ProfileDirectoryEntry;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);

  // Issue #18 audience-countdown finding, broadened by the unified
  // inactive-speaker finding: the *same* authoritative deadline this
  // seat's own row already carries (whichever of disconnected_at/
  // media_inactive_since is set — already flowing through the same
  // Realtime-subscribed `speakers` state the returning speaker's own
  // "Tap to reconnect · Ns"/"Resume speaking · Ns" prompt reads from) —
  // never a second, independently-started timer. `useReconnectCountdown`
  // returns null (no suffix) whenever there's nothing to count down, so
  // passing it unconditionally here is safe regardless of `isInactive`.
  const mySeatInactiveSince = inactiveSince(speaker);
  const reconnectSecondsRemaining = useReconnectCountdown(mySeatInactiveSince);

  // Issue #18 real-device finding (2026-08-25), generalized by the
  // unified inactive-speaker finding: ORs the caller's own derived
  // signal with the seat's own authoritative field directly — see the
  // isInactive prop's own doc comment above for why the two could
  // disagree and why this field must win. Only ever adds true, never
  // suppresses a true the caller already passed.
  const isInactive = isInactiveProp || mySeatInactiveSince !== null;

  // Issue #21, Part 1: the same "read the row's own authoritative
  // deadline, never invent a fresh one" discipline as
  // reconnectSecondsRemaining above — null whenever there's nothing to
  // show (no speaker, or the real product's reveal window hasn't been
  // reached yet).
  const roundDisplay = useSpeakerRoundCountdown(speaker, isPreviewBuild);

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
    //
    // Issue #21, fifth corrective pass: `onTapEmptySeat` being wired at
    // all now means one of *two* legitimate direct-join cases — a
    // never-established stage's ordinary first-come opening, or the
    // small-room fallback (`emptySeatState === "fallback-open"`) — both
    // say the same thing to the viewer and both go through the same
    // server-side handler, so one tappable button covers both.
    if (onTapEmptySeat) {
      return (
        <button
          type="button"
          data-testid="empty-seat"
          onClick={onTapEmptySeat}
          disabled={isJoiningSeat}
          className="flex h-full w-full flex-col items-center justify-center gap-1 border border-dashed border-border bg-foreground/[0.02] text-muted transition-colors hover:bg-accent/5 hover:text-accent disabled:opacity-60"
        >
          <p className="text-sm font-medium">
            {isJoiningSeat ? "Joining…" : emptySeatState === "fallback-open" ? "Stage open" : "Seat open"}
          </p>
          {!isJoiningSeat && <p className="text-xs">Tap to join</p>}
        </button>
      );
    }
    // Issue #21, third/fifth corrective passes: past initial stage
    // formation, an empty seat is tappable again only in the narrow
    // fallback case above — every other established-stage empty seat is
    // a plain, non-interactive status, never a disabled-looking CTA, so
    // it never reads as "you could tap this if only X." Section 2's
    // explicit distinction: "Selecting next speaker…" only when there's
    // actually somebody eligible to select — otherwise "Waiting for
    // speaker requests…", never the other way around.
    return (
      <div
        data-testid="empty-seat"
        className="flex h-full w-full flex-col items-center justify-center gap-1 border border-dashed border-border bg-foreground/[0.02] text-muted"
      >
        <p className="text-sm font-medium">
          {emptySeatState === "joining"
            ? "Joining…"
            : emptySeatState === "selecting"
              ? "Selecting next speaker…"
              : emptySeatState === "waiting"
                ? "Waiting for speaker requests…"
                : "Seat open"}
        </p>
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
          <ParticipantAvatar name={speaker.display_name} size="md" className="bg-accent/20" />
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
          <ProfileLink username={profileEntry?.username ?? null} ariaLabel={`${speaker.display_name}'s profile`}>
            <ParticipantAvatar name={speaker.display_name} imageUrl={profileEntry?.avatarUrl} size="md" />
          </ProfileLink>
          <p className="px-4 text-center text-xs">You&apos;re live — see your preview in the corner</p>
        </div>
      ) : isInactive ? (
        <div
          data-testid="speaker-inactive"
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted"
        >
          <ProfileLink username={profileEntry?.username ?? null} ariaLabel={`${speaker.display_name}'s profile`}>
            <ParticipantAvatar name={speaker.display_name} imageUrl={profileEntry?.avatarUrl} size="md" />
          </ProfileLink>
          <p className="text-xs" data-testid="audience-inactive-countdown">
            {reconnectSecondsRemaining === 0
              ? // Issue #18 expiration-enforcement finding: never a stuck
                // "· 0s" here either — authoritative expiration is being
                // confirmed (the seat's own occupant already triggers
                // this; see useOwnSeatExpirationConfirmation), and this
                // tile has nothing further to decide either way.
                "Speaker inactive — resolving…"
              : `Speaker inactive${reconnectSecondsRemaining !== null ? ` · ${reconnectSecondsRemaining}s` : "…"}`}
          </p>
        </div>
      ) : isSimulated ? (
        <div
          data-testid="simulated-speaker-placeholder"
          className="flex h-full w-full flex-col items-center justify-center gap-2 border-2 border-dashed border-accent/40 bg-accent/5 text-accent"
        >
          <ParticipantAvatar name={speaker.display_name} size="md" className="bg-accent/20" />
          <p className="text-xs font-medium" data-testid="simulated-speaker-label">
            Simulated speaker
          </p>
        </div>
      ) : (
        <div
          data-testid="no-video-placeholder"
          className="flex h-full w-full flex-col items-center justify-center gap-2 text-muted"
        >
          <ProfileLink username={profileEntry?.username ?? null} ariaLabel={`${speaker.display_name}'s profile`}>
            <ParticipantAvatar name={speaker.display_name} imageUrl={profileEntry?.avatarUrl} size="md" />
          </ProfileLink>
          <p className="text-xs">{isLocal && mediaError ? mediaErrorShortLabel(mediaError) : "Camera off"}</p>
        </div>
      )}
      {!isLocal && <audio ref={audioRef} autoPlay />}
      {orientation === "portrait" ? (
        <div
          data-testid="speaker-identity"
          className={cn("absolute left-3 flex items-center gap-1.5", clearTopChrome ? "top-12" : "top-3")}
        >
          <span
            aria-hidden="true"
            className="h-[7px] w-[7px] shrink-0 rounded-full bg-emerald-400 [filter:drop-shadow(0_1px_2px_rgb(0_0_0/0.65))]"
          />
          <p className="truncate text-sm font-semibold text-white [text-shadow:0_1px_4px_rgb(0_0_0/0.65)]">
            {speaker.display_name}
            {isLocal ? " (you)" : ""}
          </p>
          {roundDisplay && <SpeakerRoundBadge display={roundDisplay} />}
        </div>
      ) : (
        <div className="absolute inset-x-0 bottom-0 flex items-center gap-1.5 bg-gradient-to-t from-black/70 to-transparent px-3 py-2">
          <p className="truncate text-sm font-medium text-white">
            {speaker.display_name}
            {isLocal ? " (you)" : ""}
          </p>
          {roundDisplay && <SpeakerRoundBadge display={roundDisplay} />}
        </div>
      )}
    </div>
  );
}

/**
 * Issue #21 corrective pass: an *individual* seat's own round badge —
 * narrowed to the narrow-loss closing window only, since the ordinary
 * shared countdown now renders exactly once, at the stage level
 * (`SpeakerStage`'s `StageRoundBadge`), never per-tile. Deliberately
 * tiny and neutral (no color-shift/pulse here; that emphasis
 * intensification is the Vote *control*'s job per Part 2/H, not this
 * identity-area badge). "Final Ns" since this is a guaranteed-outcome
 * grace window, not another survival round.
 */
function SpeakerRoundBadge({ display }: { display: { remainingSeconds: number; phase: "closing" } }) {
  return (
    <span
      data-testid="speaker-round-timer"
      className="shrink-0 rounded-full bg-black/40 px-1.5 py-0.5 text-[10px] font-medium text-white/80 [text-shadow:none]"
    >
      Final {display.remainingSeconds}s
    </span>
  );
}
