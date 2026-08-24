import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CountdownOverlay } from "./countdown-overlay";

describe("CountdownOverlay (issue #18 UX finding — center-stage 'Going live' transition)", () => {
  it("shows the suggested hierarchy: 'Going live', the number, the get-ready subtitle, and Cancel", () => {
    render(<CountdownOverlay countdown={3} onCancel={vi.fn()} />);
    expect(screen.getByText("Going live")).toBeInTheDocument();
    expect(screen.getByTestId("countdown-number")).toHaveTextContent("3");
    expect(screen.getByText(/get ready/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("the number is the dominant element — largest text size on the overlay", () => {
    render(<CountdownOverlay countdown={2} onCancel={vi.fn()} />);
    expect(screen.getByTestId("countdown-number").className).toMatch(/\btext-7xl\b/);
  });

  it("Cancel is visually secondary — no solid/accent treatment competing with the number", () => {
    render(<CountdownOverlay countdown={2} onCancel={vi.fn()} />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel.className).not.toMatch(/\bbg-accent\b/);
    expect(cancel.className).toMatch(/\btext-white\/60\b/);
  });

  it("clicking Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(<CountdownOverlay countdown={1} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("re-renders the number element (remounts) when the countdown value changes, so its pop animation replays each tick", () => {
    const { rerender } = render(<CountdownOverlay countdown={3} onCancel={vi.fn()} />);
    const first = screen.getByTestId("countdown-number");

    rerender(<CountdownOverlay countdown={2} onCancel={vi.fn()} />);
    const second = screen.getByTestId("countdown-number");
    expect(second).toHaveTextContent("2");
    expect(second).not.toBe(first);
  });

  it("captures pointer events on itself (it's meant to block interaction with whatever's behind it during the transition)", () => {
    render(<CountdownOverlay countdown={3} onCancel={vi.fn()} />);
    expect(screen.getByTestId("countdown-overlay").className).toMatch(/\bpointer-events-auto\b/);
  });
});
