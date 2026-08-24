import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpeakerReconnectGrace } from "./use-speaker-reconnect-grace";
import { SPEAKER_DISCONNECT_GRACE_MS } from "@/lib/speaker-reconnect";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";

const { checkAndEvictDisconnectedSpeaker } = vi.hoisted(() => ({
  checkAndEvictDisconnectedSpeaker: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({ checkAndEvictDisconnectedSpeaker }));

function speaker(overrides: Partial<EventSpeaker> = {}): EventSpeaker {
  return {
    id: "s1",
    event_id: "e1",
    profile_id: "p1",
    guest_id: null,
    seat_number: 1,
    display_name: "Jamie",
    joined_at: new Date().toISOString(),
    left_at: null,
    left_reason: null,
    disconnected_at: null,
    ...overrides,
  };
}

describe("useSpeakerReconnectGrace (issue #18 UX finding — server-authoritative disconnected_at, not a LiveKit-live-participant heuristic)", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("watches nothing when disabled — e.g. still lobby_open", () => {
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })],
        myIdentity: "profile:p1",
        enabled: false,
      }),
    );
    expect(result.current.size).toBe(0);
  });

  it("reports nothing disconnected when no occupied seat has disconnected_at set", () => {
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p2", disconnected_at: null })],
        myIdentity: "profile:p1",
        enabled: true,
      }),
    );
    expect(result.current.size).toBe(0);
  });

  it("never watches the viewer's own seat, even if it somehow carried a disconnected_at value", () => {
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p1", disconnected_at: new Date().toISOString() })],
        myIdentity: "profile:p1",
        enabled: true,
      }),
    );
    expect(result.current.size).toBe(0);
  });

  it("marks another seat's occupant as reconnecting the instant their disconnected_at is set — a pure derivation, no local heuristic", () => {
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })],
        myIdentity: "profile:p1",
        enabled: true,
      }),
    );
    expect(result.current.has("profile:p2")).toBe(true);
  });

  describe("disconnect → no return → release trigger at the grace boundary", () => {
    it("does not call checkAndEvictDisconnectedSpeaker before the grace period has elapsed", async () => {
      vi.useFakeTimers();
      renderHook(() =>
        useSpeakerReconnectGrace({
          eventId: "e1",
          speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })],
          myIdentity: "profile:p1",
          enabled: true,
        }),
      );

      expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPEAKER_DISCONNECT_GRACE_MS - 1000);
      });
      expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();
    });

    it("calls checkAndEvictDisconnectedSpeaker once the grace period elapses, with the disconnected identity", async () => {
      vi.useFakeTimers();
      renderHook(() =>
        useSpeakerReconnectGrace({
          eventId: "e1",
          speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })],
          myIdentity: "profile:p1",
          enabled: true,
        }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPEAKER_DISCONNECT_GRACE_MS);
      });
      expect(checkAndEvictDisconnectedSpeaker).toHaveBeenCalledWith("e1", { type: "profile", id: "p2" });
    });

    it("schedules from the actual disconnected_at timestamp, not from mount — a page loaded partway through an existing grace window fires correspondingly sooner", async () => {
      vi.useFakeTimers();
      const disconnectedAt = new Date(Date.now() - (SPEAKER_DISCONNECT_GRACE_MS - 2000)).toISOString();
      renderHook(() =>
        useSpeakerReconnectGrace({
          eventId: "e1",
          speakers: [speaker({ profile_id: "p2", disconnected_at: disconnectedAt })],
          myIdentity: "profile:p1",
          enabled: true,
        }),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(checkAndEvictDisconnectedSpeaker).toHaveBeenCalledWith("e1", { type: "profile", id: "p2" });
    });
  });

  describe("disconnect → reconnect inside the grace period", () => {
    it("cancels the pending check the moment disconnected_at clears, before the grace period elapses", async () => {
      vi.useFakeTimers();
      const { rerender } = renderHook(
        ({ speakers }: { speakers: EventSpeaker[] }) =>
          useSpeakerReconnectGrace({ eventId: "e1", speakers, myIdentity: "profile:p1", enabled: true }),
        { initialProps: { speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })] } },
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPEAKER_DISCONNECT_GRACE_MS / 2);
      });

      // The webhook's participant_joined handler clears disconnected_at
      // server-side; Realtime delivers the updated row here.
      rerender({ speakers: [speaker({ profile_id: "p2", disconnected_at: null })] });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPEAKER_DISCONNECT_GRACE_MS);
      });
      expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();
    });

    it("reflects the reconnect in the returned set immediately", () => {
      const { result, rerender } = renderHook(
        ({ speakers }: { speakers: EventSpeaker[] }) =>
          useSpeakerReconnectGrace({ eventId: "e1", speakers, myIdentity: "profile:p1", enabled: true }),
        { initialProps: { speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })] } },
      );
      expect(result.current.has("profile:p2")).toBe(true);

      rerender({ speakers: [speaker({ profile_id: "p2", disconnected_at: null })] });
      expect(result.current.has("profile:p2")).toBe(false);
    });
  });

  describe("stale timeout after successful reconnection", () => {
    it("a timer already scheduled before the reconnect is cleared, not just superseded — advancing well past the original deadline still never calls checkAndEvictDisconnectedSpeaker", async () => {
      vi.useFakeTimers();
      const { rerender } = renderHook(
        ({ speakers }: { speakers: EventSpeaker[] }) =>
          useSpeakerReconnectGrace({ eventId: "e1", speakers, myIdentity: "profile:p1", enabled: true }),
        { initialProps: { speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })] } },
      );

      // Reconnect arrives just before the original timer would have fired.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(SPEAKER_DISCONNECT_GRACE_MS - 100);
      });
      rerender({ speakers: [speaker({ profile_id: "p2", disconnected_at: null })] });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();
    });
  });

  it("clears the reconnecting set once the seat is no longer in the DB's own active-speaker list at all (e.g. released, or replaced by a new occupant)", () => {
    const { result, rerender } = renderHook(
      ({ speakers }: { speakers: EventSpeaker[] }) =>
        useSpeakerReconnectGrace({ eventId: "e1", speakers, myIdentity: "profile:p1", enabled: true }),
      { initialProps: { speakers: [speaker({ profile_id: "p2", disconnected_at: new Date().toISOString() })] } },
    );
    expect(result.current.has("profile:p2")).toBe(true);

    rerender({ speakers: [] });
    expect(result.current.has("profile:p2")).toBe(false);
  });

  it("a stale reconnect arriving after the seat was already released and reclaimed by someone else never affects the new occupant — the returned set simply reflects the new speaker's own (unset) disconnected_at", () => {
    const { result, rerender } = renderHook(
      ({ speakers }: { speakers: EventSpeaker[] }) =>
        useSpeakerReconnectGrace({ eventId: "e1", speakers, myIdentity: "profile:p1", enabled: true }),
      { initialProps: { speakers: [speaker({ id: "s1", profile_id: "p2", disconnected_at: new Date().toISOString() })] } },
    );
    expect(result.current.has("profile:p2")).toBe(true);

    // p2's seat was released and reclaimed by p3 — a brand new row, same
    // seat_number, disconnected_at null by construction (a fresh INSERT).
    rerender({ speakers: [speaker({ id: "s2", profile_id: "p3", disconnected_at: null })] });
    expect(result.current.has("profile:p2")).toBe(false);
    expect(result.current.has("profile:p3")).toBe(false);
  });
});
