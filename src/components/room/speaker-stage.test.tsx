import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpeakerStage } from "./speaker-stage";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

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

  it("establishes a stable, empty self-preview slot (issue #22 renders the local preview into it)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    const slot = screen.getByTestId("self-preview-slot");
    expect(slot).toBeInTheDocument();
    expect(slot).toBeEmptyDOMElement();
  });

  it("establishes the scrim, invisible and inert by default so it never blocks a tap on a tile underneath (issue #21 animates it)", () => {
    render(<SpeakerStage speakers={[]} orientation="portrait" {...baseProps} />);
    const scrim = screen.getByTestId("room-scrim");
    expect(scrim).toBeInTheDocument();
    expect(scrim.className).toMatch(/\bopacity-0\b/);
    expect(scrim.className).toMatch(/\bpointer-events-none\b/);
  });
});
