import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MobileLandscapeSpeakerView } from "./mobile-landscape-speaker-view";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const { leaveSpeakerSeat, sendMessage } = vi.hoisted(() => ({
  leaveSpeakerSeat: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
  submitSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({
  sendMessage,
  setGuestName: vi.fn(),
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

function seat(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    ...overrides,
  };
}

const baseProps: RoomLayoutProps = {
  event,
  phase: "ready",
  countdownText: null,
  roomStatus: "live",
  speakers: [seat({ id: "s1", seat_number: 1, profile_id: "p1" }), seat({ id: "s2", seat_number: 2, profile_id: "p2" })],
  myIdentity: "profile:p1",
  identity,
  isSpeaker: true,
  mySeatNumber: 1,
  participantRole: "speaker",
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
  participantCount: 2,
  connectionStatus: "connected",
  canPublish: true,
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => {}),
  mediaError: null,
  localVideoTrack: null,
  onPrepareMedia: vi.fn(async () => {}),
  reconnectingIdentities: new Set<string>(),
  messages: [],
  reactions: {},
  microphoneMuted: false,
  cameraMuted: false,
  toggleMicrophone: vi.fn(async () => {}),
  toggleCamera: vi.fn(async () => {}),
};

describe("MobileLandscapeSpeakerView (issue #18, Speaker View landscape corrective pass)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the stage full-bleed, with only the other speaker's tile (no divider), side-by-side orientation", () => {
    render(<MobileLandscapeSpeakerView {...baseProps} />);
    expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("speaker-tile")).toHaveLength(1);
  });

  it("shows the ordinary empty-seat placeholder when the other seat is empty", () => {
    render(
      <MobileLandscapeSpeakerView {...baseProps} speakers={[seat({ id: "s1", seat_number: 1, profile_id: "p1" })]} />,
    );
    expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
  });

  it("shows the minimal top-chrome status pill", () => {
    render(<MobileLandscapeSpeakerView {...baseProps} />);
    expect(screen.getByTestId("watch-status-pill")).toHaveTextContent("Late Night Debate");
  });

  it("has none of the audience landscape composition's chrome — no RoomHeader participant count, no Comments toggle, no full legacy RoomControls block", () => {
    render(<MobileLandscapeSpeakerView {...baseProps} />);
    expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
    expect(screen.queryByText(/setting up your mic access/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /enable camera/i })).not.toBeInTheDocument();
  });

  it("shows no activation prompt when media is already active", () => {
    render(<MobileLandscapeSpeakerView {...baseProps} />);
    expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
  });

  describe("Leave the stage, composer, ambient comments (issue #18, Phase 2 — same as portrait, restored for stress-testing)", () => {
    it("renders a Leave the stage control, calling the same leaveSpeakerSeat action", async () => {
      leaveSpeakerSeat.mockResolvedValue({ ok: true });
      render(<MobileLandscapeSpeakerView {...baseProps} />);
      fireEvent.click(screen.getByRole("button", { name: /leave the stage/i }));
      await waitFor(() => expect(leaveSpeakerSeat).toHaveBeenCalledWith("e1"));
    });

    it("renders a real comment field, no mic-request toggle", () => {
      render(<MobileLandscapeSpeakerView {...baseProps} />);
      expect(screen.getByPlaceholderText("Add a comment…")).not.toBeDisabled();
      expect(screen.queryByTestId("watch-composer-mic")).not.toBeInTheDocument();
    });

    it("sending a comment calls the existing sendMessage action", async () => {
      sendMessage.mockResolvedValue(undefined);
      render(<MobileLandscapeSpeakerView {...baseProps} />);
      fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hi" } });
      fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    });

    it("renders ambient comments from the same messages stream", () => {
      render(
        <MobileLandscapeSpeakerView
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

    it("clears the full control-region footprint, same as portrait — not the shorter Watch Mode bottom-16 offset", () => {
      render(
        <MobileLandscapeSpeakerView
          {...baseProps}
          messages={[
            {
              id: "m1",
              author_display_name: "Cheerful Fox",
              author_profile_id: "p1",
              author_guest_id: null,
              body: "Hello",
              created_at: new Date().toISOString(),
              is_speaker_request: false,
            },
          ]}
        />,
      );
      const wrapper = screen.getByTestId("ambient-comments").parentElement as HTMLElement;
      expect(wrapper.className).toMatch(/\bbottom-32\b/);
    });

    it("Gift stays inert; React/Vote are replaced by the mic/camera toggles", () => {
      render(<MobileLandscapeSpeakerView {...baseProps} />);
      expect(screen.getByTestId("watch-gift-emblem")).toBeDisabled();
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-vote-emblem")).not.toBeInTheDocument();
    });
  });

  describe("mic/camera toggles in the persistent bottom row (issue #18, UI cleanup — same as portrait)", () => {
    it("renders Comment · Mic · Camera · Gift, only one copy of each control", () => {
      render(<MobileLandscapeSpeakerView {...baseProps} />);
      expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
      expect(screen.getAllByTestId("speaker-mic-toggle")).toHaveLength(1);
      expect(screen.getAllByTestId("speaker-camera-toggle")).toHaveLength(1);
      expect(screen.getByTestId("watch-gift-emblem")).toBeInTheDocument();
    });

    it("tapping the mic/camera toggles calls the toggles already wired through this view's props", () => {
      const toggleMicrophone = vi.fn(async () => {});
      const toggleCamera = vi.fn(async () => {});
      render(
        <MobileLandscapeSpeakerView
          {...baseProps}
          toggleMicrophone={toggleMicrophone}
          toggleCamera={toggleCamera}
        />,
      );
      fireEvent.click(screen.getByTestId("speaker-mic-toggle"));
      fireEvent.click(screen.getByTestId("speaker-camera-toggle"));
      expect(toggleMicrophone).toHaveBeenCalledTimes(1);
      expect(toggleCamera).toHaveBeenCalledTimes(1);
    });
  });

  describe("local-seat permutation symmetry (same coverage as portrait/SpeakerStage)", () => {
    it.each([
      { mine: 1 as const, other: 2 as const },
      { mine: 2 as const, other: 1 as const },
    ])("viewer owns seat $mine, other seat $other occupied → only seat $other's tile renders, no divider", ({ mine, other }) => {
      render(
        <MobileLandscapeSpeakerView
          {...baseProps}
          myIdentity="profile:me"
          mySeatNumber={mine}
          speakers={[
            seat({ id: `s${mine}`, seat_number: mine, profile_id: "me" }),
            seat({ id: `s${other}`, seat_number: other, profile_id: "remote" }),
          ]}
        />,
      );
      expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("speaker-tile")).toHaveLength(1);
    });

    it.each([1 as const, 2 as const])(
      "viewer owns seat %i, other seat empty → the empty seat's tile renders full-bleed, no divider",
      (mine) => {
        render(
          <MobileLandscapeSpeakerView
            {...baseProps}
            myIdentity="profile:me"
            mySeatNumber={mine}
            speakers={[seat({ id: `s${mine}`, seat_number: mine, profile_id: "me" })]}
          />,
        );
        expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
        expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
        expect(screen.queryByTestId("speaker-tile")).not.toBeInTheDocument();
      },
    );
  });

  describe("media-activation recovery (same lifecycle fix as portrait)", () => {
    it("shows the activate-media prompt when needsMediaActivation is true", () => {
      render(<MobileLandscapeSpeakerView {...baseProps} needsMediaActivation={true} />);
      expect(screen.getByTestId("speaker-view-activate-media")).toBeInTheDocument();
    });

    it("tapping it calls the same activateMedia already wired through this view's props", () => {
      const activateMedia = vi.fn(async () => {});
      render(
        <MobileLandscapeSpeakerView {...baseProps} needsMediaActivation={true} activateMedia={activateMedia} />,
      );
      screen.getByTestId("speaker-view-activate-media").click();
      expect(activateMedia).toHaveBeenCalledTimes(1);
    });
  });
});
