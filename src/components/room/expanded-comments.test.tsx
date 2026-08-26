import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpandedComments } from "./expanded-comments";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

const { sendMessage, submitSpeakerRequest } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  submitSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({ sendMessage }));
vi.mock("@/app/events/[id]/room/actions", () => ({ submitSpeakerRequest }));

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

const baseProps = {
  eventId: "e1",
  onClose: vi.fn(),
  micRequestMode: false,
  onMicRequestModeChange: vi.fn(),
  onHasPendingRequestChange: vi.fn(),
  onPrepareMedia: vi.fn(async () => {}),
};

/** Configures the scroll container's geometry so the follow/scrolled-up threshold logic has something real to compute against — jsdom never computes layout on its own. */
function setScrollGeometry(el: HTMLElement, { scrollTop, scrollHeight, clientHeight }: { scrollTop: number; scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollTop", { configurable: true, writable: true, value: scrollTop });
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: clientHeight });
}

describe("ExpandedComments (issue #21, Discussion Expanded)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when closed", () => {
    render(<ExpandedComments {...baseProps} open={false} messages={[]} />);
    expect(screen.queryByTestId("expanded-comments")).not.toBeInTheDocument();
  });

  it("renders the sheet when open", () => {
    render(<ExpandedComments {...baseProps} open messages={[]} />);
    expect(screen.getByTestId("expanded-comments")).toBeInTheDocument();
  });

  it("calls onClose when the close button is tapped", () => {
    const onClose = vi.fn();
    render(<ExpandedComments {...baseProps} open onClose={onClose} messages={[]} />);
    fireEvent.click(screen.getByTestId("expanded-comments-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders comments in chronological order", () => {
    const messages = [
      makeMessage({ id: "m1", body: "first", created_at: "2026-01-01T00:00:00.000Z" }),
      makeMessage({ id: "m2", body: "second", created_at: "2026-01-01T00:00:01.000Z" }),
      makeMessage({ id: "m3", body: "third", created_at: "2026-01-01T00:00:02.000Z" }),
    ];
    render(<ExpandedComments {...baseProps} open messages={messages} />);
    const rows = screen.getAllByTestId("expanded-comment-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("first");
    expect(rows[1]).toHaveTextContent("second");
    expect(rows[2]).toHaveTextContent("third");
  });

  it("shows the guest/profile identity, comment text, and the request-to-speak badge where applicable", () => {
    render(
      <ExpandedComments
        {...baseProps}
        open
        messages={[
          makeMessage({ id: "m1", author_display_name: "Jamie", body: "hey everyone", is_speaker_request: false }),
          makeMessage({ id: "m2", author_display_name: "Alex", body: "can I speak?", is_speaker_request: true }),
        ]}
      />,
    );
    const rows = screen.getAllByTestId("expanded-comment-row");
    expect(rows[0]).toHaveTextContent("Jamie");
    expect(rows[0]).toHaveTextContent("hey everyone");
    expect(rows[1]).toHaveTextContent("Alex");
    expect(screen.getByTitle("Requested the mic")).toBeInTheDocument();
  });

  it("auto-scrolls to the newest comment while following (the default on open)", () => {
    const { rerender } = render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
    scrollToSpy.mockClear();

    rerender(
      <ExpandedComments
        {...baseProps}
        open
        messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2", body: "new one" })]}
      />,
    );

    expect(scrollToSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("expanded-comments-jump-latest")).not.toBeInTheDocument();
  });

  it("does not steal scroll position when a comment arrives while scrolled up, and shows a jump-to-latest indicator instead", () => {
    const { rerender } = render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
    const list = screen.getByTestId("expanded-comments-list");

    // Scroll well away from the bottom — past the near-bottom threshold.
    setScrollGeometry(list, { scrollTop: 0, scrollHeight: 2000, clientHeight: 400 });
    fireEvent.scroll(list);

    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
    scrollToSpy.mockClear();

    rerender(
      <ExpandedComments
        {...baseProps}
        open
        messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2", body: "arrived while scrolled up" })]}
      />,
    );

    // Position untouched — no scroll-to-bottom call for this arrival.
    expect(scrollToSpy).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(0);
    expect(screen.getByTestId("expanded-comments-jump-latest")).toHaveTextContent("1 new comment");
  });

  it("jump-to-latest scrolls to the bottom, clears the indicator, and resumes live-follow behavior", () => {
    const { rerender } = render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
    const list = screen.getByTestId("expanded-comments-list");
    setScrollGeometry(list, { scrollTop: 0, scrollHeight: 2000, clientHeight: 400 });
    fireEvent.scroll(list);

    rerender(
      <ExpandedComments
        {...baseProps}
        open
        messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2" })]}
      />,
    );
    expect(screen.getByTestId("expanded-comments-jump-latest")).toBeInTheDocument();

    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
    scrollToSpy.mockClear();
    fireEvent.click(screen.getByTestId("expanded-comments-jump-latest"));

    expect(scrollToSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("expanded-comments-jump-latest")).not.toBeInTheDocument();

    // Resumed following — the next arrival auto-scrolls again, no indicator.
    scrollToSpy.mockClear();
    rerender(
      <ExpandedComments
        {...baseProps}
        open
        messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2" }), makeMessage({ id: "m3" })]}
      />,
    );
    expect(scrollToSpy).toHaveBeenCalled();
    expect(screen.queryByTestId("expanded-comments-jump-latest")).not.toBeInTheDocument();
  });

  it("resumes following automatically once the viewer scrolls back near the bottom themselves", () => {
    render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
    const list = screen.getByTestId("expanded-comments-list");

    setScrollGeometry(list, { scrollTop: 0, scrollHeight: 2000, clientHeight: 400 });
    fireEvent.scroll(list);

    // Scrolls back near the bottom manually.
    setScrollGeometry(list, { scrollTop: 1580, scrollHeight: 2000, clientHeight: 400 });
    fireEvent.scroll(list);

    const scrollToSpy = vi.spyOn(Element.prototype, "scrollTo");
    scrollToSpy.mockClear();

    const { rerender } = render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
    rerender(
      <ExpandedComments
        {...baseProps}
        open
        messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2" })]}
      />,
    );
    expect(screen.queryByTestId("expanded-comments-jump-latest")).not.toBeInTheDocument();
  });

  it("sends a comment from the expanded composer via the existing sendMessage action", async () => {
    sendMessage.mockResolvedValue(undefined);
    render(<ExpandedComments {...baseProps} open messages={[]} />);

    const input = screen.getByPlaceholderText("Add a comment…");
    fireEvent.change(input, { target: { value: "hello from the sheet" } });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    // sendMessage.bind(null, eventId) prepends eventId ahead of
    // useActionState's own (prevState, formData) — same call shape
    // ChatPanel's own tests rely on.
    const formData = sendMessage.mock.calls[0][2] as FormData;
    expect(formData.get("body")).toBe("hello from the sheet");
  });
});
