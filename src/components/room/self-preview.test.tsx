import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SelfPreview } from "./self-preview";
import type { LocalVideoTrack } from "livekit-client";

function fakeVideoTrack(): LocalVideoTrack {
  return { attach: vi.fn(), detach: vi.fn() } as unknown as LocalVideoTrack;
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
});
