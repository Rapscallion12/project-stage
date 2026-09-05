import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StageOverlayShell } from "./stage-overlay-shell";

describe("StageOverlayShell (real-device finding: an actionable tile could end up under this overlay)", () => {
  it("the outer layer is click-through; only the inner content wrapper captures taps", () => {
    render(
      <StageOverlayShell>
        <button type="button">Do something</button>
      </StageOverlayShell>,
    );
    const outer = screen.getByTestId("stage-bottom-overlay");
    expect(outer.className).toMatch(/\bpointer-events-none\b/);
    const inner = outer.firstElementChild as HTMLElement;
    expect(inner.className).toMatch(/\bpointer-events-auto\b/);
    expect(inner).toContainElement(screen.getByRole("button", { name: "Do something" }));
  });

  it("defaults to portrait's top padding when none is given", () => {
    render(<StageOverlayShell>content</StageOverlayShell>);
    expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bpt-14\b/);
  });

  it("accepts a caller-supplied top padding (mobile landscape needs a shorter one)", () => {
    render(<StageOverlayShell topClassName="pt-8">content</StageOverlayShell>);
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.className).toMatch(/\bpt-8\b/);
    expect(overlay.className).not.toMatch(/\bpt-14\b/);
  });

  it("stays anchored to the bottom, above the stage (z-10 vs the stage's z-0)", () => {
    render(<StageOverlayShell>content</StageOverlayShell>);
    const overlay = screen.getByTestId("stage-bottom-overlay");
    expect(overlay.className).toMatch(/\babsolute\b/);
    expect(overlay.className).toMatch(/\bbottom-0\b/);
    expect(overlay.className).toMatch(/\bz-10\b/);
  });

  describe("gradient opt-out (issue #21, 05 interaction model: small glass emblems carry their own legibility, not a full-height wash)", () => {
    it("defaults to the existing gradient wash — unchanged for callers that don't opt out", () => {
      render(<StageOverlayShell>content</StageOverlayShell>);
      expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bfrom-black\/90\b/);
    });

    it("omits the gradient entirely when gradient={false}, keeping the click-through structure intact", () => {
      render(
        <StageOverlayShell gradient={false}>
          <button type="button">Do something</button>
        </StageOverlayShell>,
      );
      const overlay = screen.getByTestId("stage-bottom-overlay");
      expect(overlay.className).not.toMatch(/\bfrom-black\/90\b/);
      expect(overlay.className).toMatch(/\bpointer-events-none\b/);
      const inner = overlay.firstElementChild as HTMLElement;
      expect(inner.className).toMatch(/\bpointer-events-auto\b/);
    });
  });

  describe("idle adaptive transparency (pre-launch interaction pass, Section 8)", () => {
    it("defaults to the full-opacity gradient — unaffected until a caller opts in", () => {
      render(<StageOverlayShell>content</StageOverlayShell>);
      expect(screen.getByTestId("stage-bottom-overlay").className).not.toMatch(/\bopacity-50\b/);
    });

    it("fades the gradient's own opacity when idle", () => {
      render(<StageOverlayShell idle>content</StageOverlayShell>);
      expect(screen.getByTestId("stage-bottom-overlay").className).toMatch(/\bopacity-50\b/);
    });

    it("never affects the inner, pointer-events-auto content wrapper — foreground stays fully opaque and interactive regardless of idle", () => {
      render(
        <StageOverlayShell idle>
          <button type="button">Do something</button>
        </StageOverlayShell>,
      );
      const overlay = screen.getByTestId("stage-bottom-overlay");
      const inner = overlay.firstElementChild as HTMLElement;
      expect(inner.className).not.toMatch(/\bopacity-50\b/);
      expect(inner.className).toMatch(/\bpointer-events-auto\b/);
      expect(screen.getByRole("button", { name: "Do something" })).toBeEnabled();
    });

    it("does nothing when gradient is already off (idle has nothing to fade) — no stray opacity class applied to a non-existent gradient", () => {
      render(
        <StageOverlayShell gradient={false} idle>
          content
        </StageOverlayShell>,
      );
      const overlay = screen.getByTestId("stage-bottom-overlay");
      expect(overlay.className).not.toMatch(/\bopacity-50\b/);
    });

    it("exposes the idle state via a data attribute for real-device/visual inspection", () => {
      const { rerender } = render(<StageOverlayShell idle={false}>content</StageOverlayShell>);
      expect(screen.getByTestId("stage-bottom-overlay")).toHaveAttribute("data-idle", "false");
      rerender(<StageOverlayShell idle={true}>content</StageOverlayShell>);
      expect(screen.getByTestId("stage-bottom-overlay")).toHaveAttribute("data-idle", "true");
    });
  });
});
