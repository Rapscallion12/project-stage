import { describe, expect, it } from "vitest";
import { deriveSpeakerPresence, inactiveSince, isLocalMediaInactive } from "./speaker-presence";

describe("inactiveSince (issue #18 unified inactive-speaker finding)", () => {
  it("is null when neither field is set", () => {
    expect(inactiveSince({ disconnected_at: null, media_inactive_since: null })).toBeNull();
  });

  it("is null for a null/undefined speaker", () => {
    expect(inactiveSince(null)).toBeNull();
    expect(inactiveSince(undefined)).toBeNull();
  });

  it("returns disconnected_at when only that's set", () => {
    const at = new Date().toISOString();
    expect(inactiveSince({ disconnected_at: at, media_inactive_since: null })).toBe(at);
  });

  it("returns media_inactive_since when only that's set", () => {
    const at = new Date().toISOString();
    expect(inactiveSince({ disconnected_at: null, media_inactive_since: at })).toBe(at);
  });

  it("returns the earlier of the two when both are somehow set — the seat stopped being useful at the earlier moment", () => {
    const earlier = new Date(Date.now() - 5000).toISOString();
    const later = new Date().toISOString();
    expect(inactiveSince({ disconnected_at: later, media_inactive_since: earlier })).toBe(earlier);
    expect(inactiveSince({ disconnected_at: earlier, media_inactive_since: later })).toBe(earlier);
  });
});

describe("deriveSpeakerPresence", () => {
  it("is 'active' when neither field is set", () => {
    expect(deriveSpeakerPresence({ disconnected_at: null, media_inactive_since: null })).toBe("active");
  });

  it("is 'inactive' when disconnected_at is set", () => {
    expect(deriveSpeakerPresence({ disconnected_at: new Date().toISOString(), media_inactive_since: null })).toBe(
      "inactive",
    );
  });

  it("is 'inactive' when media_inactive_since is set", () => {
    expect(deriveSpeakerPresence({ disconnected_at: null, media_inactive_since: new Date().toISOString() })).toBe(
      "inactive",
    );
  });
});

describe("isLocalMediaInactive (issue #18 unified inactive-speaker finding: cause B)", () => {
  it("is false whenever canPublish is false, regardless of the other flags — this is about a seated speaker's own media state, not eligibility", () => {
    expect(
      isLocalMediaInactive({
        canPublish: false,
        needsMediaActivation: true,
        microphoneMuted: true,
        cameraMuted: true,
      }),
    ).toBe(false);
  });

  it("is true when media was never activated at all (needsMediaActivation) — nothing is currently being transmitted", () => {
    expect(
      isLocalMediaInactive({
        canPublish: true,
        needsMediaActivation: true,
        microphoneMuted: false,
        cameraMuted: false,
      }),
    ).toBe(true);
  });

  it("camera off alone (mic still on) remains active — only camera is muted", () => {
    expect(
      isLocalMediaInactive({
        canPublish: true,
        needsMediaActivation: false,
        microphoneMuted: false,
        cameraMuted: true,
      }),
    ).toBe(false);
  });

  it("mic muted alone (camera still on) remains active — only mic is muted", () => {
    expect(
      isLocalMediaInactive({
        canPublish: true,
        needsMediaActivation: false,
        microphoneMuted: true,
        cameraMuted: false,
      }),
    ).toBe(false);
  });

  it("both camera and mic muted simultaneously is inactive — no longer meaningfully participating", () => {
    expect(
      isLocalMediaInactive({
        canPublish: true,
        needsMediaActivation: false,
        microphoneMuted: true,
        cameraMuted: true,
      }),
    ).toBe(true);
  });

  it("neither muted (fully active) is active", () => {
    expect(
      isLocalMediaInactive({
        canPublish: true,
        needsMediaActivation: false,
        microphoneMuted: false,
        cameraMuted: false,
      }),
    ).toBe(false);
  });
});
