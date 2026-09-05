import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OnSpeakerReactionBursts, ReactionSideLane } from "./stage-reactions-overlay";
import type { IncomingStageReaction } from "@/hooks/use-stage-reactions";

function reaction(overrides: Partial<IncomingStageReaction> = {}): IncomingStageReaction {
  return {
    id: "r1",
    targetIdentity: "profile:alice",
    emoji: "❤️",
    x: 0.5,
    y: 0.5,
    senderIdentity: "guest:g1",
    ts: Date.now(),
    ...overrides,
  };
}

describe("OnSpeakerReactionBursts (pre-launch interaction pass, Section 3)", () => {
  it("renders nothing when there are no reactions", () => {
    const { container } = render(<OnSpeakerReactionBursts reactions={[]} />);
    expect(container.querySelectorAll("span")).toHaveLength(0);
  });

  it("positions a burst at the normalized tile-relative coordinates it was sent with", () => {
    render(<OnSpeakerReactionBursts reactions={[reaction({ x: 0.64, y: 0.31 })]} />);
    const burst = screen.getByText("❤️");
    expect(burst.style.left).toBe("64%");
    expect(burst.style.top).toBe("31%");
  });

  it("renders one burst per incoming reaction", () => {
    render(
      <OnSpeakerReactionBursts
        reactions={[reaction({ id: "a", emoji: "❤️" }), reaction({ id: "b", emoji: "🔥" })]}
      />,
    );
    expect(screen.getByText("❤️")).toBeInTheDocument();
    expect(screen.getByText("🔥")).toBeInTheDocument();
  });

  it("is purely decorative and click-through — never intercepts the next double-tap", () => {
    const { container } = render(<OnSpeakerReactionBursts reactions={[reaction()]} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.className).toMatch(/\bpointer-events-none\b/);
    expect(root).toHaveAttribute("aria-hidden", "true");
  });

  it("gives two different reactions distinct drift/rotation derived from their own id — not perfectly stacked", () => {
    render(<OnSpeakerReactionBursts reactions={[reaction({ id: "aaa" }), reaction({ id: "zzz" })]} />);
    const spans = screen.getAllByText("❤️");
    const a = spans[0].style.getPropertyValue("--drift-x");
    const b = spans[1].style.getPropertyValue("--drift-x");
    expect(a).not.toBe(b);
  });
});

describe("ReactionSideLane (pre-launch interaction pass, Section 4B)", () => {
  it("renders regardless of which speaker a reaction targeted — Side mode isn't scoped to one seat", () => {
    render(
      <ReactionSideLane
        reactions={[reaction({ id: "a", targetIdentity: "profile:alice" }), reaction({ id: "b", targetIdentity: "profile:bob" })]}
      />,
    );
    expect(screen.getByTestId("reaction-side-lane")).toBeInTheDocument();
    expect(screen.getAllByText("❤️")).toHaveLength(2);
  });

  it("caps the visible lane to the most recent handful — never grows unbounded", () => {
    const many = Array.from({ length: 20 }, (_, i) => reaction({ id: `r${i}`, emoji: "😂" }));
    render(<ReactionSideLane reactions={many} />);
    expect(screen.getAllByText("😂").length).toBeLessThanOrEqual(8);
  });

  it("is purely decorative, click-through", () => {
    render(<ReactionSideLane reactions={[reaction()]} />);
    const lane = screen.getByTestId("reaction-side-lane");
    expect(lane.className).toMatch(/\bpointer-events-none\b/);
    expect(lane).toHaveAttribute("aria-hidden", "true");
  });

  describe("region (real-device follow-up: Side mode must preserve which speaker was targeted)", () => {
    it("region='top' gets its own distinct testid and an upper-stage position", () => {
      render(<ReactionSideLane reactions={[reaction()]} region="top" />);
      expect(screen.queryByTestId("reaction-side-lane")).not.toBeInTheDocument();
      const lane = screen.getByTestId("reaction-side-lane-top");
      expect(lane.className).toMatch(/top-\[18%\]/);
    });

    it("region='bottom' gets its own distinct testid and a lower-stage position", () => {
      render(<ReactionSideLane reactions={[reaction()]} region="bottom" />);
      expect(screen.queryByTestId("reaction-side-lane")).not.toBeInTheDocument();
      const lane = screen.getByTestId("reaction-side-lane-bottom");
      expect(lane.className).toMatch(/bottom-\[12%\]/);
    });

    it("omitting region keeps the original single-lane testid and position — landscape/solo scope is unchanged", () => {
      render(<ReactionSideLane reactions={[reaction()]} />);
      const lane = screen.getByTestId("reaction-side-lane");
      expect(lane.className).toMatch(/bottom-24/);
    });
  });
});
