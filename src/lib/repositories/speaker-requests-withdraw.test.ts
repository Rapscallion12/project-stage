import { describe, expect, it, vi } from "vitest";

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ rpc }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc }),
}));

import { withdrawSpeakerRequest, withdrawSpeakerRequestAsGuest } from "./speaker-requests";

/**
 * Real-device finding (2026-08-23): `withdraw_speaker_request`(_as_guest)
 * `raise exception`s "no pending request found..." (migrations
 * 00000000000011/00000000000012) when the caller's request was already
 * granted/withdrawn — that used to propagate as a thrown error all the
 * way to the UI, leaving a "Withdraw" button that appeared to do
 * nothing (see room/actions.ts's withdrawSpeakerRequest and
 * useAutomaticPromotion's cancel()). These tests pin the fix: that
 * specific error becomes a `null` result, not a throw; any other error
 * still throws.
 */
describe("withdrawSpeakerRequest / withdrawSpeakerRequestAsGuest (issue #21, 05 Phase 2 fix)", () => {
  it("returns the withdrawn row when a pending request genuinely exists", async () => {
    rpc.mockResolvedValue({ data: { id: "r1", status: "withdrawn" }, error: null });
    const result = await withdrawSpeakerRequest("e1");
    expect(result).toEqual({ id: "r1", status: "withdrawn" });
  });

  it("returns null (not a throw) when the RPC reports no pending request found", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "no pending request found for this caller in event e1" },
    });
    await expect(withdrawSpeakerRequest("e1")).resolves.toBeNull();
  });

  it("still throws on a genuine, unrelated RPC error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "connection reset" } });
    await expect(withdrawSpeakerRequest("e1")).rejects.toThrow("connection reset");
  });

  it("the guest variant has the same null-on-nothing-to-withdraw contract", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "no pending request found for this guest in event e1" },
    });
    await expect(withdrawSpeakerRequestAsGuest("e1", "g1")).resolves.toBeNull();
  });
});
