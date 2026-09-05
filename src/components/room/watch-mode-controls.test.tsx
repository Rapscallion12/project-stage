import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WatchModeControls } from "./watch-mode-controls";

describe("WatchModeControls (issue #21, 05 interaction model)", () => {
  it("renders composer, react, vote — no gift emblem (pre-launch interaction pass: gifting isn't implemented, the dead affordance was removed)", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-composer")).toBeInTheDocument();
    expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
    expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
    expect(screen.queryByTestId("watch-gift-emblem")).not.toBeInTheDocument();
    expect(screen.queryByText("🎁")).not.toBeInTheDocument();
  });

  it("React/Vote are disabled placeholders when the caller supplies no real slot", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-emoji-emblem")).toBeDisabled();
    expect(screen.getByTestId("watch-vote-emblem")).toBeDisabled();
  });

  it("without a composer prop, falls back to the original Phase 1 disabled placeholder", () => {
    render(<WatchModeControls />);
    const composer = screen.getByTestId("watch-composer");
    expect(composer).toBeDisabled();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Add a comment…")).toBeInTheDocument();
  });

  it("each control emblem has an accessible label", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-emoji-emblem")).toHaveAccessibleName("React");
    expect(screen.getByTestId("watch-vote-emblem")).toHaveAccessibleName("Vote");
  });

  describe("composer slot (issue #21, '05 — Social Stage' Phase 2)", () => {
    it("renders the supplied composer in place of the inert placeholder", () => {
      render(<WatchModeControls composer={<input placeholder="Add a comment…" />} />);
      expect(screen.queryByTestId("watch-composer")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
    });

    it("still renders React/Vote alongside a supplied composer", () => {
      render(<WatchModeControls composer={<input placeholder="Add a comment…" />} />);
      expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
      expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
    });
  });

  describe("micCameraSlot (issue #18, Speaker View UI cleanup — replaces React/Vote)", () => {
    it("replaces React/Vote with the supplied slot", () => {
      render(<WatchModeControls micCameraSlot={<button data-testid="fake-mic-toggle">mic</button>} />);
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-vote-emblem")).not.toBeInTheDocument();
      expect(screen.getByTestId("fake-mic-toggle")).toBeInTheDocument();
    });

    it("without micCameraSlot, ordinary Watch Mode keeps React/Vote exactly as before — purely additive", () => {
      render(<WatchModeControls />);
      expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
      expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
    });
  });

  describe("reactionSlot (pre-launch interaction pass): activates the React position with a real control", () => {
    it("renders the supplied reaction slot in place of the inert React placeholder", () => {
      render(<WatchModeControls reactionSlot={<button data-testid="fake-reaction-control">react</button>} />);
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
      expect(screen.getByTestId("fake-reaction-control")).toBeInTheDocument();
      // Vote stays the ordinary inert placeholder unless voteSlot is also supplied.
      expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
    });

    it("micCameraSlot still takes precedence over reactionSlot — Speaker View's mic/camera pair, not a reaction control", () => {
      render(
        <WatchModeControls
          micCameraSlot={<button data-testid="fake-mic-toggle">mic</button>}
          reactionSlot={<button data-testid="fake-reaction-control">react</button>}
        />,
      );
      expect(screen.getByTestId("fake-mic-toggle")).toBeInTheDocument();
      expect(screen.queryByTestId("fake-reaction-control")).not.toBeInTheDocument();
    });
  });

  describe("idle adaptive transparency (pre-launch interaction pass, Section 8)", () => {
    it("defaults to the full-opacity glass background on the inert placeholders", () => {
      render(<WatchModeControls />);
      expect(screen.getByTestId("watch-composer").className).toMatch(/bg-white\/\[0\.14\]/);
      expect(screen.getByTestId("watch-vote-emblem").className).toMatch(/bg-white\/\[0\.14\]/);
    });

    it("fades the inert placeholders' own backgrounds when idle — never removes them or affects the emoji/text foreground", () => {
      render(<WatchModeControls idle />);
      const composer = screen.getByTestId("watch-composer");
      const vote = screen.getByTestId("watch-vote-emblem");
      expect(composer.className).toMatch(/bg-white\/\[0\.06\]/);
      expect(vote.className).toMatch(/bg-white\/\[0\.06\]/);
      expect(screen.getByText("Add a comment…")).toBeInTheDocument();
      expect(screen.getByText("🗳")).toBeInTheDocument();
    });
  });
});
