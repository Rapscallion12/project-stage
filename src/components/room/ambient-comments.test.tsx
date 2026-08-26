import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbientComments } from "./ambient-comments";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

function makeMessage(overrides: Partial<LobbyMessage> = {}): LobbyMessage {
  return {
    id: "m1",
    author_display_name: "Jamie",
    author_profile_id: "p1",
    author_guest_id: null,
    body: "hello room",
    created_at: new Date().toISOString(),
    is_speaker_request: false,
    ...overrides,
  };
}

describe("AmbientComments (issue #21, '05 — Social Stage' Phase 3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when there are no messages", () => {
    render(<AmbientComments messages={[]} />);
    expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
  });

  it("shows a message already present at mount — a viewer arriving mid-conversation sees the room is inhabited immediately", () => {
    render(<AmbientComments messages={[makeMessage({ id: "m1", body: "already here" })]} />);
    expect(screen.getByText(/already here/)).toBeInTheDocument();
  });

  it("shows a new message as it arrives, alongside the author's display name", () => {
    const { rerender } = render(<AmbientComments messages={[]} />);
    rerender(<AmbientComments messages={[makeMessage({ id: "m1", author_display_name: "Jamie", body: "hi" })]} />);
    const bubble = screen.getByTestId("ambient-comment");
    expect(bubble).toHaveTextContent("Jamie");
    expect(bubble).toHaveTextContent("hi");
  });

  it("marks a request-to-speak message with the mic badge, distinct from an ordinary comment", () => {
    render(
      <AmbientComments
        messages={[makeMessage({ id: "m1", is_speaker_request: true, body: "can I speak?" })]}
      />,
    );
    expect(screen.getByTitle("Requested the mic")).toBeInTheDocument();
  });

  it("carries a stable data-message-id per bubble — the Discussion Expanded click-target seam", () => {
    render(<AmbientComments messages={[makeMessage({ id: "abc123" })]} />);
    const bubble = screen.getByTestId("ambient-comment");
    expect(bubble).toHaveAttribute("data-message-id", "abc123");
  });

  it("does not throw when tapped without an onExpand handler (every existing caller before issue #21's Discussion Expanded)", () => {
    render(<AmbientComments messages={[makeMessage({ id: "m1" })]} />);
    expect(() => fireEvent.click(screen.getByTestId("ambient-comment"))).not.toThrow();
  });

  it("calls onExpand when a bubble is tapped — the Discussion Expanded entry point", () => {
    const onExpand = vi.fn();
    render(<AmbientComments messages={[makeMessage({ id: "m1" })]} onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("ambient-comment"));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("never shows more than 3 at once — a burst evicts the oldest immediately rather than stacking the feed taller", () => {
    render(
      <AmbientComments
        messages={[
          makeMessage({ id: "m1", body: "first" }),
          makeMessage({ id: "m2", body: "second" }),
          makeMessage({ id: "m3", body: "third" }),
          makeMessage({ id: "m4", body: "fourth" }),
        ]}
      />,
    );
    expect(screen.getAllByTestId("ambient-comment")).toHaveLength(3);
    expect(screen.queryByText(/first/)).not.toBeInTheDocument();
    expect(screen.getByText(/fourth/)).toBeInTheDocument();
  });

  it("does not re-add a message id it has already shown and expired — each message gets exactly one lifecycle", () => {
    vi.useFakeTimers();
    const { rerender } = render(<AmbientComments messages={[makeMessage({ id: "m1", body: "once" })]} />);
    expect(screen.getByText(/once/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(7000);
    });
    expect(screen.queryByText(/once/)).not.toBeInTheDocument();

    // Same message id still present in the underlying stream (as it always
    // would be — messages never disappear from the real data) must not
    // resurrect the bubble.
    rerender(<AmbientComments messages={[makeMessage({ id: "m1", body: "once" })]} />);
    expect(screen.queryByText(/once/)).not.toBeInTheDocument();
  });

  it("expires a bubble after its lifetime elapses", () => {
    vi.useFakeTimers();
    render(<AmbientComments messages={[makeMessage({ id: "m1", body: "fading" })]} />);
    expect(screen.getByText(/fading/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6999);
    });
    expect(screen.getByText(/fading/)).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText(/fading/)).not.toBeInTheDocument();
  });
});
