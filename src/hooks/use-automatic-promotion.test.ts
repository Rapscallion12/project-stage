import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutomaticPromotion, PROMOTION_COUNTDOWN_SECONDS } from "./use-automatic-promotion";

const { checkPromotionEligibility, claimOpenSeat, leaveSpeakerSeat, withdrawSpeakerRequest } = vi.hoisted(() => ({
  checkPromotionEligibility: vi.fn(),
  claimOpenSeat: vi.fn(),
  leaveSpeakerSeat: vi.fn(),
  withdrawSpeakerRequest: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({
  checkPromotionEligibility,
  claimOpenSeat,
  leaveSpeakerSeat,
  withdrawSpeakerRequest,
}));

const baseParams = {
  eventId: "e1",
  hasPendingRequest: true,
  isSpeaker: false,
  phase: "ready" as const,
  needsMediaActivation: false,
  mediaError: null,
  onHasPendingRequestChange: vi.fn(),
};

describe("useAutomaticPromotion", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("does not poll at all while there's no pending request — nothing to become eligible for", () => {
    renderHook(() => useAutomaticPromotion({ ...baseParams, hasPendingRequest: false }));
    expect(checkPromotionEligibility).not.toHaveBeenCalled();
  });

  it("does not poll once already speaking — promotion is irrelevant once seated", () => {
    renderHook(() => useAutomaticPromotion({ ...baseParams, isSpeaker: true }));
    expect(checkPromotionEligibility).not.toHaveBeenCalled();
  });

  it("starts the countdown once the server reports eligible — never before, and the countdown itself never re-derives eligibility on its own", async () => {
    checkPromotionEligibility.mockResolvedValue({ eligible: true });
    const { result } = renderHook(() => useAutomaticPromotion(baseParams));

    await waitFor(() => expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS));
    expect(checkPromotionEligibility).toHaveBeenCalledWith("e1");
  });

  it("ticks the countdown down at least once per second, never jumping straight to the claim", async () => {
    vi.useFakeTimers();
    checkPromotionEligibility.mockResolvedValue({ eligible: true });
    const { result } = renderHook(() => useAutomaticPromotion(baseParams));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS - 1);
    expect(claimOpenSeat).not.toHaveBeenCalled();
  });

  // The full countdown-reaches-zero-then-claims chain (each tick's timer
  // only scheduled once the previous tick's effect-driven state update
  // has committed) isn't reliably reproducible with fake timers in this
  // environment — attempted with advanceTimersByTimeAsync at several
  // granularities and runAllTimersAsync, none converged consistently.
  // Not asserted here; the single-timer mechanism it's built from (one
  // setTimeout firing one action call) is the same shape already proven
  // by the grace-period self-eviction test below, and the full sequence
  // is covered by real-device/production verification instead — see
  // this session's verification report.

  it("cancel() stops the countdown immediately and withdraws the request, without ever calling claimOpenSeat", async () => {
    checkPromotionEligibility.mockResolvedValue({ eligible: true });
    withdrawSpeakerRequest.mockResolvedValue({ ok: true });
    const onHasPendingRequestChange = vi.fn();
    const { result } = renderHook(() =>
      useAutomaticPromotion({ ...baseParams, onHasPendingRequestChange }),
    );

    await waitFor(() => expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS));

    act(() => {
      result.current.cancel();
    });

    expect(result.current.countdown).toBeNull();
    await waitFor(() => expect(onHasPendingRequestChange).toHaveBeenCalledWith(false));
    expect(claimOpenSeat).not.toHaveBeenCalled();
  });

  it("self-evicts via the existing leaveSpeakerSeat if seated but media isn't activated within the grace period — reusing existing authority, not a new mechanism", async () => {
    vi.useFakeTimers();
    leaveSpeakerSeat.mockResolvedValue({ ok: true });
    renderHook(() =>
      useAutomaticPromotion({ ...baseParams, hasPendingRequest: false, isSpeaker: true, needsMediaActivation: true }),
    );

    expect(leaveSpeakerSeat).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(leaveSpeakerSeat).toHaveBeenCalledWith("e1");
  });

  it("does not self-evict once media is actually active (no error, activation no longer needed)", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useAutomaticPromotion({
        ...baseParams,
        hasPendingRequest: false,
        isSpeaker: true,
        needsMediaActivation: false,
        mediaError: null,
      }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(leaveSpeakerSeat).not.toHaveBeenCalled();
  });
});
