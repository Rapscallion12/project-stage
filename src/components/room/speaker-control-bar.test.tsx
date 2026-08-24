import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerControlBar } from "./speaker-control-bar";

const { leaveSpeakerSeat } = vi.hoisted(() => ({ leaveSpeakerSeat: vi.fn() }));

vi.mock("@/app/events/[id]/room/actions", () => ({ leaveSpeakerSeat }));

const baseProps = {
  eventId: "e1",
  microphoneMuted: false,
  cameraMuted: false,
  onToggleMicrophone: vi.fn(async () => {}),
  onToggleCamera: vi.fn(async () => {}),
  canToggleMedia: true,
};

describe("SpeakerControlBar (issue #18, Phase 2)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a Leave the stage button", () => {
    render(<SpeakerControlBar {...baseProps} />);
    expect(screen.getByRole("button", { name: /leave the stage/i })).toBeInTheDocument();
  });

  it("tapping it calls the same leaveSpeakerSeat Server Action RoomControls already uses, with the given eventId", async () => {
    leaveSpeakerSeat.mockResolvedValue({ ok: true });
    render(<SpeakerControlBar {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /leave the stage/i }));
    await waitFor(() => expect(leaveSpeakerSeat).toHaveBeenCalledWith("e1"));
  });

  it("surfaces a server-returned error", async () => {
    leaveSpeakerSeat.mockResolvedValue({ error: "Something went wrong." });
    render(<SpeakerControlBar {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: /leave the stage/i }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong."));
  });

  it("shows no error before any attempt", () => {
    render(<SpeakerControlBar {...baseProps} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  describe("mic/camera toggles (issue #18, Phase 2 — mute in place on the already-published track, never reacquire)", () => {
    it("renders both toggle buttons", () => {
      render(<SpeakerControlBar {...baseProps} />);
      expect(screen.getByTestId("speaker-mic-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("speaker-camera-toggle")).toBeInTheDocument();
    });

    it("tapping the mic toggle calls onToggleMicrophone", () => {
      const onToggleMicrophone = vi.fn(async () => {});
      render(<SpeakerControlBar {...baseProps} onToggleMicrophone={onToggleMicrophone} />);
      fireEvent.click(screen.getByTestId("speaker-mic-toggle"));
      expect(onToggleMicrophone).toHaveBeenCalledTimes(1);
    });

    it("tapping the camera toggle calls onToggleCamera", () => {
      const onToggleCamera = vi.fn(async () => {});
      render(<SpeakerControlBar {...baseProps} onToggleCamera={onToggleCamera} />);
      fireEvent.click(screen.getByTestId("speaker-camera-toggle"));
      expect(onToggleCamera).toHaveBeenCalledTimes(1);
    });

    it("reflects muted state visually via aria-pressed", () => {
      const { rerender } = render(<SpeakerControlBar {...baseProps} microphoneMuted={false} />);
      expect(screen.getByTestId("speaker-mic-toggle")).toHaveAttribute("aria-pressed", "false");

      rerender(<SpeakerControlBar {...baseProps} microphoneMuted={true} />);
      expect(screen.getByTestId("speaker-mic-toggle")).toHaveAttribute("aria-pressed", "true");
    });

    it("disables both toggles when canToggleMedia is false — nothing published yet to mute", () => {
      render(<SpeakerControlBar {...baseProps} canToggleMedia={false} />);
      expect(screen.getByTestId("speaker-mic-toggle")).toBeDisabled();
      expect(screen.getByTestId("speaker-camera-toggle")).toBeDisabled();
    });

    it("Leave the stage itself stays enabled regardless of canToggleMedia", () => {
      render(<SpeakerControlBar {...baseProps} canToggleMedia={false} />);
      expect(screen.getByRole("button", { name: /leave the stage/i })).not.toBeDisabled();
    });
  });
});
