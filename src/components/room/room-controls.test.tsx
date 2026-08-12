import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomControls } from "./room-controls";
import type { Identity } from "@/lib/identity";

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

describe("RoomControls", () => {
  it("shows 'Leave the stage' for an active speaker, never the request controls", () => {
    render(<RoomControls eventId="e1" isSpeaker identity={profileIdentity} hasPendingRequest={false} />);
    expect(screen.getByRole("button", { name: "Leave the stage" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Request the mic" })).not.toBeInTheDocument();
  });

  it("shows the account prompt inline when a guest clicks 'Request the mic' — never proactively", () => {
    render(<RoomControls eventId="e1" isSpeaker={false} identity={guestIdentity} hasPendingRequest={false} />);
    expect(screen.queryByText(/Create an account/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Request the mic" }));

    expect(screen.getByText("Create an account to request the mic.")).toBeInTheDocument();
    expect(requestToSpeak).not.toHaveBeenCalled();
  });

  it("an account holder can open the request form and submit, moving to the pending state", async () => {
    requestToSpeak.mockResolvedValue({ ok: true });
    render(<RoomControls eventId="e1" isSpeaker={false} identity={profileIdentity} hasPendingRequest={false} />);

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
    render(<RoomControls eventId="e1" isSpeaker={false} identity={profileIdentity} hasPendingRequest={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Claim your seat" }));

    await waitFor(() =>
      expect(screen.getByText("Other requests currently have more support than yours.")).toBeInTheDocument(),
    );
    // Still in the pending state — a rejected claim doesn't withdraw the request.
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeInTheDocument();
  });

  it("withdrawing returns to the 'Request the mic' state", async () => {
    withdrawSpeakerRequest.mockResolvedValue({ ok: true });
    render(<RoomControls eventId="e1" isSpeaker={false} identity={profileIdentity} hasPendingRequest={true} />);

    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Request the mic" })).toBeInTheDocument());
  });
});
