import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ReactionControl } from "./reaction-control";
import type { ReactionsController } from "@/hooks/use-stage-reactions";

function fixture(overrides: Partial<ReactionsController> = {}): ReactionsController {
  return {
    selectedEmoji: "❤️",
    setSelectedEmoji: vi.fn(),
    displayMode: "on-speaker",
    setDisplayMode: vi.fn(),
    showReactions: true,
    setShowReactions: vi.fn(),
    incoming: [],
    send: vi.fn(async () => ({ ok: true as const, heatAfter: 0, inCooldownAfter: false })),
    heat: 0,
    heatFraction: 0,
    inCooldown: false,
    canSend: true,
    ...overrides,
  };
}

describe("ReactionControl (pre-launch interaction pass): the button + its own panel, wired to one shared controller", () => {
  it("tapping the button opens the panel — sends nothing", () => {
    const reactions = fixture();
    render(<ReactionControl reactions={reactions} />);
    expect(screen.queryByTestId("reaction-panel")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("watch-emoji-emblem"));
    expect(screen.getByTestId("reaction-panel")).toBeInTheDocument();
    expect(reactions.send).not.toHaveBeenCalled();
  });

  it("tapping the button again closes the panel", () => {
    const reactions = fixture();
    render(<ReactionControl reactions={reactions} />);
    fireEvent.click(screen.getByTestId("watch-emoji-emblem"));
    fireEvent.click(screen.getByTestId("watch-emoji-emblem"));
    expect(screen.queryByTestId("reaction-panel")).not.toBeInTheDocument();
  });

  it("the button reflects the controller's own currently selected emoji", () => {
    render(<ReactionControl reactions={fixture({ selectedEmoji: "🔥" })} />);
    expect(screen.getByTestId("watch-emoji-emblem")).toHaveTextContent("🔥");
  });

  it("selecting a different emoji in the panel calls the controller's setter — never sends", () => {
    const reactions = fixture();
    render(<ReactionControl reactions={reactions} />);
    fireEvent.click(screen.getByTestId("watch-emoji-emblem"));
    fireEvent.click(screen.getByTestId("reaction-emoji-option-👏"));
    expect(reactions.setSelectedEmoji).toHaveBeenCalledWith("👏");
    expect(reactions.send).not.toHaveBeenCalled();
  });

  it("notifies onOpenChange when the panel opens and closes — lets the caller hold idle-activity active while it's open", () => {
    const onOpenChange = vi.fn();
    render(<ReactionControl reactions={fixture()} onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByTestId("watch-emoji-emblem"));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("reaction-panel-backdrop"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("passes heat/cooldown straight through to the button", () => {
    render(<ReactionControl reactions={fixture({ heatFraction: 0.9, inCooldown: true })} />);
    const fill = screen.getByTestId("reaction-heat-fill");
    expect(fill.style.transform).toBe("scale(0.9)");
  });

  it("passes idle through to the button's own background treatment", () => {
    render(<ReactionControl reactions={fixture()} idle />);
    expect(screen.getByTestId("watch-emoji-emblem").className).toMatch(/bg-white\/\[0\.06\]/);
  });
});
