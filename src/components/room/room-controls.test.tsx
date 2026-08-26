import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomControls } from "./room-controls";
import type { MediaError } from "@/hooks/use-live-room-connection";

const { leaveSpeakerSeat } = vi.hoisted(() => ({
  leaveSpeakerSeat: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
}));

/** A speaker who's already fully connected and publishing — the common case for the non-media-focused tests below. */
const readyMediaProps = {
  canPublish: true,
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => {}),
  onPrepareMedia: vi.fn(async () => {}),
  mediaError: null as MediaError,
  connectionStatus: "connected" as const,
  // Issue #17: most tests exercise the room once genuinely live — the
  // phase-gating-specific tests below override these.
  phase: "ready" as const,
  countdownText: null as string | null,
};

const notPromoting = { promotionCountdown: null, onCancelPromotion: vi.fn() };

describe("RoomControls", () => {
  it("shows 'Leave the stage' for an active speaker", () => {
    render(<RoomControls eventId="e1" isSpeaker hasPendingRequest={false} {...notPromoting} {...readyMediaProps} />);
    expect(screen.getByRole("button", { name: "Leave the stage" })).toBeInTheDocument();
  });

  // Issue #27: the standalone "Request the mic" control (and its
  // justification form) is gone — that entry point is now the composer's
  // own 🎤 mode (see chat-panel.test.tsx) and tapping an empty seat
  // directly (see speaker-tile.test.tsx). RoomControls has nothing left
  // to show for a plain audience member with no pending request.
  it("renders nothing for a plain audience member with no pending request — the request entry points live elsewhere now", () => {
    const { container } = render(
      <RoomControls eventId="e1" isSpeaker={false} hasPendingRequest={false} {...notPromoting} {...readyMediaProps} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Issue #23: no more manual "Claim your seat" button at all — a
  // pending requester either sees the plain waiting state or the
  // automatic-promotion countdown, never a button that claims anything
  // itself. See use-automatic-promotion.test.ts for the countdown/claim
  // state machine itself.
  describe("waiting for automatic promotion (issue #23 — replaces manual claiming)", () => {
    it("never shows a 'Claim your seat' button, in any state", () => {
      render(
        <RoomControls eventId="e1" isSpeaker={false} hasPendingRequest={true} {...notPromoting} {...readyMediaProps} />,
      );
      expect(screen.queryByRole("button", { name: "Claim your seat" })).not.toBeInTheDocument();
    });

    it("explains that going live happens automatically while just waiting", () => {
      render(
        <RoomControls eventId="e1" isSpeaker={false} hasPendingRequest={true} {...notPromoting} {...readyMediaProps} />,
      );
      expect(screen.getByText(/you'll go live automatically when it's your turn/i)).toBeInTheDocument();
    });

    it("shows the 'You're up next' countdown once promotionCountdown is set, instead of the plain waiting text", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          promotionCountdown={3}
          onCancelPromotion={vi.fn()}
          {...readyMediaProps}
        />,
      );
      expect(screen.getByText("You're up next")).toBeInTheDocument();
      expect(screen.getByText("Going live in 3…")).toBeInTheDocument();
      expect(screen.queryByText(/you'll go live automatically/i)).not.toBeInTheDocument();
    });

    it("'Cancel' during the countdown and 'Withdraw' while waiting both call onCancelPromotion — the same action either way", () => {
      const onCancelPromotion = vi.fn();
      const { rerender } = render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          promotionCountdown={null}
          onCancelPromotion={onCancelPromotion}
          {...readyMediaProps}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
      expect(onCancelPromotion).toHaveBeenCalledTimes(1);

      rerender(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          promotionCountdown={2}
          onCancelPromotion={onCancelPromotion}
          {...readyMediaProps}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancelPromotion).toHaveBeenCalledTimes(2);
    });
  });

  describe("candidate media readiness (issue #22)", () => {
    it("surfaces a mediaError with a retry action while just waiting, not just once seated", () => {
      const onPrepareMedia = vi.fn(async () => {});
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          {...notPromoting}
          {...readyMediaProps}
          onPrepareMedia={onPrepareMedia}
          mediaError={{ source: "camera", reason: "permission-denied" }}
        />,
      );
      expect(screen.getByText(/Camera permission was denied/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onPrepareMedia).toHaveBeenCalledTimes(1);
    });

    it("surfaces a mediaError with a retry action during the countdown too", () => {
      const onPrepareMedia = vi.fn(async () => {});
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          promotionCountdown={2}
          onCancelPromotion={vi.fn()}
          {...readyMediaProps}
          onPrepareMedia={onPrepareMedia}
          mediaError={{ source: "microphone", reason: "no-device" }}
        />,
      );
      expect(screen.getByText("No microphone found on this device.")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onPrepareMedia).toHaveBeenCalledTimes(1);
    });

    it("shows no media error/retry while waiting cleanly (no error yet)", () => {
      render(
        <RoomControls eventId="e1" isSpeaker={false} hasPendingRequest={true} {...notPromoting} {...readyMediaProps} />,
      );
      expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
    });
  });

  describe("camera/mic activation and error states (issue #15)", () => {
    it("shows an explicit 'Enable camera & mic' button when media hasn't been activated yet, and calls activateMedia directly from the click handler", () => {
      const activateMedia = vi.fn(async () => {});
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          {...notPromoting}
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
        <RoomControls eventId="e1" isSpeaker hasPendingRequest={false} {...notPromoting} {...readyMediaProps} />,
      );
      expect(screen.queryByRole("button", { name: "Enable camera & mic" })).not.toBeInTheDocument();
    });

    it("shows a specific permission-denied message, not a generic failure", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          hasPendingRequest={false}
          {...notPromoting}
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
          {...notPromoting}
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
          {...notPromoting}
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
          {...notPromoting}
          {...readyMediaProps}
          canPublish={false}
          needsMediaActivation={false}
          connectionStatus="connecting"
        />,
      );
      expect(screen.queryByText("Setting up your mic access…")).not.toBeInTheDocument();
    });
  });

  describe("phase-aware waiting copy (issue #17)", () => {
    it("mentions the pre-show countdown while waiting, pre-show", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          {...notPromoting}
          {...readyMediaProps}
          phase="lobby_open"
          countdownText="Live in 2h 15m"
        />,
      );
      expect(
        screen.getByText(/you'll go live automatically once the conversation starts \(live in 2h 15m\)/i),
      ).toBeInTheDocument();
      // Withdraw must still work pre-show.
      expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
    });

    it("drops the pre-show phrasing once phase is ready", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          {...notPromoting}
          {...readyMediaProps}
          phase="ready"
          countdownText={null}
        />,
      );
      expect(screen.getByText(/you'll go live automatically when it's your turn/i)).toBeInTheDocument();
      expect(screen.queryByText(/hasn't started yet/i)).not.toBeInTheDocument();
    });
  });

  describe("compact (issue #21, '05 — Social Stage' Phase 2 fix: pending-request feedback shouldn't occupy a large share of the video)", () => {
    it("renders a single-line pill instead of the paragraph+button treatment while waiting", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          {...notPromoting}
          {...readyMediaProps}
          compact
        />,
      );
      expect(screen.getByText("Request sent")).toBeInTheDocument();
      expect(screen.queryByText(/you'll go live automatically/i)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    });

    it("shows the countdown compactly too, same Cancel action", () => {
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          promotionCountdown={3}
          onCancelPromotion={vi.fn()}
          {...readyMediaProps}
          compact
        />,
      );
      expect(screen.getByText("Going live in 3…")).toBeInTheDocument();
      expect(screen.queryByText("You're up next")).not.toBeInTheDocument();
    });

    it("Cancel still calls onCancelPromotion", () => {
      const onCancelPromotion = vi.fn();
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          promotionCountdown={null}
          onCancelPromotion={onCancelPromotion}
          {...readyMediaProps}
          compact
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      expect(onCancelPromotion).toHaveBeenCalledTimes(1);
    });

    it("still surfaces a media error with its retry action in compact mode — nothing necessary is dropped", () => {
      const onPrepareMedia = vi.fn(async () => {});
      render(
        <RoomControls
          eventId="e1"
          isSpeaker={false}
          hasPendingRequest={true}
          {...notPromoting}
          {...readyMediaProps}
          onPrepareMedia={onPrepareMedia}
          mediaError={{ source: "camera", reason: "permission-denied" }}
          compact
        />,
      );
      expect(screen.getByText(/Camera permission was denied/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(onPrepareMedia).toHaveBeenCalledTimes(1);
    });

    it("does not affect the isSpeaker (Leave the stage) state — compact only changes the pending-request states", () => {
      render(
        <RoomControls eventId="e1" isSpeaker hasPendingRequest={false} {...notPromoting} {...readyMediaProps} compact />,
      );
      expect(screen.getByRole("button", { name: "Leave the stage" })).toBeInTheDocument();
    });
  });
});
