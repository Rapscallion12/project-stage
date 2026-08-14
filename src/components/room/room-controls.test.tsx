import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomControls } from "./room-controls";
import type { Identity } from "@/lib/identity";
import type { MediaError } from "@/hooks/use-live-room-connection";

const { leaveSpeakerSeat, requestToSpeak, withdrawSpeakerRequest, claimOpenSeat } = vi.hoisted(() => ({
  leaveSpeakerSeat: vi.fn(),
  requestToSpeak: vi.fn(),
  withdrawSpeakerRequest: vi.fn(),
  claimOpenSeat: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  leaveSpeakerSeat,
  requestToSpeak,
  withdrawSpeakerRequest,
  claimOpenSeat,
}));

const profileIdentity: Identity = { type: "profile", id: "p1", displayName: "Jamie" };
const guestIdentity: Identity = { type: "guest", id: "g1", displayName: "Curious Fox" };

/** A speaker who's already fully connected and publishing — the common case for the non-media-focused tests below. */
const readyMediaProps = {
  canPublish: true,
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => {}),
  mediaError: null as MediaError,
  connectionStatus: "connected" as const,
};

describe("RoomControls", () => {
  it("shows 'Leave the stage' for an active speaker, never the request controls", () => {
    render(
      <RoomControls
        eventId="e1"
        isSpeaker
        identity={profileIdentity}
        hasPendingRequest={false}
        {...readyMediaProps}
      />,
    );
    expect(screen.getByRole("button", { name: "Leave the stage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request the mic" })).not.toBeInTheDocument();
  });

  it("shows the account prompt inline when a guest clicks 'Request the mic' — never proactively", () => {
    render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        identity={guestIdentity}
        hasPendingRequest={false}
        {...readyMediaProps}
      />,
    );
    expect(screen.queryByText(/Create an account/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Request the mic" }));

    expect(screen.getByText("Create an account to request the mic.")).toBeInTheDocument();
    expect(requestToSpeak).not.toHaveBeenCalled();
  });

  it("an account holder can open the request form and submit, moving to the pending state", async () => {
    requestToSpeak.mockResolvedValue({ ok: true });
    render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        identity={profileIdentity}
        hasPendingRequest={false}
        {...readyMediaProps}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Request the mic" }));
    fireEvent.change(screen.getByPlaceholderText("Why should you get the mic?"), {
      target: { value: "I have thoughts." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Submit" }));

    await waitFor(() => expect(screen.getByText("Your request is live in chat.")).toBeInTheDocument());
    expect(requestToSpeak).toHaveBeenCalledWith("e1", "I have thoughts.");
    expect(screen.getByRole("button", { name: "Claim your seat" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("shows a server rejection inline without changing state when claiming fails", async () => {
    claimOpenSeat.mockResolvedValue({ error: "Other requests currently have more support than yours." });
    render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        identity={profileIdentity}
        hasPendingRequest={true}
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

  it("withdrawing returns to the 'Request the mic' state", async () => {
    withdrawSpeakerRequest.mockResolvedValue({ ok: true });
    render(
      <RoomControls
        eventId="e1"
        isSpeaker={false}
        identity={profileIdentity}
        hasPendingRequest={true}
        {...readyMediaProps}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Request the mic" })).toBeInTheDocument());
  });

  describe("camera/mic activation and error states (issue #15)", () => {
    it("shows an explicit 'Enable camera & mic' button when media hasn't been activated yet, and calls activateMedia directly from the click handler", () => {
      const activateMedia = vi.fn(async () => {});
      render(
        <RoomControls
          eventId="e1"
          isSpeaker
          identity={profileIdentity}
          hasPendingRequest={false}
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
          identity={profileIdentity}
          hasPendingRequest={false}
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
          identity={profileIdentity}
          hasPendingRequest={false}
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
          identity={profileIdentity}
          hasPendingRequest={false}
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
          identity={profileIdentity}
          hasPendingRequest={false}
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
          identity={profileIdentity}
          hasPendingRequest={false}
          {...readyMediaProps}
          canPublish={false}
          needsMediaActivation={false}
          connectionStatus="connecting"
        />,
      );
      expect(screen.queryByText("Setting up your mic access…")).not.toBeInTheDocument();
    });
  });
});
