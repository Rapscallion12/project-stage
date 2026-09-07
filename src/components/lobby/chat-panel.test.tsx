import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./chat-panel";

const { submitSpeakerRequest } = vi.hoisted(() => ({
  submitSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({ submitSpeakerRequest }));

// jsdom doesn't implement Element.scrollTo — unrelated to anything this
// file tests.
Element.prototype.scrollTo = vi.fn();

// Real-device report (optimistic-send redesign): ordinary commenting no
// longer goes through a server action from this component at all —
// `submitComment` (a prop, from `useLobbyRealtime`) is the one thing this
// file asserts against for the comment path now. Mic-request mode is
// unchanged and still exercises the real `submitSpeakerRequest` mock.
const baseProps = {
  eventId: "e1",
  messages: [],
  reactions: {},
  submitComment: vi.fn(),
  micRequestMode: false,
  onMicRequestModeChange: vi.fn(),
  onHasPendingRequestChange: vi.fn(),
  onPrepareMedia: vi.fn(),
};

describe("ChatPanel", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults to normal comment mode: 'Say something…' / 'Send'", () => {
    render(<ChatPanel {...baseProps} />);
    expect(screen.getByPlaceholderText("Say something…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("What do you want to talk about?")).not.toBeInTheDocument();
  });

  it("tapping 🎤 requests mode-change rather than switching itself — the mode is a controlled prop", () => {
    const onMicRequestModeChange = vi.fn();
    render(<ChatPanel {...baseProps} onMicRequestModeChange={onMicRequestModeChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Request to speak" }));
    expect(onMicRequestModeChange).toHaveBeenCalledWith(true);
  });

  it("in mic-request mode, shows 'What do you want to talk about?' / 'Request' — the same input/button pair, not a second form", () => {
    render(<ChatPanel {...baseProps} micRequestMode={true} />);
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.getByPlaceholderText("What do you want to talk about?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Request" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Say something…")).not.toBeInTheDocument();
  });

  it("submitting in normal mode calls submitComment immediately, never submitSpeakerRequest", () => {
    const submitComment = vi.fn();
    render(<ChatPanel {...baseProps} submitComment={submitComment} />);
    fireEvent.change(screen.getByPlaceholderText("Say something…"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(submitComment).toHaveBeenCalledWith("hello");
    expect(submitSpeakerRequest).not.toHaveBeenCalled();
  });

  it("submitting in mic-request mode calls the existing authoritative request path (submitSpeakerRequest), never submitComment", async () => {
    submitSpeakerRequest.mockResolvedValue(undefined);
    const submitComment = vi.fn();
    render(<ChatPanel {...baseProps} submitComment={submitComment} micRequestMode={true} />);
    fireEvent.change(screen.getByPlaceholderText("What do you want to talk about?"), {
      target: { value: "AI and creativity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    await waitFor(() => expect(submitSpeakerRequest).toHaveBeenCalled());
    expect(submitComment).not.toHaveBeenCalled();
  });

  it("a successful request flips hasPendingRequest and drops the composer back to normal mode", async () => {
    submitSpeakerRequest.mockResolvedValue(undefined);
    const onHasPendingRequestChange = vi.fn();
    const onMicRequestModeChange = vi.fn();
    render(
      <ChatPanel
        {...baseProps}
        micRequestMode={true}
        onHasPendingRequestChange={onHasPendingRequestChange}
        onMicRequestModeChange={onMicRequestModeChange}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText("What do you want to talk about?"), {
      target: { value: "AI and creativity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request" }));

    await waitFor(() => expect(onHasPendingRequestChange).toHaveBeenCalledWith(true));
    expect(onMicRequestModeChange).toHaveBeenCalledWith(false);
  });

  it("submitting a speaker request also acquires camera/mic, synchronously from the same gesture — issue #22", () => {
    submitSpeakerRequest.mockResolvedValue(undefined);
    const onPrepareMedia = vi.fn();
    render(<ChatPanel {...baseProps} micRequestMode={true} onPrepareMedia={onPrepareMedia} />);
    fireEvent.change(screen.getByPlaceholderText("What do you want to talk about?"), {
      target: { value: "AI and creativity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    expect(onPrepareMedia).toHaveBeenCalledTimes(1);
  });

  it("submitting a normal chat message never acquires camera/mic", () => {
    const onPrepareMedia = vi.fn();
    render(<ChatPanel {...baseProps} onPrepareMedia={onPrepareMedia} />);
    fireEvent.change(screen.getByPlaceholderText("Say something…"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(onPrepareMedia).not.toHaveBeenCalled();
  });

  it("a failed request shows its error and stays in request mode — never silently reverts", async () => {
    submitSpeakerRequest.mockResolvedValue({ error: "You already have a pending request." });
    const onMicRequestModeChange = vi.fn();
    render(<ChatPanel {...baseProps} micRequestMode={true} onMicRequestModeChange={onMicRequestModeChange} />);
    fireEvent.change(screen.getByPlaceholderText("What do you want to talk about?"), {
      target: { value: "AI and creativity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request" }));

    await waitFor(() => expect(screen.getByText("You already have a pending request.")).toBeInTheDocument());
    expect(onMicRequestModeChange).not.toHaveBeenCalledWith(false);
  });

  describe("comment draft clears instantly on submit, never waits for the server (optimistic-send redesign, Sections 1-2, 8, 10)", () => {
    it("clears the draft the instant of submit — before submitComment's own caller ever resolves anything", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} />);
      const input = screen.getByPlaceholderText("Say something…") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "hello there" } });
      expect(input.value).toBe("hello there");
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(input.value).toBe("");
      expect(submitComment).toHaveBeenCalledWith("hello there");
    });

    // Real-device report: the previous (blocking) composer could wipe a
    // second, not-yet-submitted draft the moment an earlier submission's
    // own success settled. Comment-mode no longer has any settle
    // lifecycle to race with at all — this pins that a second draft typed
    // immediately after sending the first is never touched.
    it("typing a new draft immediately after sending the previous one is never wiped — no pending/settle lifecycle exists to race with", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} />);
      const input = screen.getByPlaceholderText("Say something…") as HTMLInputElement;

      fireEvent.change(input, { target: { value: "first comment" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(input.value).toBe("");

      fireEvent.change(input, { target: { value: "second comment, not yet sent" } });
      expect(input.value).toBe("second comment, not yet sent");
      expect(submitComment).toHaveBeenCalledTimes(1);
      expect(submitComment).toHaveBeenCalledWith("first comment");
    });

    it("refocuses the input immediately after submit — ready for the next comment with zero delay", () => {
      render(<ChatPanel {...baseProps} />);
      const input = screen.getByPlaceholderText("Say something…");
      fireEvent.change(input, { target: { value: "hello" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(input).toHaveFocus();
    });
  });

  describe("send button governed only by the current draft — never by an earlier comment's own pending state (Section 7)", () => {
    it("disabled for an empty or whitespace-only draft, enabled otherwise", () => {
      render(<ChatPanel {...baseProps} />);
      const button = screen.getByRole("button", { name: "Send" });
      expect(button).toBeDisabled();
      fireEvent.change(screen.getByPlaceholderText("Say something…"), { target: { value: "   " } });
      expect(button).toBeDisabled();
      fireEvent.change(screen.getByPlaceholderText("Say something…"), { target: { value: "hi" } });
      expect(button).not.toBeDisabled();
    });

    it("stays active for a freshly-typed valid draft immediately after sending a previous comment — ChatPanel itself has no notion of an 'earlier comment still pending' at all; that state lives entirely in useLobbyRealtime's own messages array, never here", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} />);
      const input = screen.getByPlaceholderText("Say something…");
      const button = screen.getByRole("button", { name: "Send" });

      fireEvent.change(input, { target: { value: "hello" } });
      fireEvent.click(button);
      expect(button).toBeDisabled(); // empty draft again, momentarily

      fireEvent.change(input, { target: { value: "another one" } });
      expect(button).not.toBeDisabled();
    });
  });

  describe("multiple comments can be in flight at once — never single-flight-guarded (Section 5)", () => {
    it("sending comment A, then immediately B, then C, calls submitComment three times in order — no dedup, no queueing at this layer", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} />);
      const input = screen.getByPlaceholderText("Say something…");
      const button = screen.getByRole("button", { name: "Send" });

      fireEvent.change(input, { target: { value: "A" } });
      fireEvent.click(button);
      fireEvent.change(input, { target: { value: "B" } });
      fireEvent.click(button);
      fireEvent.change(input, { target: { value: "C" } });
      fireEvent.click(button);

      expect(submitComment.mock.calls.map((call) => call[0])).toEqual(["A", "B", "C"]);
    });
  });

  describe("exactly-once submission, visible arrow and keyboard share one authoritative path (real-device report, Sections 1-2, 9-10)", () => {
    it("a single tap on the visible arrow submits exactly once", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} />);
      fireEvent.change(screen.getByPlaceholderText("Say something…"), { target: { value: "hello" } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(submitComment).toHaveBeenCalledTimes(1);
    });

    it("an empty or whitespace-only draft never submits at all", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} />);
      fireEvent.change(screen.getByPlaceholderText("Say something…"), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Send" }));
      expect(submitComment).not.toHaveBeenCalled();
    });

    it("keyboard submission (the form's native submit event, e.g. Enter on this single-line input) invokes the exact same submitComment path as the visible arrow, exactly once", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} />);
      const input = screen.getByPlaceholderText("Say something…");
      fireEvent.change(input, { target: { value: "typed then entered" } });
      fireEvent.submit(screen.getByTestId("chat-composer-form"));
      expect(submitComment).toHaveBeenCalledTimes(1);
      expect(submitComment).toHaveBeenCalledWith("typed then entered");
    });

    it("keyboard submission clears the draft immediately, same as the visible arrow", () => {
      render(<ChatPanel {...baseProps} />);
      const input = screen.getByPlaceholderText("Say something…") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "typed then entered" } });
      fireEvent.submit(screen.getByTestId("chat-composer-form"));
      expect(input.value).toBe("");
    });

    it("sets enterKeyHint to 'send' on the single-line input, for a deterministic mobile keyboard action key (Section 9)", () => {
      render(<ChatPanel {...baseProps} />);
      expect(screen.getByPlaceholderText("Say something…")).toHaveAttribute("enterkeyhint", "send");
    });

    it("the compact composer (both the ambient bar and Expanded Comments render this exact mode) uses the identical submission behavior", () => {
      const submitComment = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} compact />);
      const input = screen.getByPlaceholderText("Add a comment…") as HTMLInputElement;
      fireEvent.change(input, { target: { value: "compact composer test" } });
      fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
      expect(input.value).toBe("");
      expect(submitComment).toHaveBeenCalledTimes(1);
      expect(submitComment).toHaveBeenCalledWith("compact composer test");
    });

    it("the compact composer's arrow is a real functional submit target — not merely visually present", () => {
      render(<ChatPanel {...baseProps} compact />);
      fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hi" } });
      const button = screen.getByRole("button", { name: "Send comment" });
      expect(button).toHaveAttribute("type", "submit");
      expect(button.closest("form")).toBe(screen.getByTestId("chat-composer-form"));
      expect(button).not.toBeDisabled();
    });

    it("sets enterKeyHint to 'send' on the compact input too", () => {
      render(<ChatPanel {...baseProps} compact />);
      expect(screen.getByPlaceholderText("Add a comment…")).toHaveAttribute("enterkeyhint", "send");
    });
  });

  describe("compact mode (issue #21, '05 — Social Stage' Phase 2: Watch Mode's persistent composer)", () => {
    it("renders only the form — no message history, no quick-emoji row", () => {
      render(<ChatPanel {...baseProps} compact messages={[{
        id: "m1",
        author_display_name: "Sam",
        author_profile_id: "p1",
        author_guest_id: null,
        body: "hello",
        created_at: new Date().toISOString(),
        is_speaker_request: false,
      }]} />);
      expect(screen.queryByText("hello")).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/^Insert /)).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
    });

    describe("landscape width cap (real-device finding, issue #21: the composer stretched across most of the screen in landscape, pushing React/Vote/Gift to the far right)", () => {
      // Pins the rendered CSS class — jsdom doesn't evaluate the
      // `orientation` media query itself, so this can't exercise the
      // actual landscape-vs-portrait visual difference. Real-device-only
      // check for that (see this session's verification report).
      it("the compact form caps its width in landscape, uncapped in portrait", () => {
        render(<ChatPanel {...baseProps} compact />);
        const form = screen.getByTestId("chat-composer-form");
        expect(form.className).toMatch(/\blandscape:max-w-\[40%\]/);
      });

      it("still grows/shrinks normally up to that cap — min-w-0 and flex-1 both preserved, not a fixed size", () => {
        render(<ChatPanel {...baseProps} compact />);
        const form = screen.getByTestId("chat-composer-form");
        expect(form.className).toMatch(/\bmin-w-0\b/);
        const pill = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
        expect(pill.className).toMatch(/\bflex-1\b/);
        expect(pill.className).toMatch(/\bmin-w-0\b/);
      });

      it("full (non-compact) mode is unaffected — no landscape cap applied", () => {
        render(<ChatPanel {...baseProps} />);
        const form = screen.getByTestId("chat-composer-form");
        expect(form.className).not.toMatch(/landscape:/);
      });
    });

    describe("idle adaptive transparency (pre-launch interaction pass follow-up: the compact pill is the widest surface in Watch Mode's bottom row, so leaving it out of the idle fade left the effect barely visible)", () => {
      it("defaults to the full-opacity glass background, same as before this prop existed", () => {
        render(<ChatPanel {...baseProps} compact />);
        const pill = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
        expect(pill.className).toMatch(/bg-white\/\[0\.14\]/);
      });

      it("fades to a fully transparent fill when idle — border, mic icon, and placeholder text untouched", () => {
        render(<ChatPanel {...baseProps} compact idle />);
        const pill = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
        expect(pill.className).toMatch(/bg-transparent/);
        expect(pill.className).not.toMatch(/bg-white\/\[0\.14\]/);
        expect(pill.className).toMatch(/border-white\/30/);
        expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();
      });

      it("does not fade the mic-request-mode accent background even while idle — that's an active state, not idle chrome", () => {
        render(<ChatPanel {...baseProps} compact idle micRequestMode={true} />);
        const pill = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
        expect(pill.className).toMatch(/bg-accent\/15/);
        expect(pill.className).not.toMatch(/bg-transparent/);
      });
    });

    describe("input font size (real-device finding, 2026-08-23: text-sm/14px triggered iOS Safari's auto-zoom-on-focus)", () => {
      // This only pins the rendered CSS class, which is what actually
      // governs the computed font-size — it does not and cannot exercise
      // real Safari zoom behavior. That's a real-device-only check (see
      // this session's verification report).
      it("the input uses text-base (16px+), never text-sm, when commenting normally", () => {
        render(<ChatPanel {...baseProps} compact />);
        const input = screen.getByPlaceholderText("Add a comment…");
        expect(input.className).toMatch(/\btext-base\b/);
        expect(input.className).not.toMatch(/\btext-sm\b/);
      });

      it("the same is true in Request-to-Speak (mic-on) mode — same input element, same fix applies to both", () => {
        render(<ChatPanel {...baseProps} compact micRequestMode={true} />);
        const input = screen.getByPlaceholderText("What's your topic?");
        expect(input.className).toMatch(/\btext-base\b/);
        expect(input.className).not.toMatch(/\btext-sm\b/);
      });
    });

    it("defaults to the comment placeholder; mic mode switches to the request placeholder — same contract as full mode", () => {
      const { rerender } = render(<ChatPanel {...baseProps} compact />);
      expect(screen.getByPlaceholderText("Add a comment…")).toBeInTheDocument();

      rerender(<ChatPanel {...baseProps} compact micRequestMode={true} />);
      expect(screen.getByPlaceholderText("What's your topic?")).toBeInTheDocument();
    });

    it("tapping the mic toggle requests mode-change — same controlled-prop contract as full mode", () => {
      const onMicRequestModeChange = vi.fn();
      render(<ChatPanel {...baseProps} compact onMicRequestModeChange={onMicRequestModeChange} />);
      fireEvent.click(screen.getByTestId("watch-composer-mic"));
      expect(onMicRequestModeChange).toHaveBeenCalledWith(true);
    });

    it("sending a normal comment calls submitComment, never submitSpeakerRequest or onPrepareMedia", () => {
      const submitComment = vi.fn();
      const onPrepareMedia = vi.fn();
      render(<ChatPanel {...baseProps} submitComment={submitComment} compact onPrepareMedia={onPrepareMedia} />);
      fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "nice point" } });
      fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
      expect(submitComment).toHaveBeenCalledWith("nice point");
      expect(submitSpeakerRequest).not.toHaveBeenCalled();
      expect(onPrepareMedia).not.toHaveBeenCalled();
    });

    it("submitting a request in mic mode still calls onPrepareMedia synchronously, same as full mode", () => {
      submitSpeakerRequest.mockResolvedValue(undefined);
      const onPrepareMedia = vi.fn();
      render(<ChatPanel {...baseProps} compact micRequestMode={true} onPrepareMedia={onPrepareMedia} />);
      fireEvent.change(screen.getByPlaceholderText("What's your topic?"), {
        target: { value: "AI and creativity" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Send speaker request" }));
      expect(onPrepareMedia).toHaveBeenCalledTimes(1);
    });

    it("the mic-on state is visually distinct from mic-off, without a second/larger control appearing", () => {
      const { rerender } = render(<ChatPanel {...baseProps} compact />);
      const pillOff = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
      expect(pillOff.className).not.toMatch(/\bborder-accent/);

      rerender(<ChatPanel {...baseProps} compact micRequestMode={true} />);
      const pillOn = screen.getByTestId("watch-composer-mic").parentElement as HTMLElement;
      expect(pillOn.className).toMatch(/\bborder-accent/);
      expect(screen.getAllByRole("button")).toHaveLength(2); // mic + send only, no third control appears
    });

    describe("allowMicRequest (issue #18, Speaker View Phase 2: a seated speaker has no use for requesting the mic they already hold)", () => {
      it("defaults to true — every existing caller keeps the mic toggle", () => {
        render(<ChatPanel {...baseProps} compact />);
        expect(screen.getByTestId("watch-composer-mic")).toBeInTheDocument();
      });

      it("false hides the mic toggle entirely, not just disables it", () => {
        render(<ChatPanel {...baseProps} compact allowMicRequest={false} />);
        expect(screen.queryByTestId("watch-composer-mic")).not.toBeInTheDocument();
      });

      it("still submits an ordinary comment via submitComment with the toggle hidden", () => {
        const submitComment = vi.fn();
        render(<ChatPanel {...baseProps} submitComment={submitComment} compact allowMicRequest={false} />);
        fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hi" } });
        fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
        expect(submitComment).toHaveBeenCalledWith("hi");
      });
    });

    describe("hasPendingRequest / onCancelPendingRequest (issue #18 UX finding: no separate 'Request sent' bar — the mic button itself carries the pending state)", () => {
      it("defaults to the idle state when hasPendingRequest is omitted — every existing caller unaffected", () => {
        render(<ChatPanel {...baseProps} compact />);
        const micButton = screen.getByTestId("watch-composer-mic");
        expect(micButton).toHaveAccessibleName("Request to speak");
        expect(micButton.className).not.toMatch(/\banimate-pulse\b/);
      });

      it("shows a distinct pending visual state when hasPendingRequest is true and micRequestMode is false", () => {
        render(<ChatPanel {...baseProps} compact hasPendingRequest={true} />);
        const micButton = screen.getByTestId("watch-composer-mic");
        expect(micButton).toHaveAccessibleName("Cancel speaker request");
        expect(micButton.className).toMatch(/\banimate-pulse\b/);
        expect(micButton.className).toMatch(/\bbg-accent\/30\b/);
      });

      it("the pending state is visually distinct from the actively-composing state — not the same solid accent treatment", () => {
        render(<ChatPanel {...baseProps} compact hasPendingRequest={true} />);
        const pendingButton = screen.getByTestId("watch-composer-mic");
        expect(pendingButton.className).not.toMatch(/\bbg-accent text-white\b/);
      });

      it("micRequestMode takes visual priority over hasPendingRequest — actively composing a new request always shows the solid accent state", () => {
        render(<ChatPanel {...baseProps} compact hasPendingRequest={true} micRequestMode={true} />);
        const micButton = screen.getByTestId("watch-composer-mic");
        expect(micButton.className).toMatch(/\bbg-accent text-white\b/);
        expect(micButton.className).not.toMatch(/\banimate-pulse\b/);
      });

      it("tapping the mic button while pending calls onCancelPendingRequest, not onMicRequestModeChange", () => {
        const onCancelPendingRequest = vi.fn();
        const onMicRequestModeChange = vi.fn();
        render(
          <ChatPanel
            {...baseProps}
            compact
            hasPendingRequest={true}
            onCancelPendingRequest={onCancelPendingRequest}
            onMicRequestModeChange={onMicRequestModeChange}
          />,
        );
        fireEvent.click(screen.getByTestId("watch-composer-mic"));
        expect(onCancelPendingRequest).toHaveBeenCalledTimes(1);
        expect(onMicRequestModeChange).not.toHaveBeenCalled();
      });

      it("tapping the mic button while idle (no pending request) still opens the request-mode input as before", () => {
        const onCancelPendingRequest = vi.fn();
        const onMicRequestModeChange = vi.fn();
        render(
          <ChatPanel
            {...baseProps}
            compact
            hasPendingRequest={false}
            onCancelPendingRequest={onCancelPendingRequest}
            onMicRequestModeChange={onMicRequestModeChange}
          />,
        );
        fireEvent.click(screen.getByTestId("watch-composer-mic"));
        expect(onMicRequestModeChange).toHaveBeenCalledWith(true);
        expect(onCancelPendingRequest).not.toHaveBeenCalled();
      });
    });

    describe("keyboard/focus preservation when toggling Request-to-Speak while typing (issue #21, fourth corrective pass, real-device finding)", () => {
      it("the mic button prevents mousedown's default behavior — the actual browser mechanism that would otherwise blur a focused input", () => {
        render(<ChatPanel {...baseProps} compact />);
        const micButton = screen.getByTestId("watch-composer-mic");
        // fireEvent's own return value is `false` exactly when the event
        // was canceled (preventDefault() was called) — this is the one
        // thing jsdom can actually prove here, since it doesn't reproduce
        // a real browser's own focus-shift-on-mousedown behavior for
        // fireEvent to visibly counteract. Real keyboard-staying-open
        // behavior itself needs the user's own real-device confirmation.
        const notCanceled = fireEvent.mouseDown(micButton);
        expect(notCanceled).toBe(false);
      });

      it("toggling Request-to-Speak never touches the input's own draft value — same DOM node throughout, never remounted", () => {
        const { rerender } = render(<ChatPanel {...baseProps} compact micRequestMode={false} />);
        const input = screen.getByPlaceholderText("Add a comment…") as HTMLInputElement;
        // Real-device report, submission-reliability rewrite: the input
        // is now fully controlled (`draft` state, single source of
        // truth) — a real user's keystroke fires `onChange`, which
        // `fireEvent.change` reproduces; directly mutating `.value` (the
        // old uncontrolled-input test technique) no longer means
        // anything, since React re-asserts `value={draft}` on every
        // render regardless.
        fireEvent.change(input, { target: { value: "an unfinished comment" } });

        rerender(<ChatPanel {...baseProps} compact micRequestMode={true} />);
        const sameInput = screen.getByPlaceholderText("What's your topic?") as HTMLInputElement;
        expect(sameInput).toBe(input); // identical node — never unmounted/remounted
        expect(sameInput.value).toBe("an unfinished comment");

        rerender(<ChatPanel {...baseProps} compact micRequestMode={false} />);
        expect((screen.getByPlaceholderText("Add a comment…") as HTMLInputElement).value).toBe("an unfinished comment");
      });

      it("canceling a pending request (tapping the mic button again) also never touches the draft", () => {
        const { rerender } = render(<ChatPanel {...baseProps} compact hasPendingRequest={false} />);
        const input = screen.getByPlaceholderText("Add a comment…") as HTMLInputElement;
        fireEvent.change(input, { target: { value: "still typing this" } });

        rerender(<ChatPanel {...baseProps} compact hasPendingRequest={true} />);
        expect((screen.getByPlaceholderText("Add a comment…") as HTMLInputElement).value).toBe("still typing this");
      });

      it("the non-compact mic button also prevents mousedown's default focus-shifting behavior", () => {
        render(<ChatPanel {...baseProps} />);
        const micButton = screen.getByLabelText("Request to speak");
        expect(fireEvent.mouseDown(micButton)).toBe(false);
      });
    });
  });
});
