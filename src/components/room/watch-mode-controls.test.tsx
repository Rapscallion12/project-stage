import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WatchModeControls } from "./watch-mode-controls";

describe("WatchModeControls (issue #21, 05 interaction model)", () => {
  it("renders all four controls: composer, react, vote, gift", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-composer")).toBeInTheDocument();
    expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
    expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
    expect(screen.getByTestId("watch-gift-emblem")).toBeInTheDocument();
  });

  it("React/Vote/Gift are disabled — inert until their own later phase", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-emoji-emblem")).toBeDisabled();
    expect(screen.getByTestId("watch-vote-emblem")).toBeDisabled();
    expect(screen.getByTestId("watch-gift-emblem")).toBeDisabled();
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
    expect(screen.getByTestId("watch-gift-emblem")).toHaveAccessibleName("Gift");
  });

  describe("composer slot (issue #21, '05 — Social Stage' Phase 2)", () => {
    it("renders the supplied composer in place of the inert placeholder", () => {
      render(<WatchModeControls composer={<input placeholder="Add a comment…" />} />);
      expect(screen.queryByTestId("watch-composer")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
    });

    it("still renders React/Vote/Gift alongside a supplied composer", () => {
      render(<WatchModeControls composer={<input placeholder="Add a comment…" />} />);
      expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
      expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
      expect(screen.getByTestId("watch-gift-emblem")).toBeInTheDocument();
    });
  });

  describe("micCameraSlot (issue #18, Speaker View UI cleanup — replaces React/Vote, Gift stays)", () => {
    it("replaces React/Vote with the supplied slot, Gift unaffected", () => {
      render(<WatchModeControls micCameraSlot={<button data-testid="fake-mic-toggle">mic</button>} />);
      expect(screen.queryByTestId("watch-emoji-emblem")).not.toBeInTheDocument();
      expect(screen.queryByTestId("watch-vote-emblem")).not.toBeInTheDocument();
      expect(screen.getByTestId("fake-mic-toggle")).toBeInTheDocument();
      expect(screen.getByTestId("watch-gift-emblem")).toBeInTheDocument();
    });

    it("without micCameraSlot, ordinary Watch Mode keeps React/Vote exactly as before — purely additive", () => {
      render(<WatchModeControls />);
      expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
      expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
    });
  });
});
