import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortraitRoom } from "./portrait-room";
import { MobileLandscapeRoom } from "./mobile-landscape-room";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";
import type { ReactionsController } from "@/hooks/use-stage-reactions";

/**
 * Issue #18 consistency fix (real-device report, 2026-08-24): "Speaker
 * View activates but the bottom controls remain the Audience row."
 * Investigation traced every source of "am I a speaker" in the room tree
 * (EventRoom's isSpeaker, SpeakerStage's own now-removed internal
 * re-derivation, the role routers) and found the composition and its
 * bottom row were already provably coupled to the same `isSpeaker` prop
 * within a single render — but `SpeakerStage` independently re-derived
 * its own copy of the same fact from raw speakers/myIdentity, a real
 * "second, separately-maintained source" architecture smell even though
 * no concrete divergence could be constructed against the pre-fix code.
 * See lib/participant-role.ts's own doc comment for the full writeup.
 *
 * This file is the transition-level regression coverage the fix asked
 * for: every render, across every tested transition, must show either
 * the full Speaker View treatment (mic/camera toggles, Leave the stage)
 * or the full Audience treatment (React/Vote emblems), never a mix of
 * the two, and never neither.
 *
 * **What this can and can't prove**: `PortraitRoom`/`MobileLandscapeRoom`
 * are presentation-only — real state (isSpeaker/mySeatNumber/
 * participantRole) lives in `EventRoom`, which has no dedicated test
 * file (an existing, accepted limitation — see SESSION_LOG.md). These
 * tests drive the same props `EventRoom` would compute via `rerender`,
 * which exercises the actual composition-swap/reconciliation React does
 * on a role change, but does not exercise EventRoom's own Realtime
 * subscription or the actual timing of a live promotion. "Rotation" is
 * approximated by rendering both orientation compositions with matching
 * props and comparing their control rows, not a single continuous
 * device rotation event.
 */

const { leaveSpeakerSeat, withdrawSpeakerRequest, submitSpeakerRequest, sendMessage } = vi.hoisted(() => ({
  leaveSpeakerSeat: vi.fn(),
  withdrawSpeakerRequest: vi.fn(),
  submitSpeakerRequest: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
  withdrawSpeakerRequest,
  submitSpeakerRequest,
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({
  sendMessage,
  addReaction: vi.fn(),
  setGuestName: vi.fn(),
}));

const MEDIA_READY: MediaReadinessState = { camera: { ready: true, error: null }, microphone: { ready: true, error: null } };
const MOCK_STAGE_REACTIONS: ReactionsController = {
  selectedEmoji: "❤️",
  setSelectedEmoji: vi.fn(),
  displayMode: "on-speaker",
  setDisplayMode: vi.fn(),
  showReactions: true,
  setShowReactions: vi.fn(),
  incoming: [],
  send: vi.fn(async () => ({ ok: true as const, heatAfter: 0, inCooldownAfter: false })),
  heat: 0,
  heatFraction: 0,
  inCooldown: false,
  canSend: true,
  myIdentity: "profile:p1",
};
const identity: Identity = { type: "profile", id: "p1", displayName: "Jamie", username: null };

const event: Event = {
  id: "e1",
  title: "Late Night Debate",
  description: "",
  scheduled_start: new Date().toISOString(),
  lobby_opens_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  format: "main_stage",
};

const audienceProps: RoomLayoutProps = {
  event,
  phase: "ready",
  countdownText: null,
  roomStatus: "live",
  speakers: [],
  myIdentity: "profile:p1",
  identity,
  isSpeaker: false,
  mySeatNumber: null,
  participantRole: "audience",
  myInactiveSince: null,
  hasPendingRequest: false,
  onHasPendingRequestChange: vi.fn(),
  promotionCountdown: null,
  onCancelPromotion: vi.fn(),
  micRequestMode: false,
  onMicRequestModeChange: vi.fn(),
  onTapEmptySeat: vi.fn(),
  isJoiningSeat: false,
  joinSeatMessage: null,
  getParticipant: () => undefined,
  participantCount: 3,
  connectionStatus: "connected",
  canPublish: false,
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => MEDIA_READY),
  mediaError: null,
  mediaReadiness: MEDIA_READY,
  acquiringMedia: false,
  localVideoTrack: null,
  onPrepareMedia: vi.fn(async () => MEDIA_READY),
  reconnectingIdentities: new Set<string>(),
  messages: [],
  reactions: {},
  submitComment: vi.fn(),
  retryComment: vi.fn(),
  pendingRequests: [],
  profileDirectory: {},
  isPreviewBuild: false,
  simulatedGuestIds: new Set(),
  stageRound: null,
  onOpenRoomInfo: () => {},
  stageReactions: MOCK_STAGE_REACTIONS,
  microphoneMuted: false,
  cameraMuted: false,
  toggleMicrophone: vi.fn(async () => {}),
  toggleCamera: vi.fn(async () => {}),
};

const speakerProps: RoomLayoutProps = {
  ...audienceProps,
  speakers: [
    {
      id: "s1",
      event_id: "e1",
      profile_id: "p1",
      guest_id: null,
      seat_number: 1,
      display_name: "Jamie",
      joined_at: new Date().toISOString(),
      left_at: null,
      left_reason: null,
      disconnected_at: null,
      media_inactive_since: null,
      round_number: 1,
      round_started_at: new Date().toISOString(),
      round_ends_at: new Date(Date.now() + 60_000).toISOString(),
      round_phase: "active" as const,
      closing_ends_at: null,
    },
  ],
  isSpeaker: true,
  mySeatNumber: 1,
  participantRole: "speaker",
  canPublish: true,
};

/** Issue #18 UX finding: a candidate whose promotion countdown is actively running — still audience/candidate role-wise (isSpeaker is false, mySeatNumber is null), same as `audienceProps`, but with the center-stage countdown state layered on. */
const countingDownProps: RoomLayoutProps = {
  ...audienceProps,
  hasPendingRequest: true,
  participantRole: "candidate",
  promotionCountdown: 3,
};

/** Asserts the currently-rendered tree shows exactly one of the two mutually-exclusive control sets — never both, never neither. */
function expectExclusiveControlRow(expected: "speaker" | "audience") {
  const speakerMarkers = [
    screen.queryByTestId("speaker-mic-toggle"),
    screen.queryByTestId("speaker-camera-toggle"),
    screen.queryByRole("button", { name: /leave the stage/i }),
  ];
  const audienceMarkers = [screen.queryByTestId("watch-emoji-emblem"), screen.queryByTestId("watch-vote-emblem")];

  if (expected === "speaker") {
    for (const marker of speakerMarkers) expect(marker).toBeInTheDocument();
    for (const marker of audienceMarkers) expect(marker).not.toBeInTheDocument();
  } else {
    for (const marker of speakerMarkers) expect(marker).not.toBeInTheDocument();
    for (const marker of audienceMarkers) expect(marker).toBeInTheDocument();
  }
}

describe.each([
  { name: "PortraitRoom", Room: PortraitRoom },
  { name: "MobileLandscapeRoom", Room: MobileLandscapeRoom },
])("$name — role transition consistency (issue #18 fix)", ({ Room }) => {
  it("starts in Audience composition/controls when not a speaker", () => {
    render(<Room {...audienceProps} />);
    expectExclusiveControlRow("audience");
  });

  it("audience → successful promotion: composition and controls switch together, in the same resulting render", () => {
    const { rerender } = render(<Room {...audienceProps} />);
    expectExclusiveControlRow("audience");

    rerender(<Room {...speakerProps} />);
    expectExclusiveControlRow("speaker");
  });

  it("speaker → leave: Audience composition/controls restore", () => {
    const { rerender } = render(<Room {...speakerProps} />);
    expectExclusiveControlRow("speaker");

    rerender(<Room {...audienceProps} />);
    expectExclusiveControlRow("audience");
  });

  it("repeated join/leave cycles never leave a mixed or stale control row", () => {
    const { rerender } = render(<Room {...audienceProps} />);
    for (let i = 0; i < 5; i++) {
      rerender(<Room {...speakerProps} />);
      expectExclusiveControlRow("speaker");
      rerender(<Room {...audienceProps} />);
      expectExclusiveControlRow("audience");
    }
  });

  it("promotion while the composer has local state (mic-request mode already on) still ends in a fully consistent Speaker View — no leftover request-mode UI", () => {
    const { rerender } = render(<Room {...audienceProps} micRequestMode={true} />);
    expect(screen.getByPlaceholderText("What's your topic?")).toBeInTheDocument();

    // Speaker View doesn't read micRequestMode at all (a seated speaker
    // has no use for it) — this asserts that stale prop value doesn't
    // leak into or corrupt the post-promotion render.
    rerender(<Room {...speakerProps} micRequestMode={true} />);
    expectExclusiveControlRow("speaker");
    expect(screen.queryByPlaceholderText("What's your topic?")).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
  });

  it("no render ever shows both Speaker View's mic/camera toggles and the Audience React/Vote emblems at once", () => {
    for (const props of [audienceProps, speakerProps]) {
      const { unmount } = render(<Room {...props} />);
      const hasSpeakerMarker = Boolean(screen.queryByTestId("speaker-mic-toggle"));
      const hasAudienceMarker = Boolean(screen.queryByTestId("watch-emoji-emblem"));
      expect(hasSpeakerMarker && hasAudienceMarker).toBe(false);
      expect(hasSpeakerMarker || hasAudienceMarker).toBe(true);
      unmount();
    }
  });

  describe("countdown → speaker / countdown → cancel (issue #18 UX finding — center-stage 'Going live' transition)", () => {
    it("while counting down, the countdown overlay dominates — neither control row is visible", () => {
      render(<Room {...countingDownProps} />);
      expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();
      expect(screen.queryByTestId("speaker-mic-toggle")).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
    });

    it("countdown → speaker: promotion completing swaps directly into Speaker View/controls, in the same resulting render — the countdown never survives alongside it", () => {
      const { rerender } = render(<Room {...countingDownProps} />);
      expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();

      // The real transition: isSpeaker flips true and useAutomaticPromotion
      // resets promotionCountdown to null in the same state update this
      // simulates — see useAutomaticPromotion's own claimOpenSeat.then().
      rerender(<Room {...speakerProps} />);
      expect(screen.queryByTestId("countdown-overlay")).not.toBeInTheDocument();
      expectExclusiveControlRow("speaker");
    });

    it("countdown → cancel: cancelling clears the countdown and restores the ordinary Audience/Candidate state, with no stale countdown left behind", () => {
      const { rerender } = render(<Room {...countingDownProps} />);
      expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();

      // The real transition: onCancelPromotion sets promotionCountdown to
      // null synchronously (see useAutomaticPromotion's own cancel()) —
      // simulated here by rerendering with the plain audience props.
      rerender(<Room {...audienceProps} />);
      expect(screen.queryByTestId("countdown-overlay")).not.toBeInTheDocument();
      expectExclusiveControlRow("audience");
    });

    it("no render ever shows the countdown overlay together with either control row", () => {
      for (const props of [audienceProps, speakerProps, countingDownProps]) {
        const { unmount } = render(<Room {...props} />);
        const hasCountdown = Boolean(screen.queryByTestId("countdown-overlay"));
        const hasSpeakerMarker = Boolean(screen.queryByTestId("speaker-mic-toggle"));
        const hasAudienceMarker = Boolean(screen.queryByTestId("watch-emoji-emblem"));
        expect(hasCountdown && (hasSpeakerMarker || hasAudienceMarker)).toBe(false);
        unmount();
      }
    });
  });
});

describe("rotation during/after promotion (issue #18 fix — approximated, see this file's own doc comment)", () => {
  it("PortraitRoom and MobileLandscapeRoom agree on the control row for the same speaker props", () => {
    const { unmount: unmountPortrait } = render(<PortraitRoom {...speakerProps} />);
    expectExclusiveControlRow("speaker");
    unmountPortrait();

    render(<MobileLandscapeRoom {...speakerProps} />);
    expectExclusiveControlRow("speaker");
  });

  it("PortraitRoom and MobileLandscapeRoom agree on the control row for the same audience props", () => {
    const { unmount: unmountPortrait } = render(<PortraitRoom {...audienceProps} />);
    expectExclusiveControlRow("audience");
    unmountPortrait();

    render(<MobileLandscapeRoom {...audienceProps} />);
    expectExclusiveControlRow("audience");
  });

  it("rotating mid-promotion (audience in portrait, then speaker in landscape) lands in a fully consistent Speaker View", () => {
    const { unmount: unmountPortrait } = render(<PortraitRoom {...audienceProps} />);
    expectExclusiveControlRow("audience");
    unmountPortrait();

    render(<MobileLandscapeRoom {...speakerProps} />);
    expectExclusiveControlRow("speaker");
  });
});

describe.each([
  { name: "PortraitRoom", Room: PortraitRoom },
  { name: "MobileLandscapeRoom", Room: MobileLandscapeRoom },
])("$name — no pre-countdown candidate UI flash (issue #18 UX finding fix)", ({ Room }) => {
  /**
   * Real-device report: right before the center-stage countdown appears,
   * the old "Request sent / Cancel / normal composer / controls /
   * ambient comment" UI briefly showed. Root cause traced to
   * `useAutomaticPromotion`'s claim-success handler resetting
   * `hasPendingRequest`/`countdown` itself, racing the independent
   * Realtime push that flips `isSpeaker` true — when the reset won that
   * race, this composition fell back to plain Watch Mode for a frame
   * before `isSpeaker` caught up. Fixed by no longer resetting either on
   * success — the countdown instead stays frozen (e.g. at 0) until
   * `isSpeaker` itself flips true, at which point the whole composition
   * swaps away to Speaker View atomically (see the describe.each block
   * above). This block asserts the "frozen" state itself never falls
   * back to candidate UI.
   */
  it("promotionCountdown frozen at 0 (claim resolved, isSpeaker not yet flipped) still shows the countdown takeover — never falls back to the Request-sent/composer/ambient-comments UI", () => {
    render(<Room {...countingDownProps} promotionCountdown={0} />);
    expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();
    expect(screen.queryByText("Request sent")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
  });

  it("the exact described sequence — counting down, frozen at 0, then isSpeaker flips — never shows candidate UI at any step", () => {
    const { rerender } = render(<Room {...countingDownProps} promotionCountdown={3} />);
    expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();

    rerender(<Room {...countingDownProps} promotionCountdown={0} />);
    expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();
    expect(screen.queryByText("Request sent")).not.toBeInTheDocument();

    rerender(<Room {...speakerProps} />);
    expect(screen.queryByTestId("countdown-overlay")).not.toBeInTheDocument();
    expectExclusiveControlRow("speaker");
  });
});
