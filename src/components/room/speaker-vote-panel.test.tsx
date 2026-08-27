import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerVotePanel } from "./speaker-vote-panel";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const { voteOnSpeakerRound } = vi.hoisted(() => ({ voteOnSpeakerRound: vi.fn() }));
vi.mock("@/app/events/[id]/room/actions", () => ({ voteOnSpeakerRound }));

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    media_inactive_since: null,
    round_number: 1,
    round_started_at: new Date().toISOString(),
    round_ends_at: new Date(Date.now() + 60_000).toISOString(),
    round_phase: "active",
    closing_ends_at: null,
    ...overrides,
  };
}

describe("SpeakerVotePanel (issue #21, Part 2 — Continue/Replace)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the inert Vote emblem when no seat is occupied", () => {
    render(<SpeakerVotePanel speakers={[]} isPreviewBuild={false} />);
    expect(screen.getByTestId("watch-vote-emblem")).toBeDisabled();
    expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();
  });

  it("does not open automatically — a viewer must tap it", () => {
    render(<SpeakerVotePanel speakers={[speaker()]} isPreviewBuild={false} />);
    expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();
  });

  it("tapping the emblem opens a compact panel, one row per occupied seat", () => {
    render(
      <SpeakerVotePanel
        speakers={[speaker({ id: "a", display_name: "Alex" }), speaker({ id: "b", display_name: "Sam" })]}
        isPreviewBuild={false}
      />,
    );
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    const rows = screen.getAllByTestId("speaker-vote-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Alex");
    expect(rows[1]).toHaveTextContent("Sam");
  });

  it("tapping the emblem again closes the panel", () => {
    render(<SpeakerVotePanel speakers={[speaker()]} isPreviewBuild={false} />);
    const emblem = screen.getByTestId("watch-vote-emblem");
    fireEvent.click(emblem);
    expect(screen.getByTestId("speaker-vote-panel")).toBeInTheDocument();
    fireEvent.click(emblem);
    expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();
  });

  it("voting Continue calls voteOnSpeakerRound with this speaker's own event_speakers id", () => {
    render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    fireEvent.click(screen.getByTestId("vote-continue"));
    expect(voteOnSpeakerRound).toHaveBeenCalledWith("s1", "continue");
  });

  it("voting Replace calls voteOnSpeakerRound with 'replace'", () => {
    render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    fireEvent.click(screen.getByTestId("vote-replace"));
    expect(voteOnSpeakerRound).toHaveBeenCalledWith("s1", "replace");
  });

  it("highlights whichever choice was just tapped", () => {
    render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    fireEvent.click(screen.getByTestId("vote-replace"));
    expect(screen.getByTestId("vote-replace")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("vote-continue")).toHaveAttribute("aria-pressed", "false");
  });

  it("a viewer can change their choice before the round resolves", () => {
    render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    fireEvent.click(screen.getByTestId("vote-continue"));
    fireEvent.click(screen.getByTestId("vote-replace"));
    expect(voteOnSpeakerRound).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("vote-replace")).toHaveAttribute("aria-pressed", "true");
  });

  it("disables both choices once the round is in its closing period — the outcome is already decided", () => {
    render(
      <SpeakerVotePanel
        speakers={[speaker({ id: "s1", round_phase: "closing", closing_ends_at: new Date(Date.now() + 20_000).toISOString() })]}
        isPreviewBuild={false}
      />,
    );
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    expect(screen.getByTestId("vote-continue")).toBeDisabled();
    expect(screen.getByTestId("vote-replace")).toBeDisabled();
  });

  it("resets the displayed choice when a new round begins (round_number changes)", () => {
    const { rerender } = render(
      <SpeakerVotePanel speakers={[speaker({ id: "s1", round_number: 1 })]} isPreviewBuild={false} />,
    );
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    fireEvent.click(screen.getByTestId("vote-replace"));
    expect(screen.getByTestId("vote-replace")).toHaveAttribute("aria-pressed", "true");

    rerender(<SpeakerVotePanel speakers={[speaker({ id: "s1", round_number: 2 })]} isPreviewBuild={false} />);
    expect(screen.getByTestId("vote-replace")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("vote-continue")).toHaveAttribute("aria-pressed", "false");
  });

  it("independent per-speaker choices: voting Replace for one speaker leaves the other's choice untouched", () => {
    render(
      <SpeakerVotePanel
        speakers={[speaker({ id: "a", display_name: "Alex" }), speaker({ id: "b", display_name: "Sam" })]}
        isPreviewBuild={false}
      />,
    );
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    const replaceButtons = screen.getAllByTestId("vote-replace");
    fireEvent.click(replaceButtons[0]); // vote replace for Alex only
    expect(voteOnSpeakerRound).toHaveBeenCalledWith("a", "replace");
    expect(voteOnSpeakerRound).not.toHaveBeenCalledWith("b", expect.anything());

    const continueButtons = screen.getAllByTestId("vote-continue");
    expect(continueButtons[1]).toHaveAttribute("aria-pressed", "false");
    expect(replaceButtons[1]).toHaveAttribute("aria-pressed", "false");
  });
});
