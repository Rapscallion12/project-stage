import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatPanel } from "./chat-panel";

const { sendMessage, submitSpeakerRequest } = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  submitSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/lobby/actions", () => ({ sendMessage }));
vi.mock("@/app/events/[id]/room/actions", () => ({ submitSpeakerRequest }));

// jsdom doesn't implement Element.scrollTo — unrelated to anything this
// file tests.
Element.prototype.scrollTo = vi.fn();

const baseProps = {
  eventId: "e1",
  messages: [],
  reactions: {},
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

  it("submitting in normal mode calls sendMessage, never submitSpeakerRequest", async () => {
    sendMessage.mockResolvedValue(undefined);
    render(<ChatPanel {...baseProps} />);
    fireEvent.change(screen.getByPlaceholderText("Say something…"), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(sendMessage).toHaveBeenCalled());
    expect(submitSpeakerRequest).not.toHaveBeenCalled();
  });

  it("submitting in mic-request mode calls the existing authoritative request path (submitSpeakerRequest), never sendMessage", async () => {
    submitSpeakerRequest.mockResolvedValue(undefined);
    render(<ChatPanel {...baseProps} micRequestMode={true} />);
    fireEvent.change(screen.getByPlaceholderText("What do you want to talk about?"), {
      target: { value: "AI and creativity" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Request" }));
    await waitFor(() => expect(submitSpeakerRequest).toHaveBeenCalled());
    expect(sendMessage).not.toHaveBeenCalled();
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
    sendMessage.mockResolvedValue(undefined);
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

    it("sending a normal comment calls sendMessage, never submitSpeakerRequest or onPrepareMedia", async () => {
      sendMessage.mockResolvedValue(undefined);
      const onPrepareMedia = vi.fn();
      render(<ChatPanel {...baseProps} compact onPrepareMedia={onPrepareMedia} />);
      fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "nice point" } });
      fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
      await waitFor(() => expect(sendMessage).toHaveBeenCalled());
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

      it("still submits an ordinary comment via sendMessage with the toggle hidden", async () => {
        sendMessage.mockResolvedValue(undefined);
        render(<ChatPanel {...baseProps} compact allowMicRequest={false} />);
        fireEvent.change(screen.getByPlaceholderText("Add a comment…"), { target: { value: "hi" } });
        fireEvent.click(screen.getByRole("button", { name: "Send comment" }));
        await waitFor(() => expect(sendMessage).toHaveBeenCalled());
      });
    });
  });
});
