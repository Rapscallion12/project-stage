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
// jsdom doesn't implement the Pointer Capture APIs at all — stubbed the
// same way scrollTo is above, so real fireEvent.pointerDown/Move/Up
// sequences against real DOM nodes don't throw.
Element.prototype.setPointerCapture = vi.fn();
Element.prototype.releasePointerCapture = vi.fn();

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

  it("still has exactly one text composer, same speaker-entry-friction guarantees as every other room composition", () => {
    render(<MobileLandscapeRoom {...baseProps} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
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

  describe("comments reveal — explicit toggle (issue #21, always-reliable trigger, same state the gesture reaches)", () => {
    it("renders a compact, always-available toggle control", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const toggle = screen.getByTestId("comments-toggle");
      expect(toggle.tagName).toBe("BUTTON");
      expect(toggle).toHaveTextContent("Comments");
    });

    it("starts collapsed — not visually dominant at rest", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
    });

    it("tapping the toggle expands the chat area and darkens the scrim, without touching the stage's own size", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const stage = screen.getByTestId("room-stage");
      const stageClassBefore = stage.className;

      fireEvent.click(screen.getByTestId("comments-toggle"));

      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByTestId("comments-toggle")).toHaveTextContent("Hide");
      expect(Number(screen.getByTestId("room-scrim").style.opacity)).toBeGreaterThan(0);
      expect(stage.className).toBe(stageClassBefore);
    });

    it("tapping the toggle again collapses it back", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const toggle = screen.getByTestId("comments-toggle");
      fireEvent.click(toggle);
      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
    });

    it("the toggle sits directly against the chat it reveals — nothing else between it and the composer (real-device finding: the old handle revealed the guest-name editor instead)", () => {
      render(<MobileLandscapeRoom {...baseProps} identity={{ type: "guest", id: "g1", displayName: "Guest" }} />);
      const toggle = screen.getByTestId("comments-toggle");
      const composer = screen.getByRole("textbox");
      const nextSibling = toggle.nextElementSibling as HTMLElement;
      expect(nextSibling).toContainElement(composer);
    });

    it("the guest-name editor renders above the toggle, not between it and the chat", () => {
      render(<MobileLandscapeRoom {...baseProps} identity={{ type: "guest", id: "g1", displayName: "Guest" }} />);
      const toggle = screen.getByTestId("comments-toggle");
      const changeNameButton = screen.getByRole("button", { name: /change name/i });
      expect(changeNameButton.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
  });

  describe("comments reveal — room-level drag gesture (real-device correction: broad surface, not a handle to find first)", () => {
    it("a downward drag started on the plain stage background (not on any control) opens comments", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const surface = screen.getByTestId("room-stage").parentElement as HTMLElement;

      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 260 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientY: 260 });

      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "true");
    });

    it("a drag starting on the empty-seat tile never opens comments — the tile's own tap still fires normally", () => {
      const onTapEmptySeat = vi.fn();
      render(<MobileLandscapeRoom {...baseProps} onTapEmptySeat={onTapEmptySeat} />);
      const emptySeat = screen.getAllByTestId("empty-seat")[0];

      fireEvent.pointerDown(emptySeat, { pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(emptySeat, { pointerId: 1, clientY: 260 });
      fireEvent.pointerUp(emptySeat, { pointerId: 1, clientY: 260 });
      fireEvent.click(emptySeat);

      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "false");
      expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
    });

    it("a small accidental movement on the plain surface does nothing", () => {
      render(<MobileLandscapeRoom {...baseProps} />);
      const surface = screen.getByTestId("room-stage").parentElement as HTMLElement;

      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 108 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientY: 108 });

      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "false");
    });

    it("the message list opts out of the room-level gesture so it can scroll normally", () => {
      render(<MobileLandscapeRoom {...baseProps} messages={[]} />);
      const list = document.querySelector("[data-gesture-ignore]");
      expect(list).toBeInTheDocument();
    });
  });
});
