import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRoom } from "./desktop-room";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";
import type { ReactionsController } from "@/hooks/use-stage-reactions";

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
  activateMedia: vi.fn(async () => MEDIA_READY),
  mediaError: null,
  mediaReadiness: MEDIA_READY,
  acquiringMedia: false,
  localVideoTrack: null,
  onPrepareMedia: vi.fn(async () => MEDIA_READY),
  reconnectingIdentities: new Set<string>(),
  messages: [],
  reactions: {},
  submitComment: vi.fn(),
  retryComment: vi.fn(),
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

describe("DesktopRoom (renamed from LandscapeRoom, real-device finding: desktop and mobile landscape are not the same composition)", () => {
  it("gives chat a real dedicated sidebar, not an overlay over the stage", () => {
    render(<DesktopRoom {...baseProps} />);
    expect(screen.queryByTestId("stage-bottom-overlay")).not.toBeInTheDocument();
    const textbox = screen.getByRole("textbox");
    const stage = screen.getByTestId("room-stage");
    expect(stage).not.toContainElement(textbox);
  });

  it("lays the two seats out side by side", () => {
    render(<DesktopRoom {...baseProps} />);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bw-2\b/);
  });

  it("uses the full (non-compact) room header — desktop has the space to spare", () => {
    render(<DesktopRoom {...baseProps} />);
    expect(screen.getByRole("heading", { name: "Late Night Debate" }).className).not.toMatch(/\btext-sm\b/);
  });

  it("tapping an empty seat tile still calls onTapEmptySeat", () => {
    const onTapEmptySeat = vi.fn();
    render(<DesktopRoom {...baseProps} onTapEmptySeat={onTapEmptySeat} />);
    fireEvent.click(screen.getAllByTestId("empty-seat")[0]);
    expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
  });

  it("narrows the sidebar below the xl breakpoint instead of leaving the stage pathologically squashed right at the desktop threshold (real-device finding)", () => {
    const { container } = render(<DesktopRoom {...baseProps} />);
    const sidebar = container.querySelector(".border-l");
    expect(sidebar?.className).toMatch(/\bw-64\b/);
    expect(sidebar?.className).toMatch(/\bxl:w-80\b/);
  });

  // Issue #21, seventh corrective pass, Section 9: the desktop room/
  // navigation trigger — RoomHeader's own "☰" button, the one remaining
  // way to reach Home/Events/account actions now that the site-wide
  // header is hidden for the whole time a room is mounted.
  it("wires RoomHeader's own room/navigation trigger to onOpenRoomInfo", () => {
    const onOpenRoomInfo = vi.fn();
    render(<DesktopRoom {...baseProps} onOpenRoomInfo={onOpenRoomInfo} />);
    fireEvent.click(screen.getByTestId("room-info-trigger"));
    expect(onOpenRoomInfo).toHaveBeenCalledTimes(1);
  });

  describe("desktop navigation pass (real-desktop regression: global nav was hidden behind the hamburger on desktop, not just mobile)", () => {
    it("renders a persistent Home link, one click back to Virtual Stage — no hamburger required", () => {
      render(<DesktopRoom {...baseProps} />);
      expect(screen.getByRole("link", { name: "Virtual Stage home" })).toHaveAttribute("href", "/");
    });

    it("renders a persistent Events link", () => {
      render(<DesktopRoom {...baseProps} />);
      expect(screen.getByRole("link", { name: "Browse events" })).toHaveAttribute("href", "/events");
    });

    it("renders the account/avatar menu for a signed-in identity, reusing the same shared HomeAccountMenu", () => {
      render(<DesktopRoom {...baseProps} />);
      expect(screen.getByTestId("home-account-menu")).toBeInTheDocument();
    });

    it("shows guest Log in/Sign up, never a forced account UI, for a guest identity", () => {
      const guestIdentity: Identity = { type: "guest", id: "g1", displayName: "Cheerful Raven" };
      render(<DesktopRoom {...baseProps} identity={guestIdentity} />);
      expect(screen.getByRole("link", { name: "Log in" })).toBeInTheDocument();
      expect(screen.queryByTestId("home-account-menu")).not.toBeInTheDocument();
    });

    it("the header spans the full width, above the stage+sidebar row — not nested inside either column", () => {
      const { container } = render(<DesktopRoom {...baseProps} />);
      const header = screen.getByTestId("desktop-room-header");
      const outer = container.firstElementChild;
      // Sibling of the stage+sidebar row, not a descendant of the sidebar
      // (`.border-l`) or nested inside the stage column.
      expect(header.parentElement).toBe(outer);
    });

    it("does not change stage/sidebar layout — the sidebar width classes are unaffected", () => {
      const { container } = render(<DesktopRoom {...baseProps} />);
      const sidebar = container.querySelector(".border-l");
      expect(sidebar?.className).toMatch(/\bw-64\b/);
      expect(sidebar?.className).toMatch(/\bxl:w-80\b/);
    });
  });
});
