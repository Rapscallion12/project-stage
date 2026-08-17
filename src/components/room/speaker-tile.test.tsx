import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Participant, Track, TrackPublication } from "livekit-client";
import { SpeakerTile } from "./speaker-tile";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    seat_number: 1,
    display_name: "Jamie Rivera",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    ...overrides,
  };
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
          activateMedia={vi.fn(async () => {})}
        />,
      );
      expect(screen.getByTestId("tile-activate-media")).toHaveTextContent("Tap to enable camera & mic");
      expect(screen.queryByTestId("no-video-placeholder")).not.toBeInTheDocument();
    });

    it("calls activateMedia directly from the tile's own click handler — the real user gesture Safari requires", () => {
      const activateMedia = vi.fn(async () => {});
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
          activateMedia={vi.fn(async () => {})}
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
});
