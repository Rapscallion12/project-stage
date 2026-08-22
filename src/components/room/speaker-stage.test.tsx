import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpeakerStage } from "./speaker-stage";
import type { LocalVideoTrack } from "livekit-client";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

/** A minimal stand-in for a real LocalVideoTrack — SelfPreview only ever calls attach/detach on it. */
function fakeVideoTrack(): LocalVideoTrack {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as LocalVideoTrack;
}

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
    ...overrides,
  };
}

const baseProps = {
  getParticipant: () => undefined,
  myIdentity: "profile:someone-else",
  needsMediaActivation: false,
  activateMedia: vi.fn(async () => {}),
  mediaError: null,
  onTapEmptySeat: vi.fn(),
  isJoiningSeat: false,
  localVideoTrack: null,
};

describe("SpeakerStage", () => {
  it("always renders both seats, occupied or not — issue #20's two-seat framing", () => {
    render(<SpeakerStage speakers={[speaker({ seat_number: 1 })]} orientation="portrait" {...baseProps} />);
    expect(screen.getByTestId("speaker-tile")).toBeInTheDocument();
    expect(screen.getByTestId("empty-seat")).toBeInTheDocument();
  });

  it("establishes a structural divider between the two seats, rendered but inert (issue #25 attaches real behavior later)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    const divider = screen.getByTestId("speaker-divider");
    expect(divider).toBeInTheDocument();
    // Not yet a button/interactive control — it has no function to expose
    // to assistive tech until #25 gives it one.
    expect(divider.tagName).toBe("DIV");
    expect(divider).toHaveAttribute("aria-hidden", "true");
  });

  it("lays the divider out horizontally between stacked seats in portrait, vertically between side-by-side seats in landscape", () => {
    const { rerender } = render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bh-2\b/);

    rerender(<SpeakerStage speakers={[]} orientation="landscape" {...baseProps} />);
    expect(screen.getByTestId("speaker-divider").className).toMatch(/\bw-2\b/);
  });

  it("renders no self-preview at all when there's no local video track — hidden entirely for an ordinary audience member, not an empty placeholder (issue #22)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    expect(screen.queryByTestId("self-preview")).not.toBeInTheDocument();
  });

  it("renders the real self-preview, anchored top-right, once a local video track is held (issue #22)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} localVideoTrack={fakeVideoTrack()} />);
    const slot = screen.getByTestId("self-preview");
    expect(slot).toBeInTheDocument();
    expect(slot.className).toMatch(/\btop-3\b/);
    expect(slot.className).not.toMatch(/\bbottom-3\b/);
  });

  it("establishes the scrim, invisible and inert by default so it never blocks a tap on a tile underneath (issue #21 animates it)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    const scrim = screen.getByTestId("room-scrim");
    expect(scrim).toBeInTheDocument();
    expect(scrim.className).toMatch(/\bopacity-0\b/);
    expect(scrim.className).toMatch(/\bpointer-events-none\b/);
  });

  describe("layering (real-device fix: the divider was bleeding across chat/controls)", () => {
    it("gives the stage its own contained stacking context (z-0, not just relative) so nothing inside it can escape to paint over a sibling overlay", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      expect(screen.getByTestId("room-stage").className).toMatch(/\bz-0\b/);
    });

    it("the divider carries no z-index of its own — it doesn't overlap the tiles, and the stage's own containment is what keeps it from crossing foreground UI, not a z-index race", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      expect(screen.getByTestId("speaker-divider").className).not.toMatch(/\bz-\d/);
    });

    it("the divider's center dot/handle is not rendered — no user-facing function yet, and it was part of the visual clutter real-device testing flagged", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      expect(screen.getByTestId("speaker-divider")).toBeEmptyDOMElement();
    });
  });

  describe("direct empty-seat join (issue #27)", () => {
    it("wires onTapEmptySeat into an empty tile's tap handler when the viewer isn't already speaking", () => {
      render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
      const [firstSeat] = screen.getAllByTestId("empty-seat");
      expect(firstSeat.tagName).toBe("BUTTON");

      fireEvent.click(firstSeat);
      expect(baseProps.onTapEmptySeat).toHaveBeenCalledTimes(1);
    });

    it("never offers the tap-to-join affordance on a viewer who already holds the other seat", () => {
      const onTapEmptySeat = vi.fn();
      render(
        <SpeakerStage
          speakers={[speaker({ seat_number: 1, profile_id: "p1" })]}
          orientation="portrait"
          {...baseProps}
          myIdentity="profile:p1"
          onTapEmptySeat={onTapEmptySeat}
        />,
      );
      const emptySeat = screen.getByTestId("empty-seat");
      expect(emptySeat.tagName).toBe("DIV");
      fireEvent.click(emptySeat);
      expect(onTapEmptySeat).not.toHaveBeenCalled();
    });
  });
});
