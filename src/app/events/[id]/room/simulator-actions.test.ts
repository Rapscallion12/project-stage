// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  simulateComment,
  simulateLike,
  simulateRequestToSpeak,
  simulateRequestVote,
  simulateRoundVote,
  simulateSeedSpeaker,
  simulateOpenSeat,
  forceRoundDeadline,
} from "./simulator-actions";

/**
 * Issue #21, Part 5: the gate itself — every simulator action must
 * refuse before touching the database when `VERCEL_ENV === "production"`.
 * This is testable with no real Supabase credentials at all: the check
 * throws synchronously before any repository/RPC call is even reached.
 */
describe("simulator-actions (issue #21, Part 5) — refuse to run on production", () => {
  const original = process.env.VERCEL_ENV;

  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = original;
    vi.restoreAllMocks();
  });

  it("simulateComment throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateComment("e1", "g1", "Fake Fox", "hi")).rejects.toThrow(/not available/);
  });

  it("simulateLike throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateLike("m1", "g1")).rejects.toThrow(/not available/);
  });

  it("simulateRequestToSpeak throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateRequestToSpeak("e1", "g1", "Fake Fox", "let me speak")).rejects.toThrow(/not available/);
  });

  it("simulateRequestVote throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateRequestVote("e1", "m1", "g1")).rejects.toThrow(/not available/);
  });

  it("simulateRoundVote throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateRoundVote("s1", "continue", "g1")).rejects.toThrow(/not available/);
  });

  it("simulateSeedSpeaker throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateSeedSpeaker("e1", "g1", "Fake Fox", 1)).rejects.toThrow(/not available/);
  });

  it("simulateOpenSeat throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(simulateOpenSeat("e1", "g1")).rejects.toThrow(/not available/);
  });

  it("forceRoundDeadline throws on production", async () => {
    process.env.VERCEL_ENV = "production";
    await expect(forceRoundDeadline("s1")).rejects.toThrow(/not available/);
  });

  it("is available (does not throw the gate error) on a preview deployment — reaches real I/O, which then fails without credentials, proving the gate itself passed", async () => {
    process.env.VERCEL_ENV = "preview";
    // No Supabase credentials configured for this bare node test, so the
    // underlying call fails downstream — the point is that it's *not*
    // the "not available" gate error, proving the gate itself let it
    // through.
    await expect(simulateComment("e1", "g1", "Fake Fox", "hi")).rejects.not.toThrow(/not available/);
  });
});
