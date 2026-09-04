import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DesktopRoomHeader } from "./desktop-room-header";
import type { Identity } from "@/lib/identity";

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

const guestIdentity: Identity = { type: "guest", id: "g1", displayName: "Cheerful Raven" };
const accountIdentity: Identity = { type: "profile", id: "p1", displayName: "Jamie Rivera", username: null };

const baseProps = {
  eventTitle: "Late Night Debate",
  roomStatus: "live" as const,
  countdownText: null,
  participantCount: 3,
  connectionStatus: "connected" as const,
  onOpenRoomInfo: vi.fn(),
};

/**
 * Desktop room navigation pass (real-desktop regression): a persistent
 * desktop-only header restoring one-click Home/Events/account access,
 * without reverting to the full mobile site header. See this
 * component's own doc comment for the full design reasoning.
 */
describe("DesktopRoomHeader", () => {
  it("shows a direct, one-click Home link to the site root", () => {
    render(<DesktopRoomHeader {...baseProps} identity={guestIdentity} />);
    expect(screen.getByRole("link", { name: "Virtual Stage home" })).toHaveAttribute("href", "/");
  });

  it("shows a direct, one-click Events link", () => {
    render(<DesktopRoomHeader {...baseProps} identity={guestIdentity} />);
    expect(screen.getByRole("link", { name: "Browse events" })).toHaveAttribute("href", "/events");
  });

  it("shows the room title and status", () => {
    render(<DesktopRoomHeader {...baseProps} identity={guestIdentity} />);
    expect(screen.getByRole("heading", { name: "Late Night Debate" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
  });

  it("shows the viewer count", () => {
    render(<DesktopRoomHeader {...baseProps} identity={guestIdentity} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText(/watching/)).toBeInTheDocument();
  });

  it("shows Log in / Sign up for a guest, never an account menu", () => {
    render(<DesktopRoomHeader {...baseProps} identity={guestIdentity} />);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.queryByTestId("home-account-menu")).not.toBeInTheDocument();
  });

  it("shows the shared account/avatar menu for a signed-in identity, never Log in/Sign up", () => {
    render(<DesktopRoomHeader {...baseProps} identity={accountIdentity} identityAvatarUrl={null} />);
    expect(screen.getByTestId("home-account-menu")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Log in" })).not.toBeInTheDocument();
  });

  it("the account menu opens the same My Profile/Edit Profile/Log out behavior established elsewhere", () => {
    const withUsername: Identity = { ...accountIdentity, username: "jamier" };
    render(<DesktopRoomHeader {...baseProps} identity={withUsername} />);
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    expect(screen.getByRole("link", { name: "My Profile" })).toHaveAttribute("href", "/profile/jamier");
    expect(screen.getByRole("link", { name: "Edit Profile" })).toHaveAttribute("href", "/profile/edit");
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
  });

  it("shows Complete Profile instead of My Profile for an account with no username yet", () => {
    render(<DesktopRoomHeader {...baseProps} identity={accountIdentity} />);
    fireEvent.click(screen.getByTestId("home-account-avatar-trigger"));
    expect(screen.getByRole("link", { name: "Complete Profile" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "My Profile" })).not.toBeInTheDocument();
  });

  it("Room Info remains accessible via its own trigger, with a room-details (not navigation) accessible name", () => {
    const onOpenRoomInfo = vi.fn();
    render(<DesktopRoomHeader {...baseProps} identity={guestIdentity} onOpenRoomInfo={onOpenRoomInfo} />);
    const trigger = screen.getByRole("button", { name: "Room details for Late Night Debate" });
    fireEvent.click(trigger);
    expect(onOpenRoomInfo).toHaveBeenCalledTimes(1);
  });

  it("Home/Events/avatar are keyboard reachable — real anchors and buttons, not click-only handlers", () => {
    render(<DesktopRoomHeader {...baseProps} identity={accountIdentity} />);
    expect(screen.getByRole("link", { name: "Virtual Stage home" }).tagName).toBe("A");
    expect(screen.getByRole("link", { name: "Browse events" }).tagName).toBe("A");
    expect(screen.getByTestId("home-account-avatar-trigger").tagName).toBe("BUTTON");
  });
});
