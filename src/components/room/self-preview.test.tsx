import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelfPreview } from "./self-preview";
import type { LocalVideoTrack } from "livekit-client";

function fakeVideoTrack(): LocalVideoTrack {
  return {
    attach: vi.fn((element: HTMLVideoElement) => {
      // Real attach() sets srcObject — the repaint-nudge fix (media
      // rendering bugfix pass) reads it back, so the fake must too.
      element.srcObject = {} as MediaStream;
      return element;
    }),
    detach: vi.fn(),
  } as unknown as LocalVideoTrack;
}

describe("SelfPreview", () => {
  it("attaches the given track to its video element", () => {
    const track = fakeVideoTrack();
    render(<SelfPreview track={track} />);
    expect(track.attach).toHaveBeenCalledTimes(1);
    expect(track.attach).toHaveBeenCalledWith(expect.any(HTMLVideoElement));
  });

  it("detaches on unmount", () => {
    const track = fakeVideoTrack();
    const { unmount } = render(<SelfPreview track={track} />);
    unmount();
    expect(track.detach).toHaveBeenCalledTimes(1);
  });

  it("re-attaches to the new track, and detaches the old one, if the track prop itself changes", () => {
    const first = fakeVideoTrack();
    const second = fakeVideoTrack();
    const { rerender } = render(<SelfPreview track={first} />);
    rerender(<SelfPreview track={second} />);
    expect(first.detach).toHaveBeenCalledTimes(1);
    expect(second.attach).toHaveBeenCalledTimes(1);
  });

  it("labels itself as the viewer's own preview", () => {
    render(<SelfPreview track={fakeVideoTrack()} />);
    expect(screen.getByText("You")).toBeInTheDocument();
  });

  it("mutes local playback of its own video element (no local audio element exists at all)", () => {
    render(<SelfPreview track={fakeVideoTrack()} />);
    const video = document.querySelector("video");
    expect((video as HTMLVideoElement).muted).toBe(true);
    expect(document.querySelector("audio")).not.toBeInTheDocument();
  });

  describe("onTap (mobile UX correction): the tap-to-switch-stage-view affordance", () => {
    it("is not interactive at all when no onTap is given — the ordinary pre-claim candidate preview, unaffected", () => {
      render(<SelfPreview track={fakeVideoTrack()} />);
      const preview = screen.getByTestId("self-preview");
      expect(preview).not.toHaveAttribute("role", "button");
      expect(screen.queryByTestId("self-preview-expand-affordance")).not.toBeInTheDocument();
    });

    it("calls onTap when clicked", () => {
      const onTap = vi.fn();
      render(<SelfPreview track={fakeVideoTrack()} onTap={onTap} />);
      fireEvent.click(screen.getByTestId("self-preview"));
      expect(onTap).toHaveBeenCalledTimes(1);
    });

    it("calls onTap on Enter/Space for keyboard users", () => {
      const onTap = vi.fn();
      render(<SelfPreview track={fakeVideoTrack()} onTap={onTap} />);
      const preview = screen.getByTestId("self-preview");
      fireEvent.keyDown(preview, { key: "Enter" });
      fireEvent.keyDown(preview, { key: " " });
      expect(onTap).toHaveBeenCalledTimes(2);
    });

    it("shows a small, unobtrusive discoverability affordance when tappable", () => {
      render(<SelfPreview track={fakeVideoTrack()} onTap={vi.fn()} />);
      expect(screen.getByTestId("self-preview-expand-affordance")).toBeInTheDocument();
    });

    it("is exposed as a real button to assistive tech, with a focusable tab stop", () => {
      render(<SelfPreview track={fakeVideoTrack()} onTap={vi.fn()} />);
      const preview = screen.getByTestId("self-preview");
      expect(preview).toHaveAttribute("role", "button");
      expect(preview).toHaveAttribute("tabIndex", "0");
      expect(preview).toHaveAccessibleName();
    });
  });

  describe("repaint nudge (media rendering bugfix pass, real-device report: a fresh mount reattaching an already-flowing track can paint black until forced to redecode)", () => {
    const originalPlay = HTMLMediaElement.prototype.play;

    beforeEach(() => {
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
      vi.stubGlobal("cancelAnimationFrame", () => {});
      HTMLMediaElement.prototype.play = vi.fn().mockResolvedValue(undefined);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      HTMLMediaElement.prototype.play = originalPlay;
    });

    it("resets srcObject a beat after attach, forcing a fresh decode, without ever detaching/reattaching the track itself", () => {
      const track = fakeVideoTrack();
      render(<SelfPreview track={track} />);
      const video = document.querySelector("video") as HTMLVideoElement;

      expect(track.attach).toHaveBeenCalledTimes(1);
      // The nudge resets srcObject in place — same stream object, not a
      // second attach()/detach() cycle on the track itself.
      expect(video.srcObject).toBeTruthy();
      expect(track.detach).not.toHaveBeenCalled();
      expect(HTMLMediaElement.prototype.play).toHaveBeenCalled();
    });

    it("does nothing if the element was never actually attached (no srcObject to reset)", () => {
      const track = {
        attach: vi.fn((element: HTMLVideoElement) => element),
        detach: vi.fn(),
      } as unknown as LocalVideoTrack;
      expect(() => render(<SelfPreview track={track} />)).not.toThrow();
    });

    it("cancels the pending repaint nudge on unmount — never touches a detached element", () => {
      vi.stubGlobal("requestAnimationFrame", () => 42);
      const cancelSpy = vi.fn();
      vi.stubGlobal("cancelAnimationFrame", cancelSpy);
      const track = fakeVideoTrack();
      const { unmount } = render(<SelfPreview track={track} />);
      unmount();
      expect(cancelSpy).toHaveBeenCalledWith(42);
    });
  });
});
