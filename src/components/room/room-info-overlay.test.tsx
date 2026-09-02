import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RoomInfoOverlay } from "./room-info-overlay";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";

vi.mock("@/app/auth/actions", () => ({ signOut: vi.fn() }));

const event: Pick<Event, "title" | "description"> = {
  title: "Late Night Debate",
  description: "Strangers, live, arguing about the important stuff.",
};

const guestIdentity: Identity = { type: "guest", id: "g1", displayName: "Cheerful Raven" };
const accountIdentity: Identity = { type: "profile", id: "p1", displayName: "Jamie Rivera", username: null };

/**
 * Issue #21, seventh corrective pass, Sections 8-15: the collapsed
 * room/navigation overlay — a temporary surface over the stage, never a
 * permanent header. See the component's own doc comment for the full
 * design reasoning.
 */
describe("RoomInfoOverlay", () => {
  it("renders nothing at all while closed", () => {
    render(<RoomInfoOverlay open={false} onClose={vi.fn()} event={event} roomStatus="live" identity={guestIdentity} />);
    expect(screen.queryByTestId("room-info-panel")).not.toBeInTheDocument();
  });

  it("shows the room's title, status, and description once open", () => {
    render(<RoomInfoOverlay open={true} onClose={vi.fn()} event={event} roomStatus="live" identity={guestIdentity} />);
    const panel = screen.getByTestId("room-info-panel");
    expect(panel).toHaveTextContent("Late Night Debate");
    expect(panel).toHaveTextContent("Live");
    expect(panel).toHaveTextContent("Strangers, live, arguing about the important stuff.");
  });

  it("shows Home and Events navigation links", () => {
    render(<RoomInfoOverlay open={true} onClose={vi.fn()} event={event} roomStatus="waiting" identity={guestIdentity} />);
    expect(screen.getByRole("link", { name: /home/i })).toHaveAttribute("href", "/");
    expect(screen.getByRole("link", { name: /events/i })).toHaveAttribute("href", "/events");
  });

  it("shows Log in / Sign up for a guest, never an account control", () => {
    render(<RoomInfoOverlay open={true} onClose={vi.fn()} event={event} roomStatus="waiting" identity={guestIdentity} />);
    expect(screen.getByRole("link", { name: "Log in" })).toHaveAttribute("href", "/login");
    expect(screen.getByRole("link", { name: "Sign up" })).toHaveAttribute("href", "/signup");
    expect(screen.queryByText("Log out")).not.toBeInTheDocument();
  });

  it("shows the account holder's name and Log out for an authenticated identity, never Log in/Sign up", () => {
    render(<RoomInfoOverlay open={true} onClose={vi.fn()} event={event} roomStatus="waiting" identity={accountIdentity} />);
    expect(screen.getByText("Jamie Rivera")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Log out" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Log in" })).not.toBeInTheDocument();
  });

  describe("profile entry point (issue #29, Section 14; relabeled in the profile UX polish pass to share AccountMenuLinks with the home header)", () => {
    it("shows only Complete Profile — not My Profile/Edit Profile — for an account with no username chosen yet", () => {
      render(<RoomInfoOverlay open={true} onClose={vi.fn()} event={event} roomStatus="waiting" identity={accountIdentity} />);
      expect(screen.getByRole("link", { name: "Complete Profile" })).toHaveAttribute("href", "/profile/edit");
      expect(screen.queryByRole("link", { name: "My Profile" })).not.toBeInTheDocument();
    });

    it("shows both My Profile and Edit Profile once a username exists", () => {
      const withUsername: Identity = { ...accountIdentity, username: "jamier" };
      render(<RoomInfoOverlay open={true} onClose={vi.fn()} event={event} roomStatus="waiting" identity={withUsername} />);
      expect(screen.getByRole("link", { name: "My Profile" })).toHaveAttribute("href", "/profile/jamier");
      expect(screen.getByRole("link", { name: "Edit Profile" })).toHaveAttribute("href", "/profile/edit");
    });

    it("never shows a profile link for a guest — no forced account/profile flow", () => {
      render(<RoomInfoOverlay open={true} onClose={vi.fn()} event={event} roomStatus="waiting" identity={guestIdentity} />);
      expect(screen.queryByRole("link", { name: "My Profile" })).not.toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "Complete Profile" })).not.toBeInTheDocument();
    });
  });

  it("closes on a backdrop click", () => {
    const onClose = vi.fn();
    render(<RoomInfoOverlay open={true} onClose={onClose} event={event} roomStatus="live" identity={guestIdentity} />);
    fireEvent.click(screen.getByTestId("room-info-backdrop"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close when tapping inside the panel itself — only the backdrop dismisses", () => {
    const onClose = vi.fn();
    render(<RoomInfoOverlay open={true} onClose={onClose} event={event} roomStatus="live" identity={guestIdentity} />);
    fireEvent.click(screen.getByTestId("room-info-panel"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes via the explicit ✕ close button", () => {
    const onClose = vi.fn();
    render(<RoomInfoOverlay open={true} onClose={onClose} event={event} roomStatus="live" identity={guestIdentity} />);
    fireEvent.click(screen.getByTestId("room-info-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape (Section 12: 'Escape on desktop')", () => {
    const onClose = vi.fn();
    render(<RoomInfoOverlay open={true} onClose={onClose} event={event} roomStatus="live" identity={guestIdentity} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not listen for Escape while closed — no stray global listener outliving its own visibility", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <RoomInfoOverlay open={true} onClose={onClose} event={event} roomStatus="live" identity={guestIdentity} />,
    );
    rerender(<RoomInfoOverlay open={false} onClose={onClose} event={event} roomStatus="live" identity={guestIdentity} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
