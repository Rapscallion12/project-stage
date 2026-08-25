import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Participant, Track, TrackPublication } from "livekit-client";
import { SpeakerTile } from "./speaker-tile";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import { SPEAKER_DISCONNECT_GRACE_SECONDS } from "@/lib/speaker-reconnect";

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
    ...overrides,
  };
}

function fakeVideoTrack(): Track {
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
          activateMedia={vi.fn(async () => {})}
        />,
      );
      expect(screen.getByTestId("tile-activate-media")).toBeInTheDocument();
      expect(screen.queryByTestId("own-seat-live")).not.toBeInTheDocument();
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

    it("the on-screen diagnostic strip reports raw/parsed/deadline/remaining/active for an inactive seat", () => {
      const disconnectedAt = new Date(Date.now() - 3000).toISOString();
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: disconnectedAt })}
          participant={undefined}
          isLocal={false}
          isInactive={true}
        />,
      );
      const diag = screen.getByTestId("diagnostic-audience-reconnect");
      expect(diag).toHaveTextContent(`raw=${disconnectedAt}`);
      expect(diag).toHaveTextContent("active=true");
      expect(diag).toHaveTextContent(`remain=${SPEAKER_DISCONNECT_GRACE_SECONDS - 3}`);
    });

    it("the diagnostic strip reports active=false and no seconds when the seat isn't inactive at all", () => {
      render(
        <SpeakerTile
          speaker={speaker({ disconnected_at: null, media_inactive_since: null })}
          participant={undefined}
          isLocal={false}
        />,
      );
      const diag = screen.getByTestId("diagnostic-audience-reconnect");
      expect(diag).toHaveTextContent("raw=null");
      expect(diag).toHaveTextContent("active=false");
      expect(diag).toHaveTextContent("remain=null");
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
});
