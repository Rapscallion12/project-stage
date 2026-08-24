import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortraitSpeakerView } from "./portrait-speaker-view";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

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

describe("PortraitSpeakerView (issue #18, 'Speaker View' Direction B, Phase 1)", () => {
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

  it("has no composer, no ambient comments, and no control bar yet (Phase 1 scope)", () => {
    render(<PortraitSpeakerView {...baseProps} />);
    expect(screen.queryByPlaceholderText("Add a comment…")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /leave the stage/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
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
      const activateMedia = vi.fn(async () => {});
      render(<PortraitSpeakerView {...baseProps} needsMediaActivation={true} activateMedia={activateMedia} />);
      screen.getByTestId("speaker-view-activate-media").click();
      expect(activateMedia).toHaveBeenCalledTimes(1);
    });
  });
});
