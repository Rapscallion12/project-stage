import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MobileLandscapeRoom } from "./mobile-landscape-room";
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

describe("MobileLandscapeRoom (real-device finding: a phone rotated sideways is not a small desktop)", () => {
  it("keeps the video-first overlay philosophy — chat/controls layer over the stage, not beside it (no sidebar)", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    const stage = screen.getByTestId("room-stage");
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.className).toMatch(/\babsolute\b/);
    expect(stage.parentElement).toBe(overlay.parentElement);
  });

  it("lays the two seats out side by side (landscape), not stacked", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bw-2\b/);
  });

  it("uses the compact room header, not the full one", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    expect(screen.getByRole("heading", { name: "Late Night Debate" }).className).toMatch(/\btext-sm\b/);
  });

  it("gives the overlay less top padding than portrait — less vertical room to spend on decoration", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bpt-8\b/);
  });

  it("tapping an empty seat tile still calls onTapEmptySeat", () => {
    const onTapEmptySeat = vi.fn();
    render(<MobileLandscapeRoom {...baseProps} onTapEmptySeat={onTapEmptySeat} />);
    fireEvent.click(screen.getAllByTestId("empty-seat")[0]);
    expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
  });

  it("the overlay's decorative margin is click-through, same as PortraitRoom", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.className).toMatch(/\bpointer-events-none\b/);
    expect((overlay.firstElementChild as HTMLElement).className).toMatch(/\bpointer-events-auto\b/);
  });

  describe("room header as a top overlay (real-device finding: two document-flow headers ate too much of an already-short viewport)", () => {
    it("the room header is no longer a document-flow sibling of the stage — it renders inside the same relatively-positioned stage wrapper", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const stage = screen.getByTestId("room-stage");
      const heading = screen.getByRole("heading", { name: "Late Night Debate" });
      expect(stage.parentElement).toBe(screen.getByTestId("room-header-overlay").parentElement);
      expect(screen.getByTestId("room-header-overlay")).toContainElement(heading);
    });

    it("the header overlay is click-through outside its actual content, same pattern as the bottom overlay", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const overlay = screen.getByTestId("room-header-overlay");
      expect(overlay.className).toMatch(/\bpointer-events-none\b/);
      expect((overlay.firstElementChild as HTMLElement).className).toMatch(/\bpointer-events-auto\b/);
    });

    it("reserves space on the right so it doesn't collide with the top-right self-preview slot", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const inner = screen.getByTestId("room-header-overlay").firstElementChild as HTMLElement;
      expect(inner.className).toMatch(/\bpr-16\b/);
    });
  });

  describe("Watch Mode / Comments Mode (issue #21, gesture retired 2026-08-22: a plain tap toggle, no drag)", () => {
    it("defaults to Watch Mode: comments closed, no chat panel mounted at all", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const toggle = screen.getByTestId("comments-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveTextContent("Comments");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
    });

    it("Watch Mode exposes a compact, always-available Comments control", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const toggle = screen.getByTestId("comments-toggle");
      expect(toggle.tagName).toBe("BUTTON");
    });

    it("tapping the toggle opens Comments Mode: full composer/history mount, scrim darkens", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      fireEvent.click(screen.getByTestId("comments-toggle"));

      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("comments-toggle")).toHaveTextContent("Hide");
      expect(screen.getByRole("textbox")).toBeInTheDocument();
      expect(Number(screen.getByTestId("room-scrim").style.opacity)).toBeGreaterThan(0);
    });

    it("Comments Mode shows message history and the reaction/emoji affordance, not just a bare composer", () => {
      const messages = [
        {
          id: "m1",
          author_display_name: "Jamie",
          author_profile_id: "p1",
          author_guest_id: null,
          body: "hello from the audience",
          created_at: new Date().toISOString(),
          is_speaker_request: false,
        },
      ];
      render(<MobileLandscapeRoom {...baseProps} messages={messages} />);
      fireEvent.click(screen.getByTestId("comments-toggle"));

      expect(screen.getByText("hello from the audience")).toBeInTheDocument();
      expect(screen.getAllByLabelText(/^Insert /).length).toBeGreaterThan(0);
    });

    it("opening Comments Mode never resizes, remounts, or reconnects SpeakerStage — same DOM node, same class list", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const stage = screen.getByTestId("room-stage");
      const stageClassBefore = stage.className;

      fireEvent.click(screen.getByTestId("comments-toggle"));

      expect(screen.getByTestId("room-stage")).toBe(stage);
      expect(stage.className).toBe(stageClassBefore);
    });

    it("tapping close/back returns immediately to Watch Mode — chat panel unmounts entirely, not just shrinks", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const toggle = screen.getByTestId("comments-toggle");
      fireEvent.click(toggle);
      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
    });

    it("the guest-name editor renders above the toggle, not inside Comments Mode", () => {
      render(<MobileLandscapeRoom {...baseProps} identity={{ type: "guest", id: "g1", displayName: "Guest" }} />);
      const toggle = screen.getByTestId("comments-toggle");
      const changeNameButton = screen.getByRole("button", { name: /change name/i });
      expect(changeNameButton.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("no pointer/drag gesture infrastructure remains active on the stage wrapper", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const surface = screen.getByTestId("room-stage").parentElement as HTMLElement;

      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 260 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientY: 260 });

      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "false");
      expect(document.querySelector("[data-gesture-ignore]")).not.toBeInTheDocument();
    });
  });

  describe("role router (issue #18, Speaker View corrective pass — rotating to landscape while seated no longer reverts to the audience composition)", () => {
    it("a seated speaker is routed to Speaker View instead of the ordinary audience landscape composition", () => {
      render(<MobileLandscapeRoom {...baseProps} isSpeaker={true} canPublish={true} />);
      expect(screen.getByTestId("room-scrim")).toBeInTheDocument();
      expect(screen.queryByTestId("comments-toggle")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /leave the stage/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Late Night Debate" })).not.toBeInTheDocument();
    });

    it("still calls useCommentsMode unconditionally — toggling isSpeaker on the same mounted instance doesn't throw a Rules-of-Hooks error", () => {
      const { rerender } = render(<MobileLandscapeRoom {...baseProps} isSpeaker={false} />);
      expect(() => rerender(<MobileLandscapeRoom {...baseProps} isSpeaker={true} />)).not.toThrow();
      expect(() => rerender(<MobileLandscapeRoom {...baseProps} isSpeaker={false} />)).not.toThrow();
    });
  });
});
