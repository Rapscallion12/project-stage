import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileLandscapeRoom } from "./mobile-landscape-room";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

const { leaveSpeakerSeat, withdrawSpeakerRequest, submitSpeakerRequest, sendMessage, addReaction } = vi.hoisted(
  () => ({
    leaveSpeakerSeat: vi.fn(),
    withdrawSpeakerRequest: vi.fn(),
    submitSpeakerRequest: vi.fn(),
    sendMessage: vi.fn(),
    addReaction: vi.fn(),
  }),
);

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
  withdrawSpeakerRequest,
  submitSpeakerRequest,
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({
  sendMessage,
  addReaction,
  setGuestName: vi.fn(),
}));

Element.prototype.scrollTo = vi.fn();

const identity: Identity = { type: "profile", id: "p1", displayName: "Jamie" };

const event: Event = {
  id: "e1",
  title: "Late Night Debate",
  description: "",
  scheduled_start: new Date().toISOString(),
  lobby_opens_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  format: "main_stage",
};

const baseProps: RoomLayoutProps = {
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
  activateMedia: vi.fn(async () => {}),
  mediaError: null,
  localVideoTrack: null,
  onPrepareMedia: vi.fn(async () => {}),
  reconnectingIdentities: new Set<string>(),
  messages: [],
  reactions: {},
  pendingRequests: [],
  isPreviewBuild: false,
  microphoneMuted: false,
  cameraMuted: false,
  toggleMicrophone: vi.fn(async () => {}),
  toggleCamera: vi.fn(async () => {}),
};

describe("MobileLandscapeRoom (real-device finding: a phone rotated sideways is not a small desktop)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps the video-first overlay philosophy — chat/controls layer over the stage, not beside it (no sidebar)", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    const stage = screen.getByTestId("room-stage");
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.className).toMatch(/\babsolute\b/);
    expect(stage.parentElement).toBe(overlay.parentElement);
  });

  it("lays the two seats out side by side (landscape), not stacked — two-speaker audience viewing unchanged", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bw-2\b/);
  });

  it("tapping an empty seat tile still calls onTapEmptySeat", () => {
    const onTapEmptySeat = vi.fn();
    render(<MobileLandscapeRoom {...baseProps} onTapEmptySeat={onTapEmptySeat} />);
    fireEvent.click(screen.getAllByTestId("empty-seat")[0]);
    expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
  });

  it("the bottom overlay's decorative margin is click-through, same as PortraitRoom", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.className).toMatch(/\bpointer-events-none\b/);
    expect((overlay.firstElementChild as HTMLElement).className).toMatch(/\bpointer-events-auto\b/);
  });

  it("opts out of StageOverlayShell's heavy gradient wash, same as PortraitRoom", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    expect(screen.getByTestId("stage-bottom-overlay").className).not.toMatch(/\bfrom-black\/90\b/);
  });

  it("SpeakerStage never receives a darkened scrim — no Comments Mode left to darken it for", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
  });

  describe("minimal top chrome — same SpeakerViewTopChrome as Speaker View (issue #21, Social Stage adaptation)", () => {
    it("shows a compact status pill with the event title", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      expect(screen.getByTestId("watch-status-pill")).toHaveTextContent("Late Night Debate");
    });

    it("reserves SelfPreview's own responsive footprint on the right — same fix as Speaker View, matters here too for a candidate's self-preview", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const row = screen.getByTestId("watch-status-pill").parentElement as HTMLElement;
      expect(row.className).toMatch(/\bpr-20\b/);
    });

    it("shows the guest identity chip for a guest, not for an account holder", () => {
      const { rerender } = render(
        <MobileLandscapeRoom {...baseProps} identity={{ type: "guest", id: "g1", displayName: "Cheerful Raven" }} />,
      );
      expect(screen.getByRole("button", { name: "Cheerful Raven" })).toBeInTheDocument();

      rerender(<MobileLandscapeRoom {...baseProps} identity={identity} />);
      expect(screen.queryByRole("button", { name: /cheerful raven/i })).not.toBeInTheDocument();
    });
  });

  describe("legacy audience chrome is gone (issue #21, real-device finding: rotating to landscape reverted to the pre-05 interface)", () => {
    it("no RoomHeader-style heading, no Comments toggle — the persistent compact composer is a real input, not the old modal RoomChatPanel", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      expect(screen.queryByRole("heading", { name: "Late Night Debate" })).not.toBeInTheDocument();
      expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
      // Exactly one textbox (the compact composer) — never the old
      // RoomChatPanel's message-history + quick-emoji layout.
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
      expect(screen.queryByLabelText(/^Insert /)).not.toBeInTheDocument();
    });

    it("no room-header-overlay wrapper — SpeakerViewTopChrome replaces it entirely", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      expect(screen.queryByTestId("room-header-overlay")).not.toBeInTheDocument();
    });
  });

  describe("persistent composer, always available — no modal Comments Mode gate (issue #21, Social Stage model)", () => {
    it("renders a real, focusable comment field immediately, no toggle required", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const input = screen.getByPlaceholderText("Add a comment…");
      expect(input).toBeInTheDocument();
      expect(input).not.toBeDisabled();
    });

    it("sending a comment calls the existing sendMessage action", async () => {
      sendMessage.mockResolvedValue(undefined);
      render(<MobileLandscapeRoom {...baseProps} />);
      fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hello from the audience" } });
      fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
      expect(submitSpeakerRequest).not.toHaveBeenCalled();
    });

    it("React/Vote/Gift stay inert, unchanged — no reactions/voting/gifting behavior added", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      expect(screen.getByTestId("watch-emoji-emblem")).toBeDisabled();
      expect(screen.getByTestId("watch-vote-emblem")).toBeDisabled();
      expect(screen.getByTestId("watch-gift-emblem")).toBeDisabled();
    });

    it("opening the composer never resizes, remounts, or reconnects SpeakerStage — same DOM node, same class list", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const stage = screen.getByTestId("room-stage");
      const stageClassBefore = stage.className;
      fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hi" } });
      expect(screen.getByTestId("room-stage")).toBe(stage);
      expect(stage.className).toBe(stageClassBefore);
    });

    it("no pointer/drag gesture infrastructure remains active on the stage wrapper", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const surface = screen.getByTestId("room-stage").parentElement as HTMLElement;
      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 260 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientY: 260 });
      expect(document.querySelector("[data-gesture-ignore]")).not.toBeInTheDocument();
    });
  });

  describe("ambient comments (issue #21, Social Stage adaptation — same AmbientComments/messages stream as portrait)", () => {
    it("renders a recent comment ambiently", () => {
      render(
        <MobileLandscapeRoom
          {...baseProps}
          messages={[
            {
              id: "m1",
              author_display_name: "Jamie",
              author_profile_id: "p1",
              author_guest_id: null,
              body: "great show",
              created_at: new Date().toISOString(),
              is_speaker_request: false,
            },
          ]}
        />,
      );
      expect(screen.getByTestId("ambient-comment")).toHaveTextContent("great show");
    });

    it("renders nothing when there are no messages yet", () => {
      render(<MobileLandscapeRoom {...baseProps} messages={[]} />);
      expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    });
  });

  describe("no separate 'Request sent' bar (issue #18 UX finding — matches PortraitRoom, the composer's own mic button carries the pending state)", () => {
    it("renders nothing extra for a plain audience member with no pending request", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      expect(screen.queryByRole("button", { name: /leave the stage/i })).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-composer-mic")).toHaveAccessibleName("Request to speak");
    });

    it("renders no standalone pending-request bar/pill — the mic button reflects the pending state instead", () => {
      render(<MobileLandscapeRoom {...baseProps} hasPendingRequest={true} />);
      expect(screen.queryByText("Request sent")).not.toBeInTheDocument();
      expect(screen.getByTestId("watch-composer-mic")).toHaveAccessibleName("Cancel speaker request");
    });

    it("tapping the pending mic button calls onCancelPromotion", () => {
      const onCancelPromotion = vi.fn();
      render(<MobileLandscapeRoom {...baseProps} hasPendingRequest={true} onCancelPromotion={onCancelPromotion} />);
      fireEvent.click(screen.getByTestId("watch-composer-mic"));
      expect(onCancelPromotion).toHaveBeenCalledTimes(1);
    });
  });

  it("surfaces a failed join attempt's message visibly", () => {
    render(<MobileLandscapeRoom {...baseProps} joinSeatMessage="Create an account to join as a speaker." />);
    expect(screen.getByText("Create an account to join as a speaker.")).toBeInTheDocument();
  });

  describe("center-stage 'Going live' countdown (issue #18 UX finding — same treatment as PortraitRoom, no legacy landscape UI)", () => {
    it("renders the countdown overlay instead of the ordinary bottom composer/controls once promotionCountdown is set", () => {
      render(<MobileLandscapeRoom {...baseProps} hasPendingRequest={true} promotionCountdown={3} />);
      expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();
      expect(screen.queryByTestId("stage-bottom-overlay")).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
    });

    it("hides ambient comments during the countdown too", () => {
      render(
        <MobileLandscapeRoom
          {...baseProps}
          hasPendingRequest={true}
          promotionCountdown={2}
          messages={[
            {
              id: "m1",
              author_display_name: "Jamie",
              author_profile_id: "p1",
              author_guest_id: null,
              body: "hi",
              created_at: new Date().toISOString(),
              is_speaker_request: false,
            },
          ]}
        />,
      );
      expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    });

    it("dims the stage behind the countdown via SpeakerStage's existing scrim mechanism", () => {
      render(<MobileLandscapeRoom {...baseProps} hasPendingRequest={true} promotionCountdown={3} />);
      expect(screen.getByTestId("room-scrim").style.opacity).not.toBe("0");
    });

    it("no scrim, ordinary composer, when promotionCountdown is null", () => {
      render(<MobileLandscapeRoom {...baseProps} hasPendingRequest={true} promotionCountdown={null} />);
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
      expect(screen.queryByTestId("countdown-overlay")).not.toBeInTheDocument();
      expect(screen.getByTestId("watch-composer-mic")).toHaveAccessibleName("Cancel speaker request");
    });

    it("preserves top chrome during the countdown — still the same room, not a separate page", () => {
      render(<MobileLandscapeRoom {...baseProps} hasPendingRequest={true} promotionCountdown={3} />);
      expect(screen.getByTestId("watch-status-pill")).toBeInTheDocument();
    });

    it("Cancel on the countdown overlay calls onCancelPromotion", () => {
      const onCancelPromotion = vi.fn();
      render(
        <MobileLandscapeRoom
          {...baseProps}
          hasPendingRequest={true}
          promotionCountdown={3}
          onCancelPromotion={onCancelPromotion}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancelPromotion).toHaveBeenCalledTimes(1);
    });

    it("does not reintroduce the legacy site header or RoomHeader — still the minimal SpeakerViewTopChrome status pill only", () => {
      render(<MobileLandscapeRoom {...baseProps} hasPendingRequest={true} promotionCountdown={3} />);
      expect(screen.queryByRole("heading", { name: "Late Night Debate" })).not.toBeInTheDocument();
    });
  });

  describe("role router (issue #18, Speaker View corrective pass — rotating to landscape while seated no longer reverts to the audience composition)", () => {
    it("a seated speaker is routed to Speaker View instead of the ordinary audience landscape composition", () => {
      render(
        <MobileLandscapeRoom
          {...baseProps}
          isSpeaker={true}
          mySeatNumber={1}
          participantRole="speaker"
          canPublish={true}
        />,
      );
      expect(screen.getByTestId("room-scrim")).toBeInTheDocument();
      expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Late Night Debate" })).not.toBeInTheDocument();
      // Speaker View has its own leave control — untouched by this pass.
      expect(screen.getByRole("button", { name: /leave the stage/i })).toBeInTheDocument();
    });

    it("toggling isSpeaker/participantRole on the same mounted instance doesn't throw — no hooks of this component's own left to order around the branch", () => {
      const { rerender } = render(
        <MobileLandscapeRoom {...baseProps} isSpeaker={false} mySeatNumber={null} participantRole="audience" />,
      );
      expect(() =>
        rerender(<MobileLandscapeRoom {...baseProps} isSpeaker={true} mySeatNumber={1} participantRole="speaker" />),
      ).not.toThrow();
      expect(() =>
        rerender(<MobileLandscapeRoom {...baseProps} isSpeaker={false} mySeatNumber={null} participantRole="audience" />),
      ).not.toThrow();
    });
  });

  describe("Discussion Expanded (issue #21) — landscape audience compatibility", () => {
    it("tapping an ambient comment bubble opens the sheet", () => {
      const message: LobbyMessage = {
        id: "m1",
        author_display_name: "Jamie",
        author_profile_id: "p1",
        author_guest_id: null,
        body: "hello room",
        created_at: new Date().toISOString(),
        is_speaker_request: false,
      };
      render(<MobileLandscapeRoom {...baseProps} messages={[message]} />);
      fireEvent.click(screen.getByTestId("ambient-comment"));
      expect(screen.getByTestId("expanded-comments")).toBeInTheDocument();
    });
  });
});
