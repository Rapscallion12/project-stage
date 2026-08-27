import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSimulatorPanel } from "./session-simulator-panel";
import type { EventSpeaker, ResolveSpeakerRoundOutcome } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";
import type { ResetSimulatorSessionResult, AdvanceSelectionResult } from "@/app/events/[id]/room/simulator-actions";

const {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceRoundDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
} = vi.hoisted(() => ({
  simulateComment: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateLike: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateRequestToSpeak: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateRequestVote: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateRoundVote: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateSeedSpeaker: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  simulateOpenSeat: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
  forceRoundDeadline: vi.fn<(...args: unknown[]) => Promise<ResolveSpeakerRoundOutcome>>(async () => "decisive-replace"),
  resetSimulatorSession: vi.fn<(...args: unknown[]) => Promise<ResetSimulatorSessionResult>>(async () => ({
    messagesDeleted: 0,
    reactionsDeleted: 0,
    speakersDeleted: 0,
    requestVotesDeleted: 0,
    roundVotesDeleted: 0,
  })),
  simulateAdvanceSelection: vi.fn<(...args: unknown[]) => Promise<AdvanceSelectionResult>>(async () => ({ claimed: false })),
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
  resetSimulatorSession,
  simulateAdvanceSelection,
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

/** Finds the specific per-seat round-status block for a given seat number — the redesign (real-device follow-up) scopes every force/open control inside this block, one per occupied seat, never a single ambiguous global control. */
function roundStatusForSeat(seatNumber: number): HTMLElement {
  const blocks = screen.getAllByTestId("sim-round-status");
  const match = blocks.find((block) => block.textContent?.includes(`seat ${seatNumber}`));
  if (!match) throw new Error(`No sim-round-status block found for seat ${seatNumber}`);
  return match;
}

describe("SessionSimulatorPanel (issue #21, Part 5 + round-testing follow-up)", () => {
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

  it("Start reports every generated identity (audience + 2 stable seed speakers) via onSimulatedIdentitiesCreated", async () => {
    const onSimulatedIdentitiesCreated = vi.fn();
    render(<SessionSimulatorPanel {...baseProps} onSimulatedIdentitiesCreated={onSimulatedIdentitiesCreated} />);
    fireEvent.click(screen.getByTestId("sim-start"));
    await waitFor(() => expect(onSimulatedIdentitiesCreated).toHaveBeenCalled());
    const ids: string[] = onSimulatedIdentitiesCreated.mock.calls[0][0];
    expect(ids.length).toBe(22); // 20 audience + 2 stable seed speakers
    expect(new Set(ids).size).toBe(22); // all distinct
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

  it("shows the observability panel with round status, vote tallies, and a projected outcome for an occupied seat", () => {
    render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ display_name: "Alex", round_number: 3 })]} />);
    const status = screen.getByTestId("sim-round-status");
    expect(status).toHaveTextContent("Alex");
    expect(status).toHaveTextContent("round #3");
    expect(status).toHaveTextContent("active");
    expect(within(status).getByTestId("sim-projected-outcome")).toHaveTextContent("Continue +60s");
  });

  describe("Seed 2 Speakers (Part 5 — deterministic, stable identities)", () => {
    it("uses the same two identities on every click within one run, including Start's own automatic seeding", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      const fromStart = simulateSeedSpeaker.mock.calls.map((call) => call[1]);

      simulateSeedSpeaker.mockClear();
      fireEvent.click(screen.getByTestId("sim-seed-speakers"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      const fromManualClick = simulateSeedSpeaker.mock.calls.map((call) => call[1]);

      expect(fromManualClick).toEqual(fromStart);
    });

    it("assigns seat 1 and seat 2 explicitly", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      const seatNumbers = simulateSeedSpeaker.mock.calls.map((call) => call[3]);
      expect(seatNumbers.sort()).toEqual([1, 2]);
    });

    it("Start Simulated Session seeds both seats automatically — no separate Seed 2 Speakers press required", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      expect(simulateSeedSpeaker).not.toHaveBeenCalled();

      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      const seats = simulateSeedSpeaker.mock.calls.map((call) => call[3]).sort();
      expect(seats).toEqual([1, 2]);
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seeded 2 stable simulated speakers");
    });

    it("tolerates one seat already being occupied — still seeds the other, doesn't abort Start", async () => {
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("seat already occupied");
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("Seeded 1 simulated speaker"));
      // Start still completes — Stop is enabled, meaning the rest of the
      // session (comments/requests/etc. loops) still started normally.
      expect(screen.getByTestId("sim-stop")).not.toBeDisabled();
    });
  });

  describe("natural session progression (real-device follow-up — no force buttons required to advance)", () => {
    it("casts round votes periodically on an active round, with no force button ever clicked", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "round-1", round_phase: "active" })]} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await vi.advanceTimersByTimeAsync(20_000);

      expect(simulateRoundVote).toHaveBeenCalled();
      expect(simulateRoundVote.mock.calls.every((call) => call[0] === "round-1")).toBe(true);
    });

    it("polls for an open seat and calls simulateAdvanceSelection — closes the replacement loop without Open Speaker Seat or Seed 2 Speakers", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      // Only one seat occupied — the other is open, exactly the
      // post-replacement state this loop exists to fill automatically.
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "seat-1", seat_number: 1 })]} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(simulateAdvanceSelection).toHaveBeenCalled();
      const [calledEventId, guestIds, displayNames] = simulateAdvanceSelection.mock.calls[0] as [string, string[], Record<string, string>];
      expect(calledEventId).toBe("e1");
      expect(guestIds.length).toBeGreaterThan(0); // the generated audience + seed speakers
      expect(Object.keys(displayNames).length).toBeGreaterThan(0);
    });

    it("does not poll simulateAdvanceSelection once both seats are occupied", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "seat-1", seat_number: 1 }), speaker({ id: "seat-2", seat_number: 2 })]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-start"));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(simulateAdvanceSelection).not.toHaveBeenCalled();
    });

    it("logs a promotion when simulateAdvanceSelection reports a successful claim", async () => {
      simulateAdvanceSelection.mockResolvedValueOnce({ claimed: true, guestId: "sim-guest-x", seatNumber: 2 });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "seat-1", seat_number: 1 })]} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await vi.advanceTimersByTimeAsync(6000);

      expect(screen.getByTestId("sim-log")).toHaveTextContent("promoted");
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seat 2");
    });
  });

  describe("per-seat round-outcome forcing (real-device follow-up — never one ambiguous global control)", () => {
    it("shows no force controls at all when no seat is occupied", () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[]} />);
      expect(screen.queryByTestId("sim-force-continue")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sim-force-narrow-loss")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sim-force-replace")).not.toBeInTheDocument();
    });

    it("Force Continue on seat 1 targets only seat 1, even with a second occupied seat", async () => {
      forceRoundDeadline.mockResolvedValueOnce("continue");
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[
            speaker({ id: "seat-1-round", seat_number: 1, display_name: "Speaker A" }),
            speaker({ id: "seat-2-round", seat_number: 2, display_name: "Speaker B" }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      const seat1 = roundStatusForSeat(1);
      fireEvent.click(within(seat1).getByTestId("sim-force-continue"));

      await waitFor(() => expect(forceRoundDeadline).toHaveBeenCalledWith("seat-1-round"));
      expect(forceRoundDeadline).not.toHaveBeenCalledWith("seat-2-round");
      expect(simulateRoundVote.mock.calls.every((call) => call[0] === "seat-1-round")).toBe(true);
    });

    it("Force Narrow Loss on seat 2 targets only seat 2", async () => {
      forceRoundDeadline.mockResolvedValueOnce("narrow-loss");
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[
            speaker({ id: "seat-1-round", seat_number: 1 }),
            speaker({ id: "seat-2-round", seat_number: 2 }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      const seat2 = roundStatusForSeat(2);
      fireEvent.click(within(seat2).getByTestId("sim-force-narrow-loss"));

      await waitFor(() => expect(forceRoundDeadline).toHaveBeenCalledWith("seat-2-round"));
      expect(forceRoundDeadline).not.toHaveBeenCalledWith("seat-1-round");
      expect(simulateRoundVote.mock.calls.every((call) => call[0] === "seat-2-round")).toBe(true);
    });

    it("Force Replace on a seat casts a decisive replace split and reports the real resolved outcome", async () => {
      forceRoundDeadline.mockResolvedValueOnce("decisive-replace");
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "round-1", seat_number: 1 })]} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(within(roundStatusForSeat(1)).getByTestId("sim-force-replace"));
      await waitFor(() => expect(forceRoundDeadline).toHaveBeenCalledWith("round-1"));

      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seat 1 → Decisive Replace (100% Replace)");
    });

    it("forced-outcome feedback reflects the resolver's real return value, not just the intended split", async () => {
      // Even though this button casts a narrow-loss split, the mocked
      // resolver below returns "continue" — the log must show what the
      // real resolver decided, proving the outcome isn't just echoed back.
      forceRoundDeadline.mockResolvedValueOnce("continue");
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "round-1", seat_number: 1 })]} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(within(roundStatusForSeat(1)).getByTestId("sim-force-narrow-loss"));
      await waitFor(() => expect(forceRoundDeadline).toHaveBeenCalled());

      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seat 1 → Continue");
    });

    it("a seat in its closing phase shows only Force Replace Now — no new vote is cast", async () => {
      forceRoundDeadline.mockResolvedValueOnce("replaced-after-closing");
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "round-1", seat_number: 1, round_phase: "closing", closing_ends_at: new Date(Date.now() + 20_000).toISOString() })]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      const status = roundStatusForSeat(1);
      expect(within(status).queryByTestId("sim-force-continue")).not.toBeInTheDocument();
      expect(within(status).queryByTestId("sim-force-narrow-loss")).not.toBeInTheDocument();
      expect(within(status).getByTestId("sim-projected-outcome")).toHaveTextContent("Replace");

      fireEvent.click(within(status).getByTestId("sim-force-replace-now"));
      await waitFor(() => expect(forceRoundDeadline).toHaveBeenCalledWith("round-1"));
      expect(simulateRoundVote).not.toHaveBeenCalled();
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seat 1 → Replaced");
    });
  });

  describe("per-seat Open Seat (real-device follow-up)", () => {
    it("Open Seat on a specific seat calls simulateOpenSeat for that seat's simulated (guest-held) occupant", async () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[
            speaker({ id: "seat-1", seat_number: 1, guest_id: "g-speaker-1", profile_id: null, display_name: "Speaker A" }),
            speaker({ id: "seat-2", seat_number: 2, guest_id: "g-speaker-2", profile_id: null, display_name: "Speaker B" }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(within(roundStatusForSeat(2)).getByTestId("sim-open-seat"));
      expect(simulateOpenSeat).toHaveBeenCalledWith("e1", "g-speaker-2");
      expect(simulateOpenSeat).not.toHaveBeenCalledWith("e1", "g-speaker-1");
    });
  });

  describe("Reset Session (destroys simulator-created state, distinct from Stop)", () => {
    it("clicking Reset Session shows a confirmation instead of resetting immediately", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-reset"));
      expect(resetSimulatorSession).not.toHaveBeenCalled();
      expect(screen.getByTestId("sim-reset-confirm-row")).toHaveTextContent("Reset simulated session?");
    });

    it("Cancel dismisses the confirmation without resetting anything", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-cancel"));
      expect(resetSimulatorSession).not.toHaveBeenCalled();
      expect(screen.queryByTestId("sim-reset-confirm-row")).not.toBeInTheDocument();
      expect(screen.getByTestId("sim-reset")).toBeInTheDocument();
    });

    it("confirming Reset stops the simulation and calls resetSimulatorSession with every generated guest id", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));

      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());
      const [calledEventId, guestIds] = resetSimulatorSession.mock.calls[0] as [string, string[]];
      expect(calledEventId).toBe("e1");
      expect(guestIds.length).toBe(22); // 20 audience + 2 stable seed speakers, per Start's own accounting
      expect(new Set(guestIds).size).toBe(22);

      expect(screen.getByTestId("sim-stop")).toBeDisabled();
      expect(screen.getByTestId("sim-start")).not.toBeDisabled();
    });

    it("accumulates guest ids across multiple Start/Stop cycles, not just the latest run's audience", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-stop"));

      fireEvent.click(screen.getByTestId("sim-start")); // second run — generates a fresh, different 22 identities
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));

      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());
      const [, guestIds] = resetSimulatorSession.mock.calls[0] as [string, string[]];
      // Both runs' identities are included — never just the second run's 22.
      expect(guestIds.length).toBe(44);
    });

    it("clears the activity log down to a single reset confirmation line — old entries do not survive", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-generate-comments"));
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Generated 5 comments");

      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());

      const log = screen.getByTestId("sim-log");
      expect(log).not.toHaveTextContent("Generated 5 comments");
      expect(log).not.toHaveTextContent("Started");
      expect(log).toHaveTextContent("Reset");
    });

    it("clears round-vote tallies and pool-reset count back to a fresh state", async () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ display_name: "Alex" })]} pendingRequests={[]} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());

      expect(screen.getByTestId("sim-pool-reset-count")).toHaveTextContent("pool resets observed: 0");
    });

    it("no background simulation activity fires after a reset", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await vi.waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());

      const callsAtReset = simulateComment.mock.calls.length + simulateLike.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(simulateComment.mock.calls.length + simulateLike.mock.calls.length).toBe(callsAtReset);
    });

    it("deterministic actions are safe no-ops again after reset, exactly like before the first Start", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());

      simulateComment.mockClear();
      fireEvent.click(screen.getByTestId("sim-generate-comments"));
      expect(simulateComment).not.toHaveBeenCalled();
    });

    it("starting again after reset creates a genuinely new run — a fresh, non-overlapping set of identities", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());
      const firstRunIds = resetSimulatorSession.mock.calls[0][1] as string[];

      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalledTimes(2));
      const secondRunIds = resetSimulatorSession.mock.calls[1][1] as string[];

      expect(secondRunIds.length).toBe(22); // not accumulated with the first (reset) run
      expect(secondRunIds.some((id) => firstRunIds.includes(id))).toBe(false);
    });

    it("starting again after reset seeds a clean 2-speaker stage again — auto-seeding is not a one-time-per-mount thing", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));

      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());

      simulateSeedSpeaker.mockClear();
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      const seats = simulateSeedSpeaker.mock.calls.map((call) => call[3]).sort();
      expect(seats).toEqual([1, 2]);
    });

    it("calls onSimulatorReset so the caller can clear its own simulated-identity tracking", async () => {
      const onSimulatorReset = vi.fn();
      render(<SessionSimulatorPanel {...baseProps} onSimulatorReset={onSimulatorReset} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(onSimulatorReset).toHaveBeenCalledTimes(1));
    });

    it("reset with nothing ever started is a harmless no-op (no crash, resetSimulatorSession still called with an empty list)", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-reset"));
      fireEvent.click(screen.getByTestId("sim-reset-confirm"));
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalledWith("e1", []));
    });
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
