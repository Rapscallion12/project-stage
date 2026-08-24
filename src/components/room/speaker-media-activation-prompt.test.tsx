import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpeakerMediaActivationPrompt } from "./speaker-media-activation-prompt";

describe("SpeakerMediaActivationPrompt (issue #18, Speaker View lifecycle fix)", () => {
  it("renders nothing when media activation isn't needed", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={false}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
      />,
    );
    expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
  });

  it("shows a tap-to-enable affordance when media activation is needed", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
      />,
    );
    expect(screen.getByTestId("speaker-view-activate-media")).toBeInTheDocument();
  });

  it("calls activateMedia synchronously from the tap, the same gesture-safe path used everywhere else", () => {
    const activateMedia = vi.fn(async () => {});
    render(
      <SpeakerMediaActivationPrompt needsMediaActivation={true} activateMedia={activateMedia} mediaError={null} />,
    );
    fireEvent.click(screen.getByTestId("speaker-view-activate-media"));
    expect(activateMedia).toHaveBeenCalledTimes(1);
  });

  it("surfaces a specific media error message, reusing RoomControls' own copy", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        activateMedia={vi.fn(async () => {})}
        mediaError={{ source: "camera", reason: "permission-denied" }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/camera permission was denied/i);
  });

  it("shows no error text when there is none", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
