import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerMediaActivationPrompt } from "./speaker-media-activation-prompt";
import { SPEAKER_DISCONNECT_GRACE_MS, SPEAKER_DISCONNECT_GRACE_SECONDS } from "@/lib/speaker-reconnect";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";

const MEDIA_READY: MediaReadinessState = { camera: { ready: true, error: null }, microphone: { ready: true, error: null } };

describe("SpeakerMediaActivationPrompt (issue #18, Speaker View lifecycle fix)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when neither media activation nor both-muted applies", () => {
    render(
      <SpeakerMediaActivationPrompt
        needsMediaActivation={false}
        bothMediaMuted={false}
        activateMedia={vi.fn(async () => MEDIA_READY)}
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
        activateMedia={vi.fn(async () => MEDIA_READY)}
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
        activateMedia={vi.fn(async () => MEDIA_READY)}
        mediaError={null}
        inactiveSince={null}
      />,
    );
    expect(screen.getByTestId("speaker-view-activate-media")).toHaveTextContent("Tap to reconnect");
  });

  it("calls activateMedia synchronously from the tap, the same gesture-safe path used everywhere else", () => {
    const activateMedia = vi.fn(async () => MEDIA_READY);
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
        activateMedia={vi.fn(async () => MEDIA_READY)}
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
        activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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
          activateMedia={vi.fn(async () => MEDIA_READY)}
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

    it("never shows a negative countdown, or a stuck '0s' — clamps at 0 and moves into the resolving state instead (issue #18 expiration-enforcement finding)", () => {
      const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 5000)).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => MEDIA_READY)}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      expect(screen.getByTestId("speaker-resolving")).toHaveTextContent("Checking…");
      expect(screen.queryByTestId("speaker-view-activate-media")).not.toBeInTheDocument();
      expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();
    });

    it("recovering (inactiveSince clearing to null) removes the countdown immediately", () => {
      const { rerender } = render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => MEDIA_READY)}
          mediaError={null}
          inactiveSince={new Date().toISOString()}
        />,
      );
      expect(screen.getByTestId("speaker-reconnect-countdown")).toBeInTheDocument();

      rerender(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => MEDIA_READY)}
          mediaError={null}
          inactiveSince={null}
        />,
      );
      expect(screen.queryByTestId("speaker-reconnect-countdown")).not.toBeInTheDocument();
    });
  });

  describe("resolving state at zero (issue #18 expiration-enforcement finding: a countdown that reaches zero must not stay actionable forever)", () => {
    it("bothMediaMuted at zero also resolves to 'Checking…', not a stuck 'Resume speaking · 0s'", () => {
      const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 2000)).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={false}
          bothMediaMuted={true}
          activateMedia={vi.fn(async () => MEDIA_READY)}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      expect(screen.getByTestId("speaker-resolving")).toHaveTextContent("Checking…");
      expect(screen.queryByTestId("speaker-resume-speaking")).not.toBeInTheDocument();
    });

    it("still shows the actionable prompt at 1 second remaining — only exactly 0 triggers resolving", () => {
      const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS - 1000)).toISOString();
      render(
        <SpeakerMediaActivationPrompt
          needsMediaActivation={true}
          bothMediaMuted={false}
          activateMedia={vi.fn(async () => MEDIA_READY)}
          mediaError={null}
          inactiveSince={inactiveSince}
        />,
      );
      expect(screen.getByTestId("speaker-view-activate-media")).toHaveTextContent("1s");
      expect(screen.queryByTestId("speaker-resolving")).not.toBeInTheDocument();
    });
  });
});
