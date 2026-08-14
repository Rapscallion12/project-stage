import { describe, expect, it } from "vitest";
import { classifyMediaError, shouldPublish } from "./use-live-room-connection";

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
