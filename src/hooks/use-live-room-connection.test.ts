import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyMediaError, shouldPublish, useLiveRoomConnection } from "./use-live-room-connection";
import { Track } from "livekit-client";

const { createLocalTracks, RoomMock, roomInstances } = vi.hoisted(() => {
  const roomInstances: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    on: () => unknown;
    localParticipant: {
      identity: string;
      permissions: { canPublish: boolean };
      getTrackPublication: ReturnType<typeof vi.fn>;
      setMicrophoneEnabled: ReturnType<typeof vi.fn>;
      setCameraEnabled: ReturnType<typeof vi.fn>;
      publishTrack: ReturnType<typeof vi.fn>;
    };
    remoteParticipants: Map<string, unknown>;
  }> = [];

  class RoomMock {
    connect = vi.fn().mockResolvedValue(undefined);
    disconnect = vi.fn().mockResolvedValue(undefined);
    localParticipant = {
      identity: "profile:me",
      permissions: { canPublish: false },
      getTrackPublication: vi.fn(),
      setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
      setCameraEnabled: vi.fn().mockResolvedValue(undefined),
      publishTrack: vi.fn().mockResolvedValue(undefined),
    };
    remoteParticipants = new Map();
    on() {
      return this;
    }
    constructor() {
      roomInstances.push(this as unknown as (typeof roomInstances)[number]);
    }
  }

  return { createLocalTracks: vi.fn(), RoomMock, roomInstances };
});

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return { ...actual, createLocalTracks, Room: RoomMock };
});

describe("shouldPublish", () => {
  it("is false when there are no permissions yet (not connected)", () => {
    expect(shouldPublish(undefined)).toBe(false);
  });

  it("is false when canPublish is explicitly false", () => {
    expect(shouldPublish({ canPublish: false })).toBe(false);
  });

  it("is true only when canPublish is explicitly true", () => {
    expect(shouldPublish({ canPublish: true })).toBe(true);
  });
});

describe("classifyMediaError", () => {
  function domException(name: string): Error {
    const error = new Error(`simulated ${name}`);
    error.name = name;
    return error;
  }

  it("maps NotAllowedError/SecurityError to permission-denied", () => {
    expect(classifyMediaError("camera", domException("NotAllowedError"))).toEqual({
      source: "camera",
      reason: "permission-denied",
    });
    expect(classifyMediaError("microphone", domException("SecurityError"))).toEqual({
      source: "microphone",
      reason: "permission-denied",
    });
  });

  it("maps NotFoundError/OverconstrainedError to no-device", () => {
    expect(classifyMediaError("camera", domException("NotFoundError"))).toEqual({
      source: "camera",
      reason: "no-device",
    });
    expect(classifyMediaError("microphone", domException("OverconstrainedError"))).toEqual({
      source: "microphone",
      reason: "no-device",
    });
  });

  it("maps NotReadableError/AbortError to device-unavailable", () => {
    expect(classifyMediaError("camera", domException("NotReadableError"))).toEqual({
      source: "camera",
      reason: "device-unavailable",
    });
    expect(classifyMediaError("microphone", domException("AbortError"))).toEqual({
      source: "microphone",
      reason: "device-unavailable",
    });
  });

  it("falls back to init-failed for anything else, including non-Error throws", () => {
    expect(classifyMediaError("camera", domException("TypeError"))).toEqual({
      source: "camera",
      reason: "init-failed",
    });
    expect(classifyMediaError("microphone", "not an Error instance")).toEqual({
      source: "microphone",
      reason: "init-failed",
    });
  });
});

/**
 * Issue #22: prepareLocalMedia/releaseLocalMedia, exercised with
 * `params: null` (no LiveKit Room instantiated at all — see the hook's
 * own doc comment for why passing null skips connecting entirely) so
 * these can be tested without mocking the real Room/WebRTC surface, the
 * same reasoning shouldPublish/classifyMediaError above are already
 * unit-tested standalone for.
 */
describe("useLiveRoomConnection — candidate media readiness (issue #22)", () => {
  function fakeVideoTrack() {
    return { kind: Track.Kind.Video, stop: vi.fn() };
  }
  function fakeAudioTrack() {
    return { kind: Track.Kind.Audio, stop: vi.fn() };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("exposes the acquired camera track as localVideoTrack once prepareLocalMedia resolves", async () => {
    const video = fakeVideoTrack();
    createLocalTracks.mockResolvedValue([fakeAudioTrack(), video]);
    const { result } = renderHook(() => useLiveRoomConnection(null));

    expect(result.current.localVideoTrack).toBeNull();
    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    expect(result.current.localVideoTrack).toBe(video);
  });

  it("is idempotent — a second call doesn't re-acquire once tracks are already held", async () => {
    createLocalTracks.mockResolvedValue([fakeAudioTrack(), fakeVideoTrack()]);
    const { result } = renderHook(() => useLiveRoomConnection(null));

    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    expect(createLocalTracks).toHaveBeenCalledTimes(1);
  });

  it("on acquisition failure, surfaces mediaError and holds no track", async () => {
    const error = new Error("simulated NotAllowedError");
    error.name = "NotAllowedError";
    createLocalTracks.mockRejectedValue(error);
    const { result } = renderHook(() => useLiveRoomConnection(null));

    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    expect(result.current.localVideoTrack).toBeNull();
    expect(result.current.mediaError).toEqual({ source: "camera", reason: "permission-denied" });
  });

  it("a failed acquisition doesn't block a later retry from succeeding", async () => {
    createLocalTracks.mockRejectedValueOnce(new Error("simulated failure"));
    const video = fakeVideoTrack();
    createLocalTracks.mockResolvedValueOnce([fakeAudioTrack(), video]);
    const { result } = renderHook(() => useLiveRoomConnection(null));

    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    expect(result.current.localVideoTrack).toBeNull();

    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    expect(result.current.localVideoTrack).toBe(video);
    expect(createLocalTracks).toHaveBeenCalledTimes(2);
  });

  it("releaseLocalMedia stops held tracks and clears localVideoTrack", async () => {
    const video = fakeVideoTrack();
    const audio = fakeAudioTrack();
    createLocalTracks.mockResolvedValue([audio, video]);
    const { result } = renderHook(() => useLiveRoomConnection(null));

    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    act(() => {
      result.current.releaseLocalMedia();
    });

    expect(result.current.localVideoTrack).toBeNull();
    expect(video.stop).toHaveBeenCalledTimes(1);
    expect(audio.stop).toHaveBeenCalledTimes(1);
  });

  it("releaseLocalMedia is safe to call with nothing held", () => {
    const { result } = renderHook(() => useLiveRoomConnection(null));
    expect(() => {
      act(() => {
        result.current.releaseLocalMedia();
      });
    }).not.toThrow();
    expect(result.current.localVideoTrack).toBeNull();
  });

  it("after releasing, a later prepareLocalMedia re-acquires fresh tracks rather than staying inert", async () => {
    createLocalTracks.mockResolvedValue([fakeAudioTrack(), fakeVideoTrack()]);
    const { result } = renderHook(() => useLiveRoomConnection(null));

    await act(async () => {
      await result.current.prepareLocalMedia();
    });
    act(() => {
      result.current.releaseLocalMedia();
    });
    await act(async () => {
      await result.current.prepareLocalMedia();
    });

    expect(createLocalTracks).toHaveBeenCalledTimes(2);
    expect(result.current.localVideoTrack).not.toBeNull();
  });

  describe("activateMedia (real-device finding: refresh recovery left self-preview empty)", () => {
    it("reconstructs localVideoTrack — the old setCameraEnabled-only fallback never did", async () => {
      const video = fakeVideoTrack();
      createLocalTracks.mockResolvedValue([fakeAudioTrack(), video]);
      const { result } = renderHook(() => useLiveRoomConnection(null));

      expect(result.current.localVideoTrack).toBeNull();
      await act(async () => {
        await result.current.activateMedia();
      });
      expect(result.current.localVideoTrack).toBe(video);
    });

    it("acquires media exactly the same way prepareLocalMedia does — no separate acquisition path", async () => {
      createLocalTracks.mockResolvedValue([fakeAudioTrack(), fakeVideoTrack()]);
      const { result } = renderHook(() => useLiveRoomConnection(null));

      await act(async () => {
        await result.current.activateMedia();
      });
      expect(createLocalTracks).toHaveBeenCalledTimes(1);
      expect(createLocalTracks).toHaveBeenCalledWith({ audio: true, video: true });
    });

    it("on failure, leaves needsMediaActivation-driving state so the tile's retry affordance stays available (the old design permanently hid it after one failed attempt)", async () => {
      const error = new Error("simulated NotAllowedError");
      error.name = "NotAllowedError";
      createLocalTracks.mockRejectedValue(error);
      const { result } = renderHook(() => useLiveRoomConnection(null));

      await act(async () => {
        await result.current.activateMedia();
      });
      expect(result.current.mediaError).toEqual({ source: "camera", reason: "permission-denied" });
      expect(result.current.localVideoTrack).toBeNull();
      // canPublish is false here (params: null, no room) so needsMediaActivation
      // itself reads false too — the meaningful assertion is that nothing
      // here latched mediaActivated permanently true on a failed attempt,
      // confirmed indirectly: a later activateMedia call still re-attempts
      // acquisition rather than silently no-op'ing.
      await act(async () => {
        await result.current.activateMedia();
      });
      expect(createLocalTracks).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * Real-device finding (issue #18, Speaker View corrective pass): editing
 * the guest-name chip while seated made the self-preview disappear and
 * stay gone. Traced to `getLiveKitToken` minting a fresh-but-equivalent
 * JWT on every Server-Action-triggered page refresh (Next.js re-renders
 * the current page's Server Components after any cookie write) — with
 * the token's own string value in the connect effect's dependency array,
 * that alone tore down and reconnected an already-healthy `Room`. These
 * tests exercise the real (mocked) `Room` construction path, unlike the
 * `params: null` tests above.
 */
describe("useLiveRoomConnection — a refreshed token must never force a reconnect", () => {
  afterEach(() => {
    vi.clearAllMocks();
    roomInstances.length = 0;
  });

  it("does not create a second Room or call connect again when only the token string changes for the same url", () => {
    const { rerender } = renderHook(
      ({ token }: { token: string }) => useLiveRoomConnection({ livekitUrl: "wss://example.com", token }),
      { initialProps: { token: "token-one" } },
    );
    expect(roomInstances).toHaveLength(1);
    expect(roomInstances[0].connect).toHaveBeenCalledTimes(1);

    rerender({ token: "token-two-completely-different-jwt" });

    expect(roomInstances).toHaveLength(1);
    expect(roomInstances[0].connect).toHaveBeenCalledTimes(1);
    expect(roomInstances[0].disconnect).not.toHaveBeenCalled();
  });

  it("still connects once params first become available — the documented null-to-real transition is unaffected", () => {
    type Params = { livekitUrl: string; token: string } | null;
    const { rerender } = renderHook(({ params }: { params: Params }) => useLiveRoomConnection(params), {
      initialProps: { params: null as Params },
    });
    expect(roomInstances).toHaveLength(0);

    rerender({ params: { livekitUrl: "wss://example.com", token: "token-one" } });
    expect(roomInstances).toHaveLength(1);
    expect(roomInstances[0].connect).toHaveBeenCalledTimes(1);
  });

  it("does reconnect with a new Room if the livekitUrl itself actually changes", () => {
    const { rerender } = renderHook(
      ({ url }: { url: string }) => useLiveRoomConnection({ livekitUrl: url, token: "token-one" }),
      { initialProps: { url: "wss://a.example.com" } },
    );
    expect(roomInstances).toHaveLength(1);

    rerender({ url: "wss://b.example.com" });
    expect(roomInstances).toHaveLength(2);
    expect(roomInstances[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
