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
    localStorage.clear();
  });

  it("renders nothing when there are no messages", () => {
    render(<AmbientComments messages={[]} />);
    expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ambient-comments-hide")).not.toBeInTheDocument();
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

  it("fades comments out at the top edge via a container-level mask, instead of a hard clip (issue #21, fourth corrective pass)", () => {
    render(<AmbientComments messages={[makeMessage()]} />);
    const container = screen.getByTestId("ambient-comments");
    expect(container.style.maskImage).toContain("linear-gradient");
    expect(container.style.webkitMaskImage).toContain("linear-gradient");
    // Still clips overflow to its own bounded height — the mask is a
    // presentation refinement on top of the existing scroll container,
    // not a replacement for it.
    expect(container.className).toMatch(/\boverflow-y-auto\b/);
  });

  it("tapping a comment still opens the expected interaction with the fade applied", () => {
    const onExpand = vi.fn();
    render(<AmbientComments messages={[makeMessage({ id: "m1" })]} onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId("ambient-comment"));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it("shows an avatar placeholder for each row — the same canonical presentation Expanded Comments uses (issue #21, third corrective pass)", () => {
    render(<AmbientComments messages={[makeMessage({ author_display_name: "Jamie Rivera" })]} />);
    expect(screen.getByTestId("participant-avatar-initials")).toHaveTextContent("JA");
  });

  it("marks a request-to-speak message with a distinct badge, not folded into the same line as the comment", () => {
    render(
      <AmbientComments
        messages={[makeMessage({ id: "m1", is_speaker_request: true, body: "can I speak?" })]}
      />,
    );
    expect(screen.getByTestId("ambient-comment-request-badge")).toHaveTextContent(/requesting to speak/i);
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

  describe("readability redesign (issue #21, fifth corrective pass, Sections 19-24)", () => {
    it("renders the display name on its own line, separate from the comment text below it", () => {
      render(<AmbientComments messages={[makeMessage({ author_display_name: "Restless Otter", body: "curious where this goes next, been thinking about it all day" })]} />);
      const bubble = screen.getByTestId("ambient-comment");
      const name = screen.getByText("Restless Otter");
      const body = screen.getByText(/curious where this goes next/);
      expect(bubble).toContainElement(name);
      expect(bubble).toContainElement(body);
      // Distinct elements, not one squashed line — the name is not part
      // of the same text node as the comment body.
      expect(name).not.toBe(body);
    });

    it("allows the comment text to wrap (line-clamp, not a single truncated line)", () => {
      render(<AmbientComments messages={[makeMessage({ body: "a longer comment that should be allowed to wrap across more than one line before it ever gets cut off" })]} />);
      const body = screen.getByText(/a longer comment that should be allowed to wrap/);
      expect(body.className).toMatch(/line-clamp-2/);
    });

    it("keeps the ambient feed constrained to a compact region — bounded height, not growing to fit content", () => {
      render(<AmbientComments messages={[makeMessage()]} />);
      const container = screen.getByTestId("ambient-comments");
      expect(container.className).toMatch(/\bmax-h-\d+\b/);
    });
  });

  describe("Hide/Show Live Comments (issue #21, fifth corrective pass, Sections 25-29)", () => {
    it("shows a Hide Live Comments control alongside the feed by default", () => {
      render(<AmbientComments messages={[makeMessage()]} />);
      expect(screen.getByTestId("ambient-comments-hide")).toBeInTheDocument();
    });

    it("tapping Hide removes only the ambient feed — the toggle itself stays visible as a restore control", () => {
      render(<AmbientComments messages={[makeMessage()]} />);
      fireEvent.click(screen.getByTestId("ambient-comments-hide"));

      expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
      expect(screen.getByTestId("ambient-comments-show")).toBeInTheDocument();
    });

    it("tapping Show restores the feed", () => {
      render(<AmbientComments messages={[makeMessage({ id: "m1", body: "still here" })]} />);
      fireEvent.click(screen.getByTestId("ambient-comments-hide"));
      fireEvent.click(screen.getByTestId("ambient-comments-show"));

      expect(screen.getByTestId("ambient-comments")).toBeInTheDocument();
      expect(screen.getByText(/still here/)).toBeInTheDocument();
    });

    it("incoming comments continue to be tracked while hidden — restoring shows them immediately, nothing was lost", () => {
      const { rerender } = render(<AmbientComments messages={[makeMessage({ id: "m1", body: "first" })]} />);
      fireEvent.click(screen.getByTestId("ambient-comments-hide"));

      rerender(
        <AmbientComments
          messages={[makeMessage({ id: "m1", body: "first" }), makeMessage({ id: "m2", body: "arrived while hidden" })]}
        />,
      );
      fireEvent.click(screen.getByTestId("ambient-comments-show"));

      expect(screen.getByText(/arrived while hidden/)).toBeInTheDocument();
    });

    it("persists the hidden preference across remounts (e.g. room re-render) via localStorage, per explicit instruction not to add schema for this", () => {
      const { unmount } = render(<AmbientComments messages={[makeMessage()]} />);
      fireEvent.click(screen.getByTestId("ambient-comments-hide"));
      unmount();

      render(<AmbientComments messages={[makeMessage()]} />);
      expect(screen.queryByTestId("ambient-comments")).not.toBeInTheDocument();
      expect(screen.getByTestId("ambient-comments-show")).toBeInTheDocument();
    });

    it("persists the shown preference the same way, once explicitly restored", () => {
      const { unmount } = render(<AmbientComments messages={[makeMessage()]} />);
      fireEvent.click(screen.getByTestId("ambient-comments-hide"));
      fireEvent.click(screen.getByTestId("ambient-comments-show"));
      unmount();

      render(<AmbientComments messages={[makeMessage()]} />);
      expect(screen.getByTestId("ambient-comments")).toBeInTheDocument();
    });

    it("falls back to showing comments if localStorage throws (private browsing, disabled storage)", () => {
      const getItemSpy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("storage disabled");
      });
      render(<AmbientComments messages={[makeMessage()]} />);
      expect(screen.getByTestId("ambient-comments")).toBeInTheDocument();
      getItemSpy.mockRestore();
    });
  });
});
