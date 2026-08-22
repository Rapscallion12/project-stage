import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomControls } from "./room-controls";
import type { MediaError } from "@/hooks/use-live-room-connection";

const { leaveSpeakerSeat, withdrawSpeakerRequest, claimOpenSeat } = vi.hoisted(() => ({
  leaveSpeakerSeat: vi.fn(),
  withdrawSpeakerRequest: vi.fn(),
  claimOpenSeat: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
  withdrawSpeakerRequest,
  claimOpenSeat,
}));

/** A speaker who's already fully connected and publishing — the common case for the non-media-focused tests below. */
const readyMediaProps = {
  canPublish: true,
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => {}),
  mediaError: null as MediaError,
  connectionStatus: "connected" as const,
  // Issue #17: most tests exercise the room once genuinely live — the
  // phase-gating-specific tests below override these.
  phase: "ready" as const,
  countdownText: null as string | null,
};

describe("RoomControls", () => {
  it("shows 'Leave the stage' for an active speaker", () => {
    render(
      <RoomControls
        eventId="e1"
        isSpeaker
        hasPendingRequest={false}
        onHasPendingRequestChange={vi.fn()}
        {...readyMediaProps}
      />,
    );
    expect(screen.getByRole("button", { name: "Leave the stage" })).toBeInTheDocument();
  });

  // Issue #27: the standalone "Request the mic" control (and its
  // justification form) is gone — that entry point is now the composer's
  // own 🎤 mode (see chat-panel.test.tsx) and tapping an empty seat
  // directly (see speaker-tile.test.tsx). RoomControls has nothing left
  // to show for a plain audience member with no pending request.
  it("renders nothing for a plain audience member with no pending request — the request entry points live elsewhere now", () => {
    const { container } = render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        hasPendingRequest={false}
        onHasPendingRequestChange={vi.fn()}
        {...readyMediaProps}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a server rejection inline without changing state when claiming fails", async () => {
    claimOpenSeat.mockResolvedValue({ error: "Other requests currently have more support than yours." });
    render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        hasPendingRequest={true}
        onHasPendingRequestChange={vi.fn()}
        {...readyMediaProps}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claim your seat" }));

    await waitFor(() =>
      expect(screen.getByText("Other requests currently have more support than yours.")).toBeInTheDocument(),
    );
    // Still in the pending state — a rejected claim doesn't withdraw the request.
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("withdrawing calls onHasPendingRequestChange(false), the same lifted-state signal the composer's successful submission also drives", async () => {
    withdrawSpeakerRequest.mockResolvedValue({ ok: true });
    const onHasPendingRequestChange = vi.fn();
    render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        hasPendingRequest={true}
        onHasPendingRequestChange={onHasPendingRequestChange}
        {...readyMediaProps}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    await waitFor(() => expect(onHasPendingRequestChange).toHaveBeenCalledWith(false));
  });

  it("claiming successfully calls onHasPendingRequestChange(false) too", async () => {
    claimOpenSeat.mockResolvedValue({ ok: true });
    const onHasPendingRequestChange = vi.fn();
    render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        hasPendingRequest={true}
        onHasPendingRequestChange={onHasPendingRequestChange}
        {...readyMediaProps}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Claim your seat" }));

    await waitFor(() => expect(onHasPendingRequestChange).toHaveBeenCalledWith(false));
  });

  describe("camera/mic activation and error states (issue #15)", () => {
    it("shows an explicit 'Enable camera & mic' button when media hasn't been activated yet, and calls activateMedia directly from the click handler", () => {
      const activateMedia = vi.fn(async () => {});
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
          needsMediaActivation
          activateMedia={activateMedia}
        />,
      );

      const button = screen.getByRole("button", { name: "Enable camera & mic" });
      fireEvent.click(button);
      expect(activateMedia).toHaveBeenCalledTimes(1);
    });

    it("never shows the activation button once media is already active", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
        />,
      );
      expect(screen.queryByRole("button", { name: "Enable camera & mic" })).not.toBeInTheDocument();
    });

    it("shows a specific permission-denied message, not a generic failure", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
          mediaError={{ source: "camera", reason: "permission-denied" }}
        />,
      );
      expect(screen.getByText(/Camera permission was denied/)).toBeInTheDocument();
    });

    it("shows a specific no-device message for the microphone", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
          mediaError={{ source: "microphone", reason: "no-device" }}
        />,
      );
      expect(screen.getByText("No microphone found on this device.")).toBeInTheDocument();
    });

    it("shows a waiting-for-grant message when connected but not yet granted canPublish", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
          canPublish={false}
          needsMediaActivation={false}
        />,
      );
      expect(screen.getByText("Setting up your mic access…")).toBeInTheDocument();
    });

    it("does not show the waiting-for-grant message while still connecting — RoomHeader already covers that", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
          canPublish={false}
          needsMediaActivation={false}
          connectionStatus="connecting"
        />,
      );
      expect(screen.queryByText("Setting up your mic access…")).not.toBeInTheDocument();
    });
  });

  describe("claiming a seat is gated to phase === \"ready\" (issue #17)", () => {
    it("hides the 'Claim your seat' button pre-show, showing a countdown-aware explanation instead", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
          phase="lobby_open"
          countdownText="Live in 2h 15m"
        />,
      );
      expect(screen.queryByRole("button", { name: "Claim your seat" })).not.toBeInTheDocument();
      expect(screen.getByText(/you can claim a seat once the conversation starts \(live in 2h 15m\)/i)).toBeInTheDocument();
      // Withdraw must still work pre-show — only claiming is phase-gated.
      expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    });

    it("shows the real 'Claim your seat' button once phase is ready", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          onHasPendingRequestChange={vi.fn()}
          {...readyMediaProps}
          phase="ready"
          countdownText={null}
        />,
      );
      expect(screen.getByRole("button", { name: "Claim your seat" })).toBeInTheDocument();
      expect(screen.queryByText(/hasn't started yet/i)).not.toBeInTheDocument();
    });
  });
});
