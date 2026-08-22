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
});
