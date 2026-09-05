// @vitest-environment node
import { describe, expect, it, vi, beforeEach } from "vitest";

const { resolveIdentity, recordStageReactionAttempt, httpSend, channel } = vi.hoisted(() => {
  const httpSend = vi.fn(async () => undefined);
  const channel = vi.fn(() => ({ httpSend }));
  return {
    resolveIdentity: vi.fn(async (): Promise<{ type: "profile" | "guest"; id: string }> => ({ type: "guest", id: "guest-1" })),
    recordStageReactionAttempt: vi.fn(async () => ({ accepted: true, heatAfter: 12, inCooldownAfter: false })),
    httpSend,
    channel,
  };
});

vi.mock("@/lib/identity", () => ({ resolveIdentity }));
vi.mock("@/lib/repositories/stage-reactions", () => ({ recordStageReactionAttempt }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ channel }) }));

const { sendStageReaction } = await import("./actions");

/**
 * Pre-launch interaction pass, Section 14's reaction test list: bounded
 * coordinates, invalid input rejected, a rejected/cooling-down attempt
 * never broadcasts, and (by construction — this function never imports
 * or calls anything chat/vote/RTS-related) reactions can't touch
 * comments or votes. `recordStageReactionAttempt` itself (the real
 * security boundary) has its own dedicated real-DB proof in
 * stage-reactions.test.ts; this file mocks it to isolate the action's
 * own validation/clamping/broadcast-gating logic.
 */
describe("sendStageReaction (pre-launch interaction pass, Section 2-5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveIdentity.mockResolvedValue({ type: "guest", id: "guest-1" });
    recordStageReactionAttempt.mockResolvedValue({ accepted: true, heatAfter: 12, inCooldownAfter: false });
  });

  it("rejects an emoji outside the curated set without ever attempting the rate-limit RPC", async () => {
    const result = await sendStageReaction("e1", "profile:alice", "🎉", 0.5, 0.5);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(recordStageReactionAttempt).not.toHaveBeenCalled();
    expect(httpSend).not.toHaveBeenCalled();
  });

  it("rejects an empty target identity without attempting the rate-limit RPC", async () => {
    const result = await sendStageReaction("e1", "", "❤️", 0.5, 0.5);
    expect(result).toEqual({ ok: false, reason: "invalid" });
    expect(recordStageReactionAttempt).not.toHaveBeenCalled();
  });

  it("clamps out-of-range coordinates into [0,1] rather than rejecting the reaction", async () => {
    await sendStageReaction("e1", "profile:alice", "❤️", 1.4, -0.3);
    expect(httpSend).toHaveBeenCalledWith(
      "reaction",
      expect.objectContaining({ x: 1, y: 0 }),
    );
  });

  it("falls back to center (0.5, 0.5) for a non-finite coordinate — NaN and Infinity are both non-finite, not merely out-of-range", async () => {
    await sendStageReaction("e1", "profile:alice", "❤️", NaN, Infinity);
    expect(httpSend).toHaveBeenCalledWith(
      "reaction",
      expect.objectContaining({ x: 0.5, y: 0.5 }),
    );
  });

  it("accepts a valid reaction and broadcasts it on the event's own reaction channel", async () => {
    const result = await sendStageReaction("e1", "profile:alice", "🔥", 0.2, 0.8);
    expect(result).toEqual({ ok: true, heatAfter: 12, inCooldownAfter: false });
    expect(channel).toHaveBeenCalledWith("event-reactions:e1");
    expect(httpSend).toHaveBeenCalledWith(
      "reaction",
      expect.objectContaining({ targetIdentity: "profile:alice", emoji: "🔥", x: 0.2, y: 0.8, senderIdentity: "guest:guest-1" }),
    );
  });

  it("a rejected (cooling-down) attempt never broadcasts to other viewers", async () => {
    recordStageReactionAttempt.mockResolvedValue({ accepted: false, heatAfter: 100, inCooldownAfter: true });
    const result = await sendStageReaction("e1", "profile:alice", "❤️", 0.5, 0.5);
    expect(result).toEqual({ ok: false, reason: "cooling-down", heatAfter: 100, inCooldownAfter: true });
    expect(httpSend).not.toHaveBeenCalled();
  });

  it("resolves the real caller identity itself — never trusts a client-supplied sender", async () => {
    resolveIdentity.mockResolvedValue({ type: "profile", id: "real-user-id" });
    await sendStageReaction("e1", "profile:alice", "❤️", 0.5, 0.5);
    expect(recordStageReactionAttempt).toHaveBeenCalledWith("e1", { type: "profile", id: "real-user-id" });
    expect(httpSend).toHaveBeenCalledWith("reaction", expect.objectContaining({ senderIdentity: "profile:real-user-id" }));
  });
});
