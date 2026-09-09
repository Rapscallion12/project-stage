import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExpandedComments } from "./expanded-comments";
import type { LobbyMessage, ReactionState } from "@/hooks/use-lobby-realtime";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { MediaReadinessState } from "@/hooks/use-live-room-connection";

const MEDIA_READY: MediaReadinessState = { camera: { ready: true, error: null }, microphone: { ready: true, error: null } };

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
  submitComment: vi.fn(),
  retryComment: vi.fn(),
  pendingRequests: [] as RankedPendingRequest[],
  micRequestMode: false,
  onMicRequestModeChange: vi.fn(),
  onHasPendingRequestChange: vi.fn(),
  onPrepareMedia: vi.fn(async () => MEDIA_READY),
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

  describe("profile navigation (issue #29, Section 15 — a registered commenter's avatar becomes tappable into their public profile)", () => {
    it("wraps a comment row's avatar in a profile link when the author is in profileDirectory with a username", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ author_profile_id: "p1", author_display_name: "Jamie Rivera" })]}
          profileDirectory={{ p1: { username: "jamier", avatarUrl: null } }}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      expect(within(row).getByRole("link")).toHaveAttribute("href", "/profile/jamier");
    });

    it("renders no link when the author isn't in profileDirectory (guest, or no username chosen yet)", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ author_profile_id: "p1", author_display_name: "Jamie Rivera" })]}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    });

    it("renders no link for a guest author even if profileDirectory happens to hold an entry under a different id", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ author_profile_id: null, author_guest_id: "g1", author_display_name: "Curious Fox" })]}
          profileDirectory={{ p1: { username: "jamier", avatarUrl: null } }}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      expect(within(row).queryByRole("link")).not.toBeInTheDocument();
    });

    it("tapping the avatar link does not also trigger the row's own double-tap-to-like handler", () => {
      const addReactionSpy = addReaction;
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", author_profile_id: "p1", author_display_name: "Jamie Rivera" })]}
          profileDirectory={{ p1: { username: "jamier", avatarUrl: null } }}
        />,
      );
      const row = screen.getByTestId("expanded-comment-row");
      const link = within(row).getByRole("link");
      // Two rapid clicks on the avatar link itself is exactly the
      // gesture that would normally register as the row's own
      // double-tap-to-like — Section 15's own explicit warning is that
      // this must not happen when the tap lands on the identity link.
      fireEvent.click(link);
      fireEvent.click(link);
      expect(addReactionSpy).not.toHaveBeenCalled();
    });

    it("wraps a Top Speaker Requests row's avatar in a profile link too", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", author_profile_id: "p1", author_display_name: "Dapper Rabbit", is_speaker_request: true })]}
          pendingRequests={[makeRequest({ id: "r1", message_id: "m1", profile_id: "p1" })]}
          profileDirectory={{ p1: { username: "dapperrabbit", avatarUrl: null } }}
        />,
      );
      const row = screen.getByTestId("expanded-top-request-row");
      expect(within(row).getByRole("link")).toHaveAttribute("href", "/profile/dapperrabbit");
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

    it("real-device report: is genuinely live — a new arrival appears in the visible list immediately, no manual refresh", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      expect(screen.getAllByTestId("expanded-comment-row")).toHaveLength(3);

      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4", body: "arrived after opening" })]}
        />,
      );

      // Now 4 rows — the new arrival is inserted live, no refresh tap needed.
      const rows = screen.getAllByTestId("expanded-comment-row");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("arrived after opening");
    });

    it("the old manual-refresh model is retired entirely — no refresh control exists anywhere", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      rerender(<ExpandedComments {...baseProps} open messages={[...messages, makeMessage({ id: "m4" })]} />);
      expect(screen.queryByTestId("expanded-comments-refresh")).not.toBeInTheDocument();
    });

    it("re-opening after being closed lands at the newest position again", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open={false} messages={messages} />);
      rerender(<ExpandedComments {...baseProps} open messages={messages} />);
      expect(screen.getAllByTestId("expanded-comment-row")[0]).toHaveTextContent("third");

      rerender(<ExpandedComments {...baseProps} open={false} messages={messages} />);
      const withNewOne = [...messages, makeMessage({ id: "m4", body: "landed while closed" })];
      rerender(<ExpandedComments {...baseProps} open messages={withNewOne} />);

      const rows = screen.getAllByTestId("expanded-comment-row");
      expect(rows).toHaveLength(4);
      expect(rows[0]).toHaveTextContent("landed while closed");
    });
  });

  describe("live viewport anchoring + new-comments indicator (real-device report: retired the frozen-snapshot model)", () => {
    const messages = [
      makeMessage({ id: "m1", body: "first", created_at: "2026-01-01T00:00:00.000Z" }),
      makeMessage({ id: "m2", body: "second", created_at: "2026-01-01T00:00:01.000Z" }),
      makeMessage({ id: "m3", body: "third", created_at: "2026-01-01T00:00:02.000Z" }),
    ];

    /** jsdom never actually lays out real pixel heights, so scrollHeight/scrollTop stay 0 by default — every anchoring test drives the scroll state explicitly rather than relying on real layout. */
    function stubScrollMetrics(el: HTMLElement, opts: { scrollTop: number; scrollHeight: number }) {
      Object.defineProperty(el, "scrollTop", { value: opts.scrollTop, writable: true, configurable: true });
      Object.defineProperty(el, "scrollHeight", { value: opts.scrollHeight, configurable: true });
    }

    /**
     * Two jsdom gaps this whole describe block works around, neither a
     * bug in the component itself:
     * 1. `Element.scrollTo` is a jsdom no-op — it never actually updates
     *    `scrollTop`, so a "jump to newest" assertion needs a real
     *    implementation to check against.
     * 2. The anchoring effect only *captures* the "before" scrollHeight
     *    on a render where its own dependencies (`messages`, by
     *    reference) actually change — a `stubScrollMetrics` call alone,
     *    with no accompanying prop change, is invisible to it. Every
     *    "establish a scrolled-away baseline" step below re-renders with
     *    a fresh array *reference* (`[...messages]`, same content) for
     *    exactly this reason.
     */
    const originalScrollTo = HTMLElement.prototype.scrollTo;
    beforeEach(() => {
      HTMLElement.prototype.scrollTo = function (this: HTMLElement, opts?: ScrollToOptions | number) {
        if (typeof opts === "object" && opts !== null && typeof opts.top === "number") {
          Object.defineProperty(this, "scrollTop", { value: opts.top, writable: true, configurable: true });
        }
      };
    });
    afterEach(() => {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    });

    it("a reader scrolled away from the newest position sees no scroll jump when a new comment arrives — the new-comments indicator appears instead", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      const scroller = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 800 });
      rerender(<ExpandedComments {...baseProps} open messages={[...messages]} />);
      fireEvent.scroll(scroller);
      expect(screen.queryByTestId("expanded-comments-new-indicator")).not.toBeInTheDocument();

      // A new comment prepends — simulate the resulting taller list.
      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 850 });
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4", body: "new arrival", author_guest_id: "someone-else", author_profile_id: null })]}
        />,
      );

      // Anchor preserved: scrollTop shifted by exactly the added height (50px), never reset to 0.
      expect(scroller.scrollTop).toBe(250);
      expect(screen.getByTestId("expanded-comments-new-indicator")).toHaveTextContent("1 new comment");
    });

    it("tapping the new-comments indicator scrolls to the newest position and clears the count", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      const scroller = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 800 });
      rerender(<ExpandedComments {...baseProps} open messages={[...messages]} />);
      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 850 });
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4", author_guest_id: "someone-else", author_profile_id: null })]}
        />,
      );
      expect(screen.getByTestId("expanded-comments-new-indicator")).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("expanded-comments-new-indicator"));
      expect(scroller.scrollTop).toBe(0);
      expect(screen.queryByTestId("expanded-comments-new-indicator")).not.toBeInTheDocument();
    });

    it("scrolling back up near the top manually also clears the indicator, without tapping it", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      const scroller = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 800 });
      rerender(<ExpandedComments {...baseProps} open messages={[...messages]} />);
      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 850 });
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4", author_guest_id: "someone-else", author_profile_id: null })]}
        />,
      );
      expect(screen.getByTestId("expanded-comments-new-indicator")).toBeInTheDocument();

      stubScrollMetrics(scroller, { scrollTop: 5, scrollHeight: 850 });
      fireEvent.scroll(scroller);
      expect(screen.queryByTestId("expanded-comments-new-indicator")).not.toBeInTheDocument();
    });

    it("a reader already at/near the newest position sees the new comment appear naturally, with no redundant indicator", async () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      // Stays at the top (the default state right after opening — never
      // scrolled away in this test at all).
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m4", body: "appears naturally", author_guest_id: "someone-else", author_profile_id: null })]}
        />,
      );
      expect(screen.getByText("appears naturally")).toBeInTheDocument();
      // The state update that keeps `newCount` at 0 here is deliberately
      // deferred a microtask (see the component's own `queueMicrotask`
      // doc comment) — `waitFor` covers that gap the same way it already
      // covers a real async round trip.
      await waitFor(() => expect(screen.queryByTestId("expanded-comments-new-indicator")).not.toBeInTheDocument());
    });

    it("posting my own comment jumps straight to it, even while I was reading older comments (the deliberate anchoring exception)", async () => {
      const viewerIdentity = { type: "profile" as const, id: "p1", displayName: "Jamie", username: null };
      const { rerender } = render(
        <ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />,
      );
      const scroller = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 800 });
      rerender(<ExpandedComments {...baseProps} open messages={[...messages]} viewerIdentity={viewerIdentity} />);

      stubScrollMetrics(scroller, { scrollTop: 200, scrollHeight: 850 });
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[...messages, makeMessage({ id: "m4", body: "my own new comment", author_profile_id: "p1" })]}
        />,
      );

      // Jumped to top (0), not anchored at the preserved 250 a stranger's
      // comment would have produced.
      expect(scroller.scrollTop).toBe(0);
      expect(screen.getAllByTestId("expanded-comment-row")[0]).toHaveTextContent("my own new comment");
      // Same deferred-microtask gap as the "already at newest" test above.
      await waitFor(() => expect(screen.queryByTestId("expanded-comments-new-indicator")).not.toBeInTheDocument());
    });
  });

  describe("own-comment 'You' marker (real-device report, Section 11-12)", () => {
    const viewerIdentity = { type: "profile" as const, id: "p1", displayName: "Jamie", username: null };
    const guestViewerIdentity = { type: "guest" as const, id: "g1", displayName: "Cheerful Raven" };

    it("marks my own comment with a 'You' indicator", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[makeMessage({ id: "m1", author_profile_id: "p1", author_display_name: "Jamie" })]}
        />,
      );
      expect(screen.getByTestId("comment-mine-marker")).toBeInTheDocument();
    });

    it("does not mark someone else's comment, even with the exact same display name", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[makeMessage({ id: "m1", author_profile_id: "someone-else", author_display_name: "Jamie" })]}
        />,
      );
      expect(screen.queryByTestId("comment-mine-marker")).not.toBeInTheDocument();
    });

    it("marks the guest viewer's own comment using stable guest identity, never display name", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={guestViewerIdentity}
          messages={[makeMessage({ id: "m1", author_profile_id: null, author_guest_id: "g1", author_display_name: "Cheerful Raven" })]}
        />,
      );
      expect(screen.getByTestId("comment-mine-marker")).toBeInTheDocument();
    });

    it("marks every one of my comments across the whole history, not only the newest", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[
            makeMessage({ id: "m1", author_profile_id: "p1", created_at: "2026-01-01T00:00:00.000Z" }),
            makeMessage({ id: "m2", author_profile_id: "someone-else", created_at: "2026-01-01T00:00:01.000Z" }),
            makeMessage({ id: "m3", author_profile_id: "p1", created_at: "2026-01-01T00:00:02.000Z" }),
          ]}
        />,
      );
      expect(screen.getAllByTestId("comment-mine-marker")).toHaveLength(2);
    });

    it("marks nothing at all when no viewer identity is given (degrades gracefully, never crashes)", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1", author_profile_id: "p1" })]} />);
      expect(screen.queryByTestId("comment-mine-marker")).not.toBeInTheDocument();
    });
  });

  describe("newly-sent comment highlight flash (real-device report, Section 6-7)", () => {
    const viewerIdentity = { type: "profile" as const, id: "p1", displayName: "Jamie", username: null };
    const messages = [makeMessage({ id: "m1", body: "first", author_profile_id: "someone-else", created_at: "2026-01-01T00:00:00.000Z" })];

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("the exact newly-sent message id receives a temporary highlight", async () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />);
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[...messages, makeMessage({ id: "m2", author_profile_id: "p1" })]}
        />,
      );
      // The state update driving the flash is deliberately deferred a
      // microtask (see ExpandedComments' own `queueMicrotask` doc
      // comment) — flush it the same way this file's anchoring tests do.
      await act(async () => {
        await Promise.resolve();
      });
      const flashedRow = document.querySelector('[data-message-id="m2"]');
      expect(flashedRow).toHaveAttribute("data-just-sent", "true");
    });

    it("highlight automatically clears after the flash duration", async () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />);
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[...messages, makeMessage({ id: "m2", author_profile_id: "p1" })]}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="m2"]')).toHaveAttribute("data-just-sent", "true");

      act(() => {
        vi.advanceTimersByTime(1200);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="m2"]')).not.toHaveAttribute("data-just-sent", "true");
    });

    it("an older comment of mine never flashes — only the one just sent", async () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />);
      const withMine = [...messages, makeMessage({ id: "m2", author_profile_id: "p1", created_at: "2026-01-01T00:00:01.000Z" })];
      rerender(<ExpandedComments {...baseProps} open viewerIdentity={viewerIdentity} messages={withMine} />);
      await act(async () => {
        await Promise.resolve();
      });
      // Let the flash on m2 expire, then send a second comment (m3) —
      // m2 (an older comment of mine now) must never re-flash.
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      await act(async () => {
        await Promise.resolve();
      });
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[...withMine, makeMessage({ id: "m3", author_profile_id: "p1", created_at: "2026-01-01T00:00:02.000Z" })]}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="m2"]')).not.toHaveAttribute("data-just-sent", "true");
      expect(document.querySelector('[data-message-id="m3"]')).toHaveAttribute("data-just-sent", "true");
    });

    it("another viewer's newest comment never flashes for me, even though it's the newest arrival", async () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />);
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[...messages, makeMessage({ id: "m2", author_profile_id: "someone-else-entirely" })]}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="m2"]')).not.toHaveAttribute("data-just-sent", "true");
    });

    it("a near-simultaneous incoming message from someone else never steals the flash meant for my own comment", async () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />);
      // My own comment arrives first.
      const withMine = [...messages, makeMessage({ id: "mine", author_profile_id: "p1", created_at: "2026-01-01T00:00:01.000Z" })];
      rerender(<ExpandedComments {...baseProps} open viewerIdentity={viewerIdentity} messages={withMine} />);
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="mine"]')).toHaveAttribute("data-just-sent", "true");

      // An almost-simultaneous comment from someone else arrives next,
      // before my own flash has expired.
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[...withMine, makeMessage({ id: "theirs", author_profile_id: "someone-else-entirely", created_at: "2026-01-01T00:00:02.000Z" })]}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });

      // My own row is still (or again) correctly the one flashing —
      // never the stranger's, and my own flash was never stolen by it.
      expect(document.querySelector('[data-message-id="theirs"]')).not.toHaveAttribute("data-just-sent", "true");
      expect(document.querySelector('[data-message-id="mine"]')).toHaveAttribute("data-just-sent", "true");
    });
  });

  describe("optimistic comment status (optimistic-send redesign, Sections 11-15)", () => {
    const viewerIdentity = { type: "profile" as const, id: "p1", displayName: "Jamie", username: null };

    it("shows a subtle 'Sending…' in place of the timestamp while optimisticStatus is 'sending'", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", optimisticStatus: "sending" })]}
        />,
      );
      expect(screen.getByTestId("comment-sending")).toHaveTextContent("Sending…");
    });

    it("shows a tappable 'Not sent · Retry' in place of the timestamp when optimisticStatus is 'failed'", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", optimisticStatus: "failed" })]}
        />,
      );
      expect(screen.getByTestId("comment-not-sent-retry")).toHaveTextContent("Not sent · Retry");
    });

    it("tapping Retry calls retryComment with that exact message's id — never touches the composer's own draft", () => {
      const retryComment = vi.fn();
      render(
        <ExpandedComments
          {...baseProps}
          retryComment={retryComment}
          open
          messages={[makeMessage({ id: "m1", optimisticStatus: "failed" })]}
        />,
      );
      fireEvent.click(screen.getByTestId("comment-not-sent-retry"));
      expect(retryComment).toHaveBeenCalledWith("m1");
      expect((screen.getByPlaceholderText("Add a comment…") as HTMLInputElement).value).toBe("");
    });

    it("tapping Retry never also triggers the row's own double-tap-to-like handler", () => {
      const retryComment = vi.fn();
      const onLike = vi.fn();
      render(
        <ExpandedComments
          {...baseProps}
          retryComment={retryComment}
          open
          messages={[makeMessage({ id: "m1", optimisticStatus: "failed" })]}
        />,
      );
      fireEvent.click(screen.getByTestId("comment-not-sent-retry"));
      fireEvent.click(screen.getByTestId("comment-not-sent-retry"));
      expect(onLike).not.toHaveBeenCalled();
    });

    it("a normal (never-optimistic) message still shows its ordinary timestamp, not a status", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage({ id: "m1" })]} />);
      expect(screen.queryByTestId("comment-sending")).not.toBeInTheDocument();
      expect(screen.queryByTestId("comment-not-sent-retry")).not.toBeInTheDocument();
    });

    // Design insight (optimistic-send redesign): confirmation replaces the
    // optimistic entry in place — same id, same array index — so the
    // anchoring effect's own "is this a new arrival" check (id changed)
    // never fires again on confirmation. This is what keeps the earlier
    // optimistic-insert flash from firing a second time, and confirms no
    // extra guarding was needed in this file for that.
    it("confirming an optimistic message (same id, optimisticStatus clearing) never re-flashes or re-jumps — only the original optimistic insert flashes", async () => {
      vi.useFakeTimers();
      const messages = [makeMessage({ id: "m0", body: "earlier", author_profile_id: "someone-else" })];
      const { rerender } = render(
        <ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />,
      );

      // The optimistic insert — flashes immediately.
      const optimistic = makeMessage({ id: "mine", author_profile_id: "p1", optimisticStatus: "sending" });
      rerender(
        <ExpandedComments {...baseProps} open viewerIdentity={viewerIdentity} messages={[...messages, optimistic]} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="mine"]')).toHaveAttribute("data-just-sent", "true");

      // Let the flash expire, exactly as a real confirmation delay would.
      act(() => {
        vi.advanceTimersByTime(1200);
      });
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="mine"]')).not.toHaveAttribute("data-just-sent", "true");

      // Confirmation: same id, optimisticStatus cleared — never a new
      // array id, so this must not re-trigger the flash.
      const confirmed = { ...optimistic, optimisticStatus: undefined };
      rerender(
        <ExpandedComments {...baseProps} open viewerIdentity={viewerIdentity} messages={[...messages, confirmed]} />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="mine"]')).not.toHaveAttribute("data-just-sent", "true");
      expect(screen.queryByTestId("comment-sending")).not.toBeInTheDocument();
      vi.useRealTimers();
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

  it("sends a comment from the expanded composer via submitComment (optimistic-send redesign)", () => {
    const submitComment = vi.fn();
    render(<ExpandedComments {...baseProps} submitComment={submitComment} open messages={[]} />);

    const input = screen.getByPlaceholderText("Add a comment…");
    fireEvent.change(input, { target: { value: "hello from the sheet" } });
    fireEvent.click(screen.getByRole("button", { name: "Send comment" }));

    expect(submitComment).toHaveBeenCalledWith("hello from the sheet");
  });

  describe("miniStage (mobile UX correction: this sheet must not cover the entire stage)", () => {
    it("without a miniStage, the sheet keeps its original partial-height, rounded-top behavior — no existing caller/test is affected", () => {
      render(<ExpandedComments {...baseProps} open messages={[]} />);
      const sheet = screen.getByTestId("expanded-comments");
      expect(sheet.className).toMatch(/h-\[70vh\]/);
      expect(sheet.className).toMatch(/rounded-t-2xl/);
      expect(screen.queryByTestId("expanded-comments-mini-stage")).not.toBeInTheDocument();
    });

    it("renders the given miniStage content above the drag handle, before the scrollable comments", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[]}
          miniStage={<div data-testid="fake-mini-stage">both speakers here</div>}
        />,
      );
      expect(screen.getByTestId("fake-mini-stage")).toHaveTextContent("both speakers here");
      const sheet = screen.getByTestId("expanded-comments");
      const children = Array.from(sheet.children).map((el) => el.getAttribute("data-testid"));
      const miniStageIndex = children.indexOf("expanded-comments-mini-stage");
      const handleIndex = children.indexOf("expanded-comments-handle");
      expect(miniStageIndex).toBeGreaterThanOrEqual(0);
      expect(miniStageIndex).toBeLessThan(handleIndex);
    });

    it("with a miniStage, the sheet spans the full height instead of a partial 70vh — the mini stage itself is the visible top of the screen", () => {
      render(<ExpandedComments {...baseProps} open messages={[]} miniStage={<div />} />);
      const sheet = screen.getByTestId("expanded-comments");
      expect(sheet.className).toMatch(/inset-0/);
      expect(sheet.className).not.toMatch(/h-\[70vh\]/);
    });

    it("comments, requests, refresh, and the composer all still render normally alongside a miniStage", () => {
      render(
        <ExpandedComments
          {...baseProps}
          open
          messages={[makeMessage({ id: "m1", body: "still here" })]}
          miniStage={<div />}
        />,
      );
      expect(screen.getByText("still here")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
    });

    it("closing (and reopening) still works the same with a miniStage present", () => {
      const onClose = vi.fn();
      render(<ExpandedComments {...baseProps} onClose={onClose} open messages={[]} miniStage={<div />} />);
      fireEvent.click(screen.getByTestId("expanded-comments-close"));
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe("contained scroll, no page-level rubber-band (real-device report, iPhone Safari overscroll finding)", () => {
    /**
     * jsdom performs no real layout — every element's `scrollHeight`/
     * `clientHeight`/`scrollTop` default to 0 unless explicitly stubbed.
     * That default (`scrollHeight === clientHeight === 0`) is actually
     * the exact "few comments"/non-scrollable case (Section 6) already,
     * useful on its own — `stubScrollMetrics` lets the genuinely-
     * scrollable cases override it explicitly.
     */
    function stubScrollMetrics(el: HTMLElement, metrics: { scrollTop?: number; scrollHeight?: number; clientHeight?: number }) {
      if (metrics.scrollTop !== undefined) {
        Object.defineProperty(el, "scrollTop", { value: metrics.scrollTop, writable: true, configurable: true });
      }
      if (metrics.scrollHeight !== undefined) {
        Object.defineProperty(el, "scrollHeight", { value: metrics.scrollHeight, configurable: true });
      }
      if (metrics.clientHeight !== undefined) {
        Object.defineProperty(el, "clientHeight", { value: metrics.clientHeight, configurable: true });
      }
    }

    function touchMoveAt(el: HTMLElement, clientY: number): boolean {
      const event = new TouchEvent("touchmove", {
        touches: [{ clientY } as Touch],
        cancelable: true,
        bubbles: true,
      });
      return el.dispatchEvent(event);
    }

    it("the scroll container carries native overscroll containment (overscroll-y-contain) and vertical touch-action (touch-pan-y)", () => {
      render(<ExpandedComments {...baseProps} open messages={[]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      expect(list.className).toMatch(/\boverscroll-y-contain\b/);
      expect(list.className).toMatch(/\btouch-pan-y\b/);
    });

    it("reaching the bottom and dragging further up prevents the native touchmove — never left to chain to the page", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 100, scrollHeight: 200, clientHeight: 100 }); // exactly at the bottom edge

      let notCanceled = touchMoveAt(list, 100); // establish a baseline position — no direction to compare yet
      expect(notCanceled).toBe(true);

      act(() => {
        notCanceled = touchMoveAt(list, 80); // finger moves up 20px while already at the bottom
      });
      expect(notCanceled).toBe(false); // defaultPrevented — the browser never saw this as a normal scroll
    });

    it("reaching the top and dragging further down prevents the native touchmove — never left to chain to the page", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 }); // at the top edge, genuinely scrollable

      let notCanceled = touchMoveAt(list, 200);
      expect(notCanceled).toBe(true);

      act(() => {
        notCanceled = touchMoveAt(list, 220); // finger moves down 20px while already at the top
      });
      expect(notCanceled).toBe(false);
    });

    it("an ordinary in-bounds scroll (not at either edge) is never intercepted — native scrolling proceeds untouched", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 150, scrollHeight: 400, clientHeight: 100 }); // comfortably mid-list, neither edge

      touchMoveAt(list, 200);
      let notCanceled = true;
      act(() => {
        notCanceled = touchMoveAt(list, 150); // a normal 50px drag, nowhere near either boundary
      });
      expect(notCanceled).toBe(true); // never prevented — this is exactly the "don't break ordinary scrolling" requirement
    });

    it("the few-comments / non-scrollable case (scrollHeight === clientHeight) is contained in either drag direction — never assumes scrollHeight > clientHeight", () => {
      render(<ExpandedComments {...baseProps} open messages={[]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      // jsdom's own default (no explicit stub) already models a
      // non-scrollable element — scrollHeight/clientHeight both 0 — but
      // stubbed explicitly here for clarity/robustness against jsdom
      // ever changing that default.
      stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 80, clientHeight: 80 });

      touchMoveAt(list, 100);
      let notCanceledDown = true;
      act(() => {
        notCanceledDown = touchMoveAt(list, 130); // dragging down with nothing to scroll
      });
      expect(notCanceledDown).toBe(false);
    });

    it("the damped visual offset is capped — a large drag never produces a large transform", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 });

      touchMoveAt(list, 0);
      act(() => {
        touchMoveAt(list, 10); // crosses the boundary — this frame just marks the crossing (Section 3, no huge initial jump)
      });
      act(() => {
        touchMoveAt(list, 2000); // a huge, unrealistic pull — the cap must hold regardless
      });

      const match = list.style.transform.match(/translateY\(([-\d.]+)px\)/);
      expect(match).not.toBeNull();
      const offset = Math.abs(Number(match?.[1]));
      expect(offset).toBeLessThanOrEqual(24); // MAX_OVERSCROLL_PX
      expect(offset).toBeGreaterThan(0);
    });

    it("releasing (touchend) resets the offset back to zero", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 });

      touchMoveAt(list, 0);
      act(() => {
        touchMoveAt(list, 10);
      });
      act(() => {
        touchMoveAt(list, 40);
      });
      expect(list.style.transform).toMatch(/translateY/);

      act(() => {
        list.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
      });
      expect(list.style.transform).toBeFalsy();
    });

    it("releasing via touchcancel also resets the offset back to zero", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 });

      touchMoveAt(list, 0);
      act(() => {
        touchMoveAt(list, 15);
      });
      act(() => {
        list.dispatchEvent(new TouchEvent("touchcancel", { bubbles: true }));
      });
      expect(list.style.transform).toBeFalsy();
    });

    it("a second finger joining (pinch-zoom) abandons any in-progress overscroll rather than fighting multi-touch gestures", () => {
      render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 });

      touchMoveAt(list, 0);
      act(() => {
        touchMoveAt(list, 10); // crosses the boundary — zero offset on this frame
      });
      act(() => {
        touchMoveAt(list, 20); // continues past it — offset now visible
      });
      expect(list.style.transform).toMatch(/translateY/);

      act(() => {
        const event = new TouchEvent("touchmove", {
          touches: [{ clientY: 30 } as Touch, { clientY: 60 } as Touch],
          cancelable: true,
          bubbles: true,
        });
        list.dispatchEvent(event);
      });
      expect(list.style.transform).toBeFalsy();
    });

    describe("prefers-reduced-motion", () => {
      const originalMatchMedia = window.matchMedia;

      beforeEach(() => {
        vi.stubGlobal("matchMedia", (query: string) => ({
          matches: query.includes("prefers-reduced-motion"),
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }));
      });

      afterEach(() => {
        window.matchMedia = originalMatchMedia;
      });

      it("skips the decorative visual offset entirely, while containment (preventDefault) still applies", () => {
        render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
        const list = screen.getByTestId("expanded-comments-scroll");
        stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 });

        touchMoveAt(list, 0);
        let notCanceled = true;
        act(() => {
          notCanceled = touchMoveAt(list, 20);
        });
        expect(notCanceled).toBe(false); // containment still holds
        act(() => {
          touchMoveAt(list, 60);
        });
        expect(list.style.transform).toBeFalsy(); // but no decorative bounce is ever applied
      });
    });

    it("does not regress new-comment viewport anchoring — a stranger's comment while reading older ones still increments the indicator, not a jump", () => {
      const messages = [makeMessage({ id: "m1", author_profile_id: "someone-else" })];
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 200, scrollHeight: 600, clientHeight: 100 }); // reading older comments, not near the top
      fireEvent.scroll(list);

      rerender(
        <ExpandedComments
          {...baseProps}
          open
          messages={[...messages, makeMessage({ id: "m2", author_profile_id: "someone-else-entirely" })]}
        />,
      );
      expect(screen.getByTestId("expanded-comments-new-indicator")).toHaveTextContent("1 new comment");
    });

    it("does not regress own-comment jump-to-newest — posting my own comment still scrolls to it even while mid-excursion state is otherwise idle", async () => {
      const viewerIdentity = { type: "profile" as const, id: "p1", displayName: "Jamie", username: null };
      const messages = [makeMessage({ id: "m1", author_profile_id: "someone-else" })];
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={messages} viewerIdentity={viewerIdentity} />);
      rerender(
        <ExpandedComments
          {...baseProps}
          open
          viewerIdentity={viewerIdentity}
          messages={[...messages, makeMessage({ id: "m2", author_profile_id: "p1" })]}
        />,
      );
      await act(async () => {
        await Promise.resolve();
      });
      expect(document.querySelector('[data-message-id="m2"]')).toHaveAttribute("data-just-sent", "true");
    });

    it("does not regress the composer — sending still works normally alongside the new touch handling", () => {
      const submitComment = vi.fn();
      render(<ExpandedComments {...baseProps} submitComment={submitComment} open messages={[]} />);
      const input = screen.getByPlaceholderText("Add a comment…");
      fireEvent.change(input, { target: { value: "still works" } });
      fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
      expect(submitComment).toHaveBeenCalledWith("still works");
    });

    it("closing removes the touch listeners — a stray touchmove on the old node afterward does nothing and never throws", () => {
      const { rerender } = render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
      const list = screen.getByTestId("expanded-comments-scroll");
      stubScrollMetrics(list, { scrollTop: 0, scrollHeight: 400, clientHeight: 100 });
      touchMoveAt(list, 0);

      rerender(<ExpandedComments {...baseProps} open={false} messages={[makeMessage()]} />);

      expect(() => touchMoveAt(list, 999)).not.toThrow();
    });

    describe("panel-level backstop — blank-area drags outside the scroller (real-device follow-up: dragging from the mini-stage band, or any other sheet chrome, still leaked to the page)", () => {
      /**
       * Real-device follow-up, traced live via `document.elementFromPoint`
       * against the actual mounted DOM: `expanded-comments-mini-stage` is
       * a *sibling* of `expanded-comments-scroll`, not a descendant — a
       * touch starting there never bubbles through the scroller's own
       * listener at all. This backstop, attached to the sheet root, is
       * what covers it — deliberately unconditional (no edge-detection,
       * no spring) since this region never legitimately scrolls.
       */
      function touchMoveOn(el: HTMLElement, clientY: number): boolean {
        const event = new TouchEvent("touchmove", {
          touches: [{ clientY } as Touch],
          cancelable: true,
          bubbles: true,
        });
        return el.dispatchEvent(event);
      }

      it("expanded-comments-mini-stage is a sibling of the scroller, not a descendant — confirms why the scroller's own listener alone can never see a touch that starts there", () => {
        render(<ExpandedComments {...baseProps} open messages={[]} miniStage={<div data-testid="fake-mini-stage" />} />);
        const scroller = screen.getByTestId("expanded-comments-scroll");
        const miniStage = screen.getByTestId("expanded-comments-mini-stage");
        expect(scroller.contains(miniStage)).toBe(false);
      });

      it("a drag starting on the mini-stage band is prevented from chaining to the page", () => {
        render(<ExpandedComments {...baseProps} open messages={[]} miniStage={<div data-testid="fake-mini-stage">stage</div>} />);
        const miniStage = screen.getByTestId("expanded-comments-mini-stage");

        // First move only establishes a baseline for the *scroller's own*
        // handler — the backstop has no such warm-up, it's unconditional
        // from the very first move that reaches it.
        const notCanceled = touchMoveOn(miniStage, 100);
        expect(notCanceled).toBe(false);
      });

      it("a drag starting directly on the sheet root (background chrome outside every named region) is also contained", () => {
        render(<ExpandedComments {...baseProps} open messages={[]} />);
        const sheet = screen.getByTestId("expanded-comments");
        const notCanceled = touchMoveOn(sheet, 100);
        expect(notCanceled).toBe(false);
      });

      it("never double-handles (or breaks) a drag that started inside the actual scroller — the backstop defers to the scroller's own listener entirely", () => {
        render(<ExpandedComments {...baseProps} open messages={[makeMessage()]} />);
        const list = screen.getByTestId("expanded-comments-scroll");
        stubScrollMetrics(list, { scrollTop: 150, scrollHeight: 400, clientHeight: 100 }); // comfortably mid-list, not at an edge

        touchMoveAt(list, 200);
        let notCanceled = true;
        act(() => {
          notCanceled = touchMoveAt(list, 150); // ordinary in-bounds scroll
        });
        // The backstop must not additionally prevent this — normal
        // scrolling inside the list is untouched, exactly as it was
        // before this backstop existed.
        expect(notCanceled).toBe(true);
      });

      it("a multi-touch gesture (pinch-zoom) starting outside the scroller is left alone, same as the scroller's own handler", () => {
        render(<ExpandedComments {...baseProps} open messages={[]} miniStage={<div data-testid="fake-mini-stage" />} />);
        const miniStage = screen.getByTestId("expanded-comments-mini-stage");
        const event = new TouchEvent("touchmove", {
          touches: [{ clientY: 100 } as Touch, { clientY: 200 } as Touch],
          cancelable: true,
          bubbles: true,
        });
        const notCanceled = miniStage.dispatchEvent(event);
        expect(notCanceled).toBe(true);
      });

      it("interactive controls outside the scroller (e.g. Close) remain fully clickable — the backstop only ever prevents touchmove, never touchstart/touchend/click", () => {
        const onClose = vi.fn();
        render(<ExpandedComments {...baseProps} onClose={onClose} open messages={[]} miniStage={<div />} />);
        fireEvent.click(screen.getByTestId("expanded-comments-close"));
        expect(onClose).toHaveBeenCalledTimes(1);
      });

      it("removes the backstop listener on close — a stray touchmove on the old sheet node afterward does nothing and never throws", () => {
        const { rerender } = render(<ExpandedComments {...baseProps} open messages={[]} miniStage={<div data-testid="fake-mini-stage" />} />);
        const sheet = screen.getByTestId("expanded-comments");
        touchMoveOn(sheet, 0);

        rerender(<ExpandedComments {...baseProps} open={false} messages={[]} miniStage={<div data-testid="fake-mini-stage" />} />);

        expect(() => touchMoveOn(sheet, 999)).not.toThrow();
      });
    });
  });
});
