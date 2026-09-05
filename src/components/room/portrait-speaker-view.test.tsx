import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortraitSpeakerView } from "./portrait-speaker-view";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";
import type { ReactionsController } from "@/hooks/use-stage-reactions";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

const { leaveSpeakerSeat, sendMessage, addReaction } = vi.hoisted(() => ({
  leaveSpeakerSeat: vi.fn(),
  sendMessage: vi.fn(),
  addReaction: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
  submitSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({
  sendMessage,
  addReaction,
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
    disconnected_at: null,
    media_inactive_since: null,
    round_number: 1,
    round_started_at: new Date().toISOString(),
    round_ends_at: new Date(Date.now() + 60_000).toISOString(),
    round_phase: "active" as const,
    closing_ends_at: null,
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
  participantCount: 2,
  connectionStatus: "connected",
  canPublish: true,
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

describe("PortraitSpeakerView (issue #18, 'Speaker View' Direction B)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the stage full-bleed, with only the other speaker's tile (no divider)", () => {
    render(<PortraitSpeakerView {...baseProps} />);
    expect(screen.queryByTestId("speaker-divider")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("speaker-tile")).toHaveLength(1);
  });

  it("shows the ordinary empty-seat placeholder, not a separate 'waiting for a partner' UI, when the other seat is empty", () => {
    render(<PortraitSpeakerView {...baseProps} speakers={[seat({ id: "s1", seat_number: 1, profile_id: "p1" })]} />);
    expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
  });

  it("still shows the minimal top-chrome status pill with the event title", () => {
    render(<PortraitSpeakerView {...baseProps} />);
    expect(screen.getByTestId("watch-status-pill")).toHaveTextContent("Late Night Debate");
  });

  it("shows the guest identity chip for a guest speaker, not for an account holder", () => {
    render(
      <PortraitSpeakerView
        {...baseProps}
        identity={{ type: "guest", id: "g1", displayName: "Cheerful Raven" }}
      />,
    );
    expect(screen.getByRole("button", { name: "Cheerful Raven" })).toBeInTheDocument();
  });

  it("shows no activation prompt when media is already active — the only Phase 1 gap remaining", () => {
    render(<PortraitSpeakerView {...baseProps} />);
    expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
  });

  describe("Leave the stage (issue #18, Phase 2 — restored for stress-testing the join/leave cycle)", () => {
    it("renders a Leave the stage control", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      expect(screen.getByRole("button", { name: /leave the stage/i })).toBeInTheDocument();
    });

    it("tapping it calls the same leaveSpeakerSeat Server Action RoomControls already uses", async () => {
      leaveSpeakerSeat.mockResolvedValue({ ok: true });
      render(<PortraitSpeakerView {...baseProps} />);
      fireEvent.click(screen.getByRole("button", { name: /leave the stage/i }));
      await waitFor(() => expect(leaveSpeakerSeat).toHaveBeenCalledWith("e1"));
    });

    it("is not the old legacy RoomControls block — no 'Enable camera & mic'/status text alongside it", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      expect(screen.queryByText(/setting up your mic access/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /enable camera/i })).not.toBeInTheDocument();
    });

    it("has no mic/camera toggle buttons of its own — those live in the persistent bottom row now", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      const leaveButton = screen.getByRole("button", { name: /leave the stage/i });
      // The mic/camera toggles (present elsewhere in the view) are not
      // siblings inside this button's own immediate row.
      const leaveRow = leaveButton.parentElement as HTMLElement;
      expect(leaveRow.querySelector('[data-testid="speaker-mic-toggle"]')).toBeNull();
      expect(leaveRow.querySelector('[data-testid="speaker-camera-toggle"]')).toBeNull();
    });

    it("the bottom overlay reserves safe-area-aware bottom padding, not a flat pb-3, so Leave/the control row clear the home-indicator region", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      const overlayInner = screen.getByTestId("stage-bottom-overlay").firstElementChild as HTMLElement;
      expect(overlayInner.className).toMatch(/safe-area-inset-bottom/);
    });
  });

  describe("composer (issue #18, Phase 2 — reuses ChatPanel verbatim, comments-only for a seated speaker)", () => {
    it("renders a real, focusable comment field", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      const input = screen.getByPlaceholderText("Add a comment…");
      expect(input).toBeInTheDocument();
      expect(input).not.toBeDisabled();
    });

    it("has no mic-request toggle — a seated speaker already holds the seat a request would be for", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      expect(screen.queryByTestId("watch-composer-mic")).not.toBeInTheDocument();
    });

    it("sending a comment calls the existing sendMessage action", async () => {
      sendMessage.mockResolvedValue(undefined);
      render(<PortraitSpeakerView {...baseProps} />);
      fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hello from the stage" } });
      fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    });

    it("Gift stays inert, unchanged", () => {
      render(<PortraitSpeakerView {...baseProps} />);
    });

    it("React/Vote are replaced by the mic/camera toggles for a seated speaker — not present at all", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-vote-emblem")).not.toBeInTheDocument();
    });
  });

  describe("mic/camera toggles in the persistent bottom row (issue #18, UI cleanup — relocated from the separate SpeakerControlBar row, same logic)", () => {
    it("renders Comment · Mic · Camera · Gift — the mic/camera toggles sit where React/Vote normally do", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
      expect(screen.getByTestId("speaker-mic-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("speaker-camera-toggle")).toBeInTheDocument();
    });

    it("tapping the mic toggle calls the same toggleMicrophone already wired through this view's props", () => {
      const toggleMicrophone = vi.fn(async () => {});
      render(<PortraitSpeakerView {...baseProps} toggleMicrophone={toggleMicrophone} />);
      fireEvent.click(screen.getByTestId("speaker-mic-toggle"));
      expect(toggleMicrophone).toHaveBeenCalledTimes(1);
    });

    it("tapping the camera toggle calls the same toggleCamera already wired through this view's props", () => {
      const toggleCamera = vi.fn(async () => {});
      render(<PortraitSpeakerView {...baseProps} toggleCamera={toggleCamera} />);
      fireEvent.click(screen.getByTestId("speaker-camera-toggle"));
      expect(toggleCamera).toHaveBeenCalledTimes(1);
    });

    it("only one copy of each control exists — no separate floating mic/camera row above the composer", () => {
      render(<PortraitSpeakerView {...baseProps} />);
      expect(screen.getAllByTestId("speaker-mic-toggle")).toHaveLength(1);
      expect(screen.getAllByTestId("speaker-camera-toggle")).toHaveLength(1);
    });

    it("disables both toggles before actually publishing", () => {
      render(<PortraitSpeakerView {...baseProps} needsMediaActivation={true} />);
      expect(screen.getByTestId("speaker-mic-toggle")).toBeDisabled();
      expect(screen.getByTestId("speaker-camera-toggle")).toBeDisabled();
    });
  });

  describe("ambient comments (issue #18, Phase 2 — reuses the same messages stream)", () => {
    it("renders a recent comment ambiently", () => {
      render(
        <PortraitSpeakerView
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
      render(<PortraitSpeakerView {...baseProps} messages={[]} />);
      expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    });

    it("clears the full control-region footprint (leave-stage row + control row), not Watch Mode's shorter bottom-16 offset (real-device finding: comments rendered behind the controls)", () => {
      render(
        <PortraitSpeakerView
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
      // Issue #21, fifth corrective pass: AmbientComments now wraps its
      // own feed + Hide toggle in one internal layout div (see that
      // component's own doc comment) — the caller's own positioning
      // wrapper (what this assertion cares about) is now the
      // grandparent, not the immediate parent.
      const wrapper = screen.getByTestId("ambient-comments").parentElement?.parentElement as HTMLElement;
      expect(wrapper.className).toMatch(/\bbottom-32\b/);
      expect(wrapper.className).not.toMatch(/\bbottom-16\b/);
    });
  });

  describe("local-seat permutation symmetry (real-device report, issue #18: claiming seat 1 worked, claiming seat 2 didn't) — same coverage as SpeakerStage's own matrix, exercised through the full role-router path", () => {
    it.each([
      { mine: 1 as const, other: 2 as const },
      { mine: 2 as const, other: 1 as const },
    ])("viewer owns seat $mine, other seat $other occupied → only seat $other's tile renders, no divider", ({ mine, other }) => {
      render(
        <PortraitSpeakerView
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
          <PortraitSpeakerView
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

  describe("media-activation recovery (real-device lifecycle finding: returning to the room after navigating away left no way to re-enable camera/mic)", () => {
    it("shows the activate-media prompt when needsMediaActivation is true — e.g. a fresh connection instance that's still seated", () => {
      render(<PortraitSpeakerView {...baseProps} needsMediaActivation={true} />);
      expect(screen.getByTestId("speaker-view-activate-media")).toBeInTheDocument();
    });

    it("tapping it calls the same activateMedia already wired through this view's props", () => {
      const activateMedia = vi.fn(async () => MEDIA_READY);
      render(<PortraitSpeakerView {...baseProps} needsMediaActivation={true} activateMedia={activateMedia} />);
      screen.getByTestId("speaker-view-activate-media").click();
      expect(activateMedia).toHaveBeenCalledTimes(1);
    });
  });

  describe("Discussion Expanded (issue #21) — Speaker View compatibility", () => {
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

    it("tapping an ambient comment bubble opens the sheet for a seated speaker too", () => {
      render(<PortraitSpeakerView {...baseProps} messages={[message()]} />);
      fireEvent.click(screen.getByTestId("ambient-comment"));
      expect(screen.getByTestId("expanded-comments")).toBeInTheDocument();
    });

    it("opening and closing it never changes role, mic/camera, or LiveKit-adjacent state — no callback passed through this view fires", () => {
      const activateMedia = vi.fn(async () => MEDIA_READY);
      const toggleMicrophone = vi.fn(async () => {});
      const toggleCamera = vi.fn(async () => {});
      const onPrepareMedia = vi.fn(async () => MEDIA_READY);
      render(
        <PortraitSpeakerView
          {...baseProps}
          messages={[message()]}
          activateMedia={activateMedia}
          toggleMicrophone={toggleMicrophone}
          toggleCamera={toggleCamera}
          onPrepareMedia={onPrepareMedia}
        />,
      );
      fireEvent.click(screen.getByTestId("ambient-comment"));
      expect(screen.getByTestId("expanded-comments")).toBeInTheDocument();
      fireEvent.click(screen.getByTestId("expanded-comments-close"));
      expect(screen.queryByTestId("expanded-comments")).not.toBeInTheDocument();

      expect(activateMedia).not.toHaveBeenCalled();
      expect(toggleMicrophone).not.toHaveBeenCalled();
      expect(toggleCamera).not.toHaveBeenCalled();
      expect(onPrepareMedia).not.toHaveBeenCalled();
    });

    it("Speaker View's expanded composer never offers a mic-request affordance — the seat is already held", () => {
      render(<PortraitSpeakerView {...baseProps} messages={[message()]} />);
      fireEvent.click(screen.getByTestId("ambient-comment"));
      expect(screen.queryByTestId("watch-composer-mic")).not.toBeInTheDocument();
    });

    it("double-tapping a comment to like it has no role/media/LiveKit side effects for a seated speaker", () => {
      const activateMedia = vi.fn(async () => MEDIA_READY);
      const toggleMicrophone = vi.fn(async () => {});
      const toggleCamera = vi.fn(async () => {});
      render(
        <PortraitSpeakerView
          {...baseProps}
          messages={[message()]}
          activateMedia={activateMedia}
          toggleMicrophone={toggleMicrophone}
          toggleCamera={toggleCamera}
        />,
      );
      fireEvent.click(screen.getByTestId("ambient-comment"));
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);

      expect(addReaction).toHaveBeenCalledWith("m1");
      expect(activateMedia).not.toHaveBeenCalled();
      expect(toggleMicrophone).not.toHaveBeenCalled();
      expect(toggleCamera).not.toHaveBeenCalled();
    });

    it("dragging the grabber to close has no role/media/LiveKit side effects for a seated speaker", () => {
      const toggleMicrophone = vi.fn(async () => {});
      const toggleCamera = vi.fn(async () => {});
      render(
        <PortraitSpeakerView
          {...baseProps}
          messages={[message()]}
          toggleMicrophone={toggleMicrophone}
          toggleCamera={toggleCamera}
        />,
      );
      fireEvent.click(screen.getByTestId("ambient-comment"));
      const handle = screen.getByTestId("expanded-comments-handle");
      fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientY: 150, pointerId: 1 });

      expect(screen.queryByTestId("expanded-comments")).not.toBeInTheDocument();
      expect(toggleMicrophone).not.toHaveBeenCalled();
      expect(toggleCamera).not.toHaveBeenCalled();
    });

    it("Top Speaker Requests renders for a seated speaker too", () => {
      render(
        <PortraitSpeakerView
          {...baseProps}
          messages={[message({ id: "m1", author_display_name: "Jordan", is_speaker_request: true })]}
          pendingRequests={[
            {
              id: "r1",
              event_id: "e1",
              profile_id: "p2",
              guest_id: null,
              message_id: "m1",
              status: "pending",
              created_at: new Date().toISOString(),
              resolved_at: null,
              selection_round_id: null,
              frozen_rank: null,
              frozen_vote_count: null,
              is_current_candidate: false,
              selection_failed: false,
              reserved_seat_number: null,
              voteCount: 0,
              isMyVote: false,
            },
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId("ambient-comment"));
      expect(screen.getByTestId("expanded-top-requests")).toHaveTextContent("Jordan");
    });
  });
});
