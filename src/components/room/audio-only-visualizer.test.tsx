import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocalAudioTrack } from "livekit-client";
import { AudioOnlyVisualizer } from "./audio-only-visualizer";

const { createAudioAnalyser, mockResume, mockCleanup } = vi.hoisted(() => ({
  createAudioAnalyser: vi.fn(),
  mockResume: vi.fn(async () => {}),
  mockCleanup: vi.fn(async () => {}),
}));

vi.mock("livekit-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("livekit-client")>();
  return { ...actual, createAudioAnalyser };
});

function fakeTrack(): LocalAudioTrack {
  return { sid: "TR_fake123" } as unknown as LocalAudioTrack;
}

describe("AudioOnlyVisualizer", () => {
  afterEach(() => {
    // Explicit, ahead of clearing mocks — otherwise a tree still mounted
    // from this test can get unmounted later by the global setup file's
    // own afterEach(cleanup), calling this test's `cleanup()` mock again
    // after its call count was already reset, polluting the next test.
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  function setup(contextState: AudioContextState = "suspended", runRaf = false) {
    createAudioAnalyser.mockReturnValue({
      calculateVolume: () => 0,
      analyser: { context: { state: contextState, resume: mockResume } },
      cleanup: mockCleanup,
    });
    // runRaf: invoke the callback exactly once (the initial frame) rather
    // than recursively — tick() itself calls requestAnimationFrame(tick)
    // again, so a stub that always re-invokes synchronously would recurse
    // forever.
    let invoked = false;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      if (runRaf && !invoked) {
        invoked = true;
        cb(0);
      }
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});
  }

  /**
   * Media rendering bugfix pass (real-device report): `createAudioAnalyser`
   * (livekit-client) creates a brand-new AudioContext every call, which
   * can start `suspended` outside a user gesture — confirmed by reading
   * its actual implementation, not assumed (see this component's own doc
   * comment). Without an explicit resume, the analyser would read silence
   * forever even with real audio flowing, indistinguishable from "the
   * visualizer doesn't work" — this is the fix for that.
   */
  it("explicitly resumes a suspended AudioContext — never leaves it to an incidental future click", () => {
    setup("suspended");
    render(<AudioOnlyVisualizer track={fakeTrack()} displayName="Jamie" />);
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("still calls resume even when the context is already running — a harmless no-op, not conditionally skipped", () => {
    setup("running");
    render(<AudioOnlyVisualizer track={fakeTrack()} displayName="Jamie" />);
    expect(mockResume).toHaveBeenCalledTimes(1);
  });

  it("cleans up the analyser on unmount", () => {
    setup();
    const { unmount } = render(<AudioOnlyVisualizer track={fakeTrack()} displayName="Jamie" />);
    unmount();
    expect(mockCleanup).toHaveBeenCalledTimes(1);
  });

  it("recreates the analyser (and cleans up the old one) when the track identity changes — no leaked analyser across a speaker swap", () => {
    setup();
    const trackA = fakeTrack();
    const trackB = fakeTrack();
    const { rerender } = render(<AudioOnlyVisualizer track={trackA} displayName="Jamie" />);
    expect(createAudioAnalyser).toHaveBeenCalledTimes(1);
    rerender(<AudioOnlyVisualizer track={trackB} displayName="Jamie" />);
    expect(mockCleanup).toHaveBeenCalledTimes(1);
    expect(createAudioAnalyser).toHaveBeenCalledTimes(2);
  });

  it("renders the full identity treatment (avatar linked to the speaker's profile) by default", () => {
    setup();
    render(<AudioOnlyVisualizer track={fakeTrack()} displayName="Jamie Rivera" username="jamie" />);
    expect(screen.getByRole("link", { name: "Jamie Rivera's profile" })).toBeInTheDocument();
  });

  it("renders the compact, identity-free treatment for the self-view corner slot — no avatar/profile link at all", () => {
    setup();
    render(<AudioOnlyVisualizer track={fakeTrack()} compact />);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("exposes dev-only debug attributes (analyser track sid, rAF active, context state) for real-device diagnosis — never asserted as production UI, just present in non-production", () => {
    setup("running", true);
    render(<AudioOnlyVisualizer track={fakeTrack()} compact />);
    const el = screen.getByTestId("audio-only-visualizer");
    expect(el.dataset.analyserTrackSid).toBe("TR_fake123");
    expect(el.dataset.analyserRafActive).toBe("true");
    expect(el.dataset.analyserContextState).toBe("running");
  });
});
