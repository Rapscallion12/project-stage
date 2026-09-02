import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HomeAccountMenu } from "./home-account-menu";

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

/**
 * Issue #29, profile UX polish pass, Section 1/13: the home header's own
 * avatar-triggered account menu — replaces the old bare email + full-width
 * Log out button real-iPhone feedback found unusable.
 */
describe("HomeAccountMenu", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a photo avatar as the trigger when one exists", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl="https://example.com/a.jpg" />);
    const trigger = screen.getByTestId("home-account-avatar-trigger");
    expect(trigger.querySelector("img")).toHaveAttribute("src", "https://example.com/a.jpg");
  });

  it("falls back to the shared initials avatar when no photo is set", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />);
    const trigger = screen.getByTestId("home-account-avatar-trigger");
    expect(trigger.querySelector("img")).not.toBeInTheDocument();
    expect(screen.getByTestId("participant-avatar-initials")).toHaveTextContent("JA");
  });

  it("does not show the menu panel until the avatar is tapped", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />);
    expect(screen.queryByTestId("home-account-menu-panel")).not.toBeInTheDocument();
  });

  it("opens the menu on tap, showing display name, profile links, and Log out", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />);
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    const panel = screen.getByTestId("home-account-menu-panel");
    expect(panel).toHaveTextContent("Jamie Rivera");
    expect(screen.getByRole("link", { name: "My Profile" })).toHaveAttribute("href", "/profile/jamier");
    expect(screen.getByRole("link", { name: "Edit Profile" })).toHaveAttribute("href", "/profile/edit");
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("routes to Complete Profile instead of My Profile when no username is set yet", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username={null} avatarUrl={null} />);
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    expect(screen.getByRole("link", { name: "Complete Profile" })).toHaveAttribute("href", "/profile/edit");
    expect(screen.queryByRole("link", { name: "My Profile" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Edit Profile" })).not.toBeInTheDocument();
  });

  it("closes the menu again on a second tap of the avatar", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />);
    const trigger = screen.getByTestId("home-account-avatar-trigger");
    fireEvent.click(trigger);
    expect(screen.getByTestId("home-account-menu-panel")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(screen.queryByTestId("home-account-menu-panel")).not.toBeInTheDocument();
  });

  it("closes on Escape", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />);
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    expect(screen.getByTestId("home-account-menu-panel")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("home-account-menu-panel")).not.toBeInTheDocument();
  });

  it("closes on an outside click", () => {
    render(
      <div>
        <div data-testid="outside">elsewhere on the page</div>
        <HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />
      </div>,
    );
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    expect(screen.getByTestId("home-account-menu-panel")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(screen.queryByTestId("home-account-menu-panel")).not.toBeInTheDocument();
  });

  it("closes the menu when a profile link inside it is tapped", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />);
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    fireEvent.click(screen.getByRole("link", { name: "My Profile" }));
    expect(screen.queryByTestId("home-account-menu-panel")).not.toBeInTheDocument();
  });

  it("Log out stays reachable from inside the menu", () => {
    render(<HomeAccountMenu displayName="Jamie Rivera" username="jamier" avatarUrl={null} />);
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    const logOutButton = screen.getByRole("button", { name: "Log out" });
    expect(logOutButton.closest("form")).toBeInTheDocument();
  });
});
