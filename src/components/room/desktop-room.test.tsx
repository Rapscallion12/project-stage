import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRoom } from "./desktop-room";
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
  activateMedia: vi.fn(async () => {}),
  mediaError: null,
  localVideoTrack: null,
  onPrepareMedia: vi.fn(async () => {}),
  reconnectingIdentities: new Set<string>(),
  messages: [],
  reactions: {},
  pendingRequests: [],
  profileDirectory: {},
  isPreviewBuild: false,
  simulatedGuestIds: new Set(),
  stageRound: null,
  onOpenRoomInfo: () => {},
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
});
