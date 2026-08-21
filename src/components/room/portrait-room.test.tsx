import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PortraitRoom } from "./portrait-room";
import type { RoomLayoutProps } from "@/components/room/types";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat: vi.fn(),
  requestToSpeak: vi.fn(),
  withdrawSpeakerRequest: vi.fn(),
  claimOpenSeat: vi.fn(),
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
  getParticipant: () => undefined,
  participantCount: 3,
  connectionStatus: "connected",
  canPublish: false,
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => {}),
  mediaError: null,
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

  it("re-scopes the overlay to a fixed dark theme so chat stays legible over live video regardless of the visitor's own light/dark preference", () => {
    render(<PortraitRoom {...baseProps} />);
    expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bstage-overlay\b/);
  });
});
