import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SimButton } from "./sim-button";

/**
 * Issue #21, seventh corrective pass, Sections 21-26, 44: the shared
 * tactile-feedback control every Session Simulator button now uses.
 * These tests exercise real pointer events (`fireEvent.pointerDown`/
 * `pointerUp`/etc.) — never `:hover` — per Section 24's explicit "must
 * not depend on `:hover`... make sure this works on iPhone Safari."
 */
describe("SimButton", () => {
  it("shows a pressed state (brightness-75) while a pointer is down, and releases it on pointer up", () => {
    render(<SimButton onClick={() => {}} className="rounded bg-white/10 px-2 py-1">Tap me</SimButton>);
    const button = screen.getByRole("button", { name: "Tap me" });
    expect(button.className).not.toMatch(/brightness-75/);

    fireEvent.pointerDown(button, { pointerType: "touch" });
    expect(button.className).toMatch(/brightness-75/);

    fireEvent.pointerUp(button, { pointerType: "touch" });
    expect(button.className).not.toMatch(/brightness-75/);
  });

  it("releases the pressed state on pointer leave — a finger dragging off before lifting must not leave it stuck", () => {
    render(<SimButton onClick={() => {}} className="rounded bg-white/10 px-2 py-1">Tap me</SimButton>);
    const button = screen.getByRole("button", { name: "Tap me" });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.pointerLeave(button, { pointerType: "touch" });
    expect(button.className).not.toMatch(/brightness-75/);
  });

  it("releases the pressed state on pointer cancel", () => {
    render(<SimButton onClick={() => {}} className="rounded bg-white/10 px-2 py-1">Tap me</SimButton>);
    const button = screen.getByRole("button", { name: "Tap me" });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.pointerCancel(button);
    expect(button.className).not.toMatch(/brightness-75/);
  });

  it("never depends on hover — a plain mouseEnter/mouseOver produces no pressed state at all", () => {
    render(<SimButton onClick={() => {}} className="rounded bg-white/10 px-2 py-1">Tap me</SimButton>);
    const button = screen.getByRole("button", { name: "Tap me" });
    fireEvent.mouseEnter(button);
    fireEvent.mouseOver(button);
    expect(button.className).not.toMatch(/brightness-75/);
  });

  it("enters an executing, disabled state for the duration of an async onClick, and returns to normal once it resolves", async () => {
    let resolveClick: () => void = () => {};
    const onClick = vi.fn(() => new Promise<void>((resolve) => (resolveClick = resolve)));
    render(<SimButton onClick={onClick} className="rounded bg-white/10 px-2 py-1">Reset Session</SimButton>);
    const button = screen.getByRole("button", { name: "Reset Session" });

    fireEvent.click(button);
    expect(button).toBeDisabled();
    expect(button.className).toMatch(/opacity-60/);

    resolveClick();
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  it("prevents a second concurrent invocation while an async onClick is still in flight — no duplicate reset", async () => {
    let resolveClick: () => void = () => {};
    const onClick = vi.fn(() => new Promise<void>((resolve) => (resolveClick = resolve)));
    render(<SimButton onClick={onClick} className="rounded bg-white/10 px-2 py-1">Reset Session</SimButton>);
    const button = screen.getByRole("button", { name: "Reset Session" });

    fireEvent.click(button);
    fireEvent.click(button); // fires while disabled — a real browser wouldn't even deliver this, but belt and suspenders
    expect(onClick).toHaveBeenCalledTimes(1);

    resolveClick();
    await Promise.resolve();
  });

  it("does not enter the executing/disabled state for a synchronous onClick — repeated taps stay just as responsive (Section 25)", () => {
    const onClick = vi.fn();
    render(<SimButton onClick={onClick} className="rounded bg-white/10 px-2 py-1">Generate Comments</SimButton>);
    const button = screen.getByRole("button", { name: "Generate Comments" });

    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(3);
    expect(button).not.toBeDisabled();
  });

  it("respects an externally-passed disabled prop independent of its own executing state", () => {
    render(
      <SimButton onClick={() => {}} disabled className="rounded bg-white/10 px-2 py-1">
        Stop Simulation
      </SimButton>,
    );
    expect(screen.getByRole("button", { name: "Stop Simulation" })).toBeDisabled();
  });
});
