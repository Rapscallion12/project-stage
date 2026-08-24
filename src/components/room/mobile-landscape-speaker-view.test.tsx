import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileLandscapeSpeakerView } from "./mobile-landscape-speaker-view";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

vi.mock("@/app/events/[id]/lobby/actions", () => ({ setGuestName: vi.fn() }));

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
};

describe("MobileLandscapeSpeakerView (issue #18, Speaker View landscape corrective pass)", () => {
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

  it("has none of the audience landscape composition's chrome — no RoomHeader participant count, no Comments toggle, no full RoomControls block", () => {
    render(<MobileLandscapeSpeakerView {...baseProps} />);
    expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /leave the stage/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("has no composer, ambient comments, or control bar yet (same phase boundary as portrait)", () => {
    render(<MobileLandscapeSpeakerView {...baseProps} />);
    expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
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
