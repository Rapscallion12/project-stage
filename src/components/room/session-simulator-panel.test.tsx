import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSimulatorPanel } from "./session-simulator-panel";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";

const {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceRoundDeadline,
} = vi.hoisted(() => ({
  simulateComment: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateLike: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateRequestToSpeak: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateRequestVote: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateRoundVote: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateSeedSpeaker: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateOpenSeat: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  forceRoundDeadline: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
}));

vi.mock("@/app/events/[id]/room/simulator-actions", () => ({
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceRoundDeadline,
}));

const { supabaseFrom } = vi.hoisted(() => ({
  supabaseFrom: vi.fn(() => ({
    select: vi.fn(() => ({
      in: vi.fn(async () => ({ data: [] })),
    })),
  })),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({ from: supabaseFrom }),
}));

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: null,
    guest_id: "g-speaker-1",
    seat_number: 1,
    display_name: "Sim Speaker",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    media_inactive_since: null,
    round_number: 1,
    round_started_at: new Date().toISOString(),
    round_ends_at: new Date(Date.now() + 60_000).toISOString(),
    round_phase: "active",
    closing_ends_at: null,
    ...overrides,
  };
}

function request(overrides: Partial<RankedPendingRequest> = {}): RankedPendingRequest {
  return {
    id: "r1",
    event_id: "e1",
    profile_id: null,
    guest_id: "g-req-1",
    message_id: "m1",
    status: "pending",
    created_at: new Date().toISOString(),
    resolved_at: null,
    selection_round_id: null,
    frozen_rank: null,
    frozen_vote_count: null,
    is_current_candidate: false,
    selection_failed: false,
    voteCount: 0,
    isMyVote: false,
    ...overrides,
  };
}

const baseProps = {
  eventId: "e1",
  speakers: [] as EventSpeaker[],
  pendingRequests: [] as RankedPendingRequest[],
  messages: [] as LobbyMessage[],
};

describe("SessionSimulatorPanel (issue #21, Part 5)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("renders the tooling panel with Start/Stop controls", () => {
    render(<SessionSimulatorPanel {...baseProps} />);
    expect(screen.getByTestId("session-simulator-panel")).toBeInTheDocument();
    expect(screen.getByTestId("sim-start")).not.toBeDisabled();
    expect(screen.getByTestId("sim-stop")).toBeDisabled();
  });

  it("Start Simulated Session enables Stop and disables Start", async () => {
    render(<SessionSimulatorPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => {
      expect(screen.getByTestId("sim-start")).toBeDisabled();
      expect(screen.getByTestId("sim-stop")).not.toBeDisabled();
    });
  });

  it("deterministic actions before Start are safe no-ops (no audience pool yet) — no crash, nothing called", () => {
    render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request()]} />);
    fireEvent.click(screen.getByTestId("sim-generate-comments"));
    expect(simulateComment).not.toHaveBeenCalled();
  });

  it("Generate Comments calls simulateComment using the started audience pool", async () => {
    render(<SessionSimulatorPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("sim-generate-comments"));
    expect(simulateComment).toHaveBeenCalled();
    const [eventId, guestId, displayName, body] = simulateComment.mock.calls[0];
    expect(eventId).toBe("e1");
    expect(typeof guestId).toBe("string");
    expect(typeof displayName).toBe("string");
    expect(typeof body).toBe("string");
  });

  it("Generate Speaker Requests calls simulateRequestToSpeak for real production pathway", async () => {
    render(<SessionSimulatorPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("sim-generate-requests"));
    expect(simulateRequestToSpeak).toHaveBeenCalled();
  });

  it("Shift Request Votes calls simulateRequestVote against the live pendingRequests prop", async () => {
    render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ message_id: "m1" })]} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("sim-shift-votes"));
    expect(simulateRequestVote).toHaveBeenCalled();
    expect(simulateRequestVote.mock.calls[0][1]).toBe("m1");
  });

  it("Force Decisive Replace casts replace votes then calls forceRoundDeadline for the active round", async () => {
    render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "round-1" })]} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("sim-force-decisive"));
    await waitFor(() => expect(forceRoundDeadline).toHaveBeenCalledWith("round-1"));
    expect(simulateRoundVote).toHaveBeenCalled();
    expect(simulateRoundVote.mock.calls.every((call) => call[0] === "round-1")).toBe(true);
  });

  it("Force Continue Outcome reports when there is no active round instead of throwing", async () => {
    render(<SessionSimulatorPanel {...baseProps} speakers={[]} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("sim-force-continue"));
    expect(forceRoundDeadline).not.toHaveBeenCalled();
    expect(screen.getByTestId("sim-log")).toHaveTextContent("no speaker currently in an active round");
  });

  it("Open Speaker Seat calls simulateOpenSeat for a simulated (guest-held) seat", async () => {
    render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ guest_id: "g-speaker-1", profile_id: null })]} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("sim-open-seat"));
    expect(simulateOpenSeat).toHaveBeenCalledWith("e1", "g-speaker-1");
  });

  it("Stop Simulation disables Stop and re-enables Start", async () => {
    render(<SessionSimulatorPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

    fireEvent.click(screen.getByTestId("sim-stop"));
    expect(screen.getByTestId("sim-stop")).toBeDisabled();
    expect(screen.getByTestId("sim-start")).not.toBeDisabled();
  });

  it("stopping the simulation prevents further scheduled activity (no more calls after a long time advance)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<SessionSimulatorPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    fireEvent.click(screen.getByTestId("sim-stop"));

    const callsAtStop = simulateComment.mock.calls.length + simulateLike.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    const callsAfterAdvance = simulateComment.mock.calls.length + simulateLike.mock.calls.length;
    expect(callsAfterAdvance).toBe(callsAtStop);
  });

  it("shows the observability panel with round status for an occupied seat", () => {
    render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ display_name: "Alex", round_number: 3 })]} />);
    const status = screen.getByTestId("sim-round-status");
    expect(status).toHaveTextContent("Alex");
    expect(status).toHaveTextContent("round #3");
    expect(status).toHaveTextContent("active");
  });

  describe("collapse/minimize (real-device follow-up — must not obstruct the app or the simulation)", () => {
    it("minimizing hides the expanded panel and shows only the compact SIM control", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-minimize"));
      expect(screen.queryByTestId("sim-header")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sim-start")).not.toBeInTheDocument();
      expect(screen.getByTestId("sim-collapsed-toggle")).toBeInTheDocument();
    });

    it("tapping SIM restores the expanded panel", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-minimize"));
      fireEvent.click(screen.getByTestId("sim-collapsed-toggle"));
      expect(screen.getByTestId("sim-header")).toBeInTheDocument();
      expect(screen.getByTestId("sim-start")).toBeInTheDocument();
    });

    it("the collapsed SIM control shows an active dot only while the simulation is running", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-minimize"));
      expect(screen.queryByTestId("sim-collapsed-active-dot")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("sim-collapsed-toggle"));
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-minimize"));

      expect(screen.getByTestId("sim-collapsed-active-dot")).toBeInTheDocument();
    });

    it("collapsing does NOT stop the simulation — generated activity continues in the background", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      const callsBeforeCollapse = simulateComment.mock.calls.length + simulateLike.mock.calls.length;

      fireEvent.click(screen.getByTestId("sim-minimize"));
      await vi.advanceTimersByTimeAsync(20_000);

      const callsAfterCollapse = simulateComment.mock.calls.length + simulateLike.mock.calls.length;
      expect(callsAfterCollapse).toBeGreaterThan(callsBeforeCollapse);
    });

    it("expanding again preserves simulator state — running status and activity log survive collapse/expand", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-generate-comments"));
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Generated 5 comments");

      fireEvent.click(screen.getByTestId("sim-minimize"));
      fireEvent.click(screen.getByTestId("sim-collapsed-toggle"));

      expect(screen.getByTestId("sim-stop")).not.toBeDisabled();
      expect(screen.getByTestId("sim-start")).toBeDisabled();
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Generated 5 comments");
    });

    it("moving the panel does not restart the session — audience/log state is unaffected by a drag", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-generate-comments"));

      const header = screen.getByTestId("sim-header");
      fireEvent.pointerDown(header, { pointerId: 1, clientX: 100, clientY: 100 });
      fireEvent.pointerMove(header, { pointerId: 1, clientX: 40, clientY: 40 });
      fireEvent.pointerUp(header, { pointerId: 1, clientX: 40, clientY: 40 });

      expect(screen.getByTestId("sim-stop")).not.toBeDisabled();
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Generated 5 comments");
    });
  });

  describe("dragging the panel by its header (real-device follow-up)", () => {
    it("dragging the header repositions the panel via inline left/top styles", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      const panel = screen.getByTestId("session-simulator-panel");
      const header = screen.getByTestId("sim-header");

      expect(panel.style.left).toBe("");

      fireEvent.pointerDown(header, { pointerId: 1, clientX: 200, clientY: 200 });
      fireEvent.pointerMove(header, { pointerId: 1, clientX: 150, clientY: 130 });
      fireEvent.pointerUp(header, { pointerId: 1, clientX: 150, clientY: 130 });

      expect(panel.style.left).not.toBe("");
      expect(panel.style.top).not.toBe("");
    });

    it("the panel can never be dragged fully offscreen — position stays within the viewport bounds", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      const panel = screen.getByTestId("session-simulator-panel");
      const header = screen.getByTestId("sim-header");

      fireEvent.pointerDown(header, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(header, { pointerId: 1, clientX: -100_000, clientY: -100_000 });
      fireEvent.pointerUp(header, { pointerId: 1, clientX: -100_000, clientY: -100_000 });

      expect(parseFloat(panel.style.left)).toBeGreaterThanOrEqual(0);
      expect(parseFloat(panel.style.top)).toBeGreaterThanOrEqual(0);

      fireEvent.pointerDown(header, { pointerId: 2, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(header, { pointerId: 2, clientX: 100_000, clientY: 100_000 });
      fireEvent.pointerUp(header, { pointerId: 2, clientX: 100_000, clientY: 100_000 });

      expect(parseFloat(panel.style.left)).toBeLessThanOrEqual(window.innerWidth);
      expect(parseFloat(panel.style.top)).toBeLessThanOrEqual(window.innerHeight);
    });

    it("clicking the minimize button does not initiate a drag", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      const panel = screen.getByTestId("session-simulator-panel");
      const minimizeButton = screen.getByTestId("sim-minimize");

      fireEvent.pointerDown(minimizeButton, { pointerId: 1, clientX: 200, clientY: 200 });
      fireEvent.pointerMove(screen.getByTestId("sim-header"), { pointerId: 1, clientX: 40, clientY: 40 });
      fireEvent.pointerUp(minimizeButton, { pointerId: 1, clientX: 40, clientY: 40 });

      expect(panel.style.left).toBe("");
    });

    it("orientation change re-clamps an already-dragged position instead of stranding it offscreen", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      const panel = screen.getByTestId("session-simulator-panel");
      const header = screen.getByTestId("sim-header");

      fireEvent.pointerDown(header, { pointerId: 1, clientX: 0, clientY: 0 });
      fireEvent.pointerMove(header, { pointerId: 1, clientX: 900, clientY: 700 });
      fireEvent.pointerUp(header, { pointerId: 1, clientX: 900, clientY: 700 });
      const xBeforeResize = parseFloat(panel.style.left);

      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 375 });
      Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: 667 });
      fireEvent(window, new Event("orientationchange"));

      expect(parseFloat(panel.style.left)).toBeLessThanOrEqual(375);
      expect(parseFloat(panel.style.top)).toBeLessThanOrEqual(667);
      expect(xBeforeResize).toBeGreaterThanOrEqual(0);

      Object.defineProperty(window, "innerWidth", { writable: true, configurable: true, value: 1024 });
      Object.defineProperty(window, "innerHeight", { writable: true, configurable: true, value: 768 });
    });
  });
});
