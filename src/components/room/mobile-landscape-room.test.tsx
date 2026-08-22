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
});
