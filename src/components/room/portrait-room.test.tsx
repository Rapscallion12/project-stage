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
}));

// jsdom doesn't implement Element.scrollTo — ChatPanel calls it to keep
// the message list pinned to the latest message, unrelated to anything
// this file is testing.
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

describe("PortraitRoom", () => {
  it("gives the stage 100% of the space below the header, with chat/controls layered over it as an overlay — not a separate block consuming a share of that space (issue #20 corrective pass)", () => {
    render(<PortraitRoom {...baseProps} />);
    const stageWrapper = screen.getByTestId("room-stage").parentElement;
    const overlay = screen.getByTestId("stage-bottom-overlay");
    // The stage and the overlay are siblings inside the same relatively
    // positioned wrapper — the overlay is absolutely positioned over the
    // stage, not a shrink-0 flex sibling stealing height from it.
    expect(overlay.parentElement).toBe(stageWrapper);
    expect(overlay.className).toMatch(/\babsolute\b/);
    expect(stageWrapper?.className).toMatch(/\brelative\b/);
  });

  it("explicitly ranks the overlay above the stage (z-10 vs the stage's own z-0) — real-device testing found the speaker divider bleeding across this overlay before this fix", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bz-10\b/);
    expect(screen.getByTestId("room-stage").className).toMatch(/\bz-0\b/);
  });

  it("re-scopes the overlay to a fixed dark theme so chat stays legible over live video regardless of the visitor's own light/dark preference", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bstage-overlay\b/);
  });

  describe("the overlay's decorative margin lets taps through to the stage beneath (real-device finding: an open seat could end up under it)", () => {
    it("the overlay itself is click-through — only its inner content wrapper captures taps", () => {
      render(<PortraitRoom {...baseProps} />);
      const overlay = screen.getByTestId("stage-bottom-overlay");
      expect(overlay.className).toMatch(/\bpointer-events-none\b/);
      const inner = overlay.firstElementChild as HTMLElement;
      expect(inner.className).toMatch(/\bpointer-events-auto\b/);
    });

    it("the comments toggle lives inside the click-through-capable wrapper", () => {
      render(<PortraitRoom {...baseProps} />);
      const overlay = screen.getByTestId("stage-bottom-overlay");
      expect(overlay).toContainElement(screen.getByTestId("comments-toggle"));
    });
  });

  describe("speaker-entry friction removal (issue #27)", () => {
    it("has no standalone 'Request the mic' control anywhere in the room", () => {
      render(<PortraitRoom {...baseProps} />);
      expect(screen.queryByRole("button", { name: /request the mic/i })).not.toBeInTheDocument();
      expect(screen.queryByPlaceholderText(/why should you get the mic/i)).not.toBeInTheDocument();
    });

    it("has exactly one text composer once Comments Mode is open", () => {
      render(<PortraitRoom {...baseProps} />);
      fireEvent.click(screen.getByTestId("comments-toggle"));
      expect(screen.getAllByRole("textbox")).toHaveLength(1);
    });

    it("tapping an empty seat tile calls onTapEmptySeat", () => {
      const onTapEmptySeat = vi.fn();
      render(<PortraitRoom {...baseProps} onTapEmptySeat={onTapEmptySeat} />);
      fireEvent.click(screen.getAllByTestId("empty-seat")[0]);
      expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
    });

    it("surfaces a failed join attempt's message near the controls, not silently", () => {
      render(<PortraitRoom {...baseProps} joinSeatMessage="Create an account to join as a speaker." />);
      expect(screen.getByText("Create an account to join as a speaker.")).toBeInTheDocument();
    });

    it("the composer's 🎤 toggle switches it into speaker-request mode, once Comments Mode is open", () => {
      render(<PortraitRoom {...baseProps} micRequestMode={true} />);
      fireEvent.click(screen.getByTestId("comments-toggle"));
      expect(screen.getByPlaceholderText("What do you want to talk about?")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Request" })).toBeInTheDocument();
    });
  });

  describe("Watch Mode / Comments Mode (issue #21, gesture retired 2026-08-22: built from scratch for portrait — it never got either gesture pass)", () => {
    it("defaults to Watch Mode: comments closed, no chat panel mounted at all", () => {
      render(<PortraitRoom {...baseProps} />);
      const toggle = screen.getByTestId("comments-toggle");
      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(toggle).toHaveTextContent("Comments");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
    });

    it("tapping the toggle opens Comments Mode: full composer/history mount, scrim darkens", () => {
      render(<PortraitRoom {...baseProps} />);
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
      render(<PortraitRoom {...baseProps} messages={messages} />);
      fireEvent.click(screen.getByTestId("comments-toggle"));

      expect(screen.getByText("hello from the audience")).toBeInTheDocument();
      expect(screen.getAllByLabelText(/^Insert /).length).toBeGreaterThan(0);
    });

    it("opening Comments Mode never resizes, remounts, or reconnects SpeakerStage — same DOM node, same class list", () => {
      render(<PortraitRoom {...baseProps} />);
      const stage = screen.getByTestId("room-stage");
      const stageClassBefore = stage.className;

      fireEvent.click(screen.getByTestId("comments-toggle"));

      expect(screen.getByTestId("room-stage")).toBe(stage);
      expect(stage.className).toBe(stageClassBefore);
    });

    it("tapping close/back returns immediately to Watch Mode — chat panel unmounts entirely, not just shrinks", () => {
      render(<PortraitRoom {...baseProps} />);
      const toggle = screen.getByTestId("comments-toggle");
      fireEvent.click(toggle);
      fireEvent.click(toggle);

      expect(toggle).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(screen.getByTestId("room-scrim").style.opacity).toBe("0");
    });

    it("the guest-name editor renders above the toggle, not inside Comments Mode", () => {
      render(<PortraitRoom {...baseProps} identity={{ type: "guest", id: "g1", displayName: "Guest" }} />);
      const toggle = screen.getByTestId("comments-toggle");
      const changeNameButton = screen.getByRole("button", { name: /change name/i });
      expect(changeNameButton.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("no pointer/drag gesture infrastructure remains active on the stage wrapper", () => {
      render(<PortraitRoom {...baseProps} />);
      const surface = screen.getByTestId("room-stage").parentElement as HTMLElement;

      fireEvent.pointerDown(surface, { pointerId: 1, clientY: 100 });
      fireEvent.pointerMove(surface, { pointerId: 1, clientY: 260 });
      fireEvent.pointerUp(surface, { pointerId: 1, clientY: 260 });

      expect(screen.getByTestId("comments-toggle")).toHaveAttribute("aria-expanded", "false");
      expect(document.querySelector("[data-gesture-ignore]")).not.toBeInTheDocument();
    });
  });
});
