import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeakerVotePanel } from "./speaker-vote-panel";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const { voteOnSpeakerRound } = vi.hoisted(() => ({ voteOnSpeakerRound: vi.fn() }));
vi.mock("@/app/events/[id]/room/actions", () => ({ voteOnSpeakerRound }));

const { supabaseVotesData, supabaseFrom } = vi.hoisted(() => {
  const supabaseVotesData: { current: Array<{ event_speakers_id: string; choice: "continue" | "replace" }> } = { current: [] };
  const supabaseFrom = vi.fn(() => ({
    select: vi.fn(() => ({
      in: vi.fn(async () => ({ data: supabaseVotesData.current })),
    })),
  }));
  return { supabaseVotesData, supabaseFrom };
});

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: supabaseFrom }),
}));

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

describe("SpeakerVotePanel (issue #21, Part 2 — Continue/Replace; second corrective pass — sentiment display)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    supabaseVotesData.current = [];
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

  it("removes both choices entirely once the round is in its closing period — the outcome is already decided, not just disabled", () => {
    render(
      <SpeakerVotePanel
        speakers={[speaker({ id: "s1", round_phase: "closing", closing_ends_at: new Date(Date.now() + 20_000).toISOString() })]}
        isPreviewBuild={false}
      />,
    );
    fireEvent.click(screen.getByTestId("watch-vote-emblem"));
    expect(screen.queryByTestId("vote-continue")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vote-replace")).not.toBeInTheDocument();
    expect(screen.getByTestId("speaker-vote-locked")).toHaveTextContent("Replacement decided");
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

  describe("sentiment display (second corrective pass, Part 9-11)", () => {
    it("shows 'No votes yet' rather than a misleading 0%/0% when nobody has voted", async () => {
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      fireEvent.click(screen.getByTestId("watch-vote-emblem"));
      await waitFor(() => expect(supabaseFrom).toHaveBeenCalled());
      expect(screen.getByTestId("speaker-vote-sentiment")).toHaveTextContent("No votes yet");
    });

    it("shows Continue/Replace percentages once votes exist, computed from the authoritative tally", async () => {
      supabaseVotesData.current = [
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "replace" },
      ];
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      fireEvent.click(screen.getByTestId("watch-vote-emblem"));
      await waitFor(() => expect(screen.getByTestId("speaker-vote-sentiment")).toHaveTextContent("75%"));
      expect(screen.getByTestId("speaker-vote-sentiment")).toHaveTextContent("25%");
    });

    it("does not poll vote tallies until the panel is actually opened", () => {
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      expect(supabaseFrom).not.toHaveBeenCalled();
    });

    it("shows the viewer's own selection distinctly from the sentiment percentages", async () => {
      supabaseVotesData.current = [
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "replace" },
      ];
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      fireEvent.click(screen.getByTestId("watch-vote-emblem"));
      fireEvent.click(screen.getByTestId("vote-replace"));
      await waitFor(() => expect(screen.getByTestId("speaker-vote-sentiment")).toHaveTextContent("50%"));
      expect(screen.getByTestId("vote-replace")).toHaveAttribute("aria-pressed", "true");
    });
  });

  describe("tap-away dismissal (Part 2 — a transient overlay, not modal)", () => {
    it("tapping outside the open panel closes it", () => {
      render(
        <div>
          <div data-testid="outside">elsewhere</div>
          <SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />
        </div>,
      );
      fireEvent.click(screen.getByTestId("watch-vote-emblem"));
      expect(screen.getByTestId("speaker-vote-panel")).toBeInTheDocument();

      fireEvent.pointerDown(screen.getByTestId("outside"));
      expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();
    });

    it("pressing Escape closes the open panel", () => {
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      fireEvent.click(screen.getByTestId("watch-vote-emblem"));
      expect(screen.getByTestId("speaker-vote-panel")).toBeInTheDocument();

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();
    });

    it("interacting inside the panel (e.g. casting a vote) never closes it", () => {
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      fireEvent.click(screen.getByTestId("watch-vote-emblem"));

      fireEvent.pointerDown(screen.getByTestId("vote-continue"));
      fireEvent.click(screen.getByTestId("vote-continue"));
      expect(screen.getByTestId("speaker-vote-panel")).toBeInTheDocument();
    });

    it("closing the panel does not erase the viewer's vote — reopening shows the same selection", () => {
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      fireEvent.click(screen.getByTestId("watch-vote-emblem"));
      fireEvent.click(screen.getByTestId("vote-replace"));
      expect(voteOnSpeakerRound).toHaveBeenCalledWith("s1", "replace");

      fireEvent.keyDown(document, { key: "Escape" });
      expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("watch-vote-emblem"));
      expect(screen.getByTestId("vote-replace")).toHaveAttribute("aria-pressed", "true");
      // Reopening never re-casts the vote — only the one tap did.
      expect(voteOnSpeakerRound).toHaveBeenCalledTimes(1);
    });

    it("tapping the emblem again still toggles the panel closed, alongside the outside-tap/Escape dismissal", () => {
      render(<SpeakerVotePanel speakers={[speaker({ id: "s1" })]} isPreviewBuild={false} />);
      const emblem = screen.getByTestId("watch-vote-emblem");
      fireEvent.click(emblem);
      expect(screen.getByTestId("speaker-vote-panel")).toBeInTheDocument();
      fireEvent.click(emblem);
      expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();
    });
  });

  describe("final-10s emphasis (Part 13)", () => {
    it("shows a 'Vote · Ns' countdown on the trigger once a round nears its shared deadline", () => {
      render(
        <SpeakerVotePanel speakers={[speaker({ id: "s1", round_ends_at: new Date(Date.now() + 8_000).toISOString() })]} isPreviewBuild={false} />,
      );
      expect(screen.getByTestId("vote-emphasis-countdown")).toBeInTheDocument();
    });

    it("shows no countdown far from the deadline", () => {
      render(
        <SpeakerVotePanel speakers={[speaker({ id: "s1", round_ends_at: new Date(Date.now() + 45_000).toISOString() })]} isPreviewBuild={false} />,
      );
      expect(screen.queryByTestId("vote-emphasis-countdown")).not.toBeInTheDocument();
    });

    it("does not open the panel automatically just because the deadline is near", () => {
      render(
        <SpeakerVotePanel speakers={[speaker({ id: "s1", round_ends_at: new Date(Date.now() + 8_000).toISOString() })]} isPreviewBuild={false} />,
      );
      expect(screen.queryByTestId("speaker-vote-panel")).not.toBeInTheDocument();
    });
  });
});
