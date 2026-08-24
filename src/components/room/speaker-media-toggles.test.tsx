import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpeakerMediaToggles } from "./speaker-media-toggles";

const baseProps = {
  microphoneMuted: false,
  cameraMuted: false,
  onToggleMicrophone: vi.fn(async () => {}),
  onToggleCamera: vi.fn(async () => {}),
  canToggleMedia: true,
};

describe("SpeakerMediaToggles (issue #18 — relocated from SpeakerControlBar into the persistent bottom row, same logic)", () => {
  it("renders both toggle buttons", () => {
    render(<SpeakerMediaToggles {...baseProps} />);
    expect(screen.getByTestId("speaker-mic-toggle")).toBeInTheDocument();
    expect(screen.getByTestId("speaker-camera-toggle")).toBeInTheDocument();
  });

  it("tapping the mic toggle calls onToggleMicrophone", () => {
    const onToggleMicrophone = vi.fn(async () => {});
    render(<SpeakerMediaToggles {...baseProps} onToggleMicrophone={onToggleMicrophone} />);
    fireEvent.click(screen.getByTestId("speaker-mic-toggle"));
    expect(onToggleMicrophone).toHaveBeenCalledTimes(1);
  });

  it("tapping the camera toggle calls onToggleCamera", () => {
    const onToggleCamera = vi.fn(async () => {});
    render(<SpeakerMediaToggles {...baseProps} onToggleCamera={onToggleCamera} />);
    fireEvent.click(screen.getByTestId("speaker-camera-toggle"));
    expect(onToggleCamera).toHaveBeenCalledTimes(1);
  });

  it("reflects muted state visually via aria-pressed", () => {
    const { rerender } = render(<SpeakerMediaToggles {...baseProps} microphoneMuted={false} />);
    expect(screen.getByTestId("speaker-mic-toggle")).toHaveAttribute("aria-pressed", "false");

    rerender(<SpeakerMediaToggles {...baseProps} microphoneMuted={true} />);
    expect(screen.getByTestId("speaker-mic-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("disables both toggles when canToggleMedia is false — nothing published yet to mute", () => {
    render(<SpeakerMediaToggles {...baseProps} canToggleMedia={false} />);
    expect(screen.getByTestId("speaker-mic-toggle")).toBeDisabled();
    expect(screen.getByTestId("speaker-camera-toggle")).toBeDisabled();
  });
});
