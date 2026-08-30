import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExpandedComments } from "./expanded-comments";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";

const { sendMessage, submitSpeakerRequest, addReaction, voteForSpeakerRequest } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  submitSpeakerRequest: vi.fn(),
  addReaction: vi.fn(),
  voteForSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({ sendMessage, addReaction }));
vi.mock("@/app/events/[id]/room/actions", () => ({ submitSpeakerRequest, voteForSpeakerRequest }));

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

function makeRequest(overrides: Partial<RankedPendingRequest> = {}): RankedPendingRequest {
  return {
    id: "r1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    message_id: "m1",
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    selection_round_id: null,
    frozen_rank: null,
    frozen_vote_count: null,
    is_current_candidate: false,
    selection_failed: false,
    reserved_seat_number: null,
    voteCount: 0,
    isMyVote: false,
    ...overrides,
  };
}

const baseProps = {
  eventId: "e1",
  onClose: vi.fn(),
  reactions: {} as Record<string, ReactionState>,
  pendingRequests: [] as RankedPendingRequest[],
  micRequestMode: false,
  onMicRequestModeChange: vi.fn(),
  onHasPendingRequestChange: vi.fn(),
  onPrepareMedia: vi.fn(async () => {}),
};

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

  describe("avatars (issue #21, third corrective pass — real-device finding: no avatar/placeholder was visible at all)", () => {
    it("shows an initials placeholder for each comment row, since no profile-image column exists yet", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage({ author_display_name: "Jamie Rivera" })]} />);
      const row = screen.getByTestId("expanded-comment-row");
      expect(within(row).getByTestId("participant-avatar-initials")).toHaveTextContent("JA");
    });

    it("shows a placeholder for a guest identity the same way as an authenticated one — identity-agnostic", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ author_profile_id: null, author_guest_id: "g1", author_display_name: "Curious Fox" })]}
        />,
      );
      expect(within(screen.getByTestId("expanded-comment-row")).getByTestId("participant-avatar-initials")).toHaveTextContent("CU");
    });

    it("shows a placeholder for a Request-to-Speak row in Top Speaker Requests too", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", author_display_name: "Dapper Rabbit", is_speaker_request: true })]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m1" })]}
        />,
      );
      const row = screen.getByTestId("expanded-top-request-row");
      expect(within(row).getByTestId("participant-avatar-initials")).toHaveTextContent("DA");
    });
  });

  it("never applies the ambient feed's top-edge fade — this is a deliberate reading surface, not the livestream-style ambient feed (issue #21, fourth corrective pass)", () => {
    render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
    const scroll = screen.getByTestId("expanded-comments-scroll");
    expect(scroll.style.maskImage).toBe("");
    expect(scroll.style.webkitMaskImage).toBe("");
  });

  describe("Recent Comments — newest to oldest, frozen snapshot", () => {
    const messages = [
      makeMessage({ id: "m1", body: "first", created_at: "2026-01-01T00:00:00.000Z" }),
      makeMessage({ id: "m2", body: "second", created_at: "2026-01-01T00:00:01.000Z" }),
      makeMessage({ id: "m3", body: "third", created_at: "2026-01-01T00:00:02.000Z" }),
    ];

    it("opens with the newest comment at the top", () => {
      render(<ExpandedComments {...baseProps} open messages={messages} />);
      const rows = screen.getAllByTestId("expanded-comment-row");
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent("third");
      expect(rows[1]).toHaveTextContent("second");
      expect(rows[2]).toHaveTextContent("first");
    });

    it("shows guest/profile identity, comment text, and the request-to-speak badge where applicable", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[
            makeMessage({ id: "m1", author_display_name: "Jamie", body: "hey everyone" }),
            makeMessage({ id: "m2", author_display_name: "Alex", body: "can I speak?", is_speaker_request: true }),
          ]}
        />,
      );
      expect(screen.getByText("Jamie")).toBeInTheDocument();
      expect(screen.getByText(/hey everyone/)).toBeInTheDocument();
      expect(screen.getByTitle("Requested the mic")).toBeInTheDocument();
    });

    it("does not insert a new arrival into the visible list — it stays frozen at the moment of opening", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      expect(screen.getAllByTestId("expanded-comment-row")).toHaveLength(3);

      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4", body: "arrived after opening" })]}
        />,
      );

      // Still 3 rows — the new arrival did not get inserted automatically.
      expect(screen.getAllByTestId("expanded-comment-row")).toHaveLength(3);
      expect(screen.queryByText(/arrived after opening/)).not.toBeInTheDocument();
    });

    it("increments the new-comments counter as arrivals accumulate in the background", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      expect(screen.queryByTestId("expanded-comments-refresh")).not.toBeInTheDocument();

      rerender(
        <ExpandedComments {...baseProps} open messages={[...messages, makeMessage({ id: "m4" })]} />,
      );
      expect(screen.getByTestId("expanded-comments-refresh")).toHaveTextContent("1 new comment");

      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4" }), makeMessage({ id: "m5" })]}
        />,
      );
      expect(screen.getByTestId("expanded-comments-refresh")).toHaveTextContent("2 new comments");
    });

    it("tapping refresh incorporates the waiting comments at the top, newest first, and resets the counter", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4", body: "brand new", created_at: "2026-01-01T00:00:03.000Z" })]}
        />,
      );

      fireEvent.click(screen.getByTestId("expanded-comments-refresh"));

      const rows = screen.getAllByTestId("expanded-comment-row");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("brand new");
      expect(screen.queryByTestId("expanded-comments-refresh")).not.toBeInTheDocument();
    });

    it("re-opening after being closed takes a fresh snapshot", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open={false} messages={messages} />);
      rerender(<ExpandedComments {...baseProps} open messages={messages} />);
      expect(screen.getAllByTestId("expanded-comment-row")).toHaveLength(3);

      rerender(<ExpandedComments {...baseProps} open={false} messages={messages} />);
      const withNewOne = [...messages, makeMessage({ id: "m4", body: "landed while closed" })];
      rerender(<ExpandedComments {...baseProps} open messages={withNewOne} />);

      const rows = screen.getAllByTestId("expanded-comment-row");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("landed while closed");
      expect(screen.queryByTestId("expanded-comments-refresh")).not.toBeInTheDocument();
    });
  });

  describe("Top Speaker Requests — separate section, live, not frozen", () => {
    it("renders nothing for the section when there are no pending requests", () => {
      render(<ExpandedComments {...baseProps} open messages={[]} pendingRequests={[]} />);
      expect(screen.queryByTestId("expanded-top-requests")).not.toBeInTheDocument();
    });

    it("renders up to 3 pending requests, separate from Recent Comments", () => {
      const messages = [
        makeMessage({ id: "m1", author_display_name: "Alex", body: "let me on", is_speaker_request: true }),
        makeMessage({ id: "m2", author_display_name: "Sam", body: "me too", is_speaker_request: true }),
      ];
      const pendingRequests = [
        makeRequest({ id: "r1", message_id: "m1", created_at: "2026-01-01T00:00:00.000Z" }),
        makeRequest({ id: "r2", message_id: "m2", created_at: "2026-01-01T00:00:01.000Z" }),
      ];
      render(<ExpandedComments {...baseProps} open messages={messages} pendingRequests={pendingRequests} />);

      const section = screen.getByTestId("expanded-top-requests");
      expect(section).toHaveTextContent("Alex");
      expect(section).toHaveTextContent("Sam");
      expect(screen.getAllByTestId("expanded-top-request-row")).toHaveLength(2);
    });

    it("caps at 3 even with more pending requests", () => {
      const messages = [1, 2, 3, 4].map((n) =>
        makeMessage({ id: `m${n}`, author_display_name: `User${n}`, is_speaker_request: true }),
      );
      const pendingRequests = [1, 2, 3, 4].map((n) =>
        makeRequest({ id: `r${n}`, message_id: `m${n}`, created_at: `2026-01-01T00:00:0${n}.000Z` }),
      );
      render(<ExpandedComments {...baseProps} open messages={messages} pendingRequests={pendingRequests} />);
      expect(screen.getAllByTestId("expanded-top-request-row")).toHaveLength(3);
    });

    it("stays live — a new pending request appears immediately, even while Recent Comments is frozen", () => {
      const messages = [makeMessage({ id: "m1", is_speaker_request: false, body: "ordinary comment" })];
      const { rerender } = render(
        <ExpandedComments {...baseProps} open messages={messages} pendingRequests={[]} />,
      );
      expect(screen.queryByTestId("expanded-top-requests")).not.toBeInTheDocument();

      const withRequest = [
        ...messages,
        makeMessage({ id: "m2", author_display_name: "Jordan", is_speaker_request: true }),
      ];
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={withRequest}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m2" })]}
        />,
      );

      // The section appears live immediately, without needing a refresh
      // tap — unlike Recent Comments, which (correctly, separately) still
      // counts m2 as a new arrival against its own frozen snapshot.
      expect(screen.getByTestId("expanded-top-requests")).toHaveTextContent("Jordan");
    });
  });

  describe("Double-tap to like", () => {
    it("a single tap does not like", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
      fireEvent.click(screen.getByTestId("expanded-comment-row"));
      expect(addReaction).not.toHaveBeenCalled();
    });

    it("a double-tap within the window calls the existing addReaction action", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      expect(addReaction).toHaveBeenCalledTimes(1);
      expect(addReaction).toHaveBeenCalledWith("m1");
    });

    it("shows a lightweight visual acknowledgment (a liked indicator) after double-tapping", async () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      await waitFor(() => expect(screen.getByTestId("expanded-comment-like")).toBeInTheDocument());
    });

    it("shows the real reaction count from the reactions prop (persisted/realtime data, not local-only)", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1" })]}
          reactions={{ m1: { count: 4, reactedByMe: true } }}
        />,
      );
      expect(screen.getByTestId("expanded-comment-like")).toHaveTextContent("4");
    });

    it("a fast triple-tap only fires one like, not two", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      fireEvent.click(row);
      expect(addReaction).toHaveBeenCalledTimes(1);
    });

    it("does not re-like a message the viewer already liked", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1" })]}
          reactions={{ m1: { count: 1, reactedByMe: true } }}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      expect(addReaction).not.toHaveBeenCalled();
    });

    it("a request message with no active (voteable) request falls back to an ordinary like — e.g. already resolved", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", is_speaker_request: true })]}
          pendingRequests={[]}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      expect(addReaction).toHaveBeenCalledWith("m1");
      expect(voteForSpeakerRequest).not.toHaveBeenCalled();
    });
  });

  describe("Double-tap to vote (Section A — a Request-to-Speak comment's 👍 is a vote, not an ordinary like)", () => {
    it("double-tapping a voteable request calls voteForSpeakerRequest, never addReaction", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", is_speaker_request: true })]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m1" })]}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      expect(voteForSpeakerRequest).toHaveBeenCalledWith("e1", "m1");
      expect(addReaction).not.toHaveBeenCalled();
    });

    it("works the same way on a Top Speaker Requests row", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", is_speaker_request: true })]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m1" })]}
        />,
      );
      const row = screen.getByTestId("expanded-top-request-row");
      fireEvent.click(row);
      fireEvent.click(row);
      expect(voteForSpeakerRequest).toHaveBeenCalledWith("e1", "m1");
    });

    it("re-tapping the request the viewer already voted for still fires — the server decides toggle-off, not a client-side guard", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", is_speaker_request: true })]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m1", isMyVote: true, voteCount: 1 })]}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      expect(voteForSpeakerRequest).toHaveBeenCalledTimes(1);
    });

    it("a fast triple-tap only fires the vote action once", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", is_speaker_request: true })]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m1" })]}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      fireEvent.click(row);
      fireEvent.click(row);
      fireEvent.click(row);
      expect(voteForSpeakerRequest).toHaveBeenCalledTimes(1);
    });

    it("shows the live vote count and highlights the viewer's own vote distinctly from an ordinary like", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", is_speaker_request: true })]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m1", voteCount: 3, isMyVote: true })]}
        />,
      );
      // The same message renders in both Top Speaker Requests and Recent
      // Comments (it's a real comment too) — every instance of the badge
      // should agree.
      const badges = screen.getAllByTestId("expanded-comment-vote");
      expect(badges.length).toBeGreaterThan(0);
      for (const badge of badges) {
        expect(badge).toHaveTextContent("3");
      }
      expect(screen.queryByTestId("expanded-comment-like")).not.toBeInTheDocument();
    });

    it("ordinary comment likes remain completely independent — liking an unrelated comment never calls voteForSpeakerRequest", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[
            makeMessage({ id: "m1", is_speaker_request: false }),
            makeMessage({ id: "m2", is_speaker_request: true }),
          ]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m2" })]}
        />,
      );
      const rows = screen.getAllByTestId("expanded-comment-row");
      const ordinaryRow = rows.find((r) => r.getAttribute("data-message-id") === "m1")!;
      fireEvent.click(ordinaryRow);
      fireEvent.click(ordinaryRow);
      expect(addReaction).toHaveBeenCalledWith("m1");
      expect(voteForSpeakerRequest).not.toHaveBeenCalled();
    });
  });

  describe("Grabber drag-to-close", () => {
    it("dragging the handle past the threshold and releasing closes the sheet", () => {
      const onClose = vi.fn();
      render(<ExpandedComments {...baseProps} open onClose={onClose} messages={[]} />);
      const handle = screen.getByTestId("expanded-comments-handle");
      fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientY: 150, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientY: 150, pointerId: 1 });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("an incomplete drag (below the threshold) does not close the sheet", () => {
      const onClose = vi.fn();
      render(<ExpandedComments {...baseProps} open onClose={onClose} messages={[]} />);
      const handle = screen.getByTestId("expanded-comments-handle");
      fireEvent.pointerDown(handle, { clientY: 0, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientY: 20, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientY: 20, pointerId: 1 });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("expanded-comments")).toBeInTheDocument();
    });

    it("dragging upward never closes the sheet", () => {
      const onClose = vi.fn();
      render(<ExpandedComments {...baseProps} open onClose={onClose} messages={[]} />);
      const handle = screen.getByTestId("expanded-comments-handle");
      fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 });
      fireEvent.pointerMove(handle, { clientY: 0, pointerId: 1 });
      fireEvent.pointerUp(handle, { clientY: 0, pointerId: 1 });
      expect(onClose).not.toHaveBeenCalled();
    });

    it("scrolling inside the comment list does not close or dismiss the sheet", () => {
      const onClose = vi.fn();
      render(
        <ExpandedComments
          {...baseProps}
          open
          onClose={onClose}
          messages={[makeMessage({ id: "m1" }), makeMessage({ id: "m2" })]}
        />,
      );
      const list = screen.getByTestId("expanded-comments-scroll");
      fireEvent.scroll(list, { target: { scrollTop: 40 } });
      expect(onClose).not.toHaveBeenCalled();
      expect(screen.getByTestId("expanded-comments")).toBeInTheDocument();
    });
  });

  it("sends a comment from the expanded composer via the existing sendMessage action", async () => {
    sendMessage.mockResolvedValue(undefined);
    render(<ExpandedComments {...baseProps} open messages={[]} />);

    const input = screen.getByPlaceholderText("Add a comment…");
    fireEvent.change(input, { target: { value: "hello from the sheet" } });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    const formData = sendMessage.mock.calls[0][2] as FormData;
    expect(formData.get("body")).toBe("hello from the sheet");
  });
});
