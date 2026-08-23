import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortraitRoom } from "./portrait-room";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat: vi.fn(),
  withdrawSpeakerRequest: vi.fn(),
  submitSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({
  sendMessage: vi.fn(),
  addReaction: vi.fn(),
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

const baseProps: RoomLayoutProps = {
  event,
  phase: "ready",
  countdownText: null,
  roomStatus: "live",
  speakers: [],
  myIdentity: "profile:p1",
  identity,
  isSpeaker: false,
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
};

describe("PortraitRoom (issue #21, '05 — Social Stage' interaction model, Phase 1: static shell)", () => {
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

  describe("persistent Watch Mode controls (composer + React + Vote + Gift) — visually final, functionally inert in this phase", () => {
    it("renders all four controls", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.getByTestId("watch-composer")).toBeInTheDocument();
      expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
      expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
      expect(screen.getByTestId("watch-gift-emblem")).toBeInTheDocument();
    });

    it("every control is disabled — no send, no reactions, no voting, no gifting yet", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.getByTestId("watch-composer")).toBeDisabled();
      expect(screen.getByTestId("watch-emoji-emblem")).toBeDisabled();
      expect(screen.getByTestId("watch-vote-emblem")).toBeDisabled();
      expect(screen.getByTestId("watch-gift-emblem")).toBeDisabled();
    });

    it("there is no functioning text composer anywhere in this phase — commenting returns in a later phase", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    });

    it("there is no Discussion Expanded entry point yet — no comments-toggle, no chat panel", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
    });
  });

  describe("RoomControls (leave stage / promotion countdown / withdraw) — unaffected by this redesign", () => {
    it("renders nothing for a plain audience member with no pending request", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.queryByRole("button", { name: /leave the stage/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /withdraw/i })).not.toBeInTheDocument();
    });

    it("renders the leave-stage control for a seated speaker", () => {
      render(<PortraitRoom {...baseProps} isSpeaker={true} canPublish={true} />);
      expect(screen.getByRole("button", { name: /leave the stage/i })).toBeInTheDocument();
    });

    it("renders the withdraw control for a pending requester", () => {
      render(<PortraitRoom {...baseProps} hasPendingRequest={true} />);
      expect(screen.getByRole("button", { name: /withdraw/i })).toBeInTheDocument();
    });
  });

  it("no pointer/drag gesture infrastructure is present — the retired room-level gesture stays retired", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(document.querySelector("[data-gesture-ignore]")).not.toBeInTheDocument();
  });
});
