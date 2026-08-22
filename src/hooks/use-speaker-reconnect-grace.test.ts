import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RECONNECT_GRACE_PERIOD_MS, useSpeakerReconnectGrace } from "./use-speaker-reconnect-grace";
import type { EventSpeaker } from "@/lib/repositories/event-speakers";
import type { Participant } from "livekit-client";

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
    ...overrides,
  };
}

const connectedParticipant = {} as Participant;

describe("useSpeakerReconnectGrace", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("watches nothing when disabled — no getParticipant lookups meant anything yet (e.g. still lobby_open)", () => {
    const getParticipant = vi.fn(() => undefined);
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p2" })],
        getParticipant,
        myIdentity: "profile:p1",
        enabled: false,
      }),
    );
    expect(result.current.size).toBe(0);
  });

  it("reports nothing disconnected when every occupied seat has a live LiveKit participant", () => {
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p2" })],
        getParticipant: () => connectedParticipant,
        myIdentity: "profile:p1",
        enabled: true,
      }),
    );
    expect(result.current.size).toBe(0);
  });

  it("never watches the viewer's own seat, even if their own LiveKit connection hasn't established yet", () => {
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p1" })],
        getParticipant: () => undefined,
        myIdentity: "profile:p1",
        enabled: true,
      }),
    );
    expect(result.current.size).toBe(0);
  });

  it("marks another seat's occupant as reconnecting once their LiveKit participant is absent", () => {
    const { result } = renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p2" })],
        getParticipant: () => undefined,
        myIdentity: "profile:p1",
        enabled: true,
      }),
    );
    expect(result.current.has("profile:p2")).toBe(true);
  });

  it("calls checkAndEvictDisconnectedSpeaker only after the full grace period, never immediately", async () => {
    vi.useFakeTimers();
    renderHook(() =>
      useSpeakerReconnectGrace({
        eventId: "e1",
        speakers: [speaker({ profile_id: "p2" })],
        getParticipant: () => undefined,
        myIdentity: "profile:p1",
        enabled: true,
      }),
    );

    expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_PERIOD_MS - 1000);
    });
    expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(checkAndEvictDisconnectedSpeaker).toHaveBeenCalledWith("e1", { type: "profile", id: "p2" });
  });

  it("cancels the pending check if the participant reconnects before the grace period elapses", async () => {
    vi.useFakeTimers();
    const disconnected: () => Participant | undefined = () => undefined;
    const reconnected: () => Participant | undefined = () => connectedParticipant;
    const { rerender } = renderHook(
      ({ getParticipant }: { getParticipant: () => Participant | undefined }) =>
        useSpeakerReconnectGrace({
          eventId: "e1",
          speakers: [speaker({ profile_id: "p2" })],
          getParticipant,
          myIdentity: "profile:p1",
          enabled: true,
        }),
      { initialProps: { getParticipant: disconnected } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_PERIOD_MS / 2);
    });

    rerender({ getParticipant: reconnected });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(RECONNECT_GRACE_PERIOD_MS);
    });
    expect(checkAndEvictDisconnectedSpeaker).not.toHaveBeenCalled();
  });

  it("clears the reconnecting set once the seat is no longer in the DB's own active-speaker list at all", () => {
    const { result, rerender } = renderHook(
      ({ speakers }: { speakers: EventSpeaker[] }) =>
        useSpeakerReconnectGrace({
          eventId: "e1",
          speakers,
          getParticipant: () => undefined,
          myIdentity: "profile:p1",
          enabled: true,
        }),
      { initialProps: { speakers: [speaker({ profile_id: "p2" })] } },
    );
    expect(result.current.has("profile:p2")).toBe(true);

    rerender({ speakers: [] });
    expect(result.current.has("profile:p2")).toBe(false);
  });
});
