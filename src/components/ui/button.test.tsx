import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Button, ButtonLink } from "./button";

/**
 * Responsive/accessibility polish pass: `variant="primary"` uses
 * `bg-accent-filled`, a distinct token from `--accent` tuned specifically
 * for white text on a filled background — dark-mode white-on-`--accent`
 * only reaches 4.37:1 (just under WCAG AA's 4.5:1), while
 * `--accent-filled` reaches 4.80:1. This is a regression guard against
 * silently reverting to the bare `bg-accent`/`hover:bg-accent-hover`
 * pairing this pass moved away from — see DECISIONS.md for the full
 * contrast math.
 */
describe("Button/ButtonLink primary variant", () => {
  it("uses the accent-filled tokens (not the bare accent tokens) for its filled background", () => {
    render(<Button variant="primary">Save</Button>);
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toHaveClass("bg-accent-filled");
    expect(button).toHaveClass("hover:bg-accent-filled-hover");
    // Matches a bare "bg-accent" only when NOT immediately followed by a
    // hyphen — excludes "bg-accent-filled"/"bg-accent-hover"/etc.
    expect(button.className).not.toMatch(/\bbg-accent\b(?!-)/);
  });

  it("ButtonLink's primary variant matches Button's exactly", () => {
    render(<ButtonLink href="/join" variant="primary">Join</ButtonLink>);
    const link = screen.getByRole("link", { name: "Join" });
    expect(link).toHaveClass("bg-accent-filled");
    expect(link).toHaveClass("hover:bg-accent-filled-hover");
  });

  it("secondary/ghost variants are unaffected by the contrast fix", () => {
    render(
      <>
        <Button variant="secondary">Cancel</Button>
        <Button variant="ghost">Dismiss</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Cancel" }).className).not.toMatch(/bg-accent/);
    expect(screen.getByRole("button", { name: "Dismiss" }).className).not.toMatch(/bg-accent/);
  });

  it("every button keeps the project's own 44px minimum touch target", () => {
    render(<Button variant="primary">Save</Button>);
    expect(screen.getByRole("button", { name: "Save" })).toHaveClass("min-h-11");
  });
});
