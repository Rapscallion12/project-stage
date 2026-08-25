import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerMediaActivationPrompt } from "./speaker-media-activation-prompt";
import { SPEAKER_DISCONNECT_GRACE_MS, SPEAKER_DISCONNECT_GRACE_SECONDS } from "@/lib/speaker-reconnect";

describe("SpeakerMediaActivationPrompt (issue #18, Speaker View lifecycle fix)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when neither media activation nor both-muted applies", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={false}
        bothMediaMuted={false}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
        inactiveSince={null}
      />,
    );
    expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
    expect(screen.queryByTestId("speaker-resume-speaking")).not.toBeInTheDocument();
  });

  it("shows a tap-to-enable affordance when media activation is needed", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        bothMediaMuted={false}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
        inactiveSince={null}
      />,
    );
    expect(screen.getByTestId("speaker-view-activate-media")).toBeInTheDocument();
  });

  it("reads 'Tap to reconnect', not the generic 'Tap to enable camera & mic' — this state always means an already-seated speaker's tab came back fresh, never a first-time activation (issue #18 UX finding)", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        bothMediaMuted={false}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
        inactiveSince={null}
      />,
    );
    expect(screen.getByTestId("speaker-view-activate-media")).toHaveTextContent("Tap to reconnect");
  });

  it("calls activateMedia synchronously from the tap, the same gesture-safe path used everywhere else", () => {
    const activateMedia = vi.fn(async () => {});
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        bothMediaMuted={false}
        activateMedia={activateMedia}
        mediaError={null}
        inactiveSince={null}
      />,
    );
    fireEvent.click(screen.getByTestId("speaker-view-activate-media"));
    expect(activateMedia).toHaveBeenCalledTimes(1);
  });

  it("surfaces a specific media error message, reusing RoomControls' own copy", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        bothMediaMuted={false}
        activateMedia={vi.fn(async () => {})}
        mediaError={{ source: "camera", reason: "permission-denied" }}
        inactiveSince={null}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/camera permission was denied/i);
  });

  it("shows no error text when there is none", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={true}
        bothMediaMuted={false}
        activateMedia={vi.fn(async () => {})}
        mediaError={null}
        inactiveSince={null}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  describe("both-media-muted case (issue #18 unified inactive-speaker finding: already publishing, but camera and mic both muted)", () => {
    it("shows non-interactive 'Resume speaking' text, not the tappable 'Tap to reconnect' button", () => {
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={false}
          bothMediaMuted={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={null}
        />,
      );
      expect(screen.getByTestId("speaker-resume-speaking")).toHaveTextContent("Resume speaking");
      expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
    });

    it("is not a button and has no click handler wired — tapping it can't be how recovery happens, since activateMedia would be a no-op with tracks already held", () => {
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={false}
          bothMediaMuted={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={null}
        />,
      );
      expect(screen.getByTestId("speaker-resume-speaking").tagName).not.toBe("BUTTON");
    });

    it("needsMediaActivation takes precedence when both are somehow true — the tappable prompt wins, unambiguously", () => {
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={null}
        />,
      );
      expect(screen.getByTestId("speaker-view-activate-media")).toBeInTheDocument();
      expect(screen.queryByTestId("speaker-resume-speaking")).not.toBeInTheDocument();
    });

    it("also shows the remaining-seconds countdown, from the same inactiveSince deadline", () => {
      const inactiveSince = new Date(Date.now() - 3000).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={false}
          bothMediaMuted={true}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(
        `${SPEAKER_DISCONNECT_GRACE_SECONDS - 3}s`,
      );
    });
  });

  describe("remaining-time countdown (issue #18 reconnect-countdown finding)", () => {
    it("shows no countdown suffix when inactiveSince is null (not yet known, or genuinely active)", () => {
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={null}
        />,
      );
      expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();
      expect(screen.getByTestId("speaker-view-activate-media")).toHaveTextContent("Tap to reconnect");
    });

    it("derives the initial countdown from the real inactiveSince deadline, not a fresh 11", () => {
      const inactiveSince = new Date(Date.now() - 3000).toISOString(); // inactive 3s ago
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      const remaining = SPEAKER_DISCONNECT_GRACE_SECONDS - 3;
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent(`${remaining}s`);
    });

    it("a tab reopened midway through an existing grace window shows the correct remaining time immediately, not a restart at 11", () => {
      const inactiveSince = new Date(Date.now() - 8000).toISOString(); // 8s of an 11s window already elapsed
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent("3s");
    });

    it("ticks down once per second toward zero", async () => {
      vi.useFakeTimers();
      const inactiveSince = new Date().toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={inactiveSince}
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
      const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 5000)).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toHaveTextContent("0s");
    });

    it("recovering (inactiveSince clearing to null) removes the countdown immediately", () => {
      const { rerender } = render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={new Date().toISOString()}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toBeInTheDocument();

      rerender(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={null}
        />,
      );
      expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();
    });
  });

  describe("on-screen diagnostics (issue #18 real-device finding, 2026-08-25: 'Tap to reconnect' still showed with no countdown on real devices)", () => {
    it("reports raw/parsed/deadline/remaining/active for a genuine inactivity deadline", () => {
      const inactiveSince = new Date(Date.now() - 4000).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      const diag = screen.getByTestId("diagnostic-speaker-reconnect");
      expect(diag).toHaveTextContent(`raw=${inactiveSince}`);
      expect(diag).toHaveTextContent("active=true");
      expect(diag).toHaveTextContent(`remain=${SPEAKER_DISCONNECT_GRACE_SECONDS - 4}`);
    });

    it("reports active=false and no remaining seconds when inactiveSince is null, even while the prompt itself is showing", () => {
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => {})}
          mediaError={null}
          inactiveSince={null}
        />,
      );
      const diag = screen.getByTestId("diagnostic-speaker-reconnect");
      expect(diag).toHaveTextContent("raw=null");
      expect(diag).toHaveTextContent("active=false");
      expect(diag).toHaveTextContent("remain=null");
    });
  });
});
