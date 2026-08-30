import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSimulatorPanel } from "./session-simulator-panel";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";
import type { SeatResolutionOutcome, StageRound } from "@/lib/repositories/stage-rounds";
import type { ResetSimulatorSessionResult } from "@/app/events/[id]/room/simulator-actions";
import { PROMOTION_COUNTDOWN_SECONDS } from "@/hooks/use-automatic-promotion";

/**
 * Issue #21, fourth corrective pass: `stageRoundRow` now has two distinct
 * jobs it didn't have before — a *pre-seeding* read (decides Case A vs.
 * Case B, see `establishSeat`/`establishInitialPairing`) and a
 * *post-seeding* read (verifies the shared round actually started). The
 * default here starts at `round_number: 0` (a genuinely fresh, never-
 * established stage — the Case A default every existing test below
 * already assumes) rather than the old single-purpose `round_number: 1`.
 * `noteSeatClaimed`/`autoActivateRound` mirror the real server-side
 * effect of `claim_speaker_seat`'s own `ensure_stage_round` call: once
 * two seats are genuinely claimed (via either `simulateSeedSpeaker`
 * succeeding or `simulateAdvanceSelection` reporting `claimed: true`),
 * the row flips to `active` on its own, the same way the real RPC would
 * — a test that wants a *different* post-seed outcome (e.g. "the round
 * unexpectedly failed to start") sets `autoActivateRound.current = false`
 * to suppress that and asserts its own scenario instead.
 */
const {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceStageRoundDeadline,
  forceSeatClosingDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
  reconcileStageRoundAction,
  supabaseFrom,
  stageRoundRow,
  roundVotesData,
  autoActivateRound,
  resetSeedTracking,
  noteSeatClaimed,
} = vi.hoisted(() => {
  const stageRoundRow: { current: { round_number: number; phase: string } | null } = {
    current: { round_number: 0, phase: "awaiting_pairing" },
  };
  const roundVotesData: { current: Array<{ event_speakers_id: string; choice: "continue" | "replace" }> } = { current: [] };
  const autoActivateRound = { current: true };
  let claimedCount = 0;

  function noteSeatClaimed() {
    claimedCount++;
    if (autoActivateRound.current && claimedCount >= 2) {
      stageRoundRow.current = { round_number: (stageRoundRow.current?.round_number ?? 0) + 1, phase: "active" };
    }
  }
  function resetSeedTracking() {
    claimedCount = 0;
  }

  const simulateSeedSpeaker = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {
    noteSeatClaimed();
  });
  const simulateAdvanceSelection = vi.fn<(...args: unknown[]) => Promise<{ claimed: boolean; guestId?: string; seatNumber?: 1 | 2 }>>(
    async () => ({ claimed: false }),
  );

  const supabaseFrom = vi.fn((table: string) => {
    if (table === "stage_rounds") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({ data: stageRoundRow.current })),
          })),
        })),
      };
    }
    return {
      select: vi.fn(() => ({
        in: vi.fn(async () => ({ data: roundVotesData.current })),
      })),
    };
  });

  return {
    simulateComment: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    simulateLike: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    simulateRequestToSpeak: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    simulateRequestVote: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    simulateRoundVote: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    simulateSeedSpeaker,
    simulateOpenSeat: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    forceStageRoundDeadline: vi.fn<(...args: unknown[]) => Promise<Array<{ eventSpeakersId: string; outcome: SeatResolutionOutcome }>>>(
      async () => [],
    ),
    forceSeatClosingDeadline: vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true),
    resetSimulatorSession: vi.fn<(...args: unknown[]) => Promise<ResetSimulatorSessionResult>>(async () => {
      // Mirrors the real server behavior this pass relies on (Section 6):
      // once occupancy drops to zero, `resetSimulatorSession` deletes the
      // `stage_rounds` row outright — the stage is genuinely no longer
      // established, not merely displayed differently.
      stageRoundRow.current = { round_number: 0, phase: "awaiting_pairing" };
      resetSeedTracking();
      return {
        messagesDeleted: 0,
        reactionsDeleted: 0,
        speakersDeleted: 0,
        requestVotesDeleted: 0,
        roundVotesDeleted: 0,
      };
    }),
    simulateAdvanceSelection,
    reconcileStageRoundAction: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    supabaseFrom,
    stageRoundRow,
    roundVotesData,
    autoActivateRound,
    resetSeedTracking,
    noteSeatClaimed,
  };
});

vi.mock("@/app/events/[id]/room/simulator-actions", () => ({
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceStageRoundDeadline,
  forceSeatClosingDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  reconcileStageRoundAction,
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
    reserved_seat_number: null,
    voteCount: 0,
    isMyVote: false,
    ...overrides,
  };
}

function stageRoundFixture(overrides: Partial<StageRound> = {}): StageRound {
  return {
    id: "sr1",
    event_id: "e1",
    round_number: 1,
    started_at: new Date().toISOString(),
    ends_at: new Date(Date.now() + 60_000).toISOString(),
    phase: "active",
    updated_at: new Date().toISOString(),
    fallback_excluded_profile_ids: [],
    fallback_excluded_guest_ids: [],
    ...overrides,
  };
}

const baseProps = {
  eventId: "e1",
  speakers: [] as EventSpeaker[],
  pendingRequests: [] as RankedPendingRequest[],
  messages: [] as LobbyMessage[],
  stageRound: null as StageRound | null,
};

/** Finds the specific per-seat round-status block for a given seat number — every force/open control is scoped inside this block, one per occupied seat, never a single ambiguous global control. */
function roundStatusForSeat(seatNumber: number): HTMLElement {
  const blocks = screen.getAllByTestId("sim-round-status");
  const match = blocks.find((block) => block.textContent?.includes(`Seat ${seatNumber}`));
  if (!match) throw new Error(`No sim-round-status block found for seat ${seatNumber}`);
  return match;
}

describe("SessionSimulatorPanel (issue #21, Part 5 + shared-round corrective pass)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    // Issue #21, fourth corrective pass: a genuinely fresh, never-
    // established stage — the Case A default nearly every test below
    // assumes (see this file's own doc comment on the hoisted mock
    // block above). A test that specifically wants Case B (an already-
    // established stage) sets this explicitly before clicking Start.
    stageRoundRow.current = { round_number: 0, phase: "awaiting_pairing" };
    roundVotesData.current = [];
    autoActivateRound.current = true;
    resetSeedTracking();
    // vi.clearAllMocks() only clears call/result history — a test that
    // overrides a mock's *implementation* via mockImplementation (not
    // -Once) would otherwise leak that override into every later test.
    // Restored explicitly here, not just left to each such test's own
    // cleanup, so this can never happen silently again.
    simulateSeedSpeaker.mockImplementation(async () => {
      noteSeatClaimed();
    });
    simulateAdvanceSelection.mockImplementation(async () => ({ claimed: false }));
    reconcileStageRoundAction.mockImplementation(async () => {});
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

  describe("shared round display (corrective pass — one clock, shown once)", () => {
    it("shows the shared round badge once, plus a per-seat status block without its own round countdown", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          stageRound={stageRoundFixture({ round_number: 3 })}
          speakers={[speaker({ display_name: "Alex" })]}
        />,
      );
      const shared = screen.getByTestId("sim-shared-round");
      expect(shared).toHaveTextContent("Round 3");

      const status = screen.getByTestId("sim-round-status");
      expect(status).toHaveTextContent("Seat 1 — Alex");
      expect(within(status).getByTestId("sim-projected-outcome")).toHaveTextContent("Continue +60s");
    });

    it("shows 'awaiting pairing' rather than a ticking countdown when the stage isn't ready for a shared round", () => {
      render(<SessionSimulatorPanel {...baseProps} stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 2 })} />);
      expect(screen.getByTestId("sim-shared-round")).toHaveTextContent("awaiting pairing");
    });

    it("shows a placeholder before any round has ever started", () => {
      render(<SessionSimulatorPanel {...baseProps} stageRound={null} />);
      expect(screen.getByTestId("sim-shared-round")).toHaveTextContent("Round: —");
    });

    it("a seat in its own closing phase shows its individual final countdown alongside the shared badge", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing" })}
          speakers={[speaker({ round_phase: "closing", closing_ends_at: new Date(Date.now() + 25_000).toISOString() })]}
        />,
      );
      expect(roundStatusForSeat(1).textContent).toMatch(/final \d+s/);
    });

    it("shows 'No votes yet' rather than a misleading tally when nobody has voted on a seat yet", async () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", display_name: "Alex" })]} />);
      await waitFor(() => expect(supabaseFrom).toHaveBeenCalled());
      expect(roundStatusForSeat(1)).toHaveTextContent("No votes yet");
    });

    it("shows Continue/Replace counts, percentages, and the total votes cast, from the same authoritative tally the resolver uses", async () => {
      roundVotesData.current = [
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "continue" },
        { event_speakers_id: "s1", choice: "replace" },
        { event_speakers_id: "s1", choice: "replace" },
        { event_speakers_id: "s1", choice: "replace" },
        { event_speakers_id: "s1", choice: "replace" },
        { event_speakers_id: "s1", choice: "replace" },
      ];
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", display_name: "Dapper Rabbit" })]} />);
      const status = await waitFor(() => {
        const el = roundStatusForSeat(1);
        expect(el).toHaveTextContent("12 votes cast");
        return el;
      });
      expect(status).toHaveTextContent("Continue 7 · 58%");
      expect(status).toHaveTextContent("Replace 5 · 42%");
    });
  });

  describe("Seed 2 Speakers (Part 5 — deterministic, stable identities)", () => {
    it("Seed 2 Speakers reuses Start's own two stable identities when there is still work to do (e.g. right after an Open Seat)", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      const fromStart = simulateSeedSpeaker.mock.calls.map((call) => call[1]);

      // The stage is now established (Start's own seeding just achieved
      // the initial pairing) and both seats are occupied — issue #21,
      // fourth corrective pass: a manual re-seed at this point correctly
      // goes through Case B (authorized Request-to-Speak), not another
      // direct bypass, and correctly finds no open seat to claim. This
      // mirrors an event where one seat has genuinely opened again: only
      // *that* identity's request would find a real open seat.
      simulateSeedSpeaker.mockClear();
      fireEvent.click(screen.getByTestId("sim-seed-speakers"));
      // seat 2's request only fires after seat 1's own bounded claim-retry
      // budget is exhausted (sequential establishment) — a longer timeout
      // than the default is needed here, not a sign of anything wrong.
      // Issue #21, eighth corrective pass: the budget itself grew (a
      // real-device pass found the previous one too tight — see
      // MAX_CLAIM_ATTEMPTS' own doc comment), so this real-time wait
      // grew with it.
      await waitFor(() => expect(simulateRequestToSpeak).toHaveBeenCalledTimes(2), { timeout: 13_000 });
      const namesRequested = simulateRequestToSpeak.mock.calls.map((call) => call[1]);
      // Same two stable identities Start generated — never re-randomized.
      expect(namesRequested.sort()).toEqual(fromStart.sort());
      expect(simulateSeedSpeaker).not.toHaveBeenCalled();

      // The bounded claim-retry loop still has to finish (both seats,
      // no open seat ever found) before this test hands control back —
      // otherwise its still-pending timers could bleed into the next
      // test.
      await waitFor(
        () => expect(screen.getByTestId("sim-log")).toHaveTextContent("did not result in an authorized claim"),
        { timeout: 13_000 },
      );
    }, 30_000);

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

    it("one seat failing to seed reports it clearly and does NOT half-start the session (issue #21, fourth corrective pass: a shared round requires both seats)", async () => {
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("seat already occupied");
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("Seeded 1 simulated speaker"));
      // Start does NOT complete — only one seat is occupied, so no shared
      // round is started, and the rest of the session's activity loops
      // never schedule. This is the exact invariant violation a
      // real-device pass found: a half-established stage must never look
      // like a running session.
      expect(screen.getByTestId("sim-stop")).toBeDisabled();
      expect(screen.getByTestId("sim-start")).not.toBeDisabled();
      expect(screen.getByTestId("sim-startup-phase")).toHaveTextContent("Failed");
    });

    it("surfaces the failure in the panel, rather than continuing silently, when both seats fail to seed", async () => {
      // mockImplementationOnce (not the persistent mockImplementation) —
      // this must not leak its failure into later tests' default
      // (successful) seeding behavior.
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("both seats occupied");
      });
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("both seats occupied");
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("Could not seed simulated speakers"));
    });

    it("reports the real error message for a genuine seed failure, not a swallowed/generic one", async () => {
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("seat 1 in event e1 is already occupied");
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("seat 1 in event e1 is already occupied"));
    });

    it("reports each step progressively — Starting session, Seeding Seat 1, Seeding Seat 2, Verifying shared round — rather than one opaque final result", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      const log = screen.getByTestId("sim-log");
      await waitFor(() => expect(log).toHaveTextContent("Starting session…"));
      expect(log).toHaveTextContent("Seeding Seat 1…");
      expect(log).toHaveTextContent("Seeding Seat 2…");
      await waitFor(() => expect(log).toHaveTextContent("Verifying shared round…"));
    });

    it("claims seat 1 before seat 2, sequentially — never both at once (issue #21, second corrective pass: concurrent claims raced a real database bug)", async () => {
      const callOrder: number[] = [];
      simulateSeedSpeaker.mockImplementation(async (...args: unknown[]) => {
        const seatNumber = args[3] as number;
        callOrder.push(seatNumber);
        // If seat 2 were claimed concurrently with seat 1 rather than
        // strictly after it, this delay would let seat 2's call resolve
        // *first* and prove the two were racing — it never does.
        if (seatNumber === 1) await new Promise((resolve) => setTimeout(resolve, 20));
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      expect(callOrder).toEqual([1, 2]);
    });

    it("reports the resulting shared round's real state after both seats seed successfully", async () => {
      // The default mock's own accounting (`noteSeatClaimed`) flips
      // `stage_rounds` to active once both seed calls succeed — the same
      // real side effect `claim_speaker_seat`'s own `ensure_stage_round`
      // call has in production. No explicit pre-set needed (and setting
      // one here would incorrectly flip the *pre*-seeding established
      // check to Case B — see this file's own doc comment above).
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("Round 1 active"));
    });

    it("reports clearly, rather than silently, if the shared round unexpectedly failed to start after a successful seed", async () => {
      // Suppresses the mock's normal auto-activation so both seats seed
      // successfully (Case A — the stage starts genuinely unestablished)
      // while the round row itself stays stuck at awaiting_pairing —
      // reproducing "seeding succeeded, but ensure_stage_round somehow
      // didn't fire" without touching the pre-seeding Case A/B decision.
      autoActivateRound.current = false;
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("the shared round did not start"));
      // The reactive backstop was still tried before giving up — see
      // `establishInitialPairing`'s own doc comment.
      expect(reconcileStageRoundAction).toHaveBeenCalledWith("e1");
      expect(screen.getByTestId("sim-stop")).toBeDisabled();
    });

    describe("Case B — an already-established stage (issue #21, fourth corrective pass, Section 5)", () => {
      it("seeds both seats via authorized Request-to-Speak selection, never a direct bypass, when the stage was already established before Start", async () => {
        stageRoundRow.current = { round_number: 11, phase: "awaiting_pairing" };
        // The mock can't know which physical seat is "open" the way
        // the real findOpenSeat/event_speakers_active query would — seat
        // number only matters for the log line here, not for the
        // assertions below, so a fixed value keeps the mock simple.
        simulateAdvanceSelection.mockImplementation(async (...args: unknown[]) => {
          const [, guestIds] = args as [string, string[]];
          noteSeatClaimed();
          return { claimed: true, guestId: guestIds[0], seatNumber: 1 };
        });

        render(<SessionSimulatorPanel {...baseProps} />);
        fireEvent.click(screen.getByTestId("sim-start"));

        // Generous timeouts throughout this block, not the default —
        // these are real (not fake) timer/wall-clock waits, and under a
        // full-suite run's accumulated system load a nominally-fast
        // microtask chain can occasionally take longer than the
        // default 1000ms to be observed, with no bearing on correctness.
        await waitFor(() => expect(simulateRequestToSpeak).toHaveBeenCalledTimes(2), { timeout: 5000 });
        expect(simulateSeedSpeaker).not.toHaveBeenCalled();
        await waitFor(() => expect(simulateAdvanceSelection).toHaveBeenCalledTimes(2), { timeout: 5000 });

        await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled(), { timeout: 5000 });
        expect(screen.getByTestId("sim-log")).toHaveTextContent("authorized Request-to-Speak selection");
      });

      it("bounded-retries the claim (never a blind sleep) when the freeze hasn't picked up the just-submitted request yet, then succeeds", async () => {
        stageRoundRow.current = { round_number: 4, phase: "awaiting_pairing" };
        let calls = 0;
        simulateAdvanceSelection.mockImplementation(async (...args: unknown[]) => {
          calls++;
          const [, guestIds] = args as [string, string[]];
          // Fails the *first* attempt for every seat (simulating
          // selection not having frozen the request yet), succeeds the
          // second — proves this is a real bounded retry against fresh
          // server state, not a single fire-and-forget attempt.
          if (calls % 2 === 1) return { claimed: false };
          noteSeatClaimed();
          return { claimed: true, guestId: guestIds[0], seatNumber: 1 };
        });

        render(<SessionSimulatorPanel {...baseProps} />);
        fireEvent.click(screen.getByTestId("sim-start"));

        // Stop is clickable throughout the whole startup sequence now
        // (issue #21, fourth corrective pass — see its own doc comment),
        // so "not disabled" alone no longer signals full completion the
        // way it used to; wait for the phase to actually reach Running.
        await waitFor(() => expect(screen.queryByTestId("sim-startup")).not.toBeInTheDocument(), { timeout: 6000 });
        expect(simulateAdvanceSelection.mock.calls.length).toBeGreaterThanOrEqual(4);
      });

      it("reports failure — never a bypass — when an established stage's seat can't be authorized within the bounded retry budget", async () => {
        stageRoundRow.current = { round_number: 4, phase: "active" };
        // Default simulateAdvanceSelection mock already resolves
        // {claimed:false} forever — never picks up an open seat.
        render(<SessionSimulatorPanel {...baseProps} />);
        fireEvent.click(screen.getByTestId("sim-start"));

        // Issue #21, eighth corrective pass: both seats now exhaust the
        // (widened) bounded retry budget sequentially before startup
        // gives up — see MAX_CLAIM_ATTEMPTS' own doc comment for why it
        // grew.
        await waitFor(() => expect(screen.getByTestId("sim-startup-phase")).toHaveTextContent("Failed"), { timeout: 13_000 });
        expect(screen.getByTestId("sim-log")).toHaveTextContent("did not result in an authorized claim");
        expect(simulateSeedSpeaker).not.toHaveBeenCalled();
        expect(screen.getByTestId("sim-stop")).toBeDisabled();
      }, 20_000);
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

    // Issue #21, eighth corrective pass, Sections 8, 33: a real-device
    // report found "Selecting next speaker…" persisting for several
    // seconds specifically for a simulator-generated candidate — traced
    // to the claim step depending solely on this 4-6s poll, even though
    // the reservation itself is fast. This proves the reactive fast
    // path: simulateAdvanceSelection fires the instant pendingRequests
    // shows one of this run's own identities reserved, with real timers
    // and *no* timer advance at all — never waiting for the poll tick.
    it("reacts immediately once pendingRequests shows one of this run's own identities reserved — no poll tick required (Sections 8, 33)", async () => {
      const onSimulatedIdentitiesCreated = vi.fn();
      const { rerender } = render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "seat-1", seat_number: 1 })]}
          onSimulatedIdentitiesCreated={onSimulatedIdentitiesCreated}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(onSimulatedIdentitiesCreated).toHaveBeenCalled());
      const ownGuestId: string = onSimulatedIdentitiesCreated.mock.calls[0][0][0];

      rerender(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "seat-1", seat_number: 1 })]}
          pendingRequests={[
            request({ id: "r1", guest_id: ownGuestId, is_current_candidate: true, reserved_seat_number: 2 }),
          ]}
          onSimulatedIdentitiesCreated={onSimulatedIdentitiesCreated}
        />,
      );

      await waitFor(() => expect(simulateAdvanceSelection).toHaveBeenCalled());
    });

    // Issue #21, eighth corrective pass, Section 15: two earlier cuts of
    // this reactive path (one calling `simulateAdvanceSelection` once
    // per reservation in parallel, one deduplicating by "have I already
    // attempted this exact reservation") were both proven live, against
    // a real dev server, to leave a *second* simultaneously-reserved
    // seat permanently unclaimed — `simulateAdvanceSelection` itself
    // only ever targets whichever reserved simulated candidate its own
    // internal lookup reaches first, regardless of which seat, so
    // per-reservation bookkeeping silently "used up" an attempt that
    // never actually touched that reservation. The fix drains
    // sequentially instead: call, await, and if it claimed something,
    // call again immediately — never tracking *which* reservation was
    // attempted at all. This test proves the two-seat case those
    // earlier cuts got wrong.
    it("drains sequentially until every currently-reserved simulated candidate is claimed — never stopping after just the first (Section 15)", async () => {
      const onSimulatedIdentitiesCreated = vi.fn();
      const { rerender } = render(<SessionSimulatorPanel {...baseProps} speakers={[]} onSimulatedIdentitiesCreated={onSimulatedIdentitiesCreated} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(onSimulatedIdentitiesCreated).toHaveBeenCalled());
      const ids: string[] = onSimulatedIdentitiesCreated.mock.calls[0][0];
      const [guestA, guestB] = ids;

      // Two seats, two distinct simulated candidates each reserved —
      // exactly the atomic dual-seat reservation's own real output.
      // simulateAdvanceSelection's mock claims whichever guest id its
      // own call list starts with, mirroring the real function's "first
      // matching reserved candidate" behavior — the *first* call claims
      // seat 1, the *second* (only reachable via a real sequential
      // drain) claims seat 2.
      simulateAdvanceSelection.mockImplementation(async (...args: unknown[]) => {
        const [, guestIds] = args as [string, string[]];
        if (guestIds.includes(guestA)) return { claimed: true, guestId: guestA, seatNumber: 1 as const };
        return { claimed: false };
      });

      rerender(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[]}
          pendingRequests={[
            request({ id: "r1", guest_id: guestA, is_current_candidate: true, reserved_seat_number: 1 }),
            request({ id: "r2", guest_id: guestB, is_current_candidate: true, reserved_seat_number: 2 }),
          ]}
          onSimulatedIdentitiesCreated={onSimulatedIdentitiesCreated}
        />,
      );

      // At least two calls: draining doesn't stop after the first
      // success — it keeps going until a call reports nothing left to
      // claim.
      await waitFor(() => expect(simulateAdvanceSelection.mock.calls.length).toBeGreaterThanOrEqual(2));
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

    it("never polls simulateAdvanceSelection while a real join/promotion is in progress (realJoinInProgress) — real users take precedence", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(
        <SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "seat-1", seat_number: 1 })]} realJoinInProgress={true} />,
      );
      fireEvent.click(screen.getByTestId("sim-start"));

      await vi.advanceTimersByTimeAsync(10_000);

      expect(simulateAdvanceSelection).not.toHaveBeenCalled();
    });

    it("both seats empty: the replacement loop fills both seats with distinct candidates over successive polls, never claiming the same one twice (issue #21, fifth corrective pass, Section 16)", async () => {
      // Two seats open at once — simulateAdvanceSelection (now seat-aware,
      // see its own doc comment) reports whichever reserved candidate it
      // finds each call; this mock alternates between two distinct
      // simulated winners, one per seat, matching what the real seat-aware
      // reservation RPC would hand back across two ticks.
      simulateAdvanceSelection
        .mockResolvedValueOnce({ claimed: true, guestId: "sim-guest-a", seatNumber: 1 })
        .mockResolvedValueOnce({ claimed: true, guestId: "sim-guest-b", seatNumber: 2 })
        .mockResolvedValue({ claimed: false });
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<SessionSimulatorPanel {...baseProps} speakers={[]} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await vi.advanceTimersByTimeAsync(14_000);

      const log = screen.getByTestId("sim-log");
      expect(log).toHaveTextContent("Seat 1");
      expect(log).toHaveTextContent("Seat 2");
      // Both promotions are distinctly logged — never the same claim
      // reported twice, never a seat number collision.
      const promotionLines = screen.getAllByText(/promoted/);
      expect(promotionLines.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("per-seat vote configuration + shared Resolve Round Now (corrective pass — one shared deadline, per-seat outcomes)", () => {
    it("shows no force controls at all when no seat is occupied", () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[]} />);
      expect(screen.queryByTestId("sim-force-continue")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sim-force-narrow-loss")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sim-force-replace")).not.toBeInTheDocument();
    });

    it("Force Continue on seat 1 only casts votes for seat 1's round, even with a second occupied seat — it does not resolve anything by itself", async () => {
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

      await waitFor(() => expect(simulateRoundVote).toHaveBeenCalledWith("seat-1-round", "continue", expect.any(String)));
      expect(simulateRoundVote.mock.calls.every((call) => call[0] === "seat-1-round")).toBe(true);
      expect(forceStageRoundDeadline).not.toHaveBeenCalled();
    });

    it("Force Narrow Loss on seat 2 only casts votes for seat 2's round", async () => {
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

      await waitFor(() => expect(simulateRoundVote.mock.calls.some((call) => call[0] === "seat-2-round")).toBe(true));
      expect(simulateRoundVote.mock.calls.every((call) => call[0] === "seat-2-round")).toBe(true);
      expect(forceStageRoundDeadline).not.toHaveBeenCalled();
    });

    it("Force Replace configures a decisive-replace vote split and logs that it's aiming for Replace", async () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "round-1", seat_number: 1 })]} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(within(roundStatusForSeat(1)).getByTestId("sim-force-replace"));
      await waitFor(() => expect(simulateRoundVote).toHaveBeenCalled());

      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seat 1 configured → aiming for Replace");
    });

    it("Resolve Round Now advances the shared deadline and reports each seat's real resolved outcome", async () => {
      forceStageRoundDeadline.mockResolvedValueOnce([
        { eventSpeakersId: "seat-1-round", outcome: "continue" },
        { eventSpeakersId: "seat-2-round", outcome: "decisive-replace" },
      ]);
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

      fireEvent.click(screen.getByTestId("sim-resolve-round"));
      await waitFor(() => expect(forceStageRoundDeadline).toHaveBeenCalledWith("e1"));

      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seat 1 → Continue");
      expect(screen.getByTestId("sim-log")).toHaveTextContent("Seat 2 → Decisive Replace");
    });

    it("Resolve Round Now reports no active shared round rather than crashing when there's nothing to resolve", async () => {
      forceStageRoundDeadline.mockResolvedValueOnce([]);
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-resolve-round"));
      await waitFor(() => expect(forceStageRoundDeadline).toHaveBeenCalled());
      expect(screen.getByTestId("sim-log")).toHaveTextContent("no active shared round to resolve");
    });

    it("a seat in its closing phase shows only Force Replace Now — no new vote is cast, and it never touches the shared round", async () => {
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
      await waitFor(() => expect(forceSeatClosingDeadline).toHaveBeenCalledWith("round-1"));
      expect(simulateRoundVote).not.toHaveBeenCalled();
      expect(forceStageRoundDeadline).not.toHaveBeenCalled();
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

  describe("Selection observability (Part 3/4 — making the weighted draw legible, not changing it)", () => {
    it("shows no frozen selection when no seat is opening", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      expect(screen.getByText("No candidate selection in progress")).toBeInTheDocument();
    });

    it("shows the frozen Top 3 with rank and vote counts, no weighted odds — highest votes wins", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", message_id: "m1", frozen_rank: 1, frozen_vote_count: 8, is_current_candidate: true, reserved_seat_number: 1 }),
            request({ id: "r2", guest_id: "g2", message_id: "m2", frozen_rank: 2, frozen_vote_count: 5, is_current_candidate: false }),
            request({ id: "r3", guest_id: "g3", message_id: "m3", frozen_rank: 3, frozen_vote_count: 3, is_current_candidate: false }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Calm Sparrow", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Eager Deer", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
              { id: "m3", author_display_name: "Restless Wolf", author_profile_id: null, author_guest_id: "g3", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      const candidates = screen.getAllByTestId("sim-frozen-candidate");
      expect(candidates[0]).toHaveTextContent("#1 Calm Sparrow — 8 votes");
      expect(candidates[0]).toHaveTextContent("selected");
      expect(candidates[0]).not.toHaveTextContent("%");
      expect(candidates[1]).toHaveTextContent("#2 Eager Deer — 5 votes");
      expect(candidates[2]).toHaveTextContent("#3 Restless Wolf — 3 votes");

      expect(screen.getByTestId("sim-selection-status-1")).toHaveTextContent("Calm Sparrow — authorized, joining");
      expect(screen.getByTestId("sim-selection-reason")).toHaveTextContent("Highest vote count");
    });

    it("explains a tie as the reason, not a weighted draw — earliest request wins", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", message_id: "m1", frozen_rank: 1, frozen_vote_count: 8, is_current_candidate: true, reserved_seat_number: 1 }),
            request({ id: "r2", guest_id: "g2", message_id: "m2", frozen_rank: 2, frozen_vote_count: 8, is_current_candidate: false }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Calm Sparrow", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Eager Deer", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      expect(screen.getByTestId("sim-selection-reason")).toHaveTextContent("Tied at 8 votes · earlier request");
    });

    it("reports 'authorized, joining' before the candidate occupies a seat, and 'occupied' once they do — the same identity, read from the real speakers list, never a separate guess", () => {
      const { rerender } = render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[request({ id: "r1", guest_id: "g1", frozen_rank: 1, frozen_vote_count: 4, is_current_candidate: true, reserved_seat_number: 2 })]}
        />,
      );
      expect(screen.getByTestId("sim-selection-status-2")).toHaveTextContent("authorized, joining");
      expect(screen.getByTestId("sim-selection-status-2")).not.toHaveTextContent("occupied");

      rerender(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[request({ id: "r1", guest_id: "g1", frozen_rank: 1, frozen_vote_count: 4, is_current_candidate: true, reserved_seat_number: 2 })]}
          speakers={[speaker({ id: "seat-2", seat_number: 2, guest_id: "g1", profile_id: null })]}
        />,
      );
      expect(screen.getByTestId("sim-selection-status-2")).toHaveTextContent("occupied");
    });

    it("shows two simultaneous reservations distinctly — one per seat, never collapsed into one ambiguous status (issue #21, fifth corrective pass, Section 16)", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", message_id: "m1", frozen_rank: 1, frozen_vote_count: 6, is_current_candidate: true, reserved_seat_number: 1 }),
            request({ id: "r2", guest_id: "g2", message_id: "m2", frozen_rank: 2, frozen_vote_count: 4, is_current_candidate: true, reserved_seat_number: 2 }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Calm Sparrow", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Eager Deer", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      expect(screen.getByTestId("sim-selection-status-1")).toHaveTextContent("Calm Sparrow");
      expect(screen.getByTestId("sim-selection-status-2")).toHaveTextContent("Eager Deer");
      // Never the same candidate shown for both seats.
      expect(screen.getByTestId("sim-selection-status-1")).not.toHaveTextContent("Eager Deer");
      expect(screen.getByTestId("sim-selection-status-2")).not.toHaveTextContent("Calm Sparrow");
    });

    it("shows 'no candidate reserved' for an open seat with nobody currently selected for it", () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "seat-1", seat_number: 1 })]} />);
      expect(screen.getByTestId("sim-selection-status-2")).toHaveTextContent("no candidate reserved");
    });
  });

  // Issue #21, sixth corrective pass, Sections 1-3, 20-21: the real-observed
  // per-seat diagnostic timeline this pass adds — a real-device report found
  // "Selecting next speaker…" alone gave no way to tell *where* time was
  // actually going. Every assertion below checks the *specific* WAITING AT
  // reason shown (Section 21), never a generic "Selecting…", and that a
  // completed cycle reports a real Total once the seat is occupied.
  describe("Selection Timing diagnostic display (issue #21, sixth corrective pass, Sections 1-3, 20-21)", () => {
    it("reports 'no eligible request observed yet' — never a generic reason — for a vacant seat with nothing pending", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      await waitFor(() => expect(screen.getByTestId("sim-waiting-1")).toHaveTextContent("no eligible request observed yet"));
      expect(screen.getByTestId("sim-waiting-2")).toHaveTextContent("no eligible request observed yet");
    });

    it("reports 'fallback open — tap to join' once the stage is established, both seats are empty, and there are no requests", async () => {
      render(<SessionSimulatorPanel {...baseProps} stageRound={stageRoundFixture({ round_number: 1 })} />);
      await waitFor(() => expect(screen.getByTestId("sim-waiting-1")).toHaveTextContent("fallback open — tap to join"));
    });

    it("reports that reservation is pending/not yet propagated once an eligible request exists but nothing is reserved for this seat yet", async () => {
      render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ id: "r1", guest_id: "g1" })]} />);
      await waitFor(() => expect(screen.getByTestId("sim-waiting-1")).toHaveTextContent("reservation RPC pending, or reservation not yet propagated"));
    });

    it("reports the intentional Going Live countdown, by name and duration, once a candidate is actually reserved for this seat — never the generic reservation-pending reason", async () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[request({ id: "r1", guest_id: "g1", is_current_candidate: true, reserved_seat_number: 1 })]}
        />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("sim-waiting-1")).toHaveTextContent(`Going Live (up to ${PROMOTION_COUNTDOWN_SECONDS}s, intentional)`),
      );
      expect(screen.getByTestId("sim-waiting-1")).not.toHaveTextContent("reservation RPC pending");
    });

    // Issue #21, eighth corrective pass, Section 9: the new, more
    // granular reason once a seat has been reserved noticeably longer
    // than the intentional countdown could explain — distinguishes a
    // genuine stall from normal Going Live, using a real measured
    // elapsed time (never an estimate).
    it("reports 'authoritative seat claim' — not the Going Live reason — once a seat has been reserved well past the intentional countdown and still isn't occupied", async () => {
      vi.useFakeTimers();
      try {
        const { rerender } = render(<SessionSimulatorPanel {...baseProps} />);
        // Establish a real vacantAt timestamp before reserving, so a
        // real elapsed duration can be measured from it.
        rerender(
          <SessionSimulatorPanel
            {...baseProps}
            pendingRequests={[request({ id: "r1", guest_id: "g1", is_current_candidate: true, reserved_seat_number: 1 })]}
          />,
        );
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10_000); // well past the 3s countdown + claim grace
        expect(screen.getByTestId("sim-waiting-1")).toHaveTextContent("authoritative seat claim");
        expect(screen.getByTestId("sim-waiting-1")).not.toHaveTextContent("Going Live");
      } finally {
        vi.useRealTimers();
      }
    });

    it("shows no vacancy-cycle timing for a seat that's already occupied when this panel first mounts", async () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "seat-1", seat_number: 1 })]} />);
      await waitFor(() => expect(screen.getByTestId("sim-seat-timing-1")).toHaveTextContent("occupied — no vacancy cycle in progress"));
      expect(screen.queryByTestId("sim-waiting-1")).not.toBeInTheDocument();
    });

    it("shows a real measured Total, not a fabricated one, once a vacant seat becomes occupied", async () => {
      const { rerender } = render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[request({ id: "r1", guest_id: "g1", is_current_candidate: true, reserved_seat_number: 1 })]}
        />,
      );
      await waitFor(() => expect(screen.getByTestId("sim-waiting-1")).toBeInTheDocument());

      rerender(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "seat-1", seat_number: 1 })]} />);
      await waitFor(() => expect(screen.getByTestId("sim-seat-timing-total-1")).toBeInTheDocument());
      expect(screen.getByTestId("sim-seat-timing-total-1")).toHaveTextContent(/^Total: \+\d/);
      expect(screen.queryByTestId("sim-waiting-1")).not.toBeInTheDocument();
    });
  });

  // Issue #21, eighth corrective pass, Section 9: one row per currently-
  // pending request (the full live pool, not just frozen/ranked ones),
  // so a request that arrived after the last frozen snapshot is never
  // silently missing from diagnostics.
  describe("Candidates diagnostic table (issue #21, eighth corrective pass, Section 9)", () => {
    it("shows requested/eligible/rank/reserved/occupied for every pending request, including one not yet part of any frozen round", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", frozen_rank: 1, is_current_candidate: true, reserved_seat_number: 1, selection_failed: false }),
            request({ id: "r2", guest_id: "g2", frozen_rank: null }), // not yet part of any frozen round
          ]}
        />,
      );
      const rows = screen.getAllByTestId("sim-candidate-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("requested ✓");
      expect(rows[0]).toHaveTextContent("eligible ✓");
      expect(rows[0]).toHaveTextContent("rank 1");
      expect(rows[0]).toHaveTextContent("reserved (Seat 1)");
      expect(rows[1]).toHaveTextContent("rank —");
      expect(rows[1]).toHaveTextContent("not reserved");
    });

    it("shows a candidate as ineligible once selection_failed is set", () => {
      render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ id: "r1", guest_id: "g1", selection_failed: true })]} />);
      expect(screen.getByTestId("sim-candidate-row")).toHaveTextContent("eligible ✗");
    });

    it("shows occupied ✓ once the request's own identity is actually seated", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "s1", seat_number: 1, guest_id: "g1", profile_id: null })]}
          pendingRequests={[request({ id: "r1", guest_id: "g1" })]}
        />,
      );
      expect(screen.getByTestId("sim-candidate-row")).toHaveTextContent("occupied ✓");
    });

    it("shows nothing but an explicit empty state when there are no pending requests at all", () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      expect(screen.queryByTestId("sim-candidate-row")).not.toBeInTheDocument();
    });
  });

  describe("small-room fallback status (issue #21, fifth corrective pass, Section 16 — 'if blocked, show why')", () => {
    it("reports fallback as n/a before the stage has ever been established", () => {
      render(<SessionSimulatorPanel {...baseProps} stageRound={null} speakers={[]} />);
      expect(screen.getByTestId("sim-fallback-status")).toHaveTextContent("n/a");
    });

    it("reports fallback open when the stage is established, both seats are empty, and there are zero pending requests", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 3 })}
          speakers={[]}
          pendingRequests={[]}
        />,
      );
      expect(screen.getByTestId("sim-fallback-status")).toHaveTextContent("open");
    });

    it("reports fallback closed (requests exist) when both seats are empty but an eligible request exists", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 3 })}
          speakers={[]}
          pendingRequests={[request()]}
        />,
      );
      expect(screen.getByTestId("sim-fallback-status")).toHaveTextContent("closed (requests exist");
    });

    it("reports fallback closed (a seat is occupied) when one seat is occupied", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          stageRound={stageRoundFixture({ phase: "awaiting_pairing", round_number: 3 })}
          speakers={[speaker({ id: "seat-1", seat_number: 1 })]}
          pendingRequests={[]}
        />,
      );
      expect(screen.getByTestId("sim-fallback-status")).toHaveTextContent("closed (a seat is occupied)");
    });
  });

  describe("Reset Session (destroys simulator-created state, distinct from Stop)", () => {
    // Issue #21, seventh corrective pass, Section 20: explicit instruction
    // to remove the confirmation step entirely — a preview-only tool, one
    // tap, reset begins immediately. Replaces the old "shows a
    // confirmation"/"Cancel dismisses it" tests below.
    it("a single tap begins the reset immediately — no confirmation step of any kind", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-reset"));
      expect(screen.queryByTestId("sim-reset-confirm-row")).not.toBeInTheDocument();
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());
    });

    it("shows an immediate pressed/executing acknowledgment and rejects a second tap while the first reset is still in flight (Sections 21, 25)", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      const resetButton = screen.getByTestId("sim-reset");

      fireEvent.click(resetButton);
      expect(resetButton).toBeDisabled();
      fireEvent.click(resetButton); // a real disabled button wouldn't even deliver this — belt and suspenders

      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(resetButton).not.toBeDisabled());
    });

    it("clicking Reset stops the simulation and calls resetSimulatorSession with every generated guest id", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-reset"));

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

      // Stop (unlike Reset) never touches `stage_rounds` — the stage the
      // first run established genuinely stays established. This test
      // isn't about seeding mechanics, so simulate a fresh, never-
      // established stage for the second run the same way Reset would
      // have (issue #21, fourth corrective pass — see this file's own
      // doc comment on the hoisted mock block for why the pre-seeding
      // read matters here).
      stageRoundRow.current = { round_number: 0, phase: "awaiting_pairing" };
      resetSeedTracking();

      fireEvent.click(screen.getByTestId("sim-start")); // second run — generates a fresh, different 22 identities
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-reset"));

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
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());

      expect(screen.getByTestId("sim-pool-reset-count")).toHaveTextContent("pool resets observed: 0");
    });

    it("no background simulation activity fires after a reset", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      fireEvent.click(screen.getByTestId("sim-reset"));
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
      await waitFor(() => expect(resetSimulatorSession).toHaveBeenCalled());
      const firstRunIds = resetSimulatorSession.mock.calls[0][1] as string[];

      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      fireEvent.click(screen.getByTestId("sim-reset"));
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
      await waitFor(() => expect(onSimulatorReset).toHaveBeenCalledTimes(1));
    });

    it("reset with nothing ever started is a harmless no-op (no crash, resetSimulatorSession still called with an empty list)", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-reset"));
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
