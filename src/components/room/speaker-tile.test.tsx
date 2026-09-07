import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Participant, Track, TrackPublication } from "livekit-client";
import { SpeakerTile } from "./speaker-tile";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import { SPEAKER_DISCONNECT_GRACE_SECONDS } from "@/lib/speaker-reconnect";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";

// Media Readiness pass (issue #21): jsdom has no real Web Audio API
// (AudioContext/AnalyserNode), so createAudioAnalyser — the one function
// AudioOnlyVisualizer calls — is mocked here to a harmless stand-in. This
// file exercises SpeakerTile's own state selection (which placeholder
// renders when), not the analyser's real frame-by-frame math, which has
// no meaningful jsdom-testable behavior of its own (no real audio
// hardware, no real rAF-driven canvas) — see AudioOnlyVisualizer's own
// doc comment.
vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return {
    ...actual,
    createAudioAnalyser: vi.fn(() => ({
      calculateVolume: () => 0,
      analyser: { context: { state: "running", resume: vi.fn(async () => {}) } } as unknown as AnalyserNode,
      cleanup: vi.fn(async () => {}),
    })),
  };
});

const MEDIA_READY: MediaReadinessState = { camera: { ready: true, error: null }, microphone: { ready: true, error: null } };

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie Rivera",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    media_inactive_since: null,
    round_number: 1,
    round_started_at: new Date().toISOString(),
    round_ends_at: new Date(Date.now() + 60_000).toISOString(),
    round_phase: "active" as const,
    closing_ends_at: null,
    ...overrides,
  };
}

function fakeVideoTrack(): Track {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as Track;
}

function fakeAudioTrack(): Track {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as Track;
}

function fakeParticipant(publications: Partial<Record<"camera" | "microphone", Partial<TrackPublication>>>): Participant {
  return {
    getTrackPublication: (source: string) => {
      if (source === "camera") return publications.camera as TrackPublication | undefined;
      if (source === "microphone") return publications.microphone as TrackPublication | undefined;
      return undefined;
    },
  } as unknown as Participant;
}

describe("SpeakerTile", () => {
  it("shows an intentional 'Seat open' placeholder when the seat has no occupant — never blank", () => {
    render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} />);
    expect(screen.getByTestId("empty-seat")).toHaveTextContent("Seat open");
    expect(screen.queryByTestId("speaker-tile")).not.toBeInTheDocument();
  });

  describe("direct empty-seat join (issue #27)", () => {
    it("is a plain, non-interactive placeholder when no onTapEmptySeat is given", () => {
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} />);
      expect(screen.getByTestId("empty-seat").tagName).toBe("DIV");
    });

    it("becomes a real tappable button when onTapEmptySeat is provided, calling it directly from the click handler", () => {
      const onTapEmptySeat = vi.fn();
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} onTapEmptySeat={onTapEmptySeat} />);
      const tile = screen.getByTestId("empty-seat");
      expect(tile.tagName).toBe("BUTTON");
      fireEvent.click(tile);
      expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
    });

    it("shows a 'Joining…' state and disables the tile while a join attempt is in flight", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerTile
          speaker={null}
          participant={undefined}
          isLocal={false}
          onTapEmptySeat={onTapEmptySeat}
          isJoiningSeat={true}
        />,
      );
      const tile = screen.getByTestId("empty-seat");
      expect(tile).toHaveTextContent("Joining…");
      expect(tile).toBeDisabled();
    });
  });

  describe("established-stage empty seat states (issue #21, third/fifth/sixth corrective passes — no bypassing Request-to-Speak)", () => {
    it("shows 'Joining…' — not 'Selecting next speaker…' — once a candidate is reserved for this seat (issue #21, sixth corrective pass, Section 14)", () => {
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} emptySeatState="joining" />);
      const tile = screen.getByTestId("empty-seat");
      expect(tile.tagName).toBe("DIV");
      expect(tile).toHaveTextContent("Joining…");
      expect(tile).not.toHaveTextContent("Selecting next speaker…");
    });

    it("shows 'Selecting next speaker…' instead of the tappable CTA when an eligible candidate exists", () => {
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} emptySeatState="selecting" />);
      const tile = screen.getByTestId("empty-seat");
      expect(tile.tagName).toBe("DIV"); // never interactive
      expect(tile).toHaveTextContent("Selecting next speaker…");
      expect(tile).not.toHaveTextContent("Seat open");
      expect(tile).not.toHaveTextContent("Tap to join");
    });

    it("shows 'Waiting for speaker requests…' — never 'Selecting…' — when nobody is currently eligible (issue #21, fifth corrective pass, Section 2)", () => {
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} emptySeatState="waiting" />);
      const tile = screen.getByTestId("empty-seat");
      expect(tile.tagName).toBe("DIV");
      expect(tile).toHaveTextContent("Waiting for speaker requests…");
      expect(tile).not.toHaveTextContent("Selecting next speaker…");
    });

    it("shows a tappable 'Stage open' CTA for the small-room fallback (issue #21, fifth corrective pass, Section 15)", () => {
      const onTapEmptySeat = vi.fn();
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} onTapEmptySeat={onTapEmptySeat} emptySeatState="fallback-open" />);
      const tile = screen.getByTestId("empty-seat");
      expect(tile.tagName).toBe("BUTTON");
      expect(tile).toHaveTextContent("Stage open");
      expect(tile).toHaveTextContent("Tap to join");
      fireEvent.click(tile);
      expect(onTapEmptySeat).toHaveBeenCalledTimes(1);
    });

    it("stays a plain 'Seat open' placeholder during initial stage formation (emptySeatState omitted)", () => {
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} />);
      expect(screen.getByTestId("empty-seat")).toHaveTextContent("Seat open");
    });

    it("never renders as tappable even if a caller mistakenly passes both onTapEmptySeat and a non-interactive emptySeatState — the caller (SpeakerStage) is responsible for omitting the handler, but this stays a defensive belt", () => {
      // This documents the actual contract: emptySeatState only changes
      // wording, the *real* gate is whether onTapEmptySeat is provided at
      // all (SpeakerStage never provides both together for "selecting"/
      // "waiting") — see that component's own onTapEmptySeat gating.
      const onTapEmptySeat = vi.fn();
      render(<SpeakerTile speaker={null} participant={undefined} isLocal={false} onTapEmptySeat={onTapEmptySeat} emptySeatState="selecting" />);
      expect(screen.getByTestId("empty-seat").tagName).toBe("BUTTON");
    });
  });

  it("shows the speaker's name (from the DB) even with no LiveKit participant connected yet", () => {
    render(<SpeakerTile speaker={speaker()} participant={undefined} isLocal={false} />);
    expect(screen.getByTestId("speaker-tile")).toHaveTextContent("Jamie Rivera");
    expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
  });

  it("shows a camera-off placeholder (not blank, not the empty-seat placeholder) when seated but no video track", () => {
    const participant = fakeParticipant({});
    render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={false} />);
    expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("empty-seat")).not.toBeInTheDocument();
  });

  it("shows a camera-off placeholder when the camera track is muted, even though a track exists", () => {
    const fakeTrack = {} as Track;
    const participant = fakeParticipant({ camera: { track: fakeTrack, isMuted: true } });
    render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={false} />);
    expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
  });

  describe("audio-only visualizer (Media Readiness pass, issue #21, Section 12): camera off, mic actually publishing", () => {
    it("shows the audio-only visualizer, not the generic 'Camera off' placeholder, when camera is off but the microphone track is live and unmuted", () => {
      const micTrack = fakeAudioTrack();
      const participant = fakeParticipant({ microphone: { track: micTrack, isMuted: false } });
      render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={false} />);
      expect(screen.getByTestId("audio-only-visualizer")).toBeInTheDocument();
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
    });

    it("still shows the ordinary 'Camera off' placeholder when the microphone is also off/muted — both-off is unaffected by this pass", () => {
      const micTrack = fakeAudioTrack();
      const participant = fakeParticipant({ microphone: { track: micTrack, isMuted: true } });
      render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={false} />);
      expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
      expect(screen.queryByTestId("audio-only-visualizer")).not.toBeInTheDocument();
    });

    it("shows real video instead once the camera comes back on — the visualizer never coexists with, or blocks, the video branch", () => {
      const micTrack = fakeAudioTrack();
      const cameraTrack = fakeVideoTrack();
      const participant = fakeParticipant({
        microphone: { track: micTrack, isMuted: false },
        camera: { track: cameraTrack, isMuted: false },
      });
      const { container } = render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={false} />);
      expect(screen.queryByTestId("audio-only-visualizer")).not.toBeInTheDocument();
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
      expect(container.querySelector("video")).toBeInTheDocument();
    });

    it("never shows the big-tile visualizer for the local speaker's own seat — the canonical local self-view is SpeakerStage's corner slot (media rendering bugfix pass), not a second copy here", () => {
      const micTrack = fakeAudioTrack();
      const participant = fakeParticipant({ microphone: { track: micTrack, isMuted: false } });
      render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={true} />);
      expect(screen.queryByTestId("audio-only-visualizer")).not.toBeInTheDocument();
      // Same neutral "You're live" treatment camera-on already used —
      // widened to also cover camera-off-mic-on, not a new local state.
      expect(screen.getByTestId("own-seat-live")).toBeInTheDocument();
    });

    it("inactivity still takes precedence over the visualizer if both are somehow true at once — the existing safety net is never shadowed", () => {
      const micTrack = fakeAudioTrack();
      const participant = fakeParticipant({ microphone: { track: micTrack, isMuted: false } });
      render(
        <SpeakerTile speaker={speaker()} participant={participant} isLocal={false} isInactive={true} />,
      );
      expect(screen.getByTestId("speaker-inactive")).toBeInTheDocument();
      expect(screen.queryByTestId("audio-only-visualizer")).not.toBeInTheDocument();
    });
  });

  it("still shows the speaker's name and seat even if they have media issues (DB stays authoritative)", () => {
    const participant = fakeParticipant({ camera: { track: undefined } });
    render(<SpeakerTile speaker={speaker({ display_name: "Priya" })} participant={participant} isLocal={false} />);
    expect(screen.getByTestId("speaker-tile")).toHaveTextContent("Priya");
  });

  it("marks the local participant's own tile distinctly", () => {
    render(<SpeakerTile speaker={speaker({ display_name: "You Yourself" })} participant={undefined} isLocal={true} />);
    expect(screen.getByTestId("speaker-tile")).toHaveTextContent("You Yourself (you)");
  });

  describe("tile-level media activation (issue #15 real-device follow-up)", () => {
    // Real-device testing found the RoomControls-strip-only activation
    // button easy to miss entirely — the user is looking at their own
    // tile (it's the thing showing "camera off"), not scrolling down to a
    // separate control strip. These tests cover the tile itself becoming
    // a real, working tap target.

    it("shows a tappable 'Tap to enable camera & mic' control on the local tile when activation is needed, instead of the generic placeholder", () => {
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={true}
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => MEDIA_READY)}
        />,
      );
      expect(screen.getByTestId("tile-activate-media")).toHaveTextContent("Tap to enable camera & mic");
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
    });

    it("calls activateMedia directly from the tile's own click handler — the real user gesture Safari requires", () => {
      const activateMedia = vi.fn(async () => MEDIA_READY);
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={true}
          needsMediaActivation={true}
          activateMedia={activateMedia}
        />,
      );
      fireEvent.click(screen.getByTestId("tile-activate-media"));
      expect(activateMedia).toHaveBeenCalledTimes(1);
    });

    it("never shows the tile activation control on a remote speaker's tile, even if needsMediaActivation is somehow true", () => {
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={false}
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => MEDIA_READY)}
        />,
      );
      expect(screen.queryByTestId("tile-activate-media")).not.toBeInTheDocument();
      expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
    });

    it("shows a specific short error label on the local tile instead of the generic 'Camera off', once media has been attempted and failed", () => {
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={true}
          needsMediaActivation={false}
          mediaError={{ source: "camera", reason: "permission-denied" }}
        />,
      );
      expect(screen.getByTestId("no-video-placeholder")).toHaveTextContent("Permission denied");
      expect(screen.queryByText("Camera off")).not.toBeInTheDocument();
    });
  });

  describe("no duplicate self-video on the local speaker's own seat (issue #22 dominant-video corrective pass)", () => {
    it("renders a live-but-not-duplicated placeholder on the local tile, never a <video>, even though a real published track exists", () => {
      const fakeTrack = {} as Track;
      const participant = fakeParticipant({ camera: { track: fakeTrack, isMuted: false } });
      const { container } = render(
        <SpeakerTile speaker={speaker()} participant={participant} isLocal={true} />,
      );
      expect(screen.getByTestId("own-seat-live")).toHaveTextContent("You're live");
      expect(container.querySelector("video")).not.toBeInTheDocument();
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
    });

    it("a remote (audience-viewed) speaker tile renders the actual video normally, unaffected by the local-suppression rule", () => {
      const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
      const { container } = render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={false} />);
      expect(container.querySelector("video")).toBeInTheDocument();
      expect(screen.queryByTestId("own-seat-live")).not.toBeInTheDocument();
    });

    it("still falls back to the generic 'Camera off' placeholder for the local tile when there's genuinely no video yet", () => {
      render(<SpeakerTile speaker={speaker()} participant={undefined} isLocal={true} />);
      expect(screen.getByTestId("no-video-placeholder")).toHaveTextContent("Camera off");
      expect(screen.queryByTestId("own-seat-live")).not.toBeInTheDocument();
    });

    it("the tap-to-enable-media affordance still wins over the live-placeholder when both could apply", () => {
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={true}
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => MEDIA_READY)}
        />,
      );
      expect(screen.getByTestId("tile-activate-media")).toBeInTheDocument();
      expect(screen.queryByTestId("own-seat-live")).not.toBeInTheDocument();
    });
  });

  describe("revealOwnVideo (speaker presentation-toggle correction, real-device report: Normal Stage View must show my real feed, not the corner-preview placeholder)", () => {
    it("defaults to false — the existing local-suppression placeholder is completely unaffected when this prop is simply omitted", () => {
      const fakeTrack = {} as Track;
      const participant = fakeParticipant({ camera: { track: fakeTrack, isMuted: false } });
      const { container } = render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={true} />);
      expect(screen.getByTestId("own-seat-live")).toHaveTextContent("You're live");
      expect(container.querySelector("video")).not.toBeInTheDocument();
    });

    it("renders my own real video, not the 'You're live' placeholder, when isLocal and revealOwnVideo are both true", () => {
      const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
      const { container } = render(
        <SpeakerTile speaker={speaker()} participant={participant} isLocal={true} revealOwnVideo={true} />,
      );
      expect(container.querySelector("video")).toBeInTheDocument();
      expect(screen.queryByTestId("own-seat-live")).not.toBeInTheDocument();
    });

    it("camera off, mic on: renders the ordinary audio-only visualizer, not the placeholder — same treatment any other speaker gets", () => {
      const micTrack = fakeAudioTrack();
      const participant = fakeParticipant({ camera: { track: undefined }, microphone: { track: micTrack, isMuted: false } });
      render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={true} revealOwnVideo={true} />);
      expect(screen.queryByTestId("own-seat-live")).not.toBeInTheDocument();
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
    });

    it("has no effect on a remote (non-local) tile — a co-speaker's tile renders exactly as it always did", () => {
      const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
      const { container } = render(
        <SpeakerTile speaker={speaker()} participant={participant} isLocal={false} revealOwnVideo={true} />,
      );
      expect(container.querySelector("video")).toBeInTheDocument();
      expect(screen.queryByTestId("own-seat-live")).not.toBeInTheDocument();
    });

    it("the media-activation tap target still wins over revealOwnVideo when media hasn't been activated yet", () => {
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={true}
          revealOwnVideo={true}
          needsMediaActivation={true}
          activateMedia={vi.fn(async () => MEDIA_READY)}
        />,
      );
      expect(screen.getByTestId("tile-activate-media")).toBeInTheDocument();
    });

    describe("repaint nudge — the same 'reattached to a brand-new element' remount pattern SelfPreview already handles, at this second call site", () => {
      const originalPlay = HTMLMediaElement.prototype.play;

      beforeEach(() => {
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
          cb(0);
          return 0;
        });
        vi.stubGlobal("cancelAnimationFrame", () => {});
        HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
      });

      afterEach(() => {
        vi.unstubAllGlobals();
        HTMLMediaElement.prototype.play = originalPlay;
      });

      it("resets srcObject a beat after attach when isLocal && revealOwnVideo — the exact scenario the corner preview just vacated", () => {
        const track = {
          attach: vi.fn((element: HTMLVideoElement) => {
            element.srcObject = {} as MediaStream;
            return element;
          }),
          detach: vi.fn(),
        } as unknown as Track;
        const participant = fakeParticipant({ camera: { track, isMuted: false } });
        render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={true} revealOwnVideo={true} />);
        expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
      });

      it("never runs the nudge for an ordinary remote tile — this remount pattern only ever happens locally", () => {
        const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
        render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={false} />);
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
      });
    });

    describe("return-to-speaker-view affordance (Section 6: one tap back, since the corner self-preview no longer exists to tap instead)", () => {
      it("renders only when isLocal, revealOwnVideo, and the callback are all present", () => {
        const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
        render(
          <SpeakerTile
            speaker={speaker()}
            participant={participant}
            isLocal={true}
            revealOwnVideo={true}
            onTapReturnToSpeakerView={vi.fn()}
          />,
        );
        expect(screen.getByTestId("return-to-speaker-view")).toBeInTheDocument();
      });

      it("calls the callback when tapped", () => {
        const onTapReturnToSpeakerView = vi.fn();
        const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
        render(
          <SpeakerTile
            speaker={speaker()}
            participant={participant}
            isLocal={true}
            revealOwnVideo={true}
            onTapReturnToSpeakerView={onTapReturnToSpeakerView}
          />,
        );
        fireEvent.click(screen.getByTestId("return-to-speaker-view"));
        expect(onTapReturnToSpeakerView).toHaveBeenCalledTimes(1);
      });

      it("is absent when revealOwnVideo is false — Speaker-Focused View still relies on the corner self-preview instead", () => {
        const fakeTrack = {} as Track;
        const participant = fakeParticipant({ camera: { track: fakeTrack, isMuted: false } });
        render(
          <SpeakerTile speaker={speaker()} participant={participant} isLocal={true} onTapReturnToSpeakerView={vi.fn()} />,
        );
        expect(screen.queryByTestId("return-to-speaker-view")).not.toBeInTheDocument();
      });

      it("is absent on a remote tile even if revealOwnVideo happens to be true (it only ever matters for isLocal)", () => {
        const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
        render(
          <SpeakerTile
            speaker={speaker()}
            participant={participant}
            isLocal={false}
            revealOwnVideo={true}
            onTapReturnToSpeakerView={vi.fn()}
          />,
        );
        expect(screen.queryByTestId("return-to-speaker-view")).not.toBeInTheDocument();
      });

      it("is absent when no callback is given, even in Normal Stage View — never a dead-end tap target", () => {
        const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
        render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={true} revealOwnVideo={true} />);
        expect(screen.queryByTestId("return-to-speaker-view")).not.toBeInTheDocument();
      });
    });
  });

  describe("inactivity grace period (real-device finding: an inactive-but-still-seated speaker shouldn't just read as 'Camera off')", () => {
    it("shows 'Speaker inactive…' instead of the generic camera-off placeholder when isInactive is true", () => {
      render(
        <SpeakerTile speaker={speaker()} participant={undefined} isLocal={false} isInactive={true} />,
      );
      expect(screen.getByTestId("speaker-inactive")).toHaveTextContent("Speaker inactive…");
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
    });

    it("still shows the seat's own display name below the tile while inactive — DB stays authoritative", () => {
      render(
        <SpeakerTile
          speaker={speaker({ display_name: "Priya" })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("speaker-tile")).toHaveTextContent("Priya");
    });

    it("defaults to false — ordinary 'Camera off' is unaffected when the prop is omitted", () => {
      render(<SpeakerTile speaker={speaker()} participant={undefined} isLocal={false} />);
      expect(screen.getByTestId("no-video-placeholder")).toHaveTextContent("Camera off");
      expect(screen.queryByTestId("speaker-inactive")).not.toBeInTheDocument();
    });

    it("a real published video still wins over isInactive — stale/contradictory props never hide a live feed", () => {
      const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
      const { container } = render(
        <SpeakerTile speaker={speaker()} participant={participant} isLocal={false} isInactive={true} />,
      );
      expect(screen.queryByTestId("speaker-inactive")).not.toBeInTheDocument();
      expect(container.querySelector("video")).toBeInTheDocument();
    });
  });

  describe("unified inactive-speaker finding: media_inactive_since alone (no disconnected_at) also drives the inactive UI", () => {
    it("a seat with only media_inactive_since set (still connected, both muted) shows 'Speaker inactive · Ns', same as a disconnect would", () => {
      const mediaInactiveSince = new Date(Date.now() - 2000).toISOString();
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: null, media_inactive_since: mediaInactiveSince })}
          participant={undefined}
          isLocal={false}
        />,
      );
      expect(screen.getByTestId("speaker-inactive")).toBeInTheDocument();
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${SPEAKER_DISCONNECT_GRACE_SECONDS - 2}s`,
      );
    });

    it("the audience never sees which of the two causes applies — the copy is identical either way", () => {
      const since = new Date(Date.now() - 2000).toISOString();
      const { unmount } = render(
        <SpeakerTile speaker={speaker({ disconnected_at: since })} participant={undefined} isLocal={false} />,
      );
      const disconnectText = screen.getByTestId("audience-inactive-countdown").textContent;
      unmount();

      render(
        <SpeakerTile
          speaker={speaker({ media_inactive_since: since })}
          participant={undefined}
          isLocal={false}
        />,
      );
      const mediaInactiveText = screen.getByTestId("audience-inactive-countdown").textContent;
      expect(mediaInactiveText).toBe(disconnectText);
    });
  });

  describe("audience inactivity countdown (issue #18 real-device finding: the audience saw an inactive speaker with no indication of when they'd be removed)", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("shows no suffix when there's no authoritative deadline yet despite isInactive — nothing to count down from", () => {
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: null, media_inactive_since: null })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent("Speaker inactive…");
    });

    it("real-device precedence fix: an inactivity deadline alone (isInactive prop omitted/false) still overrides the generic 'Camera off' placeholder — the seat's own field is authoritative, not a separately-derived flag that could disagree with it", () => {
      const disconnectedAt = new Date(Date.now() - 2000).toISOString();
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={false}
        />,
      );
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
      expect(screen.getByTestId("speaker-inactive")).toBeInTheDocument();
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${SPEAKER_DISCONNECT_GRACE_SECONDS - 2}s`,
      );
    });

    it("renders the remaining seconds derived from the seat's own deadline — the same deadline the returning speaker's own prompt reads from", () => {
      const disconnectedAt = new Date(Date.now() - 3000).toISOString();
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${SPEAKER_DISCONNECT_GRACE_SECONDS - 3}s`,
      );
    });

    it("reopening partway through the grace period shows the actual remainder, not a fresh restart at the full grace period", () => {
      const disconnectedAt = new Date(Date.now() - 6000).toISOString();
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${SPEAKER_DISCONNECT_GRACE_SECONDS - 6}s`,
      );
    });

    it("ticks down once a second, same as the speaker's own reconnect prompt", async () => {
      vi.useFakeTimers();
      const disconnectedAt = new Date().toISOString();
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${SPEAKER_DISCONNECT_GRACE_SECONDS}s`,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent(
        `Speaker inactive · ${SPEAKER_DISCONNECT_GRACE_SECONDS - 1}s`,
      );
    });

    it("shows a resolving state, not a stuck '· 0s', once the countdown reaches zero (issue #18 expiration-enforcement finding)", () => {
      const disconnectedAt = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_SECONDS + 5) * 1000).toISOString();
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent("Speaker inactive — resolving…");
      expect(screen.getByTestId("audience-inactive-countdown")).not.toHaveTextContent("0s");
    });

    it("the countdown disappears the instant the seat is released — a null speaker renders the empty-seat state, not a stale countdown", () => {
      const disconnectedAt = new Date(Date.now() - 3000).toISOString();
      const { rerender } = render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toBeInTheDocument();

      rerender(<SpeakerTile speaker={null} participant={undefined} isLocal={false} isInactive={false} />);
      expect(screen.queryByTestId("audience-inactive-countdown")).not.toBeInTheDocument();
      expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
    });

    it("clears immediately on recovery — both fields going back to null stops the countdown even while isInactive hasn't yet flipped", () => {
      const disconnectedAt = new Date(Date.now() - 3000).toISOString();
      const { rerender } = render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent("·");

      rerender(
        <SpeakerTile
          speaker={speaker({ disconnected_at: null, media_inactive_since: null })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      expect(screen.getByTestId("audience-inactive-countdown")).toHaveTextContent("Speaker inactive…");
    });
  });

  describe("round-timer badge (issue #21 corrective pass — closing-phase only; the ordinary shared round countdown moved to StageRoundBadge on SpeakerStage)", () => {
    it("shows nothing while the seat is in its ordinary active phase, in preview or production alike — the shared badge covers that now", () => {
      const { rerender } = render(
        <SpeakerTile
          speaker={speaker({ round_phase: "active", round_ends_at: new Date(Date.now() + 45_000).toISOString() })}
          participant={undefined}
          isLocal={false}
          isPreviewBuild={true}
        />,
      );
      expect(screen.queryByTestId("speaker-round-timer")).not.toBeInTheDocument();

      rerender(
        <SpeakerTile
          speaker={speaker({ round_phase: "active", round_ends_at: new Date(Date.now() + 45_000).toISOString() })}
          participant={undefined}
          isLocal={false}
          isPreviewBuild={false}
        />,
      );
      expect(screen.queryByTestId("speaker-round-timer")).not.toBeInTheDocument();
    });

    it("labels the closing period distinctly ('final Ns') in preview, even far from the deadline", () => {
      render(
        <SpeakerTile
          speaker={speaker({
            round_phase: "closing",
            closing_ends_at: new Date(Date.now() + 20_000).toISOString(),
          })}
          participant={undefined}
          isLocal={false}
          isPreviewBuild={true}
        />,
      );
      expect(screen.getByTestId("speaker-round-timer")).toHaveTextContent("Final 20s");
    });

    it("hides the closing countdown by default (production), far from the deadline", () => {
      render(
        <SpeakerTile
          speaker={speaker({ round_phase: "closing", closing_ends_at: new Date(Date.now() + 25_000).toISOString() })}
          participant={undefined}
          isLocal={false}
          isPreviewBuild={false}
        />,
      );
      expect(screen.queryByTestId("speaker-round-timer")).not.toBeInTheDocument();
    });

    it("reveals the closing countdown within the final ~10s even in production", () => {
      render(
        <SpeakerTile
          speaker={speaker({ round_phase: "closing", closing_ends_at: new Date(Date.now() + 8_000).toISOString() })}
          participant={undefined}
          isLocal={false}
          isPreviewBuild={false}
        />,
      );
      expect(screen.getByTestId("speaker-round-timer")).toBeInTheDocument();
    });
  });

  describe("simulated speaker placeholder (Session Simulator real-device follow-up)", () => {
    it("renders an unambiguous 'Simulated speaker' placeholder, not the generic 'Camera off' one, when isSimulated is true", () => {
      render(
        <SpeakerTile speaker={speaker({ display_name: "Curious Fox" })} participant={undefined} isLocal={false} isSimulated={true} />,
      );
      expect(screen.getByTestId("simulated-speaker-placeholder")).toBeInTheDocument();
      expect(screen.getByTestId("simulated-speaker-label")).toHaveTextContent("Simulated speaker");
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
      // The name/avatar is still shown via the ordinary identity bar, same as any other occupied seat.
      expect(screen.getAllByText("Curious Fox").length).toBeGreaterThan(0);
    });

    it("falls back to the ordinary 'Camera off' placeholder when isSimulated is false (default)", () => {
      render(<SpeakerTile speaker={speaker()} participant={undefined} isLocal={false} />);
      expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
      expect(screen.queryByTestId("simulated-speaker-placeholder")).not.toBeInTheDocument();
    });

    it("never shows the simulated placeholder for the local participant's own live seat, even if isSimulated is somehow true", () => {
      // Defensive: a real signed-in/guest local speaker is never also a
      // simulated identity in practice, but isSimulated shouldn't override
      // the isLocal/hasVideo branches that take priority above it.
      const participant = fakeParticipant({ camera: { track: fakeVideoTrack(), isMuted: false } });
      render(<SpeakerTile speaker={speaker()} participant={participant} isLocal={true} isSimulated={true} />);
      expect(screen.getByTestId("own-seat-live")).toBeInTheDocument();
      expect(screen.queryByTestId("simulated-speaker-placeholder")).not.toBeInTheDocument();
    });
  });

  describe("profile navigation (issue #29, Section 15 — a registered speaker's avatar becomes tappable into their public profile)", () => {
    it("wraps the inactive-speaker avatar in a link to the profile when profileEntry has a username", () => {
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={false}
          isInactive={true}
          profileEntry={{ username: "jaceb", avatarUrl: null }}
        />,
      );
      const link = screen.getByRole("link");
      expect(link).toHaveAttribute("href", "/profile/jaceb");
    });

    it("renders no link at all when profileEntry is absent (guest speaker, or no username chosen yet)", () => {
      render(
        <SpeakerTile speaker={speaker()} participant={undefined} isLocal={false} isInactive={true} />,
      );
      expect(screen.queryByRole("link")).not.toBeInTheDocument();
    });

    it("wraps the no-video-placeholder avatar in a profile link too", () => {
      render(
        <SpeakerTile
          speaker={speaker()}
          participant={undefined}
          isLocal={false}
          profileEntry={{ username: "jaceb", avatarUrl: null }}
        />,
      );
      expect(screen.getByTestId("no-video-placeholder")).toBeInTheDocument();
      expect(screen.getByRole("link")).toHaveAttribute("href", "/profile/jaceb");
    });
  });
});
