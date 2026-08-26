import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpeakerMediaPresenceReporting } from "./use-speaker-media-presence";

const { reportSpeakerMediaActive, reportSpeakerMediaInactive } = vi.hoisted(() => ({
  reportSpeakerMediaActive: vi.fn(),
  reportSpeakerMediaInactive: vi.fn(),
}));

vi.mock("@/app/events/[id]/room/actions", () => ({ reportSpeakerMediaActive, reportSpeakerMediaInactive }));

function baseParams(overrides: Partial<Parameters<typeof useSpeakerMediaPresenceReporting>[0]> = {}) {
  return {
    eventId: "e1",
    isSpeaker: true,
    canPublish: true,
    needsMediaActivation: false,
    microphoneMuted: false,
    cameraMuted: false,
    ...overrides,
  };
}

describe("useSpeakerMediaPresenceReporting (issue #18 unified inactive-speaker finding: cause B, client-observed half)", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("reports nothing on mount when actively publishing (both unmuted) — the common case", () => {
    renderHook((props) => useSpeakerMediaPresenceReporting(props), { initialProps: baseParams() });
    expect(reportSpeakerMediaInactive).not.toHaveBeenCalled();
    expect(reportSpeakerMediaActive).not.toHaveBeenCalled();
  });

  it("reports inactive on mount when media was never activated (needsMediaActivation true) — the moment inactivity begins, not a later poll", () => {
    renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ needsMediaActivation: true }),
    });
    expect(reportSpeakerMediaInactive).toHaveBeenCalledWith("e1");
    expect(reportSpeakerMediaActive).not.toHaveBeenCalled();
  });

  it("camera off alone never reports inactive", () => {
    renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ cameraMuted: true }),
    });
    expect(reportSpeakerMediaInactive).not.toHaveBeenCalled();
  });

  it("mic muted alone never reports inactive", () => {
    renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ microphoneMuted: true }),
    });
    expect(reportSpeakerMediaInactive).not.toHaveBeenCalled();
  });

  it("both camera and mic muted together transitions to reporting inactive", () => {
    const { rerender } = renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams(),
    });
    expect(reportSpeakerMediaInactive).not.toHaveBeenCalled();

    rerender(baseParams({ microphoneMuted: true, cameraMuted: true }));
    expect(reportSpeakerMediaInactive).toHaveBeenCalledTimes(1);
    expect(reportSpeakerMediaInactive).toHaveBeenCalledWith("e1");
  });

  it("does not re-report on every render while the derived state stays the same — only genuine transitions", () => {
    const { rerender } = renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ microphoneMuted: true, cameraMuted: true }),
    });
    expect(reportSpeakerMediaInactive).toHaveBeenCalledTimes(1);

    rerender(baseParams({ microphoneMuted: true, cameraMuted: true }));
    rerender(baseParams({ microphoneMuted: true, cameraMuted: true }));
    expect(reportSpeakerMediaInactive).toHaveBeenCalledTimes(1);
  });

  it("restoring either camera or mic alone is enough to report active again", () => {
    const { rerender } = renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ microphoneMuted: true, cameraMuted: true }),
    });
    expect(reportSpeakerMediaInactive).toHaveBeenCalledTimes(1);

    rerender(baseParams({ microphoneMuted: true, cameraMuted: false })); // unmuted camera only
    expect(reportSpeakerMediaActive).toHaveBeenCalledWith("e1");
  });

  it("tapping activateMedia (needsMediaActivation flipping false) also reports active", () => {
    const { rerender } = renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ needsMediaActivation: true }),
    });
    expect(reportSpeakerMediaInactive).toHaveBeenCalledTimes(1);

    rerender(baseParams({ needsMediaActivation: false }));
    expect(reportSpeakerMediaActive).toHaveBeenCalledWith("e1");
  });

  it("never reports anything for an audience member (isSpeaker false), even with both flags muted", () => {
    renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ isSpeaker: false, microphoneMuted: true, cameraMuted: true }),
    });
    expect(reportSpeakerMediaInactive).not.toHaveBeenCalled();
    expect(reportSpeakerMediaActive).not.toHaveBeenCalled();
  });

  it("leaving the stage (isSpeaker flips false after being media-inactive) reports active as a harmless cleanup — the server-side no-op for an already-ended row makes this safe", () => {
    const { rerender } = renderHook((props) => useSpeakerMediaPresenceReporting(props), {
      initialProps: baseParams({ microphoneMuted: true, cameraMuted: true }),
    });
    expect(reportSpeakerMediaInactive).toHaveBeenCalledTimes(1);

    rerender(baseParams({ isSpeaker: false, microphoneMuted: true, cameraMuted: true }));
    expect(reportSpeakerMediaActive).toHaveBeenCalledWith("e1");
  });
});
