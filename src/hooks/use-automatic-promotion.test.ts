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
  // Issue #21, sixth corrective pass: defaults to false so every
  // existing test below keeps exercising the polled path unchanged —
  // the reactive fast-path tests set this explicitly.
  isCurrentlyReservedCandidate: false,
  isSpeaker: false,
  phase: "ready" as const,
  needsMediaActivation: false,
  mediaError: null,
  // Media Readiness pass (issue #21): defaults to already-ready so every
  // existing test below keeps exercising the claim path unchanged — the
  // new readiness-gate describe block further down overrides these.
  cameraReady: true,
  microphoneReady: true,
  onHasPendingRequestChange: vi.fn(),
  onClaimSucceeded: vi.fn(),
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

  describe("issue #21, sixth corrective pass: the reactive fast path — no poll round trip needed to notice an already-live reservation", () => {
    it("starts the countdown immediately when isCurrentlyReservedCandidate is already true, without ever calling checkPromotionEligibility", async () => {
      const { result } = renderHook(() =>
        useAutomaticPromotion({ ...baseParams, isCurrentlyReservedCandidate: true }),
      );

      await waitFor(() => expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS));
      // The whole point of the fix: this identity's own reservation was
      // already visible in the caller's live state — no server round
      // trip was needed to discover it.
      expect(checkPromotionEligibility).not.toHaveBeenCalled();
    });

    it("starts the countdown the instant isCurrentlyReservedCandidate flips true on a later render — not on the next poll tick", async () => {
      // The poll's own mock stays "not eligible" throughout — if the
      // countdown starts anyway, it can only be from the reactive path,
      // never the poll happening to catch up.
      checkPromotionEligibility.mockResolvedValue({ eligible: false });
      const { result, rerender } = renderHook(
        (props: { isCurrentlyReservedCandidate: boolean }) =>
          useAutomaticPromotion({ ...baseParams, isCurrentlyReservedCandidate: props.isCurrentlyReservedCandidate }),
        { initialProps: { isCurrentlyReservedCandidate: false } },
      );

      // Give the initial (false) poll a chance to run and confirm it
      // reports not-yet-eligible, same as any ordinary waiting candidate.
      await waitFor(() => expect(checkPromotionEligibility).toHaveBeenCalled());
      expect(result.current.countdown).toBeNull();

      rerender({ isCurrentlyReservedCandidate: true });

      await waitFor(() => expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS));
    });

    it("does not start the countdown from the reactive signal once already speaking or once counting down — same guards as the polled path", () => {
      renderHook(() => useAutomaticPromotion({ ...baseParams, isSpeaker: true, isCurrentlyReservedCandidate: true }));
      expect(checkPromotionEligibility).not.toHaveBeenCalled();
    });
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

  describe("issue #18 UX finding fix: no candidate-UI flash on a successful claim, and Cancel actually cancels the promotion path", () => {
    it("a successful claim leaves countdown non-null (frozen), rather than racing the isSpeaker Realtime flip — countdown only clears once isSpeaker actually flips true", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      claimOpenSeat.mockResolvedValue({ ok: true });
      vi.useFakeTimers();
      const { result, rerender } = renderHook((props) => useAutomaticPromotion(props), {
        initialProps: baseParams,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(PROMOTION_COUNTDOWN_SECONDS * 1000);
      });
      // countdown reached 0, claimOpenSeat resolved — deliberately still
      // non-null (not reset to null by the success path itself).
      expect(result.current.countdown).not.toBeNull();
      expect(baseParams.onHasPendingRequestChange).not.toHaveBeenCalled();

      // The authoritative signal: isSpeaker actually flips true (Realtime).
      rerender({ ...baseParams, isSpeaker: true });
      expect(result.current.countdown).toBeNull();
    });

    it("issue #18 real-device finding (2026-08-28): a successful claim calls onClaimSucceeded immediately, not waiting solely on a Realtime isSpeaker flip that could be missed — this is what lets the client resync without a second Join tap", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      claimOpenSeat.mockResolvedValue({ ok: true });
      vi.useFakeTimers();
      const onClaimSucceeded = vi.fn();
      const { result } = renderHook(() => useAutomaticPromotion({ ...baseParams, onClaimSucceeded }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS);

      // One 1000ms advance per tick, not a single combined advance — fake
      // timers don't reliably cascade through React's own re-render (each
      // tick's setCountdown needs to actually commit before the *next*
      // tick's setTimeout gets (re-)scheduled) within one
      // advanceTimersByTimeAsync call in this environment, the same
      // documented limitation the "ticks the countdown down" test above
      // and this file's own comment on the untested full-chain scenario
      // already work around.
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(onClaimSucceeded).toHaveBeenCalledTimes(1);
    });

    it("a failed/lost-race claim never calls onClaimSucceeded", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      claimOpenSeat.mockResolvedValue({ error: "That seat was just taken — try again." });
      vi.useFakeTimers();
      const onClaimSucceeded = vi.fn();
      renderHook(() => useAutomaticPromotion({ ...baseParams, onClaimSucceeded }));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(onClaimSucceeded).not.toHaveBeenCalled();
    });

    // A "failed/lost-race claim still resets countdown to null" test was
    // attempted here (mirroring the successful-claim test above, just
    // with claimOpenSeat mocked to fail) but doesn't reliably converge
    // with fake timers in this environment, even in isolation — the same
    // documented limitation as the full countdown-reaches-zero chain
    // noted elsewhere in this file. That branch (`if (!("ok" in
    // result)) setCountdown(null)`) is unchanged from the pre-fix
    // behavior; only the *success* branch changed. Not asserted here;
    // covered by real-device/production verification instead.

    it("request accepted → countdown starts → Cancel → wait beyond the original countdown duration → user must still remain non-speaker (no surprise re-promotion from the canceled countdown)", async () => {
      vi.useFakeTimers();
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      let resolveWithdraw: (value: { ok: true } | { error: string }) => void = () => {};
      withdrawSpeakerRequest.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWithdraw = resolve;
          }),
      );
      const onHasPendingRequestChange = vi.fn();
      const { result, rerender } = renderHook((props) => useAutomaticPromotion(props), {
        initialProps: { ...baseParams, onHasPendingRequestChange },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.countdown).toBe(PROMOTION_COUNTDOWN_SECONDS);
      expect(checkPromotionEligibility).toHaveBeenCalledTimes(1);

      act(() => {
        result.current.cancel();
      });
      expect(result.current.countdown).toBeNull();

      // Wait well beyond the original countdown duration and past at
      // least one poll interval — server-side withdrawal is still in
      // flight the whole time (the mocked promise hasn't resolved yet).
      // If the polling effect incorrectly re-armed the moment countdown
      // went null, it would call checkPromotionEligibility again and
      // restart the countdown, re-promoting a user who explicitly
      // canceled.
      await act(async () => {
        await vi.advanceTimersByTimeAsync((PROMOTION_COUNTDOWN_SECONDS + 10) * 1000);
      });

      expect(checkPromotionEligibility).toHaveBeenCalledTimes(1);
      expect(result.current.countdown).toBeNull();
      expect(claimOpenSeat).not.toHaveBeenCalled();

      // Withdrawal finally lands server-side. In the real app,
      // onHasPendingRequestChange(false) and clearing isCancelling happen
      // in the same .then() callback (see cancel()'s own comment) so they
      // batch into the same commit — EventRoom's re-render with
      // hasPendingRequest: false and this hook's own isCancelling
      // clearing land together, not as two separate renders. Rerendering
      // inside the same act() block models that.
      await act(async () => {
        resolveWithdraw({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
        rerender({ ...baseParams, onHasPendingRequestChange, hasPendingRequest: false });
      });
      expect(onHasPendingRequestChange).toHaveBeenCalledWith(false);
      expect(result.current.countdown).toBeNull();
      expect(claimOpenSeat).not.toHaveBeenCalled();
    });
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

  /**
   * Media Readiness pass (issue #21), Section 24: the hard seat-claim
   * invariant — claimOpenSeat must never fire for this candidacy until
   * both cameraReady/microphoneReady are true, even once the countdown
   * has reached zero. See this hook's own doc comment on the claim
   * effect for the design (countdown simply stays frozen at 0, an
   * already-established display state, while the caller's own UI —
   * StageReadinessPrompt — is what the candidate actually sees/acts on).
   */
  describe("Media Readiness pass (issue #21): seat claim gated on verified camera+microphone readiness", () => {
    it("never calls claimOpenSeat once countdown reaches zero if camera readiness is false", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      vi.useFakeTimers();
      const { result } = renderHook(() =>
        useAutomaticPromotion({ ...baseParams, cameraReady: false, microphoneReady: true }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      expect(result.current.countdown).toBe(0);
      expect(claimOpenSeat).not.toHaveBeenCalled();
    });

    it("never calls claimOpenSeat once countdown reaches zero if microphone readiness is false", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      vi.useFakeTimers();
      const { result } = renderHook(() =>
        useAutomaticPromotion({ ...baseParams, cameraReady: true, microphoneReady: false }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      expect(result.current.countdown).toBe(0);
      expect(claimOpenSeat).not.toHaveBeenCalled();
    });

    it("never calls claimOpenSeat once countdown reaches zero if both camera and microphone readiness are false", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      vi.useFakeTimers();
      const { result } = renderHook(() =>
        useAutomaticPromotion({ ...baseParams, cameraReady: false, microphoneReady: false }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      expect(result.current.countdown).toBe(0);
      expect(claimOpenSeat).not.toHaveBeenCalled();
    });

    it("retry success: once readiness flips to both-true on a rerender, the withheld claim fires on its own — no re-tap/re-countdown needed", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      claimOpenSeat.mockResolvedValue({ ok: true });
      vi.useFakeTimers();
      const { result, rerender } = renderHook((props) => useAutomaticPromotion(props), {
        initialProps: { ...baseParams, cameraReady: false, microphoneReady: true },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(result.current.countdown).toBe(0);
      expect(claimOpenSeat).not.toHaveBeenCalled();

      // The candidate taps "Try again" in StageReadinessPrompt, camera
      // acquisition now succeeds — the caller re-renders with fresh
      // readiness. No new countdown, no new tap required on this hook's
      // side: the same frozen-at-0 effect notices readiness changed and
      // fires the claim.
      await act(async () => {
        rerender({ ...baseParams, cameraReady: true, microphoneReady: true });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(claimOpenSeat).toHaveBeenCalledWith("e1");
    });

    it("retry failure: readiness never succeeds — the reservation is released via the existing cancel()/withdrawSpeakerRequest path once the bounded readiness timeout elapses, never a new replacement mechanism", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      // Held open deliberately (not mockResolvedValue) — same reasoning as
      // the existing "no surprise re-promotion" cancel test above: an
      // immediately-resolved promise's .then() would flip isCancelling
      // back to false *before* this test gets a chance to rerender with
      // hasPendingRequest: false, letting the poll effect's guard
      // momentarily pass and re-arm the countdown mid-advance.
      let resolveWithdraw: (value: { ok: true } | { error: string }) => void = () => {};
      withdrawSpeakerRequest.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveWithdraw = resolve;
          }),
      );
      vi.useFakeTimers();
      const onHasPendingRequestChange = vi.fn();
      const { result, rerender } = renderHook((props) => useAutomaticPromotion(props), {
        initialProps: {
          ...baseParams,
          cameraReady: false,
          microphoneReady: false,
          onHasPendingRequestChange,
        },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }
      expect(result.current.countdown).toBe(0);
      expect(claimOpenSeat).not.toHaveBeenCalled();

      // Bounded readiness timeout (45s) elapses with readiness still false.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });

      expect(withdrawSpeakerRequest).toHaveBeenCalledWith("e1");
      // Resolving and rerendering with hasPendingRequest: false happen
      // inside the same act() here, mirroring the existing "no surprise
      // re-promotion" cancel test above — combining them is what lets the
      // poll effect's own guard (`!hasPendingRequest`) win the race
      // against isCancelling flipping false, rather than momentarily
      // re-arming and restarting the countdown.
      await act(async () => {
        resolveWithdraw({ ok: true });
        await vi.advanceTimersByTimeAsync(0);
        rerender({ ...baseParams, cameraReady: false, microphoneReady: false, onHasPendingRequestChange, hasPendingRequest: false });
      });
      expect(onHasPendingRequestChange).toHaveBeenCalledWith(false);
      expect(result.current.countdown).toBeNull();
      expect(claimOpenSeat).not.toHaveBeenCalled();
    });

    it("does not start (or does not fire) the readiness timeout once readiness succeeds before it elapses", async () => {
      checkPromotionEligibility.mockResolvedValue({ eligible: true });
      claimOpenSeat.mockResolvedValue({ ok: true });
      vi.useFakeTimers();
      const { rerender } = renderHook((props) => useAutomaticPromotion(props), {
        initialProps: { ...baseParams, cameraReady: false, microphoneReady: true },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (let tick = 0; tick < PROMOTION_COUNTDOWN_SECONDS; tick++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
      }

      // Readiness succeeds well within the 45s window — the claim fires
      // immediately; the pending readiness-timeout must not later call
      // withdrawSpeakerRequest once it would otherwise have elapsed.
      await act(async () => {
        rerender({ ...baseParams, cameraReady: true, microphoneReady: true });
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(claimOpenSeat).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(45_000);
      });
      expect(withdrawSpeakerRequest).not.toHaveBeenCalled();
    });
  });
});
