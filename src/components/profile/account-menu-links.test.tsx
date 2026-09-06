import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AccountMenuLinks } from "./account-menu-links";

/**
 * Issue #29, profile UX polish pass, Section 2/11: the one shared
 * definition of profile-navigation links, used by both `HomeAccountMenu`
 * and `RoomInfoOverlay` — tested once here rather than duplicating these
 * cases in both callers' own test files.
 */
describe("AccountMenuLinks", () => {
  it("shows My Profile + Edit Profile as two separate links when a username exists", () => {
    render(<AccountMenuLinks username="jamier" />);
    expect(screen.getByRole("link", { name: "My Profile" })).toHaveAttribute("href", "/profile/jamier");
    expect(screen.getByRole("link", { name: "Edit Profile" })).toHaveAttribute("href", "/profile/edit");
  });

  it("shows only Complete Profile, never My Profile, when no username is set yet", () => {
    render(<AccountMenuLinks username={null} />);
    expect(screen.getByRole("link", { name: "Complete Profile" })).toHaveAttribute("href", "/profile/edit");
    expect(screen.queryByRole("link", { name: "My Profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit Profile" })).not.toBeInTheDocument();
  });

  it("never links to a public profile route when there is no username", () => {
    render(<AccountMenuLinks username={null} />);
    for (const link of screen.getAllByRole("link")) {
      expect(link.getAttribute("href")).not.toMatch(/^\/profile\/(null|undefined)$/);
    }
  });

  it("calls onNavigate when a link is tapped", () => {
    const onNavigate = vi.fn();
    render(<AccountMenuLinks username="jamier" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole("link", { name: "My Profile" }));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
