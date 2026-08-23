import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WatchModeControls } from "./watch-mode-controls";

describe("WatchModeControls (issue #21, 05 interaction model, Phase 1: static shell — all four controls visible but inert)", () => {
  it("renders all four controls: composer, react, vote, gift", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-composer")).toBeInTheDocument();
    expect(screen.getByTestId("watch-emoji-emblem")).toBeInTheDocument();
    expect(screen.getByTestId("watch-vote-emblem")).toBeInTheDocument();
    expect(screen.getByTestId("watch-gift-emblem")).toBeInTheDocument();
  });

  it("every control is disabled in this phase — visually present, not yet operable", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-composer")).toBeDisabled();
    expect(screen.getByTestId("watch-emoji-emblem")).toBeDisabled();
    expect(screen.getByTestId("watch-vote-emblem")).toBeDisabled();
    expect(screen.getByTestId("watch-gift-emblem")).toBeDisabled();
  });

  it("the composer shows the placeholder text and a mic icon, not a real input", () => {
    render(<WatchModeControls />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("Add a comment…")).toBeInTheDocument();
  });

  it("each control emblem has an accessible label", () => {
    render(<WatchModeControls />);
    expect(screen.getByTestId("watch-emoji-emblem")).toHaveAccessibleName("React");
    expect(screen.getByTestId("watch-vote-emblem")).toHaveAccessibleName("Vote");
    expect(screen.getByTestId("watch-gift-emblem")).toHaveAccessibleName("Gift");
  });
});
