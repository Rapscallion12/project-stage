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
});
