import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReactionPanel } from "./reaction-panel";
import { REACTION_EMOJI_SET } from "@/lib/reactions/constants";

describe("ReactionPanel (pre-launch interaction pass, Section 1)", () => {
  function setup(overrides: Partial<Parameters<typeof ReactionPanel>[0]> = {}) {
    const props = {
      open: true,
      onClose: vi.fn(),
      selectedEmoji: "❤️" as const,
      onSelectEmoji: vi.fn(),
      displayMode: "on-speaker" as const,
      onSelectDisplayMode: vi.fn(),
      showReactions: true,
      onToggleShowReactions: vi.fn(),
      ...overrides,
    };
    render(<ReactionPanel {...props} />);
    return props;
  }

  it("renders nothing when closed", () => {
    setup({ open: false });
    expect(screen.queryByTestId("reaction-panel")).not.toBeInTheDocument();
  });

  it("shows every emoji in the curated set — never a full emoji keyboard", () => {
    setup();
    for (const emoji of REACTION_EMOJI_SET) {
      expect(screen.getByTestId(`reaction-emoji-option-${emoji}`)).toBeInTheDocument();
    }
  });

  it("selecting an emoji calls onSelectEmoji — never sends a reaction, there is no send action wired here at all", () => {
    const { onSelectEmoji } = setup();
    fireEvent.click(screen.getByTestId("reaction-emoji-option-🔥"));
    expect(onSelectEmoji).toHaveBeenCalledWith("🔥");
    expect(onSelectEmoji).toHaveBeenCalledTimes(1);
  });

  it("teaches the double-tap gesture, naming the currently selected emoji", () => {
    setup({ selectedEmoji: "😂" });
    expect(screen.getByTestId("reaction-gesture-hint")).toHaveTextContent("Double-tap a speaker to react with");
    expect(screen.getByTestId("reaction-gesture-hint")).toHaveTextContent("😂");
  });

  it("updates the gesture hint when a different emoji is the current selection", () => {
    setup({ selectedEmoji: "👏" });
    expect(screen.getByTestId("reaction-gesture-hint")).toHaveTextContent("👏");
  });

  it("marks the currently selected emoji as pressed", () => {
    setup({ selectedEmoji: "💀" });
    expect(screen.getByTestId("reaction-emoji-option-💀")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("reaction-emoji-option-❤️")).toHaveAttribute("aria-pressed", "false");
  });

  it("choosing On speaker calls onSelectDisplayMode with 'on-speaker'", () => {
    const { onSelectDisplayMode } = setup({ displayMode: "side" });
    fireEvent.click(screen.getByTestId("reaction-display-on-speaker"));
    expect(onSelectDisplayMode).toHaveBeenCalledWith("on-speaker");
  });

  it("choosing Side calls onSelectDisplayMode with 'side'", () => {
    const { onSelectDisplayMode } = setup({ displayMode: "on-speaker" });
    fireEvent.click(screen.getByTestId("reaction-display-side"));
    expect(onSelectDisplayMode).toHaveBeenCalledWith("side");
  });

  it("toggling Show reactions off calls onToggleShowReactions(false)", () => {
    const { onToggleShowReactions } = setup({ showReactions: true });
    fireEvent.click(screen.getByTestId("reaction-show-off"));
    expect(onToggleShowReactions).toHaveBeenCalledWith(false);
  });

  it("toggling Show reactions back on calls onToggleShowReactions(true)", () => {
    const { onToggleShowReactions } = setup({ showReactions: false });
    fireEvent.click(screen.getByTestId("reaction-show-on"));
    expect(onToggleShowReactions).toHaveBeenCalledWith(true);
  });

  it("closes on a backdrop click", () => {
    const { onClose } = setup();
    fireEvent.click(screen.getByTestId("reaction-panel-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not listen for Escape while closed", () => {
    const { onClose } = setup({ open: false });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
