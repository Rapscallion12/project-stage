import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionSimulatorPanel } from "./session-simulator-panel";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { RankedPendingRequest } from "@/hooks/use-active-speaker-requests";
import type { LobbyMessage } from "@/hooks/use-lobby-realtime";
import type { SeatResolutionOutcome, StageRound } from "@/lib/repositories/stage-rounds";
import type { ResetSimulatorSessionResult, DebugSnapshotState } from "@/app/events/[id]/room/simulator-actions";
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
  simulateWithdrawRequest,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceStageRoundDeadline,
  forceSeatClosingDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
  fetchDebugSnapshotState,
  reconcileStageRoundAction,
  supabaseFrom,
  stageRoundRow,
  roundVotesData,
  autoActivateRound,
  resetSeedTracking,
  noteSeatClaimed,
  seatOccupants,
} = vi.hoisted(() => {
  const stageRoundRow: { current: { round_number: number; phase: string } | null } = {
    current: { round_number: 0, phase: "awaiting_pairing" },
  };
  const roundVotesData: { current: Array<{ event_speakers_id: string; choice: "continue" | "replace" }> } = { current: [] };
  const autoActivateRound = { current: true };
  let claimedCount = 0;
  // Issue #21, fourteenth corrective pass: `establishSeat`'s Case A
  // branch now confirms every seed attempt against a fresh, authoritative
  // `event_speakers_active` read (`fetchSeatOccupants`) rather than
  // trusting the mutation promise alone — this is that authoritative
  // read's own backing store in the mock, snake_case to match the real
  // view's own column names exactly (the production code reads
  // `row.guest_id`/`row.profile_id`/`row.display_name`).
  const seatOccupants: {
    current: Record<1 | 2, { guest_id: string | null; profile_id: string | null; display_name: string } | null>;
  } = { current: { 1: null, 2: null } };

  function noteSeatClaimed(seatNumber?: 1 | 2, occupant?: { guest_id: string | null; profile_id: string | null; display_name: string }) {
    if (seatNumber !== undefined && occupant !== undefined) {
      seatOccupants.current[seatNumber] = occupant;
    }
    claimedCount++;
    if (autoActivateRound.current && claimedCount >= 2) {
      stageRoundRow.current = { round_number: (stageRoundRow.current?.round_number ?? 0) + 1, phase: "active" };
    }
  }
  function resetSeedTracking() {
    claimedCount = 0;
    seatOccupants.current = { 1: null, 2: null };
  }

  const simulateSeedSpeaker = vi.fn<(...args: unknown[]) => Promise<void>>(async (...args: unknown[]) => {
    const [, guestId, displayName, seatNumber] = args as [string, string, string, 1 | 2];
    noteSeatClaimed(seatNumber, { guest_id: guestId, profile_id: null, display_name: displayName });
  });
  const simulateAdvanceSelection = vi.fn<(...args: unknown[]) => Promise<{ claimed: boolean; guestId?: string; seatNumber?: 1 | 2 }>>(
    async () => ({ claimed: false }),
  );
  // Default: a real removal, mirroring production's own `endSpeakerSeat`
  // — clears whichever seat this guest id currently occupies, so a test
  // exercising the "leftover simulator seat" self-heal (fourteenth pass)
  // sees the same authoritative-vacancy the real RPC would produce.
  const simulateOpenSeat = vi.fn<(...args: unknown[]) => Promise<void>>(async (...args: unknown[]) => {
    const [, guestId] = args as [string, string];
    for (const seatNumber of [1, 2] as const) {
      if (seatOccupants.current[seatNumber]?.guest_id === guestId) {
        seatOccupants.current[seatNumber] = null;
      }
    }
  });

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
    if (table === "event_speakers_active") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(async () => ({
            data: ([1, 2] as const)
              .filter((seatNumber) => seatOccupants.current[seatNumber] !== null)
              .map((seatNumber) => ({ seat_number: seatNumber, ...seatOccupants.current[seatNumber]! })),
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
    simulateWithdrawRequest: vi.fn<(...args: unknown[]) => Promise<null>>(async () => null),
    simulateRoundVote: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    simulateSeedSpeaker,
    simulateOpenSeat,
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
    fetchDebugSnapshotState: vi.fn<(...args: unknown[]) => Promise<DebugSnapshotState>>(async () => ({
      fetchedAt: new Date().toISOString(),
      round: null,
      seats: [],
      pendingRequests: [],
    })),
    reconcileStageRoundAction: vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}),
    supabaseFrom,
    stageRoundRow,
    roundVotesData,
    autoActivateRound,
    resetSeedTracking,
    noteSeatClaimed,
    seatOccupants,
  };
});

vi.mock("@/app/events/[id]/room/simulator-actions", () => ({
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateWithdrawRequest,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceStageRoundDeadline,
  forceSeatClosingDeadline,
  resetSimulatorSession,
  simulateAdvanceSelection,
  fetchDebugSnapshotState,
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
    simulateSeedSpeaker.mockImplementation(async (...args: unknown[]) => {
      const [, guestId, displayName, seatNumber] = args as [string, string, string, 1 | 2];
      noteSeatClaimed(seatNumber, { guest_id: guestId, profile_id: null, display_name: displayName });
    });
    simulateAdvanceSelection.mockImplementation(async () => ({ claimed: false }));
    simulateOpenSeat.mockImplementation(async (...args: unknown[]) => {
      const [, guestId] = args as [string, string];
      for (const seatNumber of [1, 2] as const) {
        if (seatOccupants.current[seatNumber]?.guest_id === guestId) {
          seatOccupants.current[seatNumber] = null;
        }
      }
    });
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
    it("Seed 2 Speakers on an already-fully-seeded stage is an authoritative no-op — issue #21, fifteenth corrective pass: the idempotency fast-path reports success immediately, never a redundant claim or an RTS wait", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));

      // Both seats are now authoritatively occupied by Start's own two
      // stable identities — a manual re-seed at this point recognizes
      // both via the authoritative pre-check and reports "nothing to do"
      // without attempting a second, redundant claim for either.
      simulateSeedSpeaker.mockClear();
      fireEvent.click(screen.getByTestId("sim-seed-speakers"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("nothing to do"));
      expect(simulateSeedSpeaker).not.toHaveBeenCalled();
      // The old Case B pipeline (real Request-to-Speak + a bounded RTS
      // wait) is never reached — bootstrap's own authoritative pre-check
      // resolves this before any mutation is even attempted.
      expect(simulateRequestToSpeak).not.toHaveBeenCalled();
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

    it("one seat failing to seed reports it clearly and does NOT half-start the session (issue #21, fourth corrective pass: a shared round requires both seats)", async () => {
      // Issue #21, fourteenth corrective pass: `establishSeat` now
      // authoritatively re-checks after a throw and retries a genuinely
      // transient-looking failure (no occupant found) up to
      // MAX_SEED_ATTEMPTS times — both attempts need to fail here for
      // seat 1 to end up genuinely, permanently unseeded, matching what
      // this test is actually about (one seat truly can't be seeded).
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("seat already occupied");
      });
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
      // (successful) seeding behavior. Issue #21, fourteenth corrective
      // pass: two throws *per* seat (four total) — MAX_SEED_ATTEMPTS
      // means a single throw with no matching occupant now gets one
      // retry, so both attempts for both seats need to fail for this to
      // stay a genuine, permanent double-failure.
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("both seats occupied");
      });
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        throw new Error("both seats occupied");
      });
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
        const [, guestId, displayName, seatNumber] = args as [string, string, string, 1 | 2];
        callOrder.push(seatNumber);
        // If seat 2 were claimed concurrently with seat 1 rather than
        // strictly after it, this delay would let seat 2's call resolve
        // *first* and prove the two were racing — it never does.
        if (seatNumber === 1) await new Promise((resolve) => setTimeout(resolve, 20));
        // Issue #21, fourteenth corrective pass: `establishSeat` now
        // authoritatively re-checks after every attempt — this override
        // must report a real occupant the same way the default mock does,
        // or a spurious "authoritative state disagreed" retry would call
        // this a second time for the same seat and break the exact
        // call-order assertion this test exists to make.
        noteSeatClaimed(seatNumber, { guest_id: guestId, profile_id: null, display_name: displayName });
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

    describe("Bootstrap on an already-established stage (issue #21, fifteenth corrective pass — the Case B real-RTS-wait path is retired for bootstrap)", () => {
      it("seeds both seats via the same authoritative bypass path as a fresh stage — never waits on real RTS selection — when the stage was already established before Start", async () => {
        stageRoundRow.current = { round_number: 11, phase: "awaiting_pairing" };

        render(<SessionSimulatorPanel {...baseProps} />);
        fireEvent.click(screen.getByTestId("sim-start"));

        await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2), { timeout: 5000 });
        // The old Case B pipeline — real Request-to-Speak submission plus
        // a bounded-retried simulateAdvanceSelection wait — is never
        // invoked for bootstrap now, established stage or not.
        expect(simulateRequestToSpeak).not.toHaveBeenCalled();
        expect(simulateAdvanceSelection).not.toHaveBeenCalled();

        await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled(), { timeout: 5000 });
        expect(screen.getByTestId("sim-log")).toHaveTextContent("Existing stage established: yes");
      });

      it("a non-simulator occupant on an already-established stage blocks bootstrap for that seat — never evicted, never waited-on via RTS", async () => {
        stageRoundRow.current = { round_number: 11, phase: "awaiting_pairing" };
        simulateSeedSpeaker.mockImplementationOnce(async () => {
          seatOccupants.current[1] = { guest_id: "real-participant-guest", profile_id: null, display_name: "Real Person" };
          throw new Error("seat 1 in event e1 is already occupied");
        });

        render(<SessionSimulatorPanel {...baseProps} />);
        fireEvent.click(screen.getByTestId("sim-start"));

        await waitFor(() => expect(screen.getByTestId("sim-startup-phase")).toHaveTextContent("Failed"), { timeout: 5000 });
        expect(simulateOpenSeat).not.toHaveBeenCalled();
        expect(simulateRequestToSpeak).not.toHaveBeenCalled();
        expect(screen.getByTestId("sim-log")).toHaveTextContent("not simulator-owned");
      });
    });

    describe("Stale-generation cleanup before bootstrap (issue #21, fifteenth corrective pass)", () => {
      it("withdraws a stale, simulator-owned pending request from an earlier generation before seeding the new baseline — real-device evidence: a real snapshot showed a fresh generation's own candidates losing a deterministic tie-break to an uncleared stale request", async () => {
        let capturedIds: string[] = [];
        const { rerender } = render(
          <SessionSimulatorPanel {...baseProps} onSimulatedIdentitiesCreated={(ids) => (capturedIds = ids)} />,
        );
        fireEvent.click(screen.getByTestId("sim-start"));
        await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
        fireEvent.click(screen.getByTestId("sim-stop"));
        stageRoundRow.current = { round_number: 0, phase: "awaiting_pairing" };
        resetSeedTracking();

        // A stale pending request from that same (now-stopped) generation
        // — one of its own audience ids, exactly the shape a leftover
        // Case-B-style RTS submission or an ordinary natural-activity
        // Request-to-Speak would leave behind.
        const staleGuestId = capturedIds[0];
        rerender(
          <SessionSimulatorPanel
            {...baseProps}
            pendingRequests={[request({ id: "stale-r1", guest_id: staleGuestId, message_id: "stale-m1", voteCount: 0 })]}
            onSimulatedIdentitiesCreated={(ids) => (capturedIds = ids)}
          />,
        );

        fireEvent.click(screen.getByTestId("sim-start"));
        await waitFor(() => expect(simulateWithdrawRequest).toHaveBeenCalledWith("e1", staleGuestId));
        await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("Cleared 1 stale simulator RTS request"));
      });

      it("never withdraws a real (non-simulator) participant's own pending request", async () => {
        render(
          <SessionSimulatorPanel
            {...baseProps}
            pendingRequests={[request({ id: "real-r1", guest_id: "real-participant-guest", message_id: "real-m1", voteCount: 2 })]}
          />,
        );
        fireEvent.click(screen.getByTestId("sim-start"));
        await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
        expect(simulateWithdrawRequest).not.toHaveBeenCalledWith("e1", "real-participant-guest");
      });
    });
  });

  describe("Startup reliability (issue #21, fourteenth corrective pass — Reset/Start self-healing, re-entrancy, and React #441)", () => {
    it("a leftover simulator-owned seat from an earlier incomplete Start is cleared and retried automatically — never requires a manual Reset", async () => {
      // Reproduces the real-device shape directly: seat 1's mutation
      // throws (matching the redacted "Minified React error #441" a
      // production Server Action throw looks like), but authoritative
      // state shows the seat already held by a *different* identity this
      // tab itself generated — `onSimulatedIdentitiesCreated` reports the
      // exact ids this run's own `allSimulatedGuestIdsRef` now tracks
      // (the audience pool, generated before the seed speakers), so one
      // of those stands in for "a leftover simulator-owned occupant from
      // an earlier incomplete attempt" without needing a whole separate
      // prior run.
      let capturedIds: string[] = [];
      let seat1Attempts = 0;
      simulateSeedSpeaker.mockImplementation(async (...args: unknown[]) => {
        const [, guestId, displayName, seatNumber] = args as [string, string, string, 1 | 2];
        if (seatNumber === 1) {
          seat1Attempts++;
          if (seat1Attempts === 1) {
            seatOccupants.current[1] = { guest_id: capturedIds[0], profile_id: null, display_name: "Leftover Speaker" };
            throw new Error("seat 1 in event e1 is already occupied");
          }
        }
        noteSeatClaimed(seatNumber, { guest_id: guestId, profile_id: null, display_name: displayName });
      });

      render(<SessionSimulatorPanel {...baseProps} onSimulatedIdentitiesCreated={(ids) => (capturedIds = ids)} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("leftover simulator seat"), { timeout: 5000 });
      // simulateOpenSeat is the real cleanup adapter — must be called with
      // the leftover occupant's own guest id, never a real participant's.
      await waitFor(() => expect(simulateOpenSeat).toHaveBeenCalledWith("e1", capturedIds[0]));
      // Recovers fully — reaches Running, not Failed.
      await waitFor(() => expect(screen.queryByTestId("sim-startup")).not.toBeInTheDocument(), { timeout: 5000 });
      expect(screen.getByTestId("sim-stop")).not.toBeDisabled();
    });

    it("never evicts a seat occupied by an identity this tab did not generate — reports a precise failure instead", async () => {
      simulateSeedSpeaker.mockImplementationOnce(async () => {
        seatOccupants.current[1] = { guest_id: "real-participant-guest", profile_id: null, display_name: "Real Person" };
        throw new Error("seat 1 in event e1 is already occupied");
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-startup-phase")).toHaveTextContent("Failed"), { timeout: 5000 });
      expect(simulateOpenSeat).not.toHaveBeenCalled();
      expect(screen.getByTestId("sim-log")).toHaveTextContent("not simulator-owned");
      expect(screen.getByTestId("sim-startup-error")).toHaveTextContent("FAILED PHASE");
      expect(screen.getByTestId("sim-startup-error")).toHaveTextContent("RECOVERY");
    });

    it("treats a throw as a real success, and does not retry, when authoritative state shows the intended identity already seated (the React #441 shape)", async () => {
      // The exact real-device scenario: the mutation succeeded server-side
      // (the seat authoritatively holds this identity), but a downstream
      // client-visible error still surfaced — never treated as a failure.
      simulateSeedSpeaker.mockImplementationOnce(async (...args: unknown[]) => {
        const [, guestId, displayName, seatNumber] = args as [string, string, string, 1 | 2];
        noteSeatClaimed(seatNumber, { guest_id: guestId, profile_id: null, display_name: displayName });
        throw new Error("Minified React error #441; visit https://react.dev/errors/441");
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("the mutation succeeded despite the client-visible error"), {
        timeout: 5000,
      });
      // Only one attempt for seat 1 — never retried once confirmed occupied.
      expect(simulateSeedSpeaker.mock.calls.filter((call) => call[3] === 1)).toHaveLength(1);
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
    });

    it("a rapid double-tap on Start launches only one startup pipeline — never two overlapping ones", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      const startButton = screen.getByTestId("sim-start");
      // Two synchronous DOM click dispatches in the same `act()` batch —
      // React only commits/re-renders (and therefore only updates the
      // button's own `disabled` attribute) once, *after* this callback
      // returns, so at the moment of the second dispatch the DOM element
      // itself is still not disabled yet. This is the actual race
      // `startupInFlightRef`'s synchronous guard exists for: a real
      // double-tap or duplicate pointer event arriving before a frame
      // paints, which two sequential `fireEvent.click` calls (each their
      // own `act()`, each flushing a render in between) cannot reproduce.
      act(() => {
        startButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        startButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("ignoring duplicate tap"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2), { timeout: 5000 });
      // Never more than 2 — a second overlapping pipeline would double this.
      expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
    });

    it("the Start button is disabled, and Start cannot proceed, while a Reset's primary pass is still in flight", async () => {
      let resolveReset!: () => void;
      resetSimulatorSession.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReset = () =>
              resolve({ messagesDeleted: 0, reactionsDeleted: 0, speakersDeleted: 0, requestVotesDeleted: 0, roundVotesDeleted: 0 });
          }),
      );
      render(<SessionSimulatorPanel {...baseProps} />);
      const resetButton = screen.getByTestId("sim-reset");
      const startButton = screen.getByTestId("sim-start");
      // Both clicks dispatched in the same synchronous `act()` batch, on
      // a never-yet-started panel (`running`/`startingUp` both already
      // false going in) — the only thing that can explain the second
      // click being blocked is the Reset-Start barrier itself
      // (`resetInFlightRef`), read synchronously before React has had any
      // chance to commit the re-render that would otherwise disable this
      // button via the `resetInFlight` *state* a render later.
      act(() => {
        resetButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
        startButton.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      });

      await waitFor(() => expect(screen.getByTestId("sim-log")).toHaveTextContent("Reset still in progress"));
      expect(simulateSeedSpeaker).not.toHaveBeenCalled();
      await waitFor(() => expect(startButton).toBeDisabled());

      resolveReset();
      await waitFor(() => expect(startButton).not.toBeDisabled());
    });

    it("the debug snapshot's SIMULATOR STARTUP block reports bootstrap generation, reset state, and frozen per-seat bootstrap intended vs. authoritative occupant", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      fetchDebugSnapshotState.mockResolvedValueOnce({
        fetchedAt: new Date().toISOString(),
        round: { round_number: 1, phase: "active", ends_at: new Date().toISOString() },
        seats: [{ seat_number: 1, display_name: "Dapper Heron", identity_kind: "guest", disconnected: false }],
        pendingRequests: [],
      });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain("SIMULATOR STARTUP");
      expect(copied).toContain("State: ready");
      expect(copied).toContain("Bootstrap mode: simulator-authoritative bypass");
      expect(copied).toContain("Bootstrap generation:");
      expect(copied).toContain("Reset in progress: no");
      expect(copied).toContain("Reset generation:");
      expect(copied).toContain("Startup attempt:");
      expect(copied).toContain("Existing stage established:");
      expect(copied).toContain("Initial bootstrap Seat 1 intended:");
      expect(copied).toContain("Initial bootstrap Seat 1 authoritative:");
      expect(copied).toContain("Initial bootstrap Seat 2 intended:");
      expect(copied).toContain("Initial bootstrap Seat 2 authoritative:");
      expect(copied).toContain("Stale simulator generations detected: no");
      expect(copied).toContain("Stale simulator RTS requests cleaned: 0");
      expect(copied).toContain("Non-simulator occupant blocker: none");
      expect(copied).toContain("Bootstrap result: ready");
      expect(copied).toContain("Last startup error: none");
      expect(copied).toContain("Pending cleanup from previous generation:");
    });

    it("labels a real later replacement as current live state, never as bootstrap drift — the frozen bootstrap fields stay exactly what bootstrap itself produced", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(simulateSeedSpeaker).toHaveBeenCalledTimes(2));
      const seat1Name = simulateSeedSpeaker.mock.calls.find((call) => call[3] === 1)?.[2] as string;

      // A real later replacement swaps the *live* authoritative occupant
      // for someone bootstrap never intended — the frozen bootstrap
      // fields must not be re-derived from this.
      fetchDebugSnapshotState.mockResolvedValueOnce({
        fetchedAt: new Date().toISOString(),
        round: { round_number: 2, phase: "active", ends_at: new Date().toISOString() },
        seats: [{ seat_number: 1, display_name: "Someone Else Entirely", identity_kind: "guest", disconnected: false }],
        pendingRequests: [],
      });

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain(`Initial bootstrap Seat 1 authoritative: ${seat1Name}`);
      expect(copied).toContain("Seat 1: Someone Else Entirely (guest)"); // the unrelated, always-live section
    });
  });

  describe("canonical stage speaker state reconciliation after bootstrap (issue #21, sixteenth corrective pass)", () => {
    it("calls refetchSpeakers('bootstrap') after each seat's own authoritative confirmation — the canonical client speaker state, not a simulator-only duplicate", async () => {
      const refetchSpeakers = vi.fn().mockResolvedValue([]);
      render(<SessionSimulatorPanel {...baseProps} refetchSpeakers={refetchSpeakers} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
      // At least once per seat, tagged "bootstrap" — never any other reason.
      expect(refetchSpeakers.mock.calls.filter((call) => call[0] === "bootstrap").length).toBeGreaterThanOrEqual(2);
      expect(refetchSpeakers.mock.calls.every((call) => call[0] === "bootstrap")).toBe(true);
    });

    it("verifies convergence before declaring READY — when refetchSpeakers immediately reflects both seats, startup completes normally with no added delay", async () => {
      const refetchSpeakers = vi.fn(async () => [
        speaker({ id: "conv-1", seat_number: 1, guest_id: "will-be-seat1", display_name: "Seat One" }),
        speaker({ id: "conv-2", seat_number: 2, guest_id: "will-be-seat2", display_name: "Seat Two" }),
      ]);
      // The mock's own returned guest ids won't literally match the
      // randomly-generated seed identities' own ids — this test is about
      // the *no-refetchSpeakers-wired* / *always-converges* shape rather
      // than an exact-identity match, covered by the real-database test
      // in simulator-startup.test.ts. Here, simulateSeedSpeaker's own
      // mock already reports success, and this test only asserts
      // refetchSpeakers was actually consulted and startup still reaches
      // Running promptly.
      render(<SessionSimulatorPanel {...baseProps} refetchSpeakers={refetchSpeakers} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled(), { timeout: 3000 });
      expect(refetchSpeakers).toHaveBeenCalled();
    });

    it("CLIENT SYNC: when the database confirms both seats but refetchSpeakers never reflects it, startup reports a distinct CLIENT SYNC failure — never a generic or bootstrap-failure message", async () => {
      // refetchSpeakers always resolves successfully, but its own
      // returned rows never actually show the intended identities seated
      // — simulating the canonical client state genuinely failing to
      // converge despite bootstrap's own authoritative success.
      const refetchSpeakers = vi.fn().mockResolvedValue([]);
      render(<SessionSimulatorPanel {...baseProps} refetchSpeakers={refetchSpeakers} />);
      fireEvent.click(screen.getByTestId("sim-start"));

      await waitFor(() => expect(screen.getByTestId("sim-startup-phase")).toHaveTextContent("Failed"), { timeout: 5000 });
      expect(screen.getByTestId("sim-log")).toHaveTextContent("CLIENT SYNC");
      expect(screen.getByTestId("sim-log")).toHaveTextContent("reporting distinctly from a bootstrap failure");
      expect(screen.getByTestId("sim-startup-error")).toHaveTextContent("Canonical client speaker state reconciliation");
      expect(screen.getByTestId("sim-startup-error")).toHaveTextContent("database already confirms both seats");
      // Never even attempted a real Request-to-Speak/RTS wait — the
      // retired Case B path — this is purely a client-sync reporting gap.
      expect(simulateRequestToSpeak).not.toHaveBeenCalled();
    });

    it("without refetchSpeakers wired at all (standalone/test use), startup completes normally — nothing to verify, never blocks", async () => {
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());
    });

    it("the debug snapshot's new AUTHORITATIVE SPEAKER STATE / CANONICAL CLIENT SPEAKER STATE / SPEAKER SYNC sections render the wired diagnostics", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      const getSpeakerSyncDiagnostics = vi.fn(() => ({
        channelStatus: "SUBSCRIBED",
        lastSubscribedAt: "2026-09-01T00:00:00.000Z",
        lastRealtimeEventAt: null,
        lastReconcileStartedAt: "2026-09-01T00:00:01.000Z",
        lastReconcileCompletedAt: "2026-09-01T00:00:01.500Z",
        lastReconcileReason: "bootstrap" as const,
        lastReconcileResult: "changed" as const,
        lastMutationSource: "reconcile" as const,
      }));
      fetchDebugSnapshotState.mockResolvedValueOnce({
        fetchedAt: new Date().toISOString(),
        round: { round_number: 1, phase: "active", ends_at: new Date().toISOString() },
        seats: [{ seat_number: 1, display_name: "Auth Speaker", identity_kind: "guest", disconnected: false }],
        pendingRequests: [],
      });
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "client-1", seat_number: 1, display_name: "Client Speaker" })]}
          getSpeakerSyncDiagnostics={getSpeakerSyncDiagnostics}
        />,
      );

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalled());
      const copied = writeText.mock.calls[0][0];

      expect(copied).toContain("AUTHORITATIVE SPEAKER STATE");
      expect(copied).toContain("Seat 1: Auth Speaker");
      expect(copied).toContain("CANONICAL CLIENT SPEAKER STATE");
      expect(copied).toContain("Seat 1: Client Speaker");
      expect(copied).toContain("SPEAKER SYNC");
      expect(copied).toContain("Realtime channel status: SUBSCRIBED");
      expect(copied).toContain("Last SUBSCRIBED at: 2026-09-01T00:00:00.000Z");
      expect(copied).toContain("Last speaker Realtime event at: never");
      expect(copied).toContain("Last authoritative speaker reconcile started: 2026-09-01T00:00:01.000Z");
      expect(copied).toContain("Last authoritative speaker reconcile completed: 2026-09-01T00:00:01.500Z");
      expect(copied).toContain("Reconcile reason: bootstrap");
      expect(copied).toContain("Reconcile result: changed");
      expect(copied).toContain("Last client speaker-state mutation source: reconcile");
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

  // Issue #21, ninth corrective pass, Sections 12-13: "Selection
  // Forensics" — collapsed by default, expands to show the exact RTS
  // ranking at the selection boundary (frozen_rank/frozen_vote_count)
  // separately from the current live ranking, plus the expected vs.
  // actually-reserved winner and a specific WAITING AT/BLOCKED BECAUSE
  // reason.
  describe("Selection Forensics (issue #21, ninth corrective pass, Sections 12-13)", () => {
    it("is collapsed by default, and expands on tap", () => {
      render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ id: "r1", guest_id: "g1", frozen_rank: 1, frozen_vote_count: 3 })]} />);
      expect(screen.queryByTestId("sim-forensics-1")).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId("sim-forensics-toggle"));
      expect(screen.getByTestId("sim-forensics-1")).toBeInTheDocument();
    });

    it("shows the ranking at the selection boundary (frozen) per seat, the live replacement queue once at the top, and names the expected winner from the boundary ranking specifically", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          // Issue #21, tenth corrective pass: the Live Replacement Queue
          // trusts caller order the same way Top Speaker Requests
          // already does — in production `useActiveSpeakerRequests`
          // delivers `pendingRequests` pre-sorted by live voteCount, so
          // this fixture supplies that same already-sorted order
          // directly (Later Riser first — 9 votes, gained *after* the
          // boundary — ahead of Boundary Winner's 5).
          pendingRequests={[
            request({ id: "r2", guest_id: "g2", message_id: "m2", frozen_rank: 2, frozen_vote_count: 2, voteCount: 9 }),
            request({ id: "r1", guest_id: "g1", message_id: "m1", frozen_rank: 1, frozen_vote_count: 5, voteCount: 5 }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Boundary Winner", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Later Riser", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      fireEvent.click(screen.getByTestId("sim-forensics-toggle"));
      const seat1 = screen.getByTestId("sim-forensics-1");
      expect(seat1).toHaveTextContent("RTS ranking at boundary:");
      expect(seat1).toHaveTextContent("#1 Boundary Winner — 5");
      expect(screen.getByTestId("sim-forensics-expected-1")).toHaveTextContent("Boundary Winner");

      // The live replacement queue — shown once, not duplicated per
      // seat — reflects the *current* order (voteCount), which can
      // differ from the frozen boundary ranking above it.
      const queueRows = screen.getAllByTestId("sim-queue-row");
      expect(queueRows[0]).toHaveTextContent("#1 Later Riser — 9");
      expect(queueRows[1]).toHaveTextContent("#2 Boundary Winner — 5");
    });

    it("shows Established mode and Selected/Reserved per seat", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          stageRound={stageRoundFixture({ round_number: 2, phase: "active" })}
          pendingRequests={[request({ id: "r1", guest_id: "g1", frozen_rank: 1, frozen_vote_count: 5, is_current_candidate: true, reserved_seat_number: 1 })]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-forensics-toggle"));
      expect(screen.getByTestId("sim-established-mode")).toHaveTextContent("yes");
      expect(screen.getByTestId("sim-selected-reserved-1")).not.toHaveTextContent("none");
      expect(screen.getByTestId("sim-selected-reserved-2")).toHaveTextContent("none");
    });

    it("flags when the reserved candidate differs from the expected boundary winner", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", frozen_rank: 1, frozen_vote_count: 5 }),
            request({ id: "r2", guest_id: "g2", frozen_rank: 2, frozen_vote_count: 2, is_current_candidate: true, reserved_seat_number: 1 }),
          ]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-forensics-toggle"));
      expect(screen.getByTestId("sim-forensics-reserved-1")).toHaveTextContent("different from expected winner");
    });

    it("does not flag a mismatch when the reserved candidate matches the expected boundary winner", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[request({ id: "r1", guest_id: "g1", frozen_rank: 1, frozen_vote_count: 5, is_current_candidate: true, reserved_seat_number: 1 })]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-forensics-toggle"));
      expect(screen.getByTestId("sim-forensics-reserved-1")).not.toHaveTextContent("different from expected winner");
    });

    it("shows WAITING AT / BLOCKED BECAUSE for a vacant seat, and nothing for an occupied one", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "s1", seat_number: 1 })]}
          pendingRequests={[request({ id: "r1", guest_id: "g1" })]}
        />,
      );
      fireEvent.click(screen.getByTestId("sim-forensics-toggle"));
      expect(screen.queryByTestId("sim-forensics-blocked-1")).not.toBeInTheDocument();
      expect(screen.getByTestId("sim-forensics-blocked-2")).toHaveTextContent("WAITING AT / BLOCKED BECAUSE:");
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

    // Issue #21, tenth corrective pass, Sections 26-27: a real-device
    // report found a simulator-generated comment/request still visible
    // after Reset — traced to a real ordering race (a scheduled
    // background write already in flight, landing in the database
    // *after* Reset's own DELETE already ran), not the guest-id list
    // being wrong. Fixed with a second, delayed sweep — same call, same
    // id snapshot, ~2s later, silent unless it actually finds something.
    it("a delayed follow-up sweep catches a straggler write that lands after the first Reset pass, and reports it in the log", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      resetSimulatorSession.mockResolvedValueOnce({
        messagesDeleted: 0,
        reactionsDeleted: 0,
        speakersDeleted: 0,
        requestVotesDeleted: 0,
        roundVotesDeleted: 0,
      });
      resetSimulatorSession.mockResolvedValueOnce({
        messagesDeleted: 1,
        reactionsDeleted: 0,
        speakersDeleted: 0,
        requestVotesDeleted: 0,
        roundVotesDeleted: 0,
      });

      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await vi.waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-reset"));
      await vi.waitFor(() => expect(resetSimulatorSession).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("sim-log")).not.toHaveTextContent("follow-up");

      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(resetSimulatorSession).toHaveBeenCalledTimes(2));
      // Same captured guest-id snapshot both times.
      expect(resetSimulatorSession.mock.calls[1][1]).toEqual(resetSimulatorSession.mock.calls[0][1]);
      expect(screen.getByTestId("sim-log")).toHaveTextContent("follow-up");
      expect(screen.getByTestId("sim-log")).toHaveTextContent("caught 1 straggler row(s)");
    });

    it("the delayed follow-up sweep stays silent when it finds nothing (the ordinary, no-race case)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-start"));
      await vi.waitFor(() => expect(screen.getByTestId("sim-stop")).not.toBeDisabled());

      fireEvent.click(screen.getByTestId("sim-reset"));
      await vi.waitFor(() => expect(resetSimulatorSession).toHaveBeenCalledTimes(1));

      await vi.advanceTimersByTimeAsync(2000);
      await vi.waitFor(() => expect(resetSimulatorSession).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId("sim-log")).not.toHaveTextContent("follow-up");
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

  // Issue #21, tenth corrective pass, Sections 1-25: "Copy Debug
  // Snapshot" — a fresh authoritative read combined with this tab's own
  // client state, copied as human-readable text, read-only.
  describe("Copy Debug Snapshot (issue #21, tenth/eleventh corrective passes — two-phase T0/T1 capture)", () => {
    function mockClipboard() {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      return writeText;
    }

    it("performs a fresh authoritative read and copies a human-readable snapshot, showing brief confirmation", async () => {
      const writeText = mockClipboard();
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "s1", seat_number: 1 })]}
          pendingRequests={[request({ id: "r1", guest_id: "g1" })]}
        />,
      );

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));

      await waitFor(() => expect(fetchDebugSnapshotState).toHaveBeenCalledWith(baseProps.eventId));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain("VIRTUAL STAGE DEBUG SNAPSHOT");
      expect(copied).toContain("Capture tap time (T0):");
      expect(copied).toContain("CLIENT STATE AT TAP (T0)");
      expect(copied).toContain("AUTHORITATIVE STATE AT READ (T1)");
      expect(copied).toContain("Authoritative fetch latency (T1 - T0):");
      expect(copied).toContain("STATE CHANGED DURING CAPTURE:");
      expect(copied).toContain("Authoritative seats:");
      expect(copied).toContain("Live RTS ranking (authoritative):");
      expect(copied).toContain("Selected / Reserved (client-observed):");
      expect(copied).toContain("STATE MISMATCHES");
      expect(copied).toContain("RESET / SIMULATOR OWNERSHIP");

      await waitFor(() => expect(screen.getByTestId("sim-copy-debug-snapshot")).toHaveTextContent("Copied ✓"));
    });

    it("captures the prospective next/second candidate in the T0 client section", async () => {
      const writeText = mockClipboard();
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", message_id: "m1", voteCount: 3 }),
            request({ id: "r2", guest_id: "g2", message_id: "m2", voteCount: 1 }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Candidate A", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Candidate B", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain("Prospective next: Candidate A — 3 votes (not reserved)");
      expect(copied).toContain("Prospective second: Candidate B — 1 votes");
    });

    it("shows immediate 'Capturing…' feedback the instant the tap registers, before the authoritative fetch resolves", async () => {
      const writeText = mockClipboard();
      let resolveFetch!: (v: Awaited<ReturnType<typeof fetchDebugSnapshotState>>) => void;
      fetchDebugSnapshotState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );
      render(<SessionSimulatorPanel {...baseProps} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(screen.getByTestId("sim-copy-debug-snapshot")).toHaveTextContent("Capturing…"));

      resolveFetch({ fetchedAt: new Date().toISOString(), round: null, seats: [], pendingRequests: [] });
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    });

    it("a second tap while a capture is already in flight is a no-op, not a second overlapping capture", async () => {
      const writeText = mockClipboard();
      let resolveFetch!: (v: Awaited<ReturnType<typeof fetchDebugSnapshotState>>) => void;
      fetchDebugSnapshotState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );
      render(<SessionSimulatorPanel {...baseProps} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot")); // ignored — a capture is already in flight
      resolveFetch({ fetchedAt: new Date().toISOString(), round: null, seats: [], pendingRequests: [] });

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(fetchDebugSnapshotState).toHaveBeenCalledTimes(1);
    });

    it("reports STATE CHANGED DURING CAPTURE when props change while the authoritative fetch is in flight", async () => {
      const writeText = mockClipboard();
      let resolveFetch!: (v: Awaited<ReturnType<typeof fetchDebugSnapshotState>>) => void;
      fetchDebugSnapshotState.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      );
      const { rerender } = render(<SessionSimulatorPanel {...baseProps} speakers={[]} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      // A seat becomes occupied while the fetch is still in flight — the
      // T0 client section must not reflect this; the report must flag it.
      rerender(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", seat_number: 1 })]} />);
      resolveFetch({ fetchedAt: new Date().toISOString(), round: null, seats: [], pendingRequests: [] });

      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain("Seats occupied: (none)"); // T0 — unchanged by the later rerender
      expect(copied).toContain("STATE CHANGED DURING CAPTURE: yes");
    });

    it("flags a client/authoritative seat-occupancy mismatch", async () => {
      const writeText = mockClipboard();
      fetchDebugSnapshotState.mockResolvedValueOnce({
        fetchedAt: new Date().toISOString(),
        round: null,
        seats: [], // authoritative: nothing occupied
        pendingRequests: [],
      });
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", seat_number: 1 })]} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain("Seat 1: client says occupied, database says vacant");
    });

    it("reports no mismatches when client and authoritative state agree", async () => {
      const writeText = mockClipboard();
      fetchDebugSnapshotState.mockResolvedValueOnce({
        fetchedAt: new Date().toISOString(),
        round: null,
        seats: [{ seat_number: 1, display_name: "Someone", identity_kind: "guest", disconnected: false }],
        pendingRequests: [],
      });
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", seat_number: 1 })]} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      expect(writeText.mock.calls[0][0]).toContain("none detected");
    });

    it("still copies the T0 client snapshot, clearly marked, when the authoritative fetch fails", async () => {
      const writeText = mockClipboard();
      fetchDebugSnapshotState.mockRejectedValueOnce(new Error("network blip"));
      render(<SessionSimulatorPanel {...baseProps} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain("AUTHORITATIVE FETCH: FAILED — network blip");
      expect(copied).toContain("CLIENT STATE AT TAP (T0)"); // never lost, even though T1 failed
      expect(copied).not.toContain("undefined");
    });

    it("still copies the T0 client snapshot when the authoritative fetch times out, and says so explicitly", async () => {
      const writeText = mockClipboard();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      fetchDebugSnapshotState.mockImplementationOnce(() => new Promise(() => {})); // never resolves
      render(<SessionSimulatorPanel {...baseProps} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await vi.advanceTimersByTimeAsync(4500);
      await vi.waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      const copied = writeText.mock.calls[0][0];
      expect(copied).toContain("AUTHORITATIVE FETCH: TIMED OUT");
      expect(copied).toContain("CLIENT STATE AT TAP (T0)");
    });

    it("falls back to a visible, selectable text panel — never a silent no-op — when the clipboard write itself fails, without losing the capture", async () => {
      const writeText = vi.fn<(text: string) => Promise<void>>(async () => {
        throw new Error("clipboard permission denied");
      });
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(<SessionSimulatorPanel {...baseProps} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(screen.getByTestId("sim-copy-debug-snapshot")).toHaveTextContent("See below to copy"));

      // The fallback panel opens automatically — the capture is not lost.
      const fallback = screen.getByTestId("sim-snapshot-text") as HTMLTextAreaElement;
      expect(fallback.value).toContain("VIRTUAL STAGE DEBUG SNAPSHOT");
    });

    it("a hung clipboard write (bounded timeout) still surfaces the fallback panel instead of staying stuck", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const writeText = vi.fn<(text: string) => Promise<void>>(() => new Promise(() => {})); // never resolves
      Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
      render(<SessionSimulatorPanel {...baseProps} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await vi.advanceTimersByTimeAsync(3500);
      await vi.waitFor(() => expect(screen.getByTestId("sim-copy-debug-snapshot")).toHaveTextContent("See below to copy"));
    });

    it("logs a DEBUG CAPTURE TAP marker immediately, for temporal ordering against later transitions", async () => {
      const writeText = mockClipboard();
      render(<SessionSimulatorPanel {...baseProps} />);
      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      expect(screen.getByTestId("sim-log")).toHaveTextContent("DEBUG CAPTURE TAP");
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    });

    it("is read-only — never triggers selection, claims, votes, or Reset as a side effect", async () => {
      const writeText = mockClipboard();
      render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ id: "r1", guest_id: "g1" })]} />);

      fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

      expect(simulateAdvanceSelection).not.toHaveBeenCalled();
      expect(resetSimulatorSession).not.toHaveBeenCalled();
      expect(simulateRoundVote).not.toHaveBeenCalled();
      expect(simulateRequestVote).not.toHaveBeenCalled();
    });

    // Issue #21, twelfth corrective pass: a real-device capture proved
    // the room could sit in established + fillable-vacant + eligible-
    // RTS + no-reservation with nothing in the snapshot saying so
    // directly.
    describe("VACANCY DIAGNOSTICS / INVARIANT STATUS (issue #21, twelfth corrective pass)", () => {
      it("reports VIOLATION for a fillable vacant seat with eligible RTS candidates but no reservation", async () => {
        const writeText = mockClipboard();
        fetchDebugSnapshotState.mockResolvedValueOnce({
          fetchedAt: new Date().toISOString(),
          round: { round_number: 1, phase: "awaiting_pairing", ends_at: new Date().toISOString() },
          seats: [{ seat_number: 1, display_name: "Nimble Owl", identity_kind: "guest", disconnected: false }],
          pendingRequests: [
            { id: "r1", display_name: "Dapper Rabbit", identity_kind: "guest", vote_count: 3, is_current_candidate: false, reserved_seat_number: null, frozen_rank: null, selection_failed: false },
          ],
        });
        render(
          <SessionSimulatorPanel
            {...baseProps}
            stageRound={stageRoundFixture({ round_number: 1, phase: "awaiting_pairing" })}
            speakers={[speaker({ id: "s1", seat_number: 1 })]}
            pendingRequests={[request({ id: "r1", guest_id: "g1", voteCount: 3 })]}
          />,
        );

        fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        const copied = writeText.mock.calls[0][0];
        expect(copied).toContain("VACANCY DIAGNOSTICS");
        expect(copied).toContain("Seat 2 (authoritative):");
        expect(copied).toContain("vacant: yes");
        expect(copied).toContain("eligible RTS: 1");
        expect(copied).toContain("reservation: none");
        expect(copied).toContain("INVARIANT STATUS: VIOLATION");
        expect(copied).toContain("BLOCKED BECAUSE: established room has a fillable vacant seat and 1 eligible RTS candidate(s) but no valid reservation");
      });

      it("reports OK, not a violation, when the vacant seat's #1 candidate is actually reserved", async () => {
        const writeText = mockClipboard();
        fetchDebugSnapshotState.mockResolvedValueOnce({
          fetchedAt: new Date().toISOString(),
          round: { round_number: 1, phase: "active", ends_at: new Date().toISOString() },
          seats: [{ seat_number: 1, display_name: "Nimble Owl", identity_kind: "guest", disconnected: false }],
          pendingRequests: [
            { id: "r1", display_name: "Dapper Rabbit", identity_kind: "guest", vote_count: 3, is_current_candidate: true, reserved_seat_number: 2, frozen_rank: 1, selection_failed: false },
          ],
        });
        render(
          <SessionSimulatorPanel
            {...baseProps}
            stageRound={stageRoundFixture({ round_number: 1 })}
            speakers={[speaker({ id: "s1", seat_number: 1 })]}
            pendingRequests={[request({ id: "r1", guest_id: "g1", voteCount: 3, is_current_candidate: true, reserved_seat_number: 2 })]}
          />,
        );

        fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        const copied = writeText.mock.calls[0][0];
        expect(copied).toContain("reservation: Dapper Rabbit");
        expect(copied).toContain("INVARIANT STATUS: OK");
        expect(copied).not.toContain("VIOLATION");
      });

      it("does not flag a violation for a vacant seat with zero eligible RTS candidates", async () => {
        const writeText = mockClipboard();
        fetchDebugSnapshotState.mockResolvedValueOnce({
          fetchedAt: new Date().toISOString(),
          round: { round_number: 1, phase: "awaiting_pairing", ends_at: new Date().toISOString() },
          seats: [{ seat_number: 1, display_name: "Nimble Owl", identity_kind: "guest", disconnected: false }],
          pendingRequests: [],
        });
        render(
          <SessionSimulatorPanel
            {...baseProps}
            stageRound={stageRoundFixture({ round_number: 1, phase: "awaiting_pairing" })}
            speakers={[speaker({ id: "s1", seat_number: 1 })]}
            pendingRequests={[]}
          />,
        );

        fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        const copied = writeText.mock.calls[0][0];
        expect(copied).toContain("eligible RTS: 0");
        expect(copied).toContain("not a violation");
        expect(copied).not.toContain("VIOLATION");
      });

      it("flags an RTS vote-count mismatch between client and authoritative state — never silently 'none detected'", async () => {
        const writeText = mockClipboard();
        fetchDebugSnapshotState.mockResolvedValueOnce({
          fetchedAt: new Date().toISOString(),
          round: null,
          seats: [],
          pendingRequests: [
            { id: "r1", display_name: "Dapper Rabbit", identity_kind: "guest", vote_count: 3, is_current_candidate: false, reserved_seat_number: null, frozen_rank: null, selection_failed: false },
          ],
        });
        render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ id: "r1", guest_id: "g1", voteCount: 4 })]} />);

        fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        const copied = writeText.mock.calls[0][0];
        expect(copied).toContain("RTS COUNT MISMATCH");
        expect(copied).toContain("Candidate: Dapper Rabbit");
        expect(copied).toContain("Client votes: 4");
        expect(copied).toContain("Database votes: 3");
        expect(copied).toContain("Delta: +1");
        expect(copied).toContain("Client rank: #1");
        expect(copied).toContain("Database rank: #1");
        expect(copied).not.toContain("RTS COUNT MISMATCH: none detected");
      });

      it("calls out a PROSPECTIVE RANKING MISMATCH when the client and authoritative rank for the same candidate disagree, not just the raw count", async () => {
        const writeText = mockClipboard();
        fetchDebugSnapshotState.mockResolvedValueOnce({
          fetchedAt: new Date().toISOString(),
          round: null,
          seats: [],
          pendingRequests: [
            { id: "r1", display_name: "Candidate A", identity_kind: "guest", vote_count: 2, is_current_candidate: false, reserved_seat_number: null, frozen_rank: null, selection_failed: false },
            { id: "r2", display_name: "Candidate B", identity_kind: "guest", vote_count: 1, is_current_candidate: false, reserved_seat_number: null, frozen_rank: null, selection_failed: false },
          ],
        });
        // Client (stale) still ranks B above A — the authoritative read
        // above has A #1, B #2, but the client's own accumulated counts
        // put B first.
        render(
          <SessionSimulatorPanel
            {...baseProps}
            pendingRequests={[
              request({ id: "r2", guest_id: "g2", voteCount: 3 }),
              request({ id: "r1", guest_id: "g1", voteCount: 1 }),
            ]}
          />,
        );

        fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        const copied = writeText.mock.calls[0][0];
        expect(copied).toContain("PROSPECTIVE RANKING MISMATCH");
      });

      it("reports RTS COUNT MISMATCH: none detected when client and authoritative vote counts fully agree", async () => {
        const writeText = mockClipboard();
        fetchDebugSnapshotState.mockResolvedValueOnce({
          fetchedAt: new Date().toISOString(),
          round: null,
          seats: [],
          pendingRequests: [
            { id: "r1", display_name: "Dapper Rabbit", identity_kind: "guest", vote_count: 3, is_current_candidate: false, reserved_seat_number: null, frozen_rank: null, selection_failed: false },
          ],
        });
        render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ id: "r1", guest_id: "g1", voteCount: 3 })]} />);

        fireEvent.click(screen.getByTestId("sim-copy-debug-snapshot"));
        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

        expect(writeText.mock.calls[0][0]).toContain("RTS COUNT MISMATCH: none detected");
      });
    });
  });

  // Issue #21, twelfth corrective pass: "OBSERVED" transition logging —
  // meaningful state transitions this tab actually observed, regardless
  // of what caused them (a SIM button, a natural production timer, or
  // anything else) — a real-device debug snapshot's own activity log
  // previously only ever recorded SIM-button-initiated actions.
  describe("OBSERVED transition logging (issue #21, twelfth corrective pass)", () => {
    it("logs a seat vacating, with the previous occupant's name, regardless of what caused it", () => {
      const { rerender } = render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", seat_number: 2, display_name: "Eager Otter" })]} />);
      rerender(<SessionSimulatorPanel {...baseProps} speakers={[]} />);
      expect(screen.getByTestId("sim-log")).toHaveTextContent("OBSERVED: Seat 2 vacated (was Eager Otter)");
    });

    it("logs a seat becoming occupied", () => {
      const { rerender } = render(<SessionSimulatorPanel {...baseProps} speakers={[]} />);
      rerender(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", seat_number: 1, display_name: "Nimble Owl" })]} />);
      expect(screen.getByTestId("sim-log")).toHaveTextContent("OBSERVED: Seat 1 occupied (Nimble Owl)");
    });

    it("does not log anything spurious on initial mount", () => {
      render(<SessionSimulatorPanel {...baseProps} speakers={[speaker({ id: "s1", seat_number: 1 })]} />);
      expect(screen.queryByTestId("sim-log")).not.toHaveTextContent("OBSERVED");
    });

    it("logs a reservation appearing and clearing", () => {
      const { rerender } = render(<SessionSimulatorPanel {...baseProps} pendingRequests={[]} />);
      rerender(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[request({ id: "r1", guest_id: "g1", message_id: "m1", is_current_candidate: true, reserved_seat_number: 2 })]}
          messages={[{ id: "m1", author_display_name: "Dapper Rabbit", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true }] as LobbyMessage[]}
        />,
      );
      expect(screen.getByTestId("sim-log")).toHaveTextContent("OBSERVED: Seat 2 reservation → Dapper Rabbit");

      rerender(<SessionSimulatorPanel {...baseProps} pendingRequests={[]} />);
      expect(screen.getByTestId("sim-log")).toHaveTextContent("OBSERVED: Seat 2 reservation cleared (was Dapper Rabbit)");
    });

    it("logs a round phase transition", () => {
      const { rerender } = render(<SessionSimulatorPanel {...baseProps} stageRound={stageRoundFixture({ phase: "active" })} />);
      rerender(<SessionSimulatorPanel {...baseProps} stageRound={stageRoundFixture({ phase: "awaiting_pairing" })} />);
      expect(screen.getByTestId("sim-log")).toHaveTextContent("OBSERVED: Round phase active → awaiting_pairing");
    });
  });

  // Issue #21, eleventh corrective pass, Sections 1-6: "Next Speaker
  // Candidate" — the PROSPECTIVE #1-ranked eligible RTS requester,
  // reactive to live vote changes, visible without any vacancy or
  // reservation.
  describe("Next Speaker Candidate (issue #21, eleventh corrective pass)", () => {
    it("shows no eligible candidates when the RTS pool is empty", () => {
      render(<SessionSimulatorPanel {...baseProps} pendingRequests={[]} />);
      expect(screen.getByTestId("sim-prospective-next")).toHaveTextContent("No eligible RTS candidates");
    });

    it("shows the live #1/#2 ranking as prospective — not reserved — even with both seats occupied and nothing frozen", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          speakers={[speaker({ id: "s1", seat_number: 1 }), speaker({ id: "s2", seat_number: 2 })]}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", message_id: "m1", voteCount: 3 }),
            request({ id: "r2", guest_id: "g2", message_id: "m2", voteCount: 2 }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Candidate A", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Candidate B", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      expect(screen.getByTestId("sim-prospective-next")).toHaveTextContent("Candidate A — 3 votes");
      expect(screen.getByTestId("sim-prospective-next")).toHaveTextContent("prospective — not reserved");
      expect(screen.getByTestId("sim-prospective-second")).toHaveTextContent("Candidate B — 2 votes");
      expect(screen.getByTestId("sim-prospective-both")).toHaveTextContent("Candidate A + Candidate B");
      // Nothing was reserved merely by being displayed here.
      expect(screen.getByTestId("sim-selection-status-1")).toHaveTextContent("occupied");
    });

    it("reactively reorders when live votes change — the #1 candidate changes, nothing is reserved", () => {
      const { rerender } = render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", message_id: "m1", voteCount: 3 }),
            request({ id: "r2", guest_id: "g2", message_id: "m2", voteCount: 2 }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Candidate A", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Candidate B", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      expect(screen.getByTestId("sim-prospective-next")).toHaveTextContent("Candidate A");

      // B overtakes A — the live ranking (already sorted the way
      // useActiveSpeakerRequests delivers it) reflects the new order.
      rerender(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r2", guest_id: "g2", message_id: "m2", voteCount: 4 }),
            request({ id: "r1", guest_id: "g1", message_id: "m1", voteCount: 3 }),
          ]}
          messages={
            [
              { id: "m1", author_display_name: "Candidate A", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true },
              { id: "m2", author_display_name: "Candidate B", author_profile_id: null, author_guest_id: "g2", body: "", created_at: "", is_speaker_request: true },
            ] as LobbyMessage[]
          }
        />,
      );
      expect(screen.getByTestId("sim-prospective-next")).toHaveTextContent("Candidate B — 4 votes");
      expect(screen.getByTestId("sim-prospective-second")).toHaveTextContent("Candidate A — 3 votes");
      expect(screen.getByTestId("sim-prospective-next")).toHaveTextContent("prospective — not reserved");
    });

    it("shows 'reserved' rather than 'prospective' when the #1 candidate is already authoritatively reserved for a real vacancy", () => {
      render(
        <SessionSimulatorPanel
          {...baseProps}
          pendingRequests={[
            request({ id: "r1", guest_id: "g1", message_id: "m1", voteCount: 3, is_current_candidate: true, reserved_seat_number: 1 }),
          ]}
          messages={
            [{ id: "m1", author_display_name: "Candidate A", author_profile_id: null, author_guest_id: "g1", body: "", created_at: "", is_speaker_request: true }] as LobbyMessage[]
          }
        />,
      );
      expect(screen.getByTestId("sim-prospective-next")).toHaveTextContent("reserved (Seat 1)");
      expect(screen.getByTestId("sim-prospective-next")).not.toHaveTextContent("prospective — not reserved");
    });

    it("does not show 'if both replaced' with only one eligible candidate", () => {
      render(<SessionSimulatorPanel {...baseProps} pendingRequests={[request({ id: "r1", guest_id: "g1" })]} />);
      expect(screen.queryByTestId("sim-prospective-both")).not.toBeInTheDocument();
      expect(screen.queryByTestId("sim-prospective-second")).not.toBeInTheDocument();
    });
  });
});
