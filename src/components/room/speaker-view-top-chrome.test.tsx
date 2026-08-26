import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SpeakerViewTopChrome } from "./speaker-view-top-chrome";
import type { Identity } from "@/lib/identity";
import type { Event } from "@/lib/repositories/events";

vi.mock("@/app/events/[id]/lobby/actions", () => ({ setGuestName: vi.fn() }));

const event: Event = {
  id: "e1",
  title: "Late Night Debate",
  description: "",
  scheduled_start: new Date().toISOString(),
  lobby_opens_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
  format: "main_stage",
};

const accountIdentity: Identity = { type: "profile", id: "p1", displayName: "Jamie" };
const guestIdentity: Identity = { type: "guest", id: "g1", displayName: "Cheerful Raven" };

describe("SpeakerViewTopChrome (issue #18, Speaker View corrective pass)", () => {
  it("shows the status pill with the event title", () => {
    render(<SpeakerViewTopChrome event={event} identity={accountIdentity} connectionStatus="connected" />);
    expect(screen.getByTestId("watch-status-pill")).toHaveTextContent("Late Night Debate");
  });

  it("shows the guest identity chip for a guest, not for an account holder", () => {
    const { rerender } = render(
      <SpeakerViewTopChrome event={event} identity={guestIdentity} connectionStatus="connected" />,
    );
    expect(screen.getByRole("button", { name: "Cheerful Raven" })).toBeInTheDocument();

    rerender(<SpeakerViewTopChrome event={event} identity={accountIdentity} connectionStatus="connected" />);
    expect(screen.queryByRole("button", { name: /cheerful raven/i })).not.toBeInTheDocument();
  });

  it("never uses justify-between — both pieces stay anchored on the left, away from SelfPreview's fixed top-right corner (real-device finding)", () => {
    render(<SpeakerViewTopChrome event={event} identity={guestIdentity} connectionStatus="connected" />);
    const wrapper = screen.getByTestId("watch-status-pill").parentElement as HTMLElement;
    expect(wrapper.className).not.toMatch(/\bjustify-between\b/);
  });

  it("the status pill and guest chip share the same left-anchored row — not split to opposite ends", () => {
    render(<SpeakerViewTopChrome event={event} identity={guestIdentity} connectionStatus="connected" />);
    const pill = screen.getByTestId("watch-status-pill");
    const chip = screen.getByRole("button", { name: "Cheerful Raven" });
    expect(pill.parentElement).toBe(chip.parentElement?.parentElement);
  });

  describe("SelfPreview footprint reserved (real-device finding: narrow phones let the chip/title reach into the top-right corner even while left-anchored)", () => {
    it("the row reserves SelfPreview's own responsive width via right padding", () => {
      render(<SpeakerViewTopChrome event={event} identity={guestIdentity} connectionStatus="connected" />);
      const row = screen.getByTestId("watch-status-pill").parentElement as HTMLElement;
      expect(row.className).toMatch(/\bpr-20\b/);
      expect(row.className).toMatch(/\bsm:pr-24\b/);
    });

    it("the status pill can actually shrink (min-w-0, flex-1) instead of overflowing into the reserved corner", () => {
      render(<SpeakerViewTopChrome event={event} identity={guestIdentity} connectionStatus="connected" />);
      const pill = screen.getByTestId("watch-status-pill");
      expect(pill.className).toMatch(/\bmin-w-0\b/);
      expect(pill.className).toMatch(/\bflex-1\b/);
    });

    it("the guest chip stays at its own capped size (shrink-0) rather than being squeezed further", () => {
      render(<SpeakerViewTopChrome event={event} identity={guestIdentity} connectionStatus="connected" />);
      const chip = screen.getByRole("button", { name: "Cheerful Raven" });
      const chipWrapper = chip.parentElement as HTMLElement;
      expect(chipWrapper.className).toMatch(/\bshrink-0\b/);
    });
  });
});
