import { fireEvent, render, screen } from "@testing-library/react";
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

function setScrollGeometry(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: scrollTop });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

describe("AmbientComments (issue #21) — live-stream-style feed, not a self-expiring stack", () => {
  afterEach(() => {
    vi.clearAllMocks();
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
    expect(screen.getByTestId("ambient-comment")).toHaveAttribute("data-message-id", "abc123");
  });

  it("calls onExpand when a bubble is tapped", () => {
    const onExpand = vi.fn();
    render(<AmbientComments messages={[makeMessage({ id: "m1" })]} onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("ambient-comment"));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("does not evict or expire older messages — all remain rendered, reachable by scrolling", () => {
    render(
      <AmbientComments
        messages={[
          makeMessage({ id: "m1", body: "first" }),
          makeMessage({ id: "m2", body: "second" }),
          makeMessage({ id: "m3", body: "third" }),
          makeMessage({ id: "m4", body: "fourth" }),
          makeMessage({ id: "m5", body: "fifth" }),
        ]}
      />,
    );
    // Every message is still in the document — no MAX_VISIBLE cap, no timer removal.
    expect(screen.getAllByTestId("ambient-comment")).toHaveLength(5);
    expect(screen.getByText(/first/)).toBeInTheDocument();
    expect(screen.getByText(/fifth/)).toBeInTheDocument();
  });

  it("auto-scrolls to the newest comment while following (the default)", () => {
    const { rerender } = render(<AmbientComments messages={[makeMessage({ id: "m1" })]} />);
    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
    scrollToSpy.mockClear();

    rerender(<AmbientComments messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2" })]} />);

    expect(scrollToSpy).toHaveBeenCalled();
  });

  it("does not steal scroll position from a viewer reading older comments", () => {
    const { rerender } = render(<AmbientComments messages={[makeMessage({ id: "m1" })]} />);
    const list = screen.getByTestId("ambient-comments");

    setScrollGeometry(list, { scrollTop: 0, scrollHeight: 2000, clientHeight: 100 });
    fireEvent.scroll(list);

    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
    scrollToSpy.mockClear();

    rerender(
      <AmbientComments
        messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2", body: "arrived while reading" })]}
      />,
    );

    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(0);
    // The new comment is still appended — it's live, just not force-scrolled into view.
    expect(screen.getByText(/arrived while reading/)).toBeInTheDocument();
  });

  it("resumes auto-follow once the viewer scrolls back to the live edge", () => {
    const { rerender } = render(<AmbientComments messages={[makeMessage({ id: "m1" })]} />);
    const list = screen.getByTestId("ambient-comments");

    setScrollGeometry(list, { scrollTop: 0, scrollHeight: 2000, clientHeight: 100 });
    fireEvent.scroll(list);

    setScrollGeometry(list, { scrollTop: 1980, scrollHeight: 2000, clientHeight: 100 });
    fireEvent.scroll(list);

    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
    scrollToSpy.mockClear();

    rerender(<AmbientComments messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2" })]} />);
    expect(scrollToSpy).toHaveBeenCalled();
  });
});
