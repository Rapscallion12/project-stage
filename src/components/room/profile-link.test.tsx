import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProfileLink } from "./profile-link";

/**
 * Issue #29, Section 24: covers the two behaviors Section 15 explicitly
 * calls out as the real risk of this feature — (1) a registered user's
 * identity becomes tappable into their profile, and (2) that tap must
 * never also fire whatever click handler the surrounding
 * comment/speaker-tile/RTS-row element already owns (a vote, a like, a
 * comment tap-to-expand, a speaker control).
 */
describe("ProfileLink", () => {
  it("renders a real link to /profile/[username] when a username is present", () => {
    render(
      <ProfileLink username="jaceb">
        <span>Jace</span>
      </ProfileLink>,
    );
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/profile/jaceb");
  });

  it("renders a plain, non-interactive span when username is null (guest, or no username chosen yet)", () => {
    render(
      <ProfileLink username={null}>
        <span>Guest</span>
      </ProfileLink>,
    );
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText("Guest")).toBeInTheDocument();
  });

  it("stops the click from reaching a parent's own onClick handler", () => {
    const parentHandler = vi.fn();
    render(
      <div onClick={parentHandler} data-testid="parent">
        <ProfileLink username="jaceb">
          <span>Jace</span>
        </ProfileLink>
      </div>,
    );
    fireEvent.click(screen.getByRole("link"));
    expect(parentHandler).not.toHaveBeenCalled();
  });

  it("a non-navigable (null username) identity still lets the parent's own click handler fire normally", () => {
    // The guest/no-username case renders a plain span specifically so it
    // does NOT swallow clicks — e.g. an ambient comment row's own
    // tap-to-expand must keep working for a guest's message.
    const parentHandler = vi.fn();
    render(
      <div onClick={parentHandler} data-testid="parent">
        <ProfileLink username={null}>
          <span>Guest</span>
        </ProfileLink>
      </div>,
    );
    fireEvent.click(screen.getByText("Guest"));
    expect(parentHandler).toHaveBeenCalledTimes(1);
  });
});
