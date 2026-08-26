import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSeatReconciliation } from "./use-seat-reconciliation";

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

describe("useSeatReconciliation (issue #18 real-device finding, 2026-08-28: a missed Realtime delta needed a second manual Join tap to notice and fix)", () => {
  afterEach(() => {
    setVisibility("visible");
  });

  describe("the watchdog: canPublish (LiveKit-confirmed) contradicting isSpeaker (client role) — covers both 'permission became speaker-capable' and 'local publication starting', since publishing is always gated on canPublish first", () => {
    it("does not refetch when canPublish and isSpeaker already agree (the ordinary case)", () => {
      const refetch = vi.fn(async () => {});
      renderHook(() => useSeatReconciliation({ isSpeaker: true, canPublish: true, refetch }));
      expect(refetch).not.toHaveBeenCalled();
    });

    it("does not refetch for an ordinary audience member (canPublish false, isSpeaker false)", () => {
      const refetch = vi.fn(async () => {});
      renderHook(() => useSeatReconciliation({ isSpeaker: false, canPublish: false, refetch }));
      expect(refetch).not.toHaveBeenCalled();
    });

    it("refetches the instant canPublish is true while isSpeaker is still false — the exact contradiction captured on-device (self-preview live, role says audience)", () => {
      const refetch = vi.fn(async () => {});
      renderHook(() => useSeatReconciliation({ isSpeaker: false, canPublish: true, refetch }));
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("refetches on the transition into the contradiction, not just on mount", () => {
      const refetch = vi.fn(async () => {});
      const { rerender } = renderHook(
        ({ isSpeaker, canPublish }: { isSpeaker: boolean; canPublish: boolean }) =>
          useSeatReconciliation({ isSpeaker, canPublish, refetch }),
        { initialProps: { isSpeaker: false, canPublish: false } },
      );
      expect(refetch).not.toHaveBeenCalled();

      rerender({ isSpeaker: false, canPublish: true });
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("does not refetch again while the same contradiction persists across re-renders — one trigger per episode, not a loop", () => {
      const refetch = vi.fn(async () => {});
      const { rerender } = renderHook(
        ({ isSpeaker, canPublish }: { isSpeaker: boolean; canPublish: boolean }) =>
          useSeatReconciliation({ isSpeaker, canPublish, refetch }),
        { initialProps: { isSpeaker: false, canPublish: true } },
      );
      expect(refetch).toHaveBeenCalledTimes(1);

      rerender({ isSpeaker: false, canPublish: true });
      rerender({ isSpeaker: false, canPublish: true });
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("once the contradiction resolves (isSpeaker catches up) and later recurs, it can trigger again — not permanently latched", () => {
      const refetch = vi.fn(async () => {});
      const { rerender } = renderHook(
        ({ isSpeaker, canPublish }: { isSpeaker: boolean; canPublish: boolean }) =>
          useSeatReconciliation({ isSpeaker, canPublish, refetch }),
        { initialProps: { isSpeaker: false, canPublish: true } },
      );
      expect(refetch).toHaveBeenCalledTimes(1);

      rerender({ isSpeaker: true, canPublish: true }); // resolved
      // A genuinely new episode: seat lost, then somehow republishing
      // before the client noticed (edge case, but the hook shouldn't
      // permanently stop watching after its first correction).
      rerender({ isSpeaker: false, canPublish: false });
      rerender({ isSpeaker: false, canPublish: true });
      expect(refetch).toHaveBeenCalledTimes(2);
    });

    it("never refetches merely because isSpeaker is true while canPublish is false (e.g. a fresh mount before LiveKit connects) — that's not the captured contradiction", () => {
      const refetch = vi.fn(async () => {});
      renderHook(() => useSeatReconciliation({ isSpeaker: true, canPublish: false, refetch }));
      expect(refetch).not.toHaveBeenCalled();
    });
  });

  describe("visibility/focus restoration — a backgrounded mobile tab is exactly where a Realtime socket can silently drop", () => {
    it("refetches when the document becomes visible again", () => {
      const refetch = vi.fn(async () => {});
      renderHook(() => useSeatReconciliation({ isSpeaker: true, canPublish: true, refetch }));
      refetch.mockClear(); // ignore any mount-time behavior, isolate the visibility trigger

      setVisibility("visible");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("does not refetch when the document becomes hidden", () => {
      const refetch = vi.fn(async () => {});
      renderHook(() => useSeatReconciliation({ isSpeaker: true, canPublish: true, refetch }));
      refetch.mockClear();

      setVisibility("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(refetch).not.toHaveBeenCalled();
    });

    it("refetches on window focus too", () => {
      const refetch = vi.fn(async () => {});
      renderHook(() => useSeatReconciliation({ isSpeaker: true, canPublish: true, refetch }));
      refetch.mockClear();

      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      expect(refetch).toHaveBeenCalledTimes(1);
    });

    it("removes its listeners on unmount — no refetch after the component is gone", () => {
      const refetch = vi.fn(async () => {});
      const { unmount } = renderHook(() => useSeatReconciliation({ isSpeaker: true, canPublish: true, refetch }));
      refetch.mockClear();
      unmount();

      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      expect(refetch).not.toHaveBeenCalled();
    });
  });

  it("never calls anything other than the supplied refetch — no seat-claim or media-acquisition action lives in this hook at all", () => {
    // A structural guarantee, not just a behavioral one: this hook's own
    // module only imports React primitives — see its source. This test
    // documents the contract the module-shape already enforces: the only
    // side effect this hook can ever produce is calling `refetch`.
    const refetch = vi.fn(async () => {});
    renderHook(() => useSeatReconciliation({ isSpeaker: false, canPublish: true, refetch }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledWith();
  });
});
