import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortraitRoom } from "./portrait-room";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

const { leaveSpeakerSeat, withdrawSpeakerRequest, submitSpeakerRequest, sendMessage, addReaction, setGuestName } =
  vi.hoisted(() => ({
    leaveSpeakerSeat: vi.fn(),
    withdrawSpeakerRequest: vi.fn(),
    submitSpeakerRequest: vi.fn(),
    sendMessage: vi.fn(),
    addReaction: vi.fn(),
    setGuestName: vi.fn(),
  }));

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
  withdrawSpeakerRequest,
  submitSpeakerRequest,
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({
  sendMessage,
  addReaction,
  setGuestName,
}));

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

describe("PortraitRoom (issue #21, '05 — Social Stage' interaction model)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("gives the stage the full space, with chrome/controls layered over it as overlays — not separate blocks consuming a share of it", () => {
    render(<PortraitRoom {...baseProps} />);
    const stageWrapper = screen.getByTestId("room-stage").parentElement;
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.parentElement).toBe(stageWrapper);
    expect(overlay.className).toMatch(/\babsolute\b/);
    expect(stageWrapper?.className).toMatch(/\brelative\b/);
  });

  it("explicitly ranks the bottom overlay above the stage (z-10 vs the stage's own z-0)", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bz-10\b/);
    expect(screen.getByTestId("room-stage").className).toMatch(/\bz-0\b/);
  });

  it("opts out of StageOverlayShell's heavy gradient wash — the new controls carry their own individual legibility", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(screen.getByTestId("stage-bottom-overlay").className).not.toMatch(/\bfrom-black\/90\b/);
  });

  it("the bottom overlay's decorative margin is click-through — only its inner content wrapper captures taps", () => {
    render(<PortraitRoom {...baseProps} />);
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.className).toMatch(/\bpointer-events-none\b/);
    const inner = overlay.firstElementChild as HTMLElement;
    expect(inner.className).toMatch(/\bpointer-events-auto\b/);
  });

  it("tapping an empty seat tile calls onTapEmptySeat — unaffected by the redesign", () => {
    const onTapEmptySeat = vi.fn();
    render(<PortraitRoom {...baseProps} onTapEmptySeat={onTapEmptySeat} />);
    fireEvent.click(screen.getAllByTestId("empty-seat")[0]);
    expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed join attempt's message visibly", () => {
    render(<PortraitRoom {...baseProps} joinSeatMessage="Create an account to join as a speaker." />);
    expect(screen.getByText("Create an account to join as a speaker.")).toBeInTheDocument();
  });

  it("SpeakerStage never receives a darkened scrim in this phase — there is no Discussion Expanded yet to darken it for", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
  });

  describe("minimal top chrome (replaces RoomHeader for this composition)", () => {
    it("shows a compact status pill with the event title, click-through outside its own bounds", () => {
      render(<PortraitRoom {...baseProps} />);
      const pill = screen.getByTestId("watch-status-pill");
      expect(pill).toHaveTextContent("Late Night Debate");
    });

    it("omits connection-status text when connected, but surfaces it when degraded (the one safety-relevant thing RoomHeader used to show)", () => {
      const { rerender } = render(<PortraitRoom {...baseProps} connectionStatus="connected" />);
      expect(screen.getByTestId("watch-status-pill")).not.toHaveTextContent("Reconnecting");

      rerender(<PortraitRoom {...baseProps} connectionStatus="reconnecting" />);
      expect(screen.getByTestId("watch-status-pill")).toHaveTextContent("Reconnecting…");
    });

    it("shows the guest identity chip for a guest, not for an account holder", () => {
      const { rerender } = render(
        <PortraitRoom {...baseProps} identity={{ type: "guest", id: "g1", displayName: "Cheerful Raven" }} />,
      );
      expect(screen.getByRole("button", { name: "Cheerful Raven" })).toBeInTheDocument();

      rerender(<PortraitRoom {...baseProps} identity={identity} />);
      expect(screen.queryByRole("button", { name: /cheerful raven/i })).not.toBeInTheDocument();
    });
  });

  describe("persistent Watch Mode controls — composer real as of Phase 2, React/Vote/Gift still inert", () => {
    it("React, Vote, and Gift stay disabled — only the composer is functional in this phase", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.getByTestId("watch-emoji-emblem")).toBeDisabled();
      expect(screen.getByTestId("watch-vote-emblem")).toBeDisabled();
      expect(screen.getByTestId("watch-gift-emblem")).toBeDisabled();
    });

    it("there is no Discussion Expanded entry point yet — no comments-toggle", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
    });

    describe("the composer (issue #21, '05 — Social Stage' Phase 2: reuses ChatPanel's existing send/request logic verbatim)", () => {
      it("renders a real, focusable text field with the 'Add a comment…' placeholder — not the Phase 1 disabled placeholder", () => {
        render(<PortraitRoom {...baseProps} />);
        const input = screen.getByPlaceholderText("Add a comment…");
        expect(input).toBeInTheDocument();
        expect(input).not.toBeDisabled();
      });

      it("sending a normal comment calls the existing sendMessage action, never submitSpeakerRequest or onPrepareMedia", async () => {
        sendMessage.mockResolvedValue(undefined);
        const onPrepareMedia = vi.fn();
        render(<PortraitRoom {...baseProps} onPrepareMedia={onPrepareMedia} />);

        fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hello room" } });
        fireEvent.click(screen.getByRole("button", { name: "Send comment" }));

        await waitFor(() => expect(sendMessage).toHaveBeenCalled());
        expect(submitSpeakerRequest).not.toHaveBeenCalled();
        expect(onPrepareMedia).not.toHaveBeenCalled();
      });

      it("tapping the mic toggle switches to Request-to-Speak mode, changing the placeholder without enlarging the composer", () => {
        render(<PortraitRoom {...baseProps} micRequestMode={true} />);
        expect(screen.getByPlaceholderText("What's your topic?")).toBeInTheDocument();
        expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
      });

      it("the mic-on pill is visually distinct (accent border) from mic-off", () => {
        const { rerender } = render(<PortraitRoom {...baseProps} micRequestMode={false} />);
        const pillOff = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
        expect(pillOff.className).not.toMatch(/\bborder-accent/);

        rerender(<PortraitRoom {...baseProps} micRequestMode={true} />);
        const pillOn = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
        expect(pillOn.className).toMatch(/\bborder-accent/);
      });

      it("submitting a speaker request still calls onPrepareMedia synchronously — the existing Safari-gesture-safe submit order is preserved", () => {
        submitSpeakerRequest.mockResolvedValue(undefined);
        const onPrepareMedia = vi.fn();
        render(<PortraitRoom {...baseProps} micRequestMode={true} onPrepareMedia={onPrepareMedia} />);

        fireEvent.change(screen.getByPlaceholderText("What's your topic?"), {
          target: { value: "AI and creativity" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send speaker request" }));

        expect(onPrepareMedia).toHaveBeenCalledTimes(1);
      });

      it("a successful request flips hasPendingRequest and drops the composer back to normal mode", async () => {
        submitSpeakerRequest.mockResolvedValue(undefined);
        const onHasPendingRequestChange = vi.fn();
        const onMicRequestModeChange = vi.fn();
        render(
          <PortraitRoom
            {...baseProps}
            micRequestMode={true}
            onHasPendingRequestChange={onHasPendingRequestChange}
            onMicRequestModeChange={onMicRequestModeChange}
          />,
        );
        fireEvent.change(screen.getByPlaceholderText("What's your topic?"), {
          target: { value: "AI and creativity" },
        });
        fireEvent.click(screen.getByRole("button", { name: "Send speaker request" }));

        await waitFor(() => expect(onHasPendingRequestChange).toHaveBeenCalledWith(true));
        expect(onMicRequestModeChange).toHaveBeenCalledWith(false);
      });
    });
  });

  describe("RoomControls — leave stage unchanged, pending-request states compact (issue #21, Phase 2 fix)", () => {
    it("renders nothing for a plain audience member with no pending request", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.queryByRole("button", { name: /leave the stage/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
    });

    it("a seated speaker is routed to Speaker View instead of Watch Mode's own leave-stage treatment (issue #18)", () => {
      render(
        <PortraitRoom
          {...baseProps}
          isSpeaker={true}
          mySeatNumber={1}
          participantRole="speaker"
          canPublish={true}
        />,
      );
      // Still SpeakerStage underneath (via PortraitSpeakerView) — not a blank page.
      expect(screen.getByTestId("room-scrim")).toBeInTheDocument();
      // Speaker View has its own composer/leave control (issue #18, Phase
      // 2) — a real leave button exists, just not the old legacy
      // RoomControls block (no "Enable camera & mic"/status text
      // alongside it) — see portrait-speaker-view.test.tsx for the full
      // Speaker View composer/leave/ambient-comments coverage.
      expect(screen.getByRole("button", { name: /leave the stage/i })).toBeInTheDocument();
      expect(screen.queryByText(/setting up your mic access/i)).not.toBeInTheDocument();
    });

    describe("no separate 'Request sent' bar (issue #18 UX finding — the composer's own mic button carries the pending state instead)", () => {
      it("renders no standalone pending-request bar/pill at all — no 'Request sent' text, no old paragraph+Withdraw block", () => {
        render(<PortraitRoom {...baseProps} hasPendingRequest={true} />);
        expect(screen.queryByText("Request sent")).not.toBeInTheDocument();
        expect(screen.queryByText(/you'll go live automatically/i)).not.toBeInTheDocument();
        expect(screen.queryByRole("button", { name: /withdraw/i })).not.toBeInTheDocument();
      });

      it("the composer's mic button reflects the pending state and is still the sole Cancel affordance", () => {
        render(<PortraitRoom {...baseProps} hasPendingRequest={true} />);
        const micButton = screen.getByTestId("watch-composer-mic");
        expect(micButton).toHaveAccessibleName("Cancel speaker request");
        expect(micButton.className).toMatch(/\bbg-accent\/30\b/);
      });

      it("tapping the pending mic button calls onCancelPromotion — the same existing action the old bar's Cancel button used", () => {
        const onCancelPromotion = vi.fn();
        render(<PortraitRoom {...baseProps} hasPendingRequest={true} onCancelPromotion={onCancelPromotion} />);
        fireEvent.click(screen.getByTestId("watch-composer-mic"));
        expect(onCancelPromotion).toHaveBeenCalledTimes(1);
      });

      it("the ambient request comment is unaffected by this composition — still whatever ChatPanel/AmbientComments already renders", () => {
        render(
          <PortraitRoom
            {...baseProps}
            hasPendingRequest={true}
            messages={[
              {
                id: "m1",
                author_display_name: "Jamie",
                author_profile_id: "p1",
                author_guest_id: null,
                body: "AI and creativity",
                created_at: new Date().toISOString(),
                is_speaker_request: true,
              },
            ]}
          />,
        );
        expect(screen.getByTestId("ambient-comment")).toHaveTextContent("AI and creativity");
      });
    });
  });

  it("no pointer/drag gesture infrastructure is present — the retired room-level gesture stays retired", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(document.querySelector("[data-gesture-ignore]")).not.toBeInTheDocument();
  });

  describe("ambient live comments (issue #21, Phase 3 — reuses the existing chat stream, no second backend)", () => {
    it("renders nothing when there are no messages yet", () => {
      render(<PortraitRoom {...baseProps} messages={[]} />);
      expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    });

    it("shows a recent message ambiently, lower-left, click-through outside the bubbles themselves", () => {
      render(
        <PortraitRoom
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
      const bubble = screen.getByTestId("ambient-comment");
      expect(bubble).toHaveTextContent("great show");
      const wrapper = screen.getByTestId("ambient-comments").parentElement as HTMLElement;
      expect(wrapper.className).toMatch(/\bpointer-events-none\b/);
      // The scrollable feed area itself opts back into pointer events (not
      // just each bubble individually) — issue #21's live-stream-feed
      // rebuild needs the whole area touch-scrollable, not just tappable
      // per-bubble.
      expect(screen.getByTestId("ambient-comments").className).toMatch(/\bpointer-events-auto\b/);
    });

    it("positions the ambient overlay clear of the persistent bottom composer row", () => {
      render(
        <PortraitRoom
          {...baseProps}
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
      const wrapper = screen.getByTestId("ambient-comments").parentElement as HTMLElement;
      expect(wrapper.className).toMatch(/\babsolute\b/);
      expect(wrapper.className).toMatch(/\bbottom-16\b/);
      expect(wrapper.className).toMatch(/\bleft-3\b/);
    });
  });

  describe("center-stage 'Going live' countdown (issue #18 UX finding — reuses the existing promotionCountdown/onCancelPromotion state, not a new one)", () => {
    it("renders the countdown overlay instead of the ordinary bottom composer/controls once promotionCountdown is set", () => {
      render(<PortraitRoom {...baseProps} hasPendingRequest={true} promotionCountdown={3} />);
      expect(screen.getByTestId("countdown-overlay")).toBeInTheDocument();
      expect(screen.queryByTestId("stage-bottom-overlay")).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
    });

    it("hides ambient comments during the countdown too, so nothing competes with it", () => {
      render(
        <PortraitRoom
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
      render(<PortraitRoom {...baseProps} hasPendingRequest={true} promotionCountdown={3} />);
      expect(screen.getByTestId("room-scrim").style.opacity).not.toBe("0");
    });

    it("no scrim, ordinary composer, when promotionCountdown is null (including the plain pending-request waiting state, shown via the mic button's own pending style)", () => {
      render(<PortraitRoom {...baseProps} hasPendingRequest={true} promotionCountdown={null} />);
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
      expect(screen.queryByTestId("countdown-overlay")).not.toBeInTheDocument();
      expect(screen.getByTestId("watch-composer-mic")).toHaveAccessibleName("Cancel speaker request");
    });

    it("preserves top chrome (status pill/guest chip) during the countdown — still feels like the same room, not a separate page", () => {
      render(<PortraitRoom {...baseProps} hasPendingRequest={true} promotionCountdown={3} />);
      expect(screen.getByTestId("watch-status-pill")).toBeInTheDocument();
    });

    it("Cancel on the countdown overlay calls onCancelPromotion — the same existing action, not a new one", () => {
      const onCancelPromotion = vi.fn();
      render(
        <PortraitRoom
          {...baseProps}
          hasPendingRequest={true}
          promotionCountdown={3}
          onCancelPromotion={onCancelPromotion}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancelPromotion).toHaveBeenCalledTimes(1);
    });
  });

  describe("Discussion Expanded (issue #21) — audience compatibility", () => {
    function message(overrides: Partial<LobbyMessage> = {}): LobbyMessage {
      return {
        id: "m1",
        author_display_name: "Jamie",
        author_profile_id: "p1",
        author_guest_id: null,
        body: "hello room",
        created_at: new Date().toISOString(),
        is_speaker_request: false,
        ...overrides,
      };
    }

    it("is closed by default", () => {
      render(<PortraitRoom {...baseProps} messages={[message()]} />);
      expect(screen.queryByTestId("expanded-comments")).not.toBeInTheDocument();
    });

    it("tapping an ambient comment bubble opens the sheet", () => {
      render(<PortraitRoom {...baseProps} messages={[message()]} />);
      fireEvent.click(screen.getByTestId("ambient-comment"));
      expect(screen.getByTestId("expanded-comments")).toBeInTheDocument();
    });

    it("closing the sheet returns to the ordinary Watch Mode view, with no role/media/seat side effects", () => {
      const onTapEmptySeat = vi.fn();
      const activateMedia = vi.fn(async () => {});
      const toggleMicrophone = vi.fn(async () => {});
      const toggleCamera = vi.fn(async () => {});
      render(
        <PortraitRoom
          {...baseProps}
          messages={[message()]}
          onTapEmptySeat={onTapEmptySeat}
          activateMedia={activateMedia}
          toggleMicrophone={toggleMicrophone}
          toggleCamera={toggleCamera}
        />,
      );
      fireEvent.click(screen.getByTestId("ambient-comment"));
      fireEvent.click(screen.getByTestId("expanded-comments-close"));
      expect(screen.queryByTestId("expanded-comments")).not.toBeInTheDocument();
      expect(onTapEmptySeat).not.toHaveBeenCalled();
      expect(activateMedia).not.toHaveBeenCalled();
      expect(toggleMicrophone).not.toHaveBeenCalled();
      expect(toggleCamera).not.toHaveBeenCalled();
    });
  });
});
