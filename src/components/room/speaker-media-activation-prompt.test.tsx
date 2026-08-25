import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerMediaActivationPrompt } from "./speaker-media-activation-prompt";
import { SPEAKER_DISCONNECT_GRACE_MS, SPEAKER_DISCONNECT_GRACE_SECONDS } from "@/lib/speaker-reconnect";

describe("SpeakerMediaActivationPrompt (issue #18, Speaker View lifecycle fix)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when media activation isn't needed", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={false}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
        disconnectedAt={null}
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
        disconnectedAt={null}
      />,
    );
    expect(screen.getByTestId("speaker-view-activate-media")).toBeInTheDocument();
  });

  it("reads 'Tap to reconnect', not the generic 'Tap to enable camera & mic' — this state always means an already-seated speaker's tab came back fresh, never a first-time activation (issue #18 UX finding)", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
        disconnectedAt={null}
      />,
    );
    expect(screen.getByTestId("speaker-view-activate-media")).toHaveTextContent("Tap to reconnect");
  });

  it("calls activateMedia synchronously from the tap, the same gesture-safe path used everywhere else", () => {
    const activateMedia = vi.fn(async () => {});
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        activateMedia={activateMedia}
        mediaError={null}
        disconnectedAt={null}
      />,
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
        disconnectedAt={null}
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
        disconnectedAt={null}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  describe("reconnect remaining-time countdown (issue #18 reconnect-countdown finding)", () => {
    it("shows no countdown suffix when disconnectedAt is null (not yet known, or not actually disconnected)", () => {
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={null}
        />,
      );
      expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();
      expect(screen.getByTestId("speaker-view-activate-media")).toHaveTextContent("Tap to reconnect");
    });

    it("derives the initial countdown from the real disconnectedAt deadline, not a fresh 11", () => {
      const disconnectedAt = new Date(Date.now() - 3000).toISOString(); // disconnected 3s ago
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={disconnectedAt}
        />,
      );
      const remaining = SPEAKER_DISCONNECT_GRACE_SECONDS - 3;
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`${remaining}s`);
    });

    it("a tab reopened midway through an existing grace window shows the correct remaining time immediately, not a restart at 11", () => {
      const disconnectedAt = new Date(Date.now() - 8000).toISOString(); // 8s of an 11s window already elapsed
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={disconnectedAt}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent("3s");
    });

    it("ticks down once per second toward zero", async () => {
      vi.useFakeTimers();
      const disconnectedAt = new Date().toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={disconnectedAt}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`${SPEAKER_DISCONNECT_GRACE_SECONDS}s`);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(
        `${SPEAKER_DISCONNECT_GRACE_SECONDS - 1}s`,
      );
    });

    it("never shows a negative countdown once past the deadline — clamped at 0", () => {
      const disconnectedAt = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 5000)).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={disconnectedAt}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent("0s");
    });

    it("reconnecting (disconnectedAt clearing to null) removes the countdown immediately", () => {
      const { rerender } = render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={new Date().toISOString()}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toBeInTheDocument();

      rerender(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={null}
        />,
      );
      expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();
    });
  });

  describe("on-screen diagnostics (issue #18 real-device finding, 2026-08-25: 'Tap to reconnect' still showed with no countdown on real devices)", () => {
    it("reports raw/parsed/deadline/remaining/active for a genuine disconnect", () => {
      const disconnectedAt = new Date(Date.now() - 4000).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={disconnectedAt}
        />,
      );
      const diag = screen.getByTestId("diagnostic-speaker-reconnect");
      expect(diag).toHaveTextContent(`raw=${disconnectedAt}`);
      expect(diag).toHaveTextContent("active=true");
      expect(diag).toHaveTextContent(`remain=${SPEAKER_DISCONNECT_GRACE_SECONDS - 4}`);
    });

    it("reports active=false and no remaining seconds when disconnectedAt is null, even while the prompt itself is showing", () => {
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          disconnectedAt={null}
        />,
      );
      const diag = screen.getByTestId("diagnostic-speaker-reconnect");
      expect(diag).toHaveTextContent("raw=null");
      expect(diag).toHaveTextContent("active=false");
      expect(diag).toHaveTextContent("remain=null");
    });
  });
});
