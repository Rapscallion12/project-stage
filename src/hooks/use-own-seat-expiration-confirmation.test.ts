import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useOwnSeatExpirationConfirmation } from "./use-own-seat-expiration-confirmation";
import { SPEAKER_DISCONNECT_GRACE_MS } from "@/lib/speaker-reconnect";

const { confirmOwnSeatExpiration } = vi.hoisted(() => ({
  confirmOwnSeatExpiration: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({ confirmOwnSeatExpiration }));

describe("useOwnSeatExpirationConfirmation (issue #18 expiration-enforcement finding)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("never confirms while there's nothing to count down (inactiveSince is null)", () => {
    renderHook(() => useOwnSeatExpirationConfirmation("e1", null));
    expect(confirmOwnSeatExpiration).not.toHaveBeenCalled();
  });

  it("never confirms while the deadline hasn't been reached yet", () => {
    const inactiveSince = new Date(Date.now() - 3000).toISOString(); // well within the 11s window
    renderHook(() => useOwnSeatExpirationConfirmation("e1", inactiveSince));
    expect(confirmOwnSeatExpiration).not.toHaveBeenCalled();
  });

  it("confirms exactly once, for the event id passed in, the instant the deadline is already past on mount", () => {
    const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 5000)).toISOString();
    renderHook(() => useOwnSeatExpirationConfirmation("e1", inactiveSince));
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(1);
    expect(confirmOwnSeatExpiration).toHaveBeenCalledWith("e1");
  });

  it("confirms on the transition into zero while ticking, not before", async () => {
    vi.useFakeTimers();
    const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS - 1000)).toISOString(); // 1s remaining
    const { rerender } = renderHook(
      ({ eventId, since }: { eventId: string; since: string | null }) => useOwnSeatExpirationConfirmation(eventId, since),
      { initialProps: { eventId: "e1", since: inactiveSince as string | null } },
    );
    expect(confirmOwnSeatExpiration).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    rerender({ eventId: "e1", since: inactiveSince });
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(1);
  });

  it("does not call again on further re-renders while still at zero for the same deadline", () => {
    const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 5000)).toISOString();
    const { rerender } = renderHook(
      ({ eventId, since }: { eventId: string; since: string | null }) => useOwnSeatExpirationConfirmation(eventId, since),
      { initialProps: { eventId: "e1", since: inactiveSince as string | null } },
    );
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(1);

    rerender({ eventId: "e1", since: inactiveSince });
    rerender({ eventId: "e1", since: inactiveSince });
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(1);
  });

  it("confirms again for a genuinely new deadline (recovered, then disconnected again) even without passing through a non-null intermediate render", () => {
    const first = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 5000)).toISOString();
    const second = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 9000)).toISOString();
    const { rerender } = renderHook(
      ({ eventId, since }: { eventId: string; since: string | null }) => useOwnSeatExpirationConfirmation(eventId, since),
      { initialProps: { eventId: "e1", since: first as string | null } },
    );
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(1);

    rerender({ eventId: "e1", since: second });
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(2);
    expect(confirmOwnSeatExpiration).toHaveBeenLastCalledWith("e1");
  });

  it("stops confirming once inactiveSince clears to null (recovery)", () => {
    const inactiveSince = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS + 5000)).toISOString();
    const { rerender } = renderHook(
      ({ eventId, since }: { eventId: string; since: string | null }) => useOwnSeatExpirationConfirmation(eventId, since),
      { initialProps: { eventId: "e1", since: inactiveSince as string | null } },
    );
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(1);

    rerender({ eventId: "e1", since: null });
    rerender({ eventId: "e1", since: null });
    expect(confirmOwnSeatExpiration).toHaveBeenCalledTimes(1);
  });
});
