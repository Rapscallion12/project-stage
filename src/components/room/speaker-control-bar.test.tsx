import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerControlBar } from "./speaker-control-bar";

const { leaveSpeakerSeat } = vi.hoisted(() => ({ leaveSpeakerSeat: vi.fn() }));

vi.mock("@/app/events/[id]/room/actions", () => ({ leaveSpeakerSeat }));

describe("SpeakerControlBar (issue #18 — Leave the stage only; mic/camera toggles relocated to SpeakerMediaToggles)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a Leave the stage button", () => {
    render(<SpeakerControlBar eventId="e1" />);
    expect(screen.getByRole("button", { name: /leave the stage/i })).toBeInTheDocument();
  });

  it("tapping it calls the same leaveSpeakerSeat Server Action RoomControls already uses, with the given eventId", async () => {
    leaveSpeakerSeat.mockResolvedValue({ ok: true });
    render(<SpeakerControlBar eventId="e1" />);
    fireEvent.click(screen.getByRole("button", { name: /leave the stage/i }));
    await waitFor(() => expect(leaveSpeakerSeat).toHaveBeenCalledWith("e1"));
  });

  it("surfaces a server-returned error", async () => {
    leaveSpeakerSeat.mockResolvedValue({ error: "Something went wrong." });
    render(<SpeakerControlBar eventId="e1" />);
    fireEvent.click(screen.getByRole("button", { name: /leave the stage/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong."));
  });

  it("shows no error before any attempt", () => {
    render(<SpeakerControlBar eventId="e1" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("has no mic/camera toggle buttons — those moved to WatchModeControls' micCameraSlot", () => {
    render(<SpeakerControlBar eventId="e1" />);
    expect(screen.queryByTestId("speaker-mic-toggle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("speaker-camera-toggle")).not.toBeInTheDocument();
  });
});
