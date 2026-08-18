import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RoomDiagnostics } from "./room-diagnostics";

const defaultProps = {
  identityType: "profile" as const,
  isSpeaker: true,
  hasServerToken: true,
  liveKitUrlConfigured: true,
  connectionStatus: "connected" as const,
  canPublish: true,
  needsMediaActivation: false,
  mediaError: null,
  participantCount: 2,
};

function expand() {
  fireEvent.click(screen.getByRole("button", { name: /Temporary diagnostics/ }));
}

describe("RoomDiagnostics", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is collapsed by default, showing only the toggle — issue #17 real-device follow-up (this panel itself was pushing real controls out of view)", () => {
    render(<RoomDiagnostics {...defaultProps} />);
    expect(screen.getByRole("button", { name: /Temporary diagnostics/ })).toBeInTheDocument();
    expect(screen.queryByText(/Identity type:/)).not.toBeInTheDocument();
  });

  it("surfaces every state value needed to distinguish the failure layers, once expanded", () => {
    render(<RoomDiagnostics {...defaultProps} liveKitUrlConfigured={false} connectionStatus="unavailable" />);
    expand();
    expect(screen.getByText(/Identity type: profile/)).toBeInTheDocument();
    expect(screen.getByText(/Recognized as seated speaker: true/)).toBeInTheDocument();
    expect(screen.getByText(/Server issued a token: true/)).toBeInTheDocument();
    expect(screen.getByText(/LiveKit client URL configured: false/)).toBeInTheDocument();
    expect(screen.getByText(/LiveKit connection status: unavailable/)).toBeInTheDocument();
  });

  it("shows the specific media error source/reason, not a generic label", () => {
    render(<RoomDiagnostics {...defaultProps} mediaError={{ source: "camera", reason: "permission-denied" }} />);
    expand();
    expect(screen.getByText(/Media error: camera\/permission-denied/)).toBeInTheDocument();
  });

  it("reports success when a direct getUserMedia call (independent of LiveKit) succeeds", async () => {
    const stopTrack = vi.fn();
    const getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<RoomDiagnostics {...defaultProps} />);
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Test camera/mic permission directly" }));

    await waitFor(() => expect(screen.getByText(/SUCCESS/)).toBeInTheDocument());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
    expect(stopTrack).toHaveBeenCalled();
  });

  it("reports the exact DOMException name when a direct getUserMedia call fails", async () => {
    const error = new Error("denied");
    error.name = "NotAllowedError";
    const getUserMedia = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });

    render(<RoomDiagnostics {...defaultProps} />);
    expand();
    fireEvent.click(screen.getByRole("button", { name: "Test camera/mic permission directly" }));

    await waitFor(() => expect(screen.getByText(/FAILED — NotAllowedError/)).toBeInTheDocument());
  });
});
